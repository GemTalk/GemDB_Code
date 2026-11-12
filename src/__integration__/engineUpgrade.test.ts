import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChildProcess, execFileSync, spawn } from 'child_process';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { NETLDI_NAME, PINNED_ENGINE_VERSION, STONE_NAME } from '../config';
import { REPOSITORY_LIMIT_MB, createDatabase, repositoryVersion } from '../database';
import { EngineUpgradeError, upgradeBackupPath, upgradeEngine } from '../engineUpgrade';
import { engineUpgradeWorld } from '../lifecycle';
import {
  databaseConfPath,
  databaseLogPath,
  expectedEnginePath,
  extentPath,
  grailStampPath,
  mcpStampPath,
} from '../paths';
import { listProcesses } from '../processes';
import { Fixture, makeFixture } from './fixture';

/**
 * The real engine upgrade, end to end: Grail's `upgrade_engine.sh --in-place`
 * on a database shaped exactly like one an earlier GemDB made, driven through
 * the same world `ensureRunning` uses, with only the question answered here.
 *
 * "Shaped like GemDB's" is the point. The first version of this test copied a
 * bare 335 MB extent into an empty directory, so the script's stone ran with
 * the product's own key and defaults and passed; the brain-freeze gate then
 * failed on a real GemDB database, whose extent is pregrown to the key's
 * 10240 MB: with no DBF_EXTENT_SIZES the temporary stone took the 8192 MB
 * default maximum and refused it. So the database here is made by
 * `createDatabase` (GemDB's system.conf and gemdb.conf: the cap, pregrow, the
 * threshold, the key), carries the previous engine's key as a database that
 * engine created does, and is pregrown to the full cap by a stone of the
 * previous engine started on GemDB's configuration -- which also leaves that
 * engine's tranlogs beside it, as a real one has. It needs about 20 GB of disk
 * while it runs (the extent and the script's backup).
 *
 * Local only, like Grail's own upgrade harness, because it needs what CI does
 * not have: a database the previous engine wrote, and that engine. Set
 *
 *   GEMDB_TEST_UPGRADE_EXTENT  an extent0.dbf the previous engine wrote; it is
 *                              copied, never opened in place
 *   GEMDB_TEST_UPGRADE_ENGINE  the previous engine's product directory
 *   GEMDB_TEST_UPGRADE_FROM    its version (default 4.0.0.a5)
 *   GEMDB_TEST_GRAIL           a Grail tree carrying scripts/upgrade_engine.sh
 *                              (default: this checkout's bundled grail/)
 *
 * and GEMDB_TEST_ENGINE to the pinned engine, as for the rest of the suite.
 * It skips itself when any of them is missing.
 *
 * Every stone here is in the fixture's own GEMSTONE_GLOBAL_DIR and has a name of
 * its own (`gemdbupgit` for the pregrow, `gemdbupgrade` for the script's), so
 * none is visible to, or confusable with, any other stone on the machine.
 */

const from = process.env.GEMDB_TEST_UPGRADE_FROM ?? '4.0.0.a5';
const source = process.env.GEMDB_TEST_UPGRADE_EXTENT;
const previous = process.env.GEMDB_TEST_UPGRADE_ENGINE;
const grail = process.env.GEMDB_TEST_GRAIL ?? path.join(process.cwd(), 'grail');
const script = path.join(grail, 'scripts', 'upgrade_engine.sh');
const ready =
  !!source &&
  fs.existsSync(source) &&
  !!previous &&
  fs.existsSync(path.join(previous, 'bin', 'startstone')) &&
  fs.existsSync(script) &&
  fs.readFileSync(script, 'utf8').includes('--in-place');

const PREGROW_STONE = 'gemdbupgit';
const CAP_BYTES = REPOSITORY_LIMIT_MB * 1048576;

let fixture: Fixture | undefined;
let extension = '';

/** Run one of the previous engine's commands against the fixture's lock directory. */
function previousEngine(command: string, args: string[]): string {
  const gs = previous as string;
  return execFileSync(path.join(gs, 'bin', command), args, {
    encoding: 'utf-8',
    env: {
      ...process.env,
      GEMSTONE: gs,
      GEMSTONE_GLOBAL_DIR: (fixture as Fixture).root,
      PATH: `${path.join(gs, 'bin')}:/usr/bin:/bin`,
    },
  });
}

/**
 * The database an earlier GemDB made under the previous engine: GemDB's own
 * files, that engine's key, the extent it wrote, pregrown to the cap by a stone
 * of that engine on GemDB's configuration, and stopped.
 */
function makeOldDatabase(): void {
  createDatabase((fixture as Fixture).engine);
  const conf = databaseConfPath();
  // createDatabase copied the pinned engine's key, read-only as the product's is.
  const key = path.join(conf, 'gemdb.key');
  fs.rmSync(key, { force: true });
  fs.copyFileSync(path.join(previous as string, 'sys', 'community.starter.key'), key);
  fs.copyFileSync(source as string, extentPath());
  fs.chmodSync(extentPath(), 0o644);
  previousEngine('startstone', [
    '-z',
    path.join(conf, 'system.conf'),
    '-e',
    path.join(conf, `${STONE_NAME}.conf`),
    '-l',
    path.join(path.dirname(extentPath()), '..', 'log', `${PREGROW_STONE}.log`),
    PREGROW_STONE,
  ]);
  previousEngine('stopstone', [PREGROW_STONE, 'DataCurator', 'swordfish']);
}

/**
 * Start GemDB's own stone and listener on the old database with the previous
 * engine, as the previous GemDB left them running: they outlive the editor, so
 * this is what an extension update finds.
 */
function startPreviousDatabase(): void {
  const running = listProcesses();
  if (!running.some((p) => p.type === 'stone' && p.name === STONE_NAME)) {
    const conf = databaseConfPath();
    previousEngine('startstone', [
      '-z',
      path.join(conf, 'system.conf'),
      '-e',
      path.join(conf, `${STONE_NAME}.conf`),
      '-l',
      path.join(databaseLogPath(), `${STONE_NAME}.log`),
      STONE_NAME,
    ]);
  }
  if (!running.some((p) => p.type === 'netldi' && p.name === NETLDI_NAME)) {
    previousEngine('startnetldi', [
      '-a',
      os.userInfo().username,
      '-g',
      '-l',
      path.join(databaseLogPath(), `${NETLDI_NAME}.log`),
      NETLDI_NAME,
    ]);
  }
}

/**
 * A session the previous engine's listener forked, standing for another window
 * still running the previous GemDB: nothing this window logs out can end it,
 * so a plain stopstone refuses while it is there. An RPC login, as a window's
 * is, and not a linked topaz: a linked one holds the extent open itself until
 * the process exits, which no window's session does. Settles once it is
 * logged in.
 */
function holdPreviousSession(): Promise<ChildProcess> {
  const gs = previous as string;
  const port = listProcesses().find((p) => p.type === 'netldi' && p.name === NETLDI_NAME)?.port;
  const topaz = spawn(path.join(gs, 'bin', 'topaz'), ['-q'], {
    env: {
      ...process.env,
      GEMSTONE: gs,
      GEMSTONE_GLOBAL_DIR: (fixture as Fixture).root,
      PATH: `${path.join(gs, 'bin')}:/usr/bin:/bin`,
    },
  });
  held.push(topaz);
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`no login:\n${output}`)), 60_000);
    const collect = (data: Buffer): void => {
      output += data.toString();
      if (/successful login/i.test(output)) {
        clearTimeout(timer);
        resolve(topaz);
      }
    };
    topaz.stdout.on('data', collect);
    topaz.stderr.on('data', collect);
    topaz.on('exit', () => reject(new Error(`topaz exited:\n${output}`)));
    topaz.stdin.write(
      [
        'set user DataCurator pass swordfish',
        `set gemstone ${STONE_NAME}`,
        `set gemnetid !tcp@localhost#netldi:${port}#task!gemnetobject`,
        'login',
        '',
      ].join('\n'),
    );
  });
}

const held: ChildProcess[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const topaz of held.splice(0)) topaz.kill('SIGKILL');
});

beforeAll(() => {
  if (!ready) return;
  fixture = makeFixture();
  if (!fixture) return;
  // Where the previous GemDB installed it, beside the pinned one: what lets a
  // stone it started be stopped with its own stopstone.
  fs.symlinkSync(previous as string, expectedEnginePath(from));
  // What `upgradeScriptPath` looks for: <extension>/grail/scripts/upgrade_engine.sh.
  extension = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdb-it-ext-'));
  fs.symlinkSync(path.resolve(grail), path.join(extension, 'grail'));
  makeOldDatabase();
}, 600_000);

afterAll(() => {
  fixture?.remove();
  if (extension) fs.rmSync(extension, { recursive: true, force: true });
});

function world(answer: boolean, version: string) {
  const real = engineUpgradeWorld(extension, (fixture as Fixture).engine, version);
  const questions: string[] = [];
  return {
    questions,
    world: {
      ...real,
      confirm: (f: string, t: string, backup: string) => {
        questions.push(`${f} -> ${t} (${backup})`);
        return Promise.resolve(answer);
      },
      withProgress: <T>(work: (report: (message: string) => void) => Promise<T>) =>
        work(() => undefined),
    },
  };
}

/** Byte-for-byte, without reading 10 GB into memory. */
function sameFile(a: string, b: string): boolean {
  try {
    execFileSync('cmp', ['-s', a, b]);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!ready)('upgrading a database an earlier GemDB made', () => {
  it('is the previous engine’s, pregrown to the key’s cap', () => {
    if (!fixture) return;
    expect(repositoryVersion(fixture.engine)).toBe(from);
    expect(fs.statSync(extentPath()).size).toBe(CAP_BYTES);
  });

  it('leaves the database alone when the answer is no', async () => {
    if (!fixture) return;
    const before = fs.statSync(extentPath()).mtimeMs;
    const { world: w } = world(false, from);
    await expect(
      upgradeEngine({ from, to: PINNED_ENGINE_VERSION, extent: extentPath() }, w),
    ).resolves.toBe('declined');
    expect(fs.statSync(extentPath()).mtimeMs).toBe(before);
    expect(fs.existsSync(upgradeBackupPath(extentPath(), from))).toBe(false);
  });

  it('puts the database back, and says so, when the upgrade fails', async () => {
    if (!fixture) return;
    // A wrong "from" makes the script fail once it has backed up and started
    // its stone: the extent's own version does not match what it was told.
    const wrong = '4.0.0.a4';
    const { world: w } = world(true, wrong);
    const run = upgradeEngine({ from: wrong, to: PINNED_ENGINE_VERSION, extent: extentPath() }, w);
    await expect(run).rejects.toThrow(EngineUpgradeError);
    const backup = upgradeBackupPath(extentPath(), wrong);
    expect(repositoryVersion((fixture as Fixture).engine)).toBe(from);
    expect(sameFile(extentPath(), backup)).toBe(true);
    expect(listProcesses()).toEqual([]);
    fs.rmSync(backup, { force: true });
  }, 600_000);

  it('changes nothing when told not to disconnect a session the previous engine holds', async () => {
    if (!fixture) return;
    startPreviousDatabase();
    await holdPreviousSession();
    const before = fs.statSync(extentPath()).mtimeMs;
    const warning = vi.spyOn(vscode.window, 'showWarningMessage');
    const { world: w } = world(true, from);

    const run = upgradeEngine({ from, to: PINNED_ENGINE_VERSION, extent: extentPath() }, w);

    await expect(run).rejects.toThrow(/nothing was changed.*Every VS Code window/);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('GemDB did not stop'),
      { modal: true },
      'Stop Anyway',
    );
    expect(listProcesses().find((p) => p.type === 'stone')?.version).toBe(from);
    // Left to the windows still using it, listener included: this engine's
    // cannot serve that stone.
    expect(listProcesses().find((p) => p.type === 'netldi')).toBeUndefined();
    expect(fs.statSync(extentPath()).mtimeMs).toBe(before);
    expect(fs.existsSync(upgradeBackupPath(extentPath(), from))).toBe(false);
  }, 600_000);

  it('upgrades it in place, keeps the original, and leaves nothing running', async () => {
    if (!fixture) return;
    // The stone the previous GemDB left running, with another window's
    // session in it: stopped with the previous engine's own stopstone, once
    // the user says Stop Anyway.
    startPreviousDatabase();
    await holdPreviousSession();
    const warning = vi
      .spyOn(vscode.window, 'showWarningMessage')
      .mockResolvedValue('Stop Anyway' as unknown as vscode.MessageItem);
    fs.mkdirSync(path.dirname(grailStampPath()), { recursive: true });
    fs.writeFileSync(grailStampPath(), 'grail=old\n');
    fs.mkdirSync(path.dirname(mcpStampPath()), { recursive: true });
    fs.writeFileSync(mcpStampPath(), 'mcp=old\n');

    const { world: w, questions } = world(true, from);
    await expect(
      upgradeEngine({ from, to: PINNED_ENGINE_VERSION, extent: extentPath() }, w),
    ).resolves.toBe('upgraded');

    expect(questions).toHaveLength(1);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('Every VS Code window running GemDB'),
      { modal: true },
      'Stop Anyway',
    );
    expect(repositoryVersion((fixture as Fixture).engine)).toBe(PINNED_ENGINE_VERSION);
    expect(fs.statSync(upgradeBackupPath(extentPath(), from)).size).toBe(CAP_BYTES);
    expect(listProcesses()).toEqual([]);
    // The start that follows installs both again.
    expect(fs.existsSync(grailStampPath())).toBe(false);
    expect(fs.existsSync(mcpStampPath())).toBe(false);
  }, 1_800_000);
});
