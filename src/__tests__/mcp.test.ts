import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __setSetting } from '../__mocks__/vscode';
import { DEFAULT_MCP_PORT, mcpEnabled, mcpPort, mcpReadOnly } from '../config';
import {
  bundledMcpStamp,
  ensureMcpInstalled,
  isPortOpen,
  listeningPid,
  mcpLabel,
  mcpNeedsUpdate,
  mcpServerState,
  mcpUrl,
  readRouterState,
  recordMcpInstalled,
  stageMcp,
} from '../mcp';
import {
  databasePath,
  installedMcpStamp,
  legacyMcpStampPath,
  mcpInstalled,
  mcpPath,
  mcpRouterStatePath,
  mcpStagedByPath,
  mcpStagedOnDisk,
  mcpStampPath,
} from '../paths';
import { clientRecipesFor } from '../mcpRegistration';

const hasLsof = (() => {
  try {
    execFileSync('lsof', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/**
 * The MCP server's decisions, without a database.
 *
 * What is worth defending here is the same shape as Grail's: whether the
 * payload on disk is the one the database has, and what happens on the paths
 * where the answer is "not ours". Forking a gem and filing classes in belong to
 * the integration suite; everything below runs in milliseconds and needs no
 * engine.
 */

let root: string;
let ext: string;

const BUNDLED = 'mcp=0.5.0-3-g89246e1\ncommit=89246e1\n';
/** What this GemDB records once BUNDLED is filed in. */
const RECORDED = `${BUNDLED}extension=1.6.0`;
const NEWER = 'mcp=0.6.0-1-gnewer\nextension=1.7.0';

/** A stand-in extension directory carrying an MCP payload. */
function makeExtensionDir(stamp: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdb-mcp-ext-'));
  fs.mkdirSync(path.join(dir, 'mcp', 'src', 'core'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'mcp', 'MCP_VERSION'), stamp);
  fs.writeFileSync(path.join(dir, 'mcp', 'src', 'core', 'McpServer.gs'), '! staged\n');
  fs.writeFileSync(path.join(dir, 'mcp', 'install.sh'), '#!/bin/bash\nexit 0\n');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '1.6.0' }));
  return dir;
}

beforeEach(() => {
  root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gemdb-mcp-run-')), 'GemDB');
  ext = makeExtensionDir(BUNDLED);
  __setSetting('gemdb.rootPath', root);
  __setSetting('gemdb.mcp.port', undefined);
  __setSetting('gemdb.mcp.enabled', undefined);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(ext, { recursive: true, force: true });
});

describe('the payload stamp', () => {
  it('reads the build the extension ships', () => {
    expect(bundledMcpStamp(ext)).toBe(BUNDLED.trim());
    expect(mcpLabel(bundledMcpStamp(ext))).toBe('0.5.0-3-g89246e1');
  });

  it('calls a build with no payload unknown rather than throwing', () => {
    expect(bundledMcpStamp(path.join(ext, 'nowhere'))).toBeUndefined();
    expect(mcpLabel(undefined)).toBe('unknown');
  });

  // The whole point of the stamp: the classes are in the database, and the
  // files on disk are only evidence of what was staged. Nothing is installed
  // until a file-in succeeded, so a staged-but-never-installed payload has to
  // read as needing an install.
  it('needs an install when nothing has been filed in', () => {
    expect(mcpNeedsUpdate(ext)).toBe(true);
    stageMcp(ext);
    expect(mcpStagedOnDisk()).toBe(true);
    expect(mcpNeedsUpdate(ext)).toBe(true);
  });

  it('is satisfied once the staged payload is recorded as installed', () => {
    stageMcp(ext);
    recordMcpInstalled(ext);
    expect(installedMcpStamp()).toBe(RECORDED);
    expect(mcpNeedsUpdate(ext)).toBe(false);
  });

  it('needs an install again when the extension ships a newer payload', () => {
    stageMcp(ext);
    recordMcpInstalled(ext);
    fs.writeFileSync(path.join(ext, 'mcp', 'MCP_VERSION'), 'mcp=0.6.0\ncommit=def\n');
    expect(mcpNeedsUpdate(ext)).toBe(true);
  });

  // A build that never ran `bundle:mcp` must not report an update it cannot
  // perform — that would put the extension in a loop of trying to install
  // nothing on every start.
  it('reports no update when the build ships no payload at all', () => {
    fs.rmSync(path.join(ext, 'mcp'), { recursive: true, force: true });
    expect(mcpNeedsUpdate(ext)).toBe(false);
  });
});

describe('staging', () => {
  it('creates the root path it is given, rather than requiring one', () => {
    expect(fs.existsSync(root)).toBe(false);
    stageMcp(ext);
    expect(fs.existsSync(path.join(mcpPath(), 'src', 'core', 'McpServer.gs'))).toBe(true);
  });

  // Staging replaces the directory wholesale. The stamp lives beside the
  // database, so a restage no longer forgets what the database holds.
  it('replaces a previous payload, and keeps the record of what is filed in', () => {
    stageMcp(ext);
    recordMcpInstalled(ext);
    fs.writeFileSync(path.join(mcpPath(), 'leftover.gs'), '! from the last version\n');

    stageMcp(ext);

    expect(fs.existsSync(path.join(mcpPath(), 'leftover.gs'))).toBe(false);
    expect(installedMcpStamp()).toBe(RECORDED);
  });

  it('records which GemDB staged it, in the stamp format', () => {
    stageMcp(ext);

    expect(fs.readFileSync(mcpStagedByPath(), 'utf8')).toBe(`${RECORDED}\n`);
  });

  it('refuses a build with no payload, naming the script that makes one', () => {
    fs.rmSync(path.join(ext, 'mcp'), { recursive: true, force: true });
    expect(() => stageMcp(ext)).toThrow(/bundle:mcp/);
  });

  it('leaves the router record alone, since a running router outlives a restage', () => {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(
      mcpRouterStatePath(),
      JSON.stringify({ port: 50390, pid: 4242, sessionId: 7, startedAt: 'now' }),
    );
    stageMcp(ext);
    expect(readRouterState()?.pid).toBe(4242);
  });
});

describe('the record of which MCP build is filed in', () => {
  /** Write a stamp, dated `ageSeconds` ago so the two locations can be ordered. */
  function writeStamp(file: string, text: string, ageSeconds: number): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${text}\n`);
    const when = new Date(Date.now() - ageSeconds * 1000);
    fs.utimesSync(file, when, when);
  }

  it('lives beside the database, which it creates for an external database', () => {
    recordMcpInstalled(ext);

    expect(path.dirname(mcpStampPath())).toBe(databasePath());
    expect(installedMcpStamp()).toBe(RECORDED);
  });

  it('still counts as filed in when only an older GemDB has recorded it', () => {
    writeStamp(legacyMcpStampPath(), BUNDLED.trim(), 0);

    expect(mcpInstalled()).toBe(true);
    expect(installedMcpStamp()).toBe(BUNDLED.trim());
  });

  it('needs an install when an older GemDB has filed its build in since', () => {
    writeStamp(mcpStampPath(), RECORDED, 60);
    writeStamp(legacyMcpStampPath(), 'mcp=0.4.0', 0);

    expect(mcpNeedsUpdate(ext)).toBe(true);
  });

  it('ignores an old-location stamp written before the current one', () => {
    writeStamp(legacyMcpStampPath(), 'mcp=0.4.0', 60);
    writeStamp(mcpStampPath(), RECORDED, 0);

    expect(mcpNeedsUpdate(ext)).toBe(false);
  });

  it('leaves a build a newer GemDB filed in where it is', () => {
    writeStamp(mcpStampPath(), NEWER, 0);

    expect(mcpNeedsUpdate(ext)).toBe(false);
  });
});

describe('staging beside a newer GemDB', () => {
  beforeEach(() => {
    fs.mkdirSync(mcpPath(), { recursive: true });
    fs.writeFileSync(path.join(mcpPath(), 'newer-only.gs'), '! newer\n');
  });

  it('leaves alone a payload a newer GemDB staged', () => {
    fs.writeFileSync(mcpStagedByPath(), `${NEWER}\n`);

    expect(stageMcp(ext)).toBe(false);

    expect(fs.existsSync(path.join(mcpPath(), 'newer-only.gs'))).toBe(true);
  });

  it('leaves alone the files when a newer GemDB filed its build in', () => {
    fs.mkdirSync(databasePath(), { recursive: true });
    fs.writeFileSync(mcpStampPath(), `${NEWER}\n`);

    expect(stageMcp(ext)).toBe(false);

    expect(fs.existsSync(path.join(mcpPath(), 'newer-only.gs'))).toBe(true);
  });

  it('files nothing in over a payload a newer GemDB staged', async () => {
    // The database holds an older build, so it needs an install; the staged
    // copy is a newer GemDB's, about to be filed in by it.
    fs.writeFileSync(mcpStagedByPath(), `${NEWER}\n`);
    fs.mkdirSync(databasePath(), { recursive: true });
    fs.writeFileSync(mcpStampPath(), 'mcp=0.4.0\nextension=1.5.4\n');

    await ensureMcpInstalled(ext);

    expect(installedMcpStamp()).toBe('mcp=0.4.0\nextension=1.5.4');
    expect(fs.existsSync(path.join(mcpPath(), 'newer-only.gs'))).toBe(true);
  });
});

describe('a staged copy that has gone missing', () => {
  it('is put back without filing anything in again', async () => {
    // Uninstall with "Keep my database" removes mcp/ and keeps the stamp.
    recordMcpInstalled(ext);

    await ensureMcpInstalled(ext);

    expect(mcpStagedOnDisk()).toBe(true);
    expect(installedMcpStamp()).toBe(RECORDED);
  });
});

describe('the defaults', () => {
  // Off by default is not caution, it is a retreat from a measured failure:
  // a client that reconnects repeatedly leaks a worker gem each time and can
  // exhaust the ten sessions the Community Edition allows, locking the user
  // out of their own database with error 4039 until the router's 30-minute
  // reaper catches up. Pinned here so turning it back on is a deliberate act
  // with a failing test to explain itself, not a quiet edit — the fix is a
  // worker cap in the router. See docs/mcp-server.md.
  it('does not run the MCP server unless it is asked to', () => {
    expect(mcpEnabled()).toBe(false);
  });

  it('is enabled by the setting, not by anything else', () => {
    __setSetting('gemdb.mcp.enabled', true);
    expect(mcpEnabled()).toBe(true);
  });

  // Read-write when it does run: an agent that cannot run Python in the
  // database is most of the value gone.
  it('is read-write when it runs', () => {
    expect(mcpReadOnly()).toBe(false);
  });
});

describe('the port', () => {
  it('defaults to one no other development server takes', () => {
    expect(mcpPort()).toBe(DEFAULT_MCP_PORT);
    expect(DEFAULT_MCP_PORT).not.toBe(8000);
    expect(mcpUrl()).toBe(`http://127.0.0.1:${DEFAULT_MCP_PORT}/mcp`);
  });

  it('takes a port the user set', () => {
    __setSetting('gemdb.mcp.port', 8123);
    expect(mcpPort()).toBe(8123);
    expect(mcpUrl()).toBe('http://127.0.0.1:8123/mcp');
  });

  // A setting is whatever ended up in settings.json. Falling back beats
  // forking a router that cannot bind and reports it in a gem log.
  it.each([0, -1, 99999, 1.5])('falls back rather than accept %s', (bad) => {
    __setSetting('gemdb.mcp.port', bad);
    expect(mcpPort()).toBe(DEFAULT_MCP_PORT);
  });
});

describe('what is on the port', () => {
  it('reports nothing running when the port is closed', async () => {
    __setSetting('gemdb.mcp.port', 54999);
    await expect(isPortOpen(54999)).resolves.toBe(false);
    expect(await mcpServerState(54999)).toEqual({
      running: false,
      port: 54999,
      foreign: false,
    });
  });

  // The distinction GemDB acts on in both directions: it will not fork over
  // another program's port, and it will not kill a process it did not start.
  it('calls a listener it has no record of foreign', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    try {
      await expect(isPortOpen(port)).resolves.toBe(true);
      expect(await mcpServerState(port)).toEqual({ running: true, port, foreign: true });
    } finally {
      server.close();
    }
  });

  // A stale record — the router's gem is long gone, something else took the
  // port — must not make GemDB claim that listener as its own.
  it('does not claim a listener on the strength of a dead pid', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(
      mcpRouterStatePath(),
      // A pid no process can have, so the liveness check cannot pass by luck.
      JSON.stringify({ port, pid: 0x7fffffff, sessionId: 3, startedAt: 'now' }),
    );
    try {
      expect(await mcpServerState(port)).toEqual({ running: true, port, foreign: true });
    } finally {
      server.close();
    }
  });

  // The router's pid, when `forkOnPort:` could not report it: an ordinary
  // account may not describe another session, so it is found by the port.
  it.skipIf(!hasLsof)('finds the pid listening on a port', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    try {
      expect(listeningPid(port)).toBe(process.pid);
    } finally {
      server.close();
    }
  });

  it('finds no pid for a port nothing listens on', () => {
    expect(listeningPid(54999)).toBeUndefined();
  });

  it('ignores a record written for a different port', () => {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(mcpRouterStatePath(), JSON.stringify({ port: 1, startedAt: 'now' }));
    expect(readRouterState()?.port).toBe(1);
    fs.writeFileSync(mcpRouterStatePath(), 'not json at all');
    expect(readRouterState()).toBeUndefined();
  });
});

describe('what a client is handed', () => {
  const url = 'http://127.0.0.1:50390/mcp';

  it('gives every client the URL, and none of them a command to spawn', () => {
    const recipes = clientRecipesFor(url);
    expect(recipes.length).toBeGreaterThan(1);
    for (const { snippet } of recipes) {
      expect(snippet).toContain(url);
      // The failure this guards against: a client told to launch a program
      // instead of open a URL reports a missing executable, which points
      // nowhere near the real problem.
      expect(snippet).not.toMatch(/"command"/);
    }
  });

  it('tells Claude Code the transport, which it does not infer from an http URL', () => {
    const claude = clientRecipesFor(url).find((r) => r.label === 'Claude Code');
    expect(claude?.snippet).toBe(`claude mcp add --transport http gemdb ${url}`);
  });

  it('gives the JSON clients valid JSON', () => {
    for (const { label, snippet } of clientRecipesFor(url)) {
      if (!snippet.trimStart().startsWith('{')) continue;
      expect(() => JSON.parse(snippet), label).not.toThrow();
      expect(JSON.parse(snippet).mcpServers.gemdb.url).toBe(url);
    }
  });
});
