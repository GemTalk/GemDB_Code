import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { __setSetting } from '../__mocks__/vscode';
import { adminAccount, mcpPort } from '../config';
import { stageGrail } from '../grail';
import {
  bundledMcpStamp,
  installMcp,
  isPortOpen,
  mcpServerState,
  readRouterState,
  recordMcpInstalled,
  stageMcp,
  startMcpServer,
  stopMcpServer,
} from '../mcp';
import { installedMcpStamp, mcpInstalled, mcpRouterStatePath, mcpStagedOnDisk } from '../paths';
import { isRunning, startNetldi, startStone, stopNetldi, stopStone } from '../processes';
import { GciSession, execute, logoutAll } from '../session';
import { createDatabaseWithPython, Fixture, haveTestExtent, makeFixture } from './fixture';

/**
 * The MCP server, filed into a real database and answering real requests.
 *
 * Nothing cheaper than this proves the thing that matters. The payload is
 * Smalltalk file-outs, so a broken one compiles nothing and the router simply
 * is not there; the toolset that makes the server worth having is optional
 * upstream and reaches the tool surface only if GemDB passed `--grail`; and
 * the claim `stopMcpServer` rests on — that killing the router takes its
 * per-client worker gems down with it — is a claim about the engine's RPC
 * semantics that no unit test can check.
 *
 * Built on the suite's prepared extent rather than a Grail file-in, so it costs
 * seconds rather than minutes: the point of that extent is a database
 * that already has Python in it.
 */

const ext = process.cwd();

// Both are build artifacts, gitignored, absent from a fresh checkout:
// `npm run bundle:mcp` and `npm run test:extent`. CI asserts both are
// present rather than trusting a green run — see the workflow's "Confirm the
// suite has something to run against" step.
const havePayload = bundledMcpStamp(ext) !== undefined;
const haveExtent = haveTestExtent();

let fixture: Fixture | undefined;

/** A port nothing on this machine is listening on, as of the moment it is asked. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

beforeAll(async () => {
  if (!havePayload || !haveExtent) return;
  fixture = makeFixture();
  if (!fixture) return;
  // The root path and lock directory already keep this database apart from a
  // developer's real one; the port is the last thing they would share. On the
  // default, a GemDB with MCP on holds it, this router cannot bind, and every
  // request reaches theirs instead.
  __setSetting('gemdb.mcp.port', await freePort());
  createDatabaseWithPython(fixture);
  // Grail's files on disk, because the router's worker gems inherit the
  // NetLDI's environment and resolve Python modules through GRAIL_DIR.
  stageGrail(ext);
  await startStone();
  await startNetldi();
});

afterAll(async () => {
  if (!fixture) return;
  // The router first, and not only for tidiness: it is a logged-in session, so
  // an unforced stopstone would refuse over it. Which is exactly why runStop
  // does this in the same order.
  await stopMcpServer();
  logoutAll();
  try {
    await stopNetldi();
  } finally {
    if (isRunning()) await stopStone(true);
    fixture.remove();
  }
});

interface McpReply {
  status: number;
  sessionId?: string;
  body: Record<string, unknown>;
  raw: string;
}

/**
 * One JSON-RPC request over the Streamable HTTP transport.
 *
 * Written out by hand rather than pulled from an SDK: what is under test is
 * the wire behaviour, and a client library that papers over a missing header
 * or a 403 would hide the very things asserted below.
 */
function mcpRequest(
  method: string,
  params: Record<string, unknown> = {},
  options: { sessionId?: string; origin?: string; id?: number } = {},
): Promise<McpReply> {
  const payload = JSON.stringify({
    jsonrpc: '2.0',
    id: options.id ?? 1,
    method,
    params,
  });
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(payload)),
  };
  if (options.sessionId) headers['MCP-Session-Id'] = options.sessionId;
  if (options.origin) headers.Origin = options.origin;

  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port: mcpPort(), path: '/mcp', method: 'POST', headers },
      (response) => {
        let raw = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => (raw += chunk));
        response.on('end', () => {
          let body: Record<string, unknown> = {};
          try {
            body = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            /* a 403 or 400 need not carry JSON */
          }
          resolve({
            status: response.statusCode ?? 0,
            sessionId: response.headers['mcp-session-id'] as string | undefined,
            body,
            raw,
          });
        });
      },
    );
    request.setTimeout(30_000, () => request.destroy(new Error('MCP request timed out')));
    request.on('error', reject);
    request.end(payload);
  });
}

/**
 * The serials of the router's gems: its own session (slot 2, the gem's pid, is
 * the router) and every worker it opened (slot 21, the RPC client's pid, is
 * the router). A serial, unlike a session id, is never handed out again, so
 * these name the same gems for good. Counting sessions instead raced CI: a
 * count taken just after a stop still included the previous router's gems on
 * their way out, and a freed session id can go to a newcomer at once.
 *
 * `descriptionOfSession:` answers zeros for a session that has gone between
 * `currentSessions` and the lookup, hence the slot 10 check.
 */
function routerGems(routerPid: number): number[] {
  const rows = asAdmin(
    [
      '| ws |',
      'ws := WriteStream on: String new.',
      'System currentSessions do: [:id | | d |',
      '  d := System descriptionOfSession: id.',
      `  ((d at: 10) ~= 0 and: [(d at: 2) = ${routerPid} or: [(d at: 21) = ${routerPid}]])`,
      '    ifTrue: [ws print: (d at: 9); space]].',
      'ws contents',
    ].join('\n'),
  );
  return rows.split(/\s+/).filter(Boolean).map(Number);
}

/**
 * Smalltalk as DataCurator, for looking at other sessions: the gemdb account
 * GemDB's sessions use may not describe them, which is the point of it.
 */
function asAdmin(code: string): string {
  const session = GciSession.login(
    { key: 'it-admin', kind: 'extension', label: 'it admin' },
    adminAccount(),
  );
  try {
    return session.execute(code);
  } finally {
    session.logout();
  }
}

/** Which of these serials still belong to a logged-in session. */
function stillLoggedIn(serials: number[]): number[] {
  if (serials.length === 0) return [];
  const rows = asAdmin(
    [
      '| ws |',
      'ws := WriteStream on: String new.',
      `#(${serials.join(' ')}) do: [:serial |`,
      '  ((System descriptionOfSessionSerialNum: serial) at: 10) = 0',
      '    ifFalse: [ws print: serial; space]].',
      'ws contents',
    ].join('\n'),
  );
  return rows.split(/\s+/).filter(Boolean).map(Number);
}

/**
 * Wait for gems to exit, which they do asynchronously once their client has
 * gone. Measured at well under a second; ten is headroom for a loaded runner.
 */
async function waitUntilGone(serials: number[]): Promise<number[]> {
  let left = stillLoggedIn(serials);
  for (let attempt = 0; attempt < 40 && left.length > 0; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    left = stillLoggedIn(serials);
  }
  return left;
}

function routerPid(): number {
  const pid = readRouterState()?.pid;
  expect(pid).toBeGreaterThan(0);
  return pid!;
}

function canMakeFixture(): boolean {
  const probe = makeFixture();
  probe?.remove();
  return probe !== undefined;
}

describe.skipIf(!havePayload || !haveExtent || !canMakeFixture())(
  'the MCP server in a real database',
  () => {
    let clientSession: string | undefined;

    it('stages the payload out of the extension without claiming it is installed', () => {
      stageMcp(ext);
      expect(mcpStagedOnDisk()).toBe(true);
      // Staged is not installed, exactly as with Grail: the stamp means the
      // classes are in the database, and nothing has put them there yet.
      expect(mcpInstalled()).toBe(false);
    });

    it('files the Mcp classes into the database', async () => {
      await installMcp(ext);
      recordMcpInstalled(ext);
      expect(mcpInstalled()).toBe(true);
      // Recorded with the GemDB that filed it in, as Grail's is.
      expect(installedMcpStamp()).toMatch(/^extension=\d+\.\d+\.\d+/m);
      // The installer asks the image what it has rather than trusting topaz's
      // exit code, but assert it here too — a file-in reports its compile
      // errors and carries on.
      expect(execute('(System myUserProfile objectNamed: #McpRouter) name')).toContain('McpRouter');
    }, 300_000);

    it('forks a detached router that owns the port', async () => {
      expect(await startMcpServer()).toBe(true);
      expect(await isPortOpen(mcpPort())).toBe(true);

      // The pid and serial are what `stopMcpServer` names instead of hunting
      // for whatever holds the port, so a fork that recorded neither is a fork
      // GemDB cannot stop cleanly. The serial is read, not reported, so check
      // it is the router's: the session it names is the recorded id.
      const state = readRouterState();
      expect(state?.port).toBe(mcpPort());
      expect(state?.pid).toBeGreaterThan(0);
      expect(state?.sessionId).toBeGreaterThan(0);
      expect(state?.serial).toBeGreaterThan(0);
      expect(
        asAdmin(`((System descriptionOfSessionSerialNum: ${state?.serial}) at: 10) printString`),
      ).toBe(String(state?.sessionId));

      // And GemDB knows it is its own, which is what keeps it from killing a
      // stranger's process on the way down.
      expect(await mcpServerState()).toMatchObject({ running: true, foreign: false });
    }, 120_000);

    it('answers initialize with a session id and says it is GemDB', async () => {
      const reply = await mcpRequest('initialize');
      expect(reply.status, reply.raw).toBe(200);
      expect(reply.sessionId, reply.raw).toBeTruthy();
      clientSession = reply.sessionId;

      const result = reply.body.result as Record<string, unknown>;
      const info = result.serverInfo as Record<string, string>;
      // The title is what a client displays to tell one server from another,
      // and GemDB sets it when it forks the router. Without it an agent's
      // server list says only what software this is, not whose database.
      expect(info.title).toContain('GemDB');
      expect(result.protocolVersion).toBeTruthy();
    });

    it('offers the Python tools, which only arrive with --grail', async () => {
      const reply = await mcpRequest('tools/list', {}, { sessionId: clientSession, id: 2 });
      expect(reply.status, reply.raw).toBe(200);
      const tools = (reply.body.result as { tools: { name: string }[] }).tools;
      const names = tools.map((tool) => tool.name);

      // The assertion that earns this test's existence. The Grail toolset is
      // opt-in upstream — it joins the default tool surface only when its file
      // is loaded — so a GemDB that forgot `--grail` would install cleanly and
      // hand an agent a server that can browse Smalltalk and not run Python.
      expect(names).toContain('eval_python');
      expect(names).toContain('compile_python');
    });

    it('runs Python in the database through a tool call', async () => {
      const reply = await mcpRequest(
        'tools/call',
        { name: 'eval_python', arguments: { code: '6 * 7' } },
        { sessionId: clientSession, id: 3 },
      );
      expect(reply.status, reply.raw).toBe(200);
      // Whatever shape the content takes, the answer has to be in it: this is
      // an agent evaluating Python against the database GemDB installed.
      expect(reply.raw).toContain('42');
    }, 120_000);

    // Why auto-starting this is defensible at all. The router binds loopback
    // and has no setter for the bind address, and it validates Origin against
    // a loopback allowlist so a page in the user's browser cannot reach it by
    // DNS rebinding. If either ever stops holding, a port opened on every
    // developer's machine becomes a very different proposition.
    it('refuses a request whose Origin is not loopback', async () => {
      const reply = await mcpRequest(
        'tools/list',
        {},
        { sessionId: clientSession, origin: 'http://evil.example', id: 4 },
      );
      expect(reply.status).toBe(403);
    });

    it('gives each client its own session, and takes it back with the router', async () => {
      const pid = routerPid();
      expect(routerGems(pid)).toHaveLength(2); // the router and the first client's worker

      // A connected client is a worker gem of its own — the isolation that
      // keeps two agents out of each other's uncommitted work, and the reason
      // the status view says the MCP server spends sessions.
      const second = await mcpRequest('initialize', {}, { id: 5 });
      expect(second.sessionId).toBeTruthy();
      expect(second.sessionId).not.toBe(clientSession);
      const gems = routerGems(pid);
      expect(gems).toHaveLength(3);

      // And the claim stopMcpServer rests on: a worker gem's client process IS
      // the router — measured, 2026-09-07, `System descriptionOfSession:` slot
      // 21 of each worker is the router's own pid — so ending the router ends
      // them too. Nothing else would: the idle reaper is a GsProcess inside
      // the router, so it dies with it. If this were wrong, every "Stop GemDB"
      // after an agent had connected would be refused by stopstone over gems
      // nothing could name, and each connected client would cost a session of
      // the ten until the stone was force-stopped.
      await stopMcpServer();
      expect(await isPortOpen(mcpPort())).toBe(false);
      expect(readRouterState()).toBeUndefined();
      expect(await waitUntilGone(gems)).toEqual([]);
    }, 180_000);

    it('starts again after being stopped', async () => {
      expect(await startMcpServer()).toBe(true);
      const reply = await mcpRequest('initialize', {}, { id: 6 });
      expect(reply.status, reply.raw).toBe(200);
    }, 120_000);

    // What a change of external database settings leaves GemDB with: a
    // recorded session id from the previous database, which must not be sent
    // to this one. The signal alone has to end the router and its workers.
    it('stops by signal alone, without ending its session from inside', async () => {
      await stopMcpServer();
      expect(await startMcpServer()).toBe(true);
      const reply = await mcpRequest('initialize', {}, { id: 10 });
      expect(reply.status, reply.raw).toBe(200);
      const gems = routerGems(routerPid());
      expect(gems).toHaveLength(2); // the router and this client's worker

      await stopMcpServer({ bySession: false });
      expect(await isPortOpen(mcpPort())).toBe(false);
      expect(readRouterState()).toBeUndefined();
      expect(await waitUntilGone(gems)).toEqual([]);
    }, 180_000);

    // `gemdb.mcp.readOnly` promises something specific, and the way it could
    // fail is the way a user cannot check: a router that forked read-WRITE
    // while the setting said read-only answers every tool call exactly as it
    // did before. So this asserts the boundary from the far side — through the
    // server, as an agent meets it — rather than asserting that GemDB sent the
    // right Smalltalk.
    //
    // Measured by hand first, on 2026-09-13: the worker's own
    // `System myUserProfile userId` is `McpReadOnly`, and `System commit`
    // answers TransactionError 2249, "Further commits have been disabled for
    // this session because: 'This UserProfile is read-only and may not
    // commit.'" Both halves matter — the identity is what GemDB configures,
    // and the refusal is what it is FOR.
    // A record outlives a router that went some other way, and the stone
    // gives its session id to the next login. This test's own session stands
    // in for that newcomer: the record names it, and the stop must leave it
    // alone and end the router by signal instead. Once with a serial, and once
    // as a record from before GemDB kept one, which is looked up by id.
    it.each([
      ['as the router left it', true],
      ['as a GemDB from before serials left it', false],
    ])(
      'leaves alone a session that has taken the router’s place, with the record %s',
      async (_how, withSerial) => {
        expect(await startMcpServer()).toBe(true);
        const state = readRouterState()!;
        const gems = routerGems(routerPid());
        expect(gems).toHaveLength(1); // the router, with no client yet

        const mine = Number(execute('System session printString'));
        const mySerial = Number(
          execute('((System descriptionOfSession: System session) at: 9) printString'),
        );
        fs.writeFileSync(
          mcpRouterStatePath(),
          JSON.stringify({
            ...state,
            sessionId: mine,
            serial: withSerial ? mySerial : undefined,
          }),
        );

        await stopMcpServer();
        expect(await isPortOpen(mcpPort())).toBe(false);
        expect(readRouterState()).toBeUndefined();
        expect(await waitUntilGone(gems)).toEqual([]);
        // Still logged in, and still the same session: had the stop sent it
        // stopSession:, the next execute would have failed or logged in anew.
        expect(execute('System session printString')).toBe(String(mine));
        expect(execute('((System descriptionOfSession: System session) at: 9) printString')).toBe(
          String(mySerial),
        );
      },
      180_000,
    );

    it('runs agent sessions as a user that cannot commit when read-only is on', async () => {
      __setSetting('gemdb.mcp.readOnly', true);
      try {
        await stopMcpServer();
        // Provisions McpReadOnly on the way through, the first time.
        expect(await startMcpServer()).toBe(true);

        const opened = await mcpRequest('initialize', {}, { id: 7 });
        expect(opened.status, opened.raw).toBe(200);
        const session = opened.sessionId;

        const whoami = await mcpRequest(
          'tools/call',
          { name: 'execute_code', arguments: { code: 'System myUserProfile userId' } },
          { sessionId: session, id: 8 },
        );
        expect(whoami.raw).toContain('McpReadOnly');

        const commit = await mcpRequest(
          'tools/call',
          { name: 'execute_code', arguments: { code: 'System commit' } },
          { sessionId: session, id: 9 },
        );
        expect(commit.raw).toMatch(/read-only and may not commit/i);
      } finally {
        __setSetting('gemdb.mcp.readOnly', false);
        await stopMcpServer();
      }
    }, 180_000);
  },
);
