import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile, execFileSync, spawn } from 'child_process';
import { promisify } from 'util';
import {
  ADMIN_PASSWORD,
  ADMIN_USER,
  NETLDI_NAME,
  STONE_NAME,
  STOP_TIMEOUT_SECONDS,
  externalDatabase,
  netldiName,
  rootPath,
  stoneName,
} from './config';
import { libraryPathVariable, sharedLibraryExtension } from './platform';
import { log, logStep } from './log';
import { STONE_LOCK_POLL_MS, STONE_LOCK_TIMEOUT_MS, withStoneLock } from './lock';
import { DiskSpaceError, databaseOnNfsError } from './database';
import { EngineProcess, parseGslist } from './gslist';
import { databaseConfPath, databaseLogPath, databasePath, enginePath, grailPath } from './paths';

export type { EngineProcess } from './gslist';

/**
 * The environment every engine command and every session runs under.
 *
 * The three Grail variables matter beyond the command being run right now:
 * a session is forked by the NetLDI, and inherits the NetLDI's environment.
 * Starting the NetLDI with these set is what makes `import` work in every
 * session afterwards, without the user configuring anything.
 */
export function engineEnvironment(): Record<string, string> {
  const gs = enginePath();
  const external = externalDatabase();
  if (!gs) {
    throw new Error(
      external
        ? `The database engine is not at ${external.gemstone} (gemdb.externalDatabase.gemstone).`
        : 'The database engine is not installed. Run "GemDB: Install GemDB" first.',
    );
  }

  // An external database brings its own configuration, logs and lock
  // directory, so GemDB sets only what finds the engine and what its own
  // sessions need. The configuration variables in particular are left alone:
  // pointed at GemDB's conf directory they would make a linked session read a
  // config file that does not describe the administrator's stone.
  if (external) {
    return {
      GEMSTONE: gs,
      GEMSTONE_GLOBAL_DIR: external.globalDirectory,
      PATH: `${path.join(gs, 'bin')}:/usr/local/bin:/usr/bin:/bin`,
      [libraryPathVariable()]: path.join(gs, 'lib'),
      MANPATH: path.join(gs, 'doc'),
      GRAIL_DIR: grailPath(),
      PYTHON_PACKAGE_PATH: path.join(grailPath(), 'src', 'python'),
      SHIM_LIB_PATH: shimLibraryPath(),
    };
  }

  const dbPath = databasePath();
  const env: Record<string, string> = {
    GEMSTONE: gs,
    GEMSTONE_GLOBAL_DIR: rootPath(),
    PATH: `${path.join(gs, 'bin')}:/usr/local/bin:/usr/bin:/bin`,
    [libraryPathVariable()]: path.join(gs, 'lib'),
    MANPATH: path.join(gs, 'doc'),
    GEMSTONE_SYS_CONF: databaseConfPath(),
    GEMSTONE_EXE_CONF: databaseConfPath(),
    GEMSTONE_LOG: path.join(databaseLogPath(), `${STONE_NAME}.log`),
    GEMSTONE_NRS_ALL: `#netldi:${NETLDI_NAME}#dir:${dbPath}#log:${path.join(databaseLogPath(), '%N_%P.log')}`,
    // Grail resolves its own directory from GRAIL_DIR, falling back to the
    // working directory. Sessions are forked by the NetLDI in an arbitrary
    // directory, so the variable is the only reliable answer.
    GRAIL_DIR: grailPath(),
    PYTHON_PACKAGE_PATH: path.join(grailPath(), 'src', 'python'),
    SHIM_LIB_PATH: shimLibraryPath(),
  };
  return env;
}

/** Path to Grail's CPython shim for this platform, staged or not. */
export function shimLibraryPath(): string {
  return path.join(grailPath(), 'src', 'c', 'shim', `libcpython_ua.${sharedLibraryExtension()}`);
}

/**
 * How to run `gslist` against the installed engine, or undefined when there is
 * no engine to ask. Shared by both readers so they cannot disagree about
 * whether the database is up.
 */
function gslistInvocation():
  | { file: string; args: string[]; options: { encoding: 'utf-8'; env: NodeJS.ProcessEnv } }
  | undefined {
  const gs = enginePath();
  if (!gs) return undefined;
  const file = path.join(gs, 'bin', 'gslist');
  if (!fs.existsSync(file)) return undefined;
  return {
    file,
    args: ['-cvl'],
    options: { encoding: 'utf-8', env: { ...process.env, ...engineEnvironment() } },
  };
}

/** Run `gslist -cvl` and return what the engine reports. Never throws. */
export function listProcesses(): EngineProcess[] {
  const gslist = gslistInvocation();
  if (!gslist) return [];
  try {
    return parseGslist(execFileSync(gslist.file, gslist.args, gslist.options));
  } catch {
    // gslist exits non-zero when nothing is running, which is not an error.
    return [];
  }
}

const runGslist = promisify(execFile);

/**
 * Same as {@link listProcesses}, run out of process rather than blocking the
 * caller's event loop — for callers on a path that cannot afford to stall,
 * such as extension activation. Never throws, for the same reason.
 */
export async function listProcessesAsync(): Promise<EngineProcess[]> {
  const gslist = gslistInvocation();
  if (!gslist) return [];
  try {
    const { stdout } = await runGslist(gslist.file, gslist.args, gslist.options);
    return parseGslist(stdout);
  } catch {
    // gslist exits non-zero when nothing is running, which is not an error.
    return [];
  }
}

export function findStone(processes = listProcesses()): EngineProcess | undefined {
  const name = stoneName();
  return processes.find((p) => p.type === 'stone' && p.name === name);
}

export function findNetldi(processes = listProcesses()): EngineProcess | undefined {
  const name = netldiName();
  return processes.find((p) => p.type === 'netldi' && p.name === name);
}

/**
 * True when the database itself is up.
 *
 * Keyed on the stone alone, deliberately, and not on "stone AND listener".
 * The two stop separately, and a stop that the stone refuses leaves exactly
 * that combination: listener down, stone still up and still holding the data.
 * Reading that as "stopped" is the most dangerous thing this readout can do,
 * because it hides the button that would actually stop the database while the
 * database is still running.
 */
export function isRunning(processes = listProcesses()): boolean {
  return findStone(processes) !== undefined;
}

/** Same as {@link isRunning}, built on {@link listProcessesAsync}. */
export async function isRunningAsync(): Promise<boolean> {
  return findStone(await listProcessesAsync()) !== undefined;
}

/** True when the listener is up, so new sessions can connect. */
export function isListening(processes = listProcesses()): boolean {
  return findNetldi(processes) !== undefined;
}

/**
 * True when the stone has finished starting and will take a login.
 *
 * Not the same question as {@link isRunning}. `gslist` lists a stone from the
 * moment it exists, and one recovering from a crash sits at `Startup` for as
 * long as recovery takes; a login in that time fails. So whatever is about to
 * log in waits for `OK`, while the status bar and maintenance, which ask
 * whether there is a stone at all, keep asking that.
 */
export function stoneReady(processes: EngineProcess[]): boolean {
  return findStone(processes)?.responding === true;
}

/** True when the listener is up and answering, the listener's half of {@link stoneReady}. */
export function listenerReady(processes: EngineProcess[]): boolean {
  return findNetldi(processes)?.responding === true;
}

/**
 * What to do about the stone, from its gslist status.
 *
 * The engine prints statuses in mixed case — `OK`, `Startup`, `Shutdown`,
 * `frozen`, `killed`, `exists`, `exe deleted` were all seen — and `gslist -h`
 * also lists `recovery`, `full`, `restoreBkup`, `restoreLogs` and
 * `contRestore`, so they are compared without case. Only a stone that is
 * starting is worth waiting for. One shutting down is said to be, rather than
 * waited on for a minute. Anything else that is listed goes on to the login,
 * which judges it, as it did before GemDB waited for `OK`: a stone left
 * running when the engine tree was replaced reads `exe deleted` and takes
 * logins, and refusing it would stop a working database.
 */
export type StoneState = 'absent' | 'ready' | 'starting' | 'stopping' | 'other';

export function stoneState(processes: EngineProcess[]): StoneState {
  const stone = findStone(processes);
  if (!stone) return 'absent';
  if (stone.responding) return 'ready';
  switch (stone.status.toLowerCase()) {
    case 'startup':
    case 'recovery':
      return 'starting';
    case 'shutdown':
      return 'stopping';
    default:
      return 'other';
  }
}

/** What to say about a stone that is on its way down, wherever it is met. */
export const SHUTTING_DOWN_MESSAGE =
  'The database is shutting down. Start it again once it has stopped.';

/**
 * Wait for a listed stone to finish starting.
 *
 * Returns at once for a stone that is not starting. One this process did not
 * start — a crash being recovered, or one an older GemDB started without
 * waiting — is polled until it is past `Startup`. A stone that disappears
 * while we wait failed to start, and one still starting after a minute is not
 * going to soon; both end in an error naming the stone's log, which says why.
 * A stone at `Shutdown` ends the wait at once: it is being stopped. Returns
 * the last listing, so the caller need not take another.
 */
export async function waitForStoneReady(
  report?: (message: string) => void,
  wait: { pollMs?: number; timeoutMs?: number } = {},
): Promise<EngineProcess[]> {
  const stoneLog = path.join(databaseLogPath(), `${STONE_NAME}.log`);
  const deadline = Date.now() + (wait.timeoutMs ?? STONE_LOCK_TIMEOUT_MS);
  let running = await listProcessesAsync();
  let waiting = false;
  for (;;) {
    switch (stoneState(running)) {
      case 'ready':
      case 'other':
        return running;
      case 'stopping':
        throw new Error(SHUTTING_DOWN_MESSAGE);
      case 'absent':
        throw new Error(`The database stopped while it was starting. See ${stoneLog}.`);
      case 'starting':
        break;
    }
    if (!waiting) {
      waiting = true;
      report?.('Waiting for the database to finish starting…');
      log('The database is still starting; waiting for it.');
    }
    if (Date.now() > deadline) {
      throw new Error(`The database has been starting for over a minute. See ${stoneLog}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, wait.pollMs ?? STONE_LOCK_POLL_MS));
    running = await listProcessesAsync();
  }
}

/**
 * Raised when something asks GemDB to start or stop a database it does not
 * run. See {@link externalDatabase} for why that is refused, not attempted.
 */
export class ExternalDatabaseError extends Error {}

/**
 * The start and stop commands below act on GemDB's own database only — its
 * names, its account, its log directory — so each one checks it is not
 * pointed at someone else's first.
 */
function requireOwnDatabase(action: string): void {
  const external = externalDatabase();
  if (!external) return;
  throw new ExternalDatabaseError(
    `GemDB does not ${action} this database: stone ${external.stone} and NetLDI ` +
      `${external.netldi} are run by the machine's administrator ` +
      '(gemdb.externalDatabase.gemstone is set).',
  );
}

/**
 * What to say when an external database is not up: GemDB does not start it,
 * so the sentence says who does.
 */
export function externalDatabaseDownError(external: {
  stone: string;
  netldi: string;
}): ExternalDatabaseError {
  return new ExternalDatabaseError(
    `The database is not running: GemDB expects stone ${external.stone} and NetLDI ` +
      `${external.netldi}, which this machine's administrator runs. Ask them to start it.`,
  );
}

/**
 * Bring up whichever of the stone and the session listener is not already
 * up, and say which of them this call started.
 *
 * Every start of GemDB's own database goes through here — the window's and
 * the GemDB Shell's (the listener a declined force-stop puts back goes through
 * {@link ensureListener}) — and all of it happens under the stone lock the `gemdb` wrapper also takes. Checking
 * and starting have to be one step: checked outside the lock, two callers
 * that both found the listener missing both ran `startnetldi`, and the loser
 * reported a failure over a database that was up. So the look happens inside
 * the lock, and a caller that queued behind whoever was starting it finds
 * everything up and starts nothing. For the same reason, both coming up while
 * we wait for the lock ends the wait, with nothing started.
 *
 * `beforeStoneStart` runs only when this call is about to start the stone:
 * the guards that refuse a stone that should not start belong there, not on
 * every call. `report` hears each step as it begins, for a progress
 * notification or a terminal.
 */
export async function ensureProcesses(
  opts: { beforeStoneStart?: () => void; report?: (message: string) => void } = {},
): Promise<{ startedStone: boolean; startedNetldi: boolean }> {
  requireOwnDatabase('start');
  // Every notebook cell lands here, and nearly always both are up: one
  // listing and no lock then. Never for a stone starting or stopping, which
  // the lock and the wait below are for.
  const before = await listProcessesAsync();
  const stoneUp = ['ready', 'other'].includes(stoneState(before));
  if (stoneUp && findNetldi(before)) {
    log('The database is already running.');
    log('The session listener is already running.');
    return { startedStone: false, startedNetldi: false };
  }
  let seen = before;
  const started = await withStoneLock(
    async () => {
      let startedStone = false;
      // Listed again: what was true before the lock may not be now.
      const state = stoneState(await listProcessesAsync());
      // Said here, before any wait: a stopping stone's last moments read
      // `Startup` before it disappears (measured), which a wait would report
      // as a start that failed.
      if (state === 'stopping') throw new Error(SHUTTING_DOWN_MESSAGE);
      if (state === 'absent') {
        opts.beforeStoneStart?.();
        opts.report?.('Starting the database…');
        logStep('Starting the database');
        await runStartstone();
        startedStone = true;
      } else {
        log('The database is already running.');
      }
      // The wait's last listing is recent enough to judge the listener by:
      // it was taken after the stone, ours or not, finished starting.
      const running = await waitForStoneReady(opts.report);

      let startedNetldi = false;
      if (!findNetldi(running)) {
        opts.report?.('Starting the session listener…');
        startedNetldi = await startNetldi();
      } else {
        log('The session listener is already running.');
      }
      return { startedStone, startedNetldi };
    },
    {
      satisfied: async () => {
        seen = await listProcessesAsync();
        return stoneReady(seen) && listenerReady(seen);
      },
      // A stone listed and not going down means whoever holds the lock is past
      // startstone: waiting on it, or starting the listener beside it.
      progressing: () => ['starting', 'ready', 'other'].includes(stoneState(seen)),
    },
  );
  return started ?? { startedStone: false, startedNetldi: false };
}

/**
 * Put the session listener back, and never the stone: what a declined
 * force-stop needs. By the time the user has answered, the stone may have gone
 * after all, or be on its way down, and starting one then would undo a stop
 * without the guards a start runs. True when this call started the listener.
 * Under the stone lock, like every other start.
 */
export async function ensureListener(): Promise<boolean> {
  requireOwnDatabase('start');
  const started = await withStoneLock(
    async () => {
      const running = await listProcessesAsync();
      const state = stoneState(running);
      if (state === 'absent' || state === 'stopping') {
        log('The database is not running; not starting the session listener.');
        return false;
      }
      if (findNetldi(running)) return false;
      return startNetldi();
    },
    { satisfied: async () => findNetldi(await listProcessesAsync()) !== undefined },
  );
  return started ?? false;
}

/**
 * Run `startstone`, turning the two refusals the stone explains only in its
 * log into errors that say what to do. The caller holds the stone lock.
 */
async function runStartstone(): Promise<void> {
  const env = engineEnvironment();
  const stoneLog = path.join(databaseLogPath(), `${STONE_NAME}.log`);
  const logSizeBefore = fileSize(stoneLog);
  try {
    await runEngineCommand(
      path.join(env.GEMSTONE, 'bin', 'startstone'),
      ['-l', stoneLog, STONE_NAME],
      env,
      'Start database',
    );
  } catch (e) {
    if (refusedNfs(e, stoneLog, logSizeBefore)) throw databaseOnNfsError();
    if (stoneLogSays(/No space left on device/, e, stoneLog, logSizeBefore)) {
      throw new DiskSpaceError(
        'The GemDB database could not start: the disk ran out of space while it reserved ' +
          'its extent. Free some disk space, or set gemdb.rootPath to a folder on a disk ' +
          'with more room, then start GemDB again.',
      );
    }
    throw e;
  }
}

/**
 * Whether the stone refused to start because its files are on NFS.
 *
 * The backstop for `assertDatabaseIsLocal`, which errs towards local when it
 * cannot tell (#69). The phrase is the 4.0.0.a4 stone's — "Extents may not be
 * on file systems that are NFS-mounted on stone's machine" — and it lands in
 * the stone's log, which is read as well as `startstone`'s own output in case
 * it is not repeated there. Only what this attempt added to the log counts, so
 * a refusal from before the root path moved cannot be blamed for a new failure.
 */
export function refusedNfs(e: unknown, stoneLog: string, logSizeBefore: number): boolean {
  return stoneLogSays(/NFS-mounted/, e, stoneLog, logSizeBefore);
}

/**
 * Whether this start attempt's error, or what it added to the stone's log,
 * matches `pattern`. Also how a pregrow the disk cannot hold is recognised:
 * the stone logs "failed with No space left on device" and "Stone startup
 * has failed" (measured).
 */
export function stoneLogSays(
  pattern: RegExp,
  e: unknown,
  stoneLog: string,
  logSizeBefore: number,
): boolean {
  const said = (text: string): boolean => pattern.test(text);
  if (e instanceof Error && said(e.message)) return true;
  try {
    const bytes = fs.readFileSync(stoneLog);
    // A log shorter than before was started afresh, and all of it is new.
    const fresh = bytes.length >= logSizeBefore ? bytes.subarray(logSizeBefore) : bytes;
    return said(fresh.toString('utf8'));
  } catch {
    return false;
  }
}

function fileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * Start the session listener. True when this call started it; false when
 * `startnetldi` refused because another process had started it first.
 *
 * Not exported: the listener starts only through {@link ensureProcesses} or
 * {@link ensureListener}, under the stone lock.
 *
 * That race is not rare (#89): the window's start, the GemDB Shell's, and
 * releases before this one, which start the listener without any lock, can
 * all find it missing and start it together. The loser's `startnetldi` fails
 * — exit 1, "Server 'gemdbldi' is already running", when the winner is fully
 * up; exit 3, "could not start server" over the winner's lock file, when the
 * two overlap — and everything the caller wanted is true, so a listener that
 * is up and answering afterwards is not a failure. One that is not still fails with startnetldi's own words. The lock
 * closes the race between GemDB's own callers; this covers what takes no lock.
 */
async function startNetldi(): Promise<boolean> {
  logStep('Starting the session listener');
  const env = engineEnvironment();
  try {
    await runEngineCommand(
      path.join(env.GEMSTONE, 'bin', 'startnetldi'),
      // -a restricts logins to this user, -g runs sessions as that user without
      // needing a host password. Together they are what lets GemDB log in with
      // no operating-system credentials at all.
      [
        '-a',
        os.userInfo().username,
        '-g',
        '-l',
        path.join(databaseLogPath(), `${NETLDI_NAME}.log`),
        NETLDI_NAME,
      ],
      env,
      'Start session listener',
    );
    return true;
  } catch (e) {
    if (!listenerReady(await listProcessesAsync())) throw e;
    log('Another process started the session listener.');
    return false;
  }
}

/**
 * Arguments for `stopstone`, with or without the override.
 *
 * `stopstone [-h] [-i] [-t timeout] [name [account [password]]]`, where `-i` is
 * "stop the stone immediately even if others are logged in". It has to come
 * before the stone name — after it, it is read as the account.
 *
 * Without `-i`, stopstone refuses while any session holds a login, and that is
 * the ordinary case rather than the exception: an open GemDB Shell terminal is
 * a logged-in session, and so is a notebook that has run a cell.
 */
export function stopStoneArgs(force: boolean): string[] {
  const flags = force ? ['-i'] : [];
  return [...flags, '-t', String(STOP_TIMEOUT_SECONDS), STONE_NAME, ADMIN_USER, ADMIN_PASSWORD];
}

export async function stopStone(force = false): Promise<void> {
  requireOwnDatabase('stop');
  logStep(force ? 'Stopping the database, disconnecting other sessions' : 'Stopping the database');
  const env = engineEnvironment();
  await runEngineCommand(
    path.join(env.GEMSTONE, 'bin', 'stopstone'),
    stopStoneArgs(force),
    env,
    'Stop database',
  );
}

export async function stopNetldi(): Promise<void> {
  requireOwnDatabase('stop');
  const env = engineEnvironment();
  await runEngineCommand(
    path.join(env.GEMSTONE, 'bin', 'stopnetldi'),
    [NETLDI_NAME],
    env,
    'Stop session listener',
  );
}

/**
 * Run an engine binary, streaming its output to the GemDB log, and reject on a
 * non-zero exit with that output attached — these commands explain themselves
 * on stdout, so the text is worth more than the exit code.
 */
function runEngineCommand(
  command: string,
  args: string[],
  env: Record<string, string>,
  label: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    log(`$ ${path.basename(command)} ${args.join(' ')}`);
    const child = spawn(command, args, { env: { ...process.env, ...env } });
    let output = '';

    const collect = (data: Buffer): void => {
      const text = data.toString();
      output += text;
      log(text.trimEnd());
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);

    child.on('close', (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`${label} failed (exit code ${code}).\n${output.trim()}`));
    });
    child.on('error', (err) => reject(new Error(`${label} failed: ${err.message}`)));
  });
}
