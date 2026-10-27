import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PINNED_ENGINE_VERSION } from '../config';
import { repositoryVersion } from '../database';
import { EngineUpgradeError, upgradeBackupPath, upgradeEngine } from '../engineUpgrade';
import { engineUpgradeWorld } from '../lifecycle';
import { extentPath, grailStampPath, mcpStampPath } from '../paths';
import { isRunning, listProcesses } from '../processes';
import { Fixture, makeFixture } from './fixture';

/**
 * The real engine upgrade, end to end: Grail's `upgrade_engine.sh --in-place`
 * on a copy of a database the previous engine wrote, driven through the same
 * world `ensureRunning` uses, with only the question answered here.
 *
 * Local only, like Grail's own upgrade harness, because it needs what CI does
 * not have: a database the previous engine wrote. Set
 *
 *   GEMDB_TEST_UPGRADE_EXTENT  an extent0.dbf the previous engine wrote; it is
 *                              copied, never opened in place
 *   GEMDB_TEST_UPGRADE_FROM    its version (default 4.0.0.a5)
 *   GEMDB_TEST_GRAIL           a Grail tree carrying scripts/upgrade_engine.sh
 *                              (default: this checkout's bundled grail/)
 *
 * and GEMDB_TEST_ENGINE to the pinned engine, as for the rest of the suite.
 * It skips itself when any of them is missing.
 *
 * The temporary stone the script runs is `gemdbupgrade`, in the fixture's own
 * GEMSTONE_GLOBAL_DIR, so it is invisible to every other stone on the machine.
 */

const from = process.env.GEMDB_TEST_UPGRADE_FROM ?? '4.0.0.a5';
const source = process.env.GEMDB_TEST_UPGRADE_EXTENT;
const grail = process.env.GEMDB_TEST_GRAIL ?? path.join(process.cwd(), 'grail');
const script = path.join(grail, 'scripts', 'upgrade_engine.sh');
const ready =
  !!source &&
  fs.existsSync(source) &&
  fs.existsSync(script) &&
  fs.readFileSync(script, 'utf8').includes('--in-place');

let fixture: Fixture | undefined;
let extension = '';

beforeAll(() => {
  if (!ready) return;
  fixture = makeFixture();
  if (!fixture) return;
  // What `upgradeScriptPath` looks for: <extension>/grail/scripts/upgrade_engine.sh.
  extension = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdb-it-ext-'));
  fs.symlinkSync(path.resolve(grail), path.join(extension, 'grail'));
});

afterAll(() => {
  fixture?.remove();
  if (extension) fs.rmSync(extension, { recursive: true, force: true });
});

/** Put a fresh copy of the previous engine's extent where GemDB keeps its own. */
function copyOldExtent(): void {
  fs.mkdirSync(path.join(path.dirname(extentPath()), '..', 'log'), { recursive: true });
  fs.mkdirSync(path.dirname(extentPath()), { recursive: true });
  for (const leftover of fs.readdirSync(path.dirname(extentPath()))) {
    fs.rmSync(path.join(path.dirname(extentPath()), leftover), { recursive: true, force: true });
  }
  fs.copyFileSync(source as string, extentPath());
  fs.chmodSync(extentPath(), 0o644);
}

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

describe.skipIf(!ready)('upgrading a database the previous engine wrote', () => {
  it('finds the copy is the previous engine’s', () => {
    if (!fixture) return;
    copyOldExtent();
    expect(repositoryVersion(fixture.engine)).toBe(from);
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
    copyOldExtent();
    const original = fs.readFileSync(extentPath());
    // A wrong "from" makes the script fail once it has backed up and started
    // its stone: the extent's own version does not match what it was told.
    const wrong = '4.0.0.a4';
    const { world: w } = world(true, wrong);
    const run = upgradeEngine({ from: wrong, to: PINNED_ENGINE_VERSION, extent: extentPath() }, w);
    await expect(run).rejects.toThrow(EngineUpgradeError);
    expect(repositoryVersion((fixture as Fixture).engine)).toBe(from);
    expect(fs.readFileSync(extentPath()).equals(original)).toBe(true);
    expect(isRunning()).toBe(false);
    expect(listProcesses()).toEqual([]);
  }, 600_000);

  it('upgrades it in place, keeps the original, and leaves nothing running', async () => {
    if (!fixture) return;
    copyOldExtent();
    fs.mkdirSync(path.dirname(grailStampPath()), { recursive: true });
    fs.writeFileSync(grailStampPath(), 'grail=old\n');
    fs.mkdirSync(path.dirname(mcpStampPath()), { recursive: true });
    fs.writeFileSync(mcpStampPath(), 'mcp=old\n');

    const { world: w, questions } = world(true, from);
    await expect(
      upgradeEngine({ from, to: PINNED_ENGINE_VERSION, extent: extentPath() }, w),
    ).resolves.toBe('upgraded');

    expect(questions).toHaveLength(1);
    expect(repositoryVersion((fixture as Fixture).engine)).toBe(PINNED_ENGINE_VERSION);
    const backup = upgradeBackupPath(extentPath(), from);
    expect(fs.readFileSync(backup).equals(fs.readFileSync(source as string))).toBe(true);
    expect(listProcesses()).toEqual([]);
    // The start that follows installs both again.
    expect(fs.existsSync(grailStampPath())).toBe(false);
    expect(fs.existsSync(mcpStampPath())).toBe(false);
  }, 1_800_000);
});
