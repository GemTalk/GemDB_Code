import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { execFileSync, spawn } from 'child_process';
import * as vscode from 'vscode';
import { DB_PASSWORD, DB_USER, STONE_NAME, mcpPort, mcpReadOnly, rootPath } from './config';
import { errorMessage, log, logStep } from './log';
import { engineEnvironment } from './processes';
import { installedMcpStamp, mcpPath, mcpRouterStatePath, mcpStampPath } from './paths';

/**
 * The MCP server — GemTalk's native GemStone Model Context Protocol server,
 * bundled so that an agent can reach the database GemDB installed.
 *
 * Three things happen here, and they are worth separating because only the
 * middle one resembles Grail:
 *
 *   Staging copies the payload out of the extension into `<rootPath>/mcp`.
 *   Installing files its `Mcp*` classes into the database, by running the
 *   payload's own `install.sh` — the same script a developer would run by
 *   hand. There is no GemDB-specific installer here, unlike Grail's, because
 *   there is nothing to skip: the payload is Smalltalk file-outs, so no C
 *   toolchain, no engine headers, and no per-platform artifact is involved.
 *   The same payload is valid on every target GemDB ships.
 *
 *   Running it forks a *detached gem* that owns the port and runs the accept
 *   loop. This is the part with no Grail counterpart, and it is why the MCP
 *   server is started and stopped alongside the stone and the NetLDI rather
 *   than merely installed: it is a process, it outlives the editor, and it
 *   holds a session.
 *
 * The session cost is the thing to keep in mind when reading the rest of this
 * file. The router gem holds one session for as long as it runs, and every
 * connected MCP client gets a worker gem of its own — one more session each,
 * released when the client disconnects or after 30 minutes idle (the router's
 * own reaper). Against the Community Edition's ten, that is real: a router,
 * two agents talking to it, three notebooks and a GemDB Shell is eight.
 * `SessionLimitError` in session.ts is what a user meets when it runs out, and
 * the MCP row in the status view is there so the router is not the invisible
 * one.
 */

/** The MCP build shipped with this extension, or undefined if none is. */
export function bundledMcpStamp(extensionPath: string): string | undefined {
  try {
    return fs.readFileSync(path.join(extensionPath, 'mcp', 'MCP_VERSION'), 'utf8').trim();
  } catch {
    return undefined;
  }
}

/** A short label for the status view, e.g. "0.5.0-3-g89246e1". */
export function mcpLabel(stamp: string | undefined): string {
  if (!stamp) return 'unknown';
  const match = stamp.match(/^mcp=(.+)$/m);
  return match ? match[1] : 'unknown';
}

/** True when what is filed into the database is not what this extension ships. */
export function mcpNeedsUpdate(extensionPath: string): boolean {
  const bundled = bundledMcpStamp(extensionPath);
  if (!bundled) return false; // nothing to install; reported separately
  return installedMcpStamp() !== bundled;
}

/**
 * Copy the bundled MCP payload to the root path, replacing any previous copy.
 *
 * Wholesale, like `stageGrail`: a partial overlay of one payload on another is
 * not a state worth supporting, and the class file-outs are a few hundred
 * kilobytes.
 */
export function stageMcp(extensionPath: string): void {
  const source = path.join(extensionPath, 'mcp');
  const stamp = bundledMcpStamp(extensionPath);
  if (!stamp) {
    throw new Error(
      'This build of GemDB ships no MCP server payload. ' +
        'Run "npm run bundle:mcp" before packaging the extension.',
    );
  }

  logStep(`Staging the MCP server ${mcpLabel(stamp)}`);
  const dest = mcpPath();
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(rootPath(), { recursive: true });
  fs.cpSync(source, dest, { recursive: true });

  // A .vsix is a zip, and depending on how it was produced the executable bit
  // may not survive. The installer is invoked through bash explicitly so this
  // cannot break the install, but `run-server.sh` and `stop-server.sh` are
  // staged for the user to run themselves.
  for (const entry of fs.readdirSync(dest)) {
    if (!entry.endsWith('.sh')) continue;
    try {
      fs.chmodSync(path.join(dest, entry), 0o755);
    } catch {
      /* best effort */
    }
  }
  log(`MCP server staged at ${dest}`);
}

/**
 * Record that the staged payload is now filed into the database.
 *
 * Written only after a successful file-in, for the reason Grail's stamp is:
 * the copy on disk and the classes in the database are different facts, and
 * conflating them makes a failed install look like a finished one.
 */
export function recordMcpInstalled(extensionPath: string): void {
  const stamp = bundledMcpStamp(extensionPath);
  if (!stamp) return;
  fs.writeFileSync(mcpStampPath(), `${stamp}\n`);
}

/**
 * File the MCP classes into the running database.
 *
 * Runs the payload's own `install.sh`, which resolves the environment, files
 * in the four groups it selects, commits, and then asks the image what it
 * actually has rather than trusting topaz's exit code.
 *
 * Two flags, both deliberate:
 *
 *   `--grail` files in the Python toolset. GemDB *is* a Grail image, and this
 *   is not merely available but the point — a server that could browse classes
 *   but not run Python in the database would be the wrong half of GemDB.
 *   Opt-in upstream because it joins the default tool surface, which for GemDB
 *   is exactly the desired effect.
 *
 *   `--no-auth` leaves out the OAuth/OIDC front end. The pinned engine could
 *   compile it, so this is a choice rather than a limitation: GemDB's server
 *   is bound to loopback for one user on one machine, and `McpAuthRouter`
 *   exists for a reachable port — which is Jasper's kind of territory, not
 *   GemDB's. Nothing here can start it, so shipping it would be code filed
 *   into every user's database that nothing can reach.
 *
 * Unlike `installGrail` this does NOT log every session out afterwards. That
 * exists for Grail because a session that logged in beforehand goes on
 * reporting "Python support is not installed" against a database where it
 * plainly is. Nothing a user session does depends on the `Mcp*` classes: the
 * only thing that reads them is the router gem, which logs in fresh when it
 * is forked, after this returns.
 */
export function installMcp(
  extensionPath: string,
  progress?: vscode.Progress<{ message?: string }>,
): Promise<void> {
  logStep('Installing the MCP server into the database');
  const installer = path.join(mcpPath(), 'install.sh');
  if (!fs.existsSync(installer)) {
    return Promise.reject(new Error(`The MCP server payload is not staged at ${mcpPath()}.`));
  }

  const env = {
    ...process.env,
    ...engineEnvironment(),
    GS_STONE: STONE_NAME,
    GS_USER: DB_USER,
    GS_PASS: DB_PASSWORD,
  };

  return new Promise((resolve, reject) => {
    const child = spawn('bash', [installer, '--grail', '--no-auth'], {
      env,
      cwd: mcpPath(),
    });
    let tail = '';
    const collect = (data: Buffer): void => {
      const text = data.toString();
      tail = (tail + text).slice(-4000);
      log(text.trimEnd());
      const lastLine = text.trim().split('\n').filter(Boolean).pop();
      if (lastLine) progress?.report({ message: truncate(lastLine, 80) });
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);

    child.on('close', (code) => {
      if (code === 0) {
        log('MCP server installed');
        resolve();
        return;
      }
      reject(
        new Error(
          `Installing the MCP server failed (exit code ${code}). ` +
            'See the GemDB output for the full log.\n' +
            tail.trim().split('\n').slice(-8).join('\n'),
        ),
      );
    });
    child.on('error', (err) =>
      reject(new Error(`Installing the MCP server failed: ${err.message}`)),
    );
  });
}

/** The address a client connects to. One endpoint, per the transport. */
export function mcpUrl(port = mcpPort()): string {
  return `http://127.0.0.1:${port}/mcp`;
}

/** What GemDB recorded about the router it forked. */
export interface RouterState {
  port: number;
  /** The gem's GemStone session id, for `System stopSession:`. */
  sessionId?: number;
  /** The gem's host process id, for a signal when the clean stop does not land. */
  pid?: number;
  startedAt: string;
}

export function readRouterState(): RouterState | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(mcpRouterStatePath(), 'utf8')) as RouterState;
    return typeof parsed.port === 'number' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function writeRouterState(state: RouterState): void {
  try {
    fs.mkdirSync(rootPath(), { recursive: true });
    fs.writeFileSync(mcpRouterStatePath(), `${JSON.stringify(state, null, 2)}\n`);
  } catch (e) {
    // Not fatal: the server is running either way. What is lost is the clean
    // stop path, which falls back to the payload's own port-based script.
    log(`Could not record the MCP router's process details: ${errorMessage(e)}`);
  }
}

function clearRouterState(): void {
  fs.rmSync(mcpRouterStatePath(), { force: true });
}

/**
 * Whether anything is listening on the port.
 *
 * A TCP connect and nothing more. The obvious alternative — POST an
 * `initialize` and read the reply — would be a positive identification of *our*
 * server, and it would also open a worker gem and spend one of the ten
 * sessions every time the status view refreshes. So the probe stays at the
 * transport layer, and `isMcpRunning` pairs it with the recorded pid to tell
 * our router apart from something else holding the port.
 */
export function isPortOpen(port: number, timeoutMs = 250): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (open: boolean): void => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, '127.0.0.1');
  });
}

/** True when a process with this pid exists and looks like a GemStone gem. */
function looksLikeGem(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false; // gone, or not ours to signal
  }
  try {
    const comm = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], {
      encoding: 'utf-8',
    }).trim();
    const name = path.basename(comm);
    return /gem|topaz/i.test(name);
  } catch {
    // `ps` said nothing, so the pid is gone between the two calls.
    return false;
  }
}

export type McpServerState =
  /** Nothing is listening on the port. */
  | { running: false; port: number; foreign: false }
  /** Our router, as recorded when GemDB forked it. */
  | { running: true; port: number; foreign: false; pid?: number; sessionId?: number }
  /** Something is listening, but it is not a router GemDB started. */
  | { running: true; port: number; foreign: true };

/**
 * What is on the port, and whether it is ours.
 *
 * The distinction matters in both directions. Starting: a port already served
 * by something else must be reported, not forked over — the router refuses the
 * bind and says so in a gem log nobody is watching. Stopping: GemDB must not
 * kill a process it did not start, however plausibly it holds the port.
 */
export async function mcpServerState(port = mcpPort()): Promise<McpServerState> {
  if (!(await isPortOpen(port))) return { running: false, port, foreign: false };
  const state = readRouterState();
  if (state?.port === port && state.pid !== undefined && looksLikeGem(state.pid)) {
    return { running: true, port, foreign: false, pid: state.pid, sessionId: state.sessionId };
  }
  // A router GemDB forked before the state file was lost — or an update that
  // cleared it — is indistinguishable from a stranger, so it is reported as
  // one. `stopMcpServer` still has the payload's port-based script for that
  // case, which makes the same gem-or-nothing check before killing anything.
  return { running: true, port, foreign: true };
}

export async function isMcpRunning(port = mcpPort()): Promise<boolean> {
  return (await mcpServerState(port)).running;
}

/**
 * Run a topaz script against the database and answer everything it printed.
 *
 * Linked topaz (`-l`), so this needs no NetLDI — which matters on the stop
 * path, where the listener may already be down. The script arrives on stdin
 * rather than as a file so that the password is never an argument and never
 * on disk.
 */
function runTopaz(script: string, label: string): Promise<string> {
  const env = { ...process.env, ...engineEnvironment() };
  const topaz = path.join(env.GEMSTONE ?? '', 'bin', 'topaz');
  return new Promise((resolve, reject) => {
    const child = spawn(topaz, ['-lq'], { env });
    let output = '';
    const collect = (data: Buffer): void => {
      output += data.toString();
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.on('close', (code) => {
      log(output.trimEnd());
      if (code === 0) resolve(output);
      else reject(new Error(`${label} failed (exit code ${code}).\n${output.trim()}`));
    });
    child.on('error', (err) => reject(new Error(`${label} failed: ${err.message}`)));
    child.stdin?.end(script);
  });
}

/** The login preamble every script below shares. */
function topazLogin(): string {
  return [
    `set gemstone ${STONE_NAME}`,
    `set username ${DB_USER}`,
    `set password ${DB_PASSWORD}`,
    'login',
    'iferr 1 stk',
  ].join('\n');
}

/** Double every quote: free-form text going into a Smalltalk string literal. */
function smalltalkString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Fork the detached router gem that owns the port.
 *
 * `forkOnPort:` is the payload's own entry point for this, and what it does is
 * why GemDB does not simply fork a Smalltalk process: a `GsProcess` inside a
 * GCI session only runs while that session is executing, so a background fork
 * in an idle session would never answer a request. Instead the router spawns a
 * separate gem through `GsTsExternalSession` — which is why the NetLDI has to
 * be up, and it is, since `ensureRunning` starts it first — and detaches it.
 * The gem survives this topaz session logging out, and the editor closing.
 *
 * The instance is configured before it is forked because the router keeps no
 * committed state: `forkOnPort:` serializes the configuration into the child's
 * fork string. So the read-only setting and the title are decided here, once,
 * per fork — changing the setting takes effect the next time the server starts.
 *
 * Answers a status line naming the gem's session id and host pid, both of
 * which are recorded: they are what lets `stopMcpServer` name this gem rather
 * than hunt for whatever holds the port.
 */
export async function startMcpServer(): Promise<boolean> {
  const port = mcpPort();
  const state = await mcpServerState(port);
  if (state.running) {
    if (state.foreign) {
      log(
        `Something is already listening on 127.0.0.1:${port}, and it is not an MCP server GemDB ` +
          'started. Leaving it alone — set `gemdb.mcp.port` to another port, or stop whatever ' +
          'holds this one.',
      );
      return false;
    }
    log(`The MCP server is already running on ${mcpUrl(port)}.`);
    return true;
  }

  logStep(`Starting the MCP server on ${mcpUrl(port)}`);
  // `serverTitle:` is what a client displays to tell one deployment from
  // another; the server's name and version stay truthful, since every GemDB
  // install runs the same software. The stone name is the only thing that
  // distinguishes this database, and it is fixed — so the title says which
  // product opened the door, which is what an agent's server list needs.
  const script = [
    topazLogin(),
    'run',
    '| r |',
    'r := McpRouter new.',
    `r readOnly: ${mcpReadOnly() ? 'true' : 'false'}.`,
    `r serverTitle: ${smalltalkString(`GemDB (${STONE_NAME})`)}.`,
    `r forkOnPort: ${port}`,
    '%',
    'logout',
    'exit',
  ].join('\n');

  const output = await runTopaz(script, 'Start the MCP server');
  const sessionId = Number(/gem session (\d+)/.exec(output)?.[1]);
  const pid = Number(/host pid (\d+)/.exec(output)?.[1]);

  // `forkOnPort:` answers a status line naming the gem it launched, so no
  // session id means no gem — a login that failed, or a class that is not
  // there. Say so now rather than spending five seconds waiting for a port
  // nothing is going to bind. topaz can exit 0 over this: `iferr 1 stk`
  // prints a stack and carries on, which is why the exit code is not the test.
  if (!Number.isInteger(sessionId)) {
    clearRouterState();
    log(
      'The MCP server was not started: topaz reported no gem session. ' +
        'The output above says why.',
    );
    return false;
  }

  writeRouterState({
    port,
    sessionId,
    pid: Number.isInteger(pid) ? pid : undefined,
    startedAt: new Date().toISOString(),
  });

  // The fork returns as soon as the child is launched, so the listener may not
  // have bound yet. Wait for the port rather than reporting a server a client
  // would fail to reach a moment later.
  for (let attempt = 0; attempt < 20; attempt++) {
    if (await isPortOpen(port)) {
      log(`The MCP server is listening on ${mcpUrl(port)}`);
      return true;
    }
    await delay(250);
  }
  log(
    `The MCP server was forked but nothing is listening on port ${port} yet. ` +
      'Check the gem log under the database log directory.',
  );
  return false;
}

/**
 * Stop the router, and with it the worker gems it opened.
 *
 * This has to happen before the stone goes down, and not as an afterthought:
 * the router is a logged-in session, so `stopstone` would refuse over it and
 * every ordinary "Stop GemDB" would land on the "Stop Anyway" modal that is
 * meant for a notebook someone forgot about.
 *
 * Two routes, in this order:
 *
 *   `System stopSession:` on the recorded gem, from a linked topaz session.
 *   The clean one — the engine ends the gem, and it needs no NetLDI (already
 *   stopped by then, in `runStop`'s ordering) and no `lsof`.
 *
 *   A signal to the recorded host pid, if the port is still open afterwards.
 *   Guarded by `looksLikeGem`, so a recycled pid belonging to something else
 *   is left alone.
 *
 * Each connected client's worker gem is a separate gem whose *client* is the
 * router, and that is what makes stopping the router sufficient: an RPC gem
 * whose client process has gone is terminated by the engine, so the workers
 * follow the router down rather than needing to be hunted individually.
 * Measured 2026-09-07 — `System descriptionOfSession:` slot 21 of each worker
 * is the router's own pid (slot 2), and the workers were gone within four
 * seconds of the router. It matters that this holds: the idle reaper is a
 * GsProcess inside the router, so it dies with it, and an orphaned worker
 * would hold one of the ten sessions until the stone was force-stopped.
 * `mcp.test.ts` in the integration suite is what keeps it honest — it asserts
 * the session count returns to its baseline after a client has connected.
 */
export async function stopMcpServer(): Promise<void> {
  const port = mcpPort();
  const state = await mcpServerState(port);
  if (!state.running) {
    clearRouterState();
    return;
  }
  if (state.foreign) {
    log(
      `Not stopping whatever is listening on 127.0.0.1:${port}: GemDB has no record of ` +
        'starting it.',
    );
    return;
  }

  logStep('Stopping the MCP server');
  if (state.sessionId !== undefined) {
    try {
      await runTopaz(
        [topazLogin(), 'run', `System stopSession: ${state.sessionId}`, '%', 'logout', 'exit'].join(
          '\n',
        ),
        'Stop the MCP server',
      );
    } catch (e) {
      log(`Could not stop the MCP server's session cleanly: ${errorMessage(e)}`);
    }
    for (let attempt = 0; attempt < 12 && (await isPortOpen(port)); attempt++) {
      await delay(250);
    }
  }

  if ((await isPortOpen(port)) && state.pid !== undefined && looksLikeGem(state.pid)) {
    log(`The MCP server is still listening; signalling pid ${state.pid}.`);
    try {
      process.kill(state.pid, 'SIGTERM');
    } catch {
      /* it went away between the check and the signal */
    }
    for (let attempt = 0; attempt < 12 && (await isPortOpen(port)); attempt++) {
      await delay(250);
    }
  }

  if (await isPortOpen(port)) {
    log(`The MCP server on port ${port} did not stop. Its gem may need stopping by hand.`);
    return;
  }
  clearRouterState();
  log('MCP server stopped.');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
