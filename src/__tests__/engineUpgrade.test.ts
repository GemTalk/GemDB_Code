import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { DiskSpaceError } from '../database';
import {
  EngineUpgradeError,
  STONE_CONFIG_VARIABLE,
  UpgradeScriptError,
  UpgradeWorld,
  failureReason,
  latestUpgradeLine,
  runUpgradeScript,
  upgradeBackupPath,
  upgradeEngine,
  writeStoneConfig,
} from '../engineUpgrade';

/**
 * Upgrading the database to a newer engine, in place.
 *
 * Grail's script does the upgrade and keeps the backup; these tests cover what
 * GemDB decides around it, where getting it wrong costs the user's data: that
 * nothing is touched without a yes, that the stone is down before the script
 * runs (its restore under a running stone would be the corruption the backup
 * exists to prevent), and that a failure says what state the database is in.
 */

const PLAN = { from: '4.0.0.a5', to: '4.0.0.a8', extent: '/db/data/extent0.dbf' };
const BACKUP = '/db/data/extent0.dbf.pre-4.0.0.a5';

/** A stand-in machine that keeps a transcript, since the order is under test. */
function makeWorld(options: {
  confirm?: boolean;
  noRoom?: boolean;
  stoneUp?: boolean;
  listenerUp?: boolean;
  stoneWillNotStop?: boolean;
  scriptFails?: string;
  /** What copydbf reads after the script, success or failure. */
  versionAfter?: string | undefined;
}): { calls: string[]; reports: string[]; world: UpgradeWorld } {
  let stoneUp = options.stoneUp ?? false;
  let listenerUp = options.listenerUp ?? false;
  const calls: string[] = [];
  const reports: string[] = [];
  const world: UpgradeWorld = {
    confirm: (from, to, backup) => {
      calls.push(`confirm(${from},${to},${backup})`);
      return Promise.resolve(options.confirm ?? true);
    },
    withProgress: (work) => {
      calls.push('progress');
      return work((message) => reports.push(message));
    },
    assertRoomForBackup: () => {
      calls.push('room');
      if (options.noRoom) throw new DiskSpaceError('no room for the copy');
    },
    withStoneLock: async (work) => {
      calls.push('lock');
      try {
        await work();
      } finally {
        calls.push('unlock');
      }
    },
    logout: () => calls.push('logout'),
    stoneUp: () => stoneUp,
    listenerUp: () => listenerUp,
    stopStone: () => {
      calls.push('stopStone');
      if (options.stoneWillNotStop) return Promise.reject(new Error('login failed'));
      stoneUp = false;
      return Promise.resolve();
    },
    stopNetldi: () => {
      calls.push('stopNetldi');
      listenerUp = false;
      return Promise.resolve();
    },
    runScript: (report) => {
      calls.push('script');
      report('backing up the extent');
      if (options.scriptFails)
        return Promise.reject(new UpgradeScriptError(options.scriptFails, ''));
      return Promise.resolve();
    },
    repositoryVersion: () => {
      calls.push('copydbf');
      if ('versionAfter' in options) return options.versionAfter;
      return options.scriptFails ? PLAN.from : PLAN.to;
    },
    forgetInstalls: () => calls.push('forgetInstalls'),
    log: () => undefined,
  };
  return { calls, reports, world };
}

describe('the backup and the progress lines', () => {
  it('names the backup the way the script does', () => {
    expect(upgradeBackupPath(PLAN.extent, '4.0.0.a5')).toBe(BACKUP);
  });

  it('shows only the script’s own progress lines, the latest one', () => {
    const chunk = [
      'upgrade_engine: backing up the extent',
      'topaz> errorcount',
      '0',
      'upgrade_engine: running upgradeImage',
      'Rowan says something long',
      '',
    ].join('\n');
    expect(latestUpgradeLine(chunk)).toBe('running upgradeImage');
    expect(latestUpgradeLine('topaz 1> commit\n')).toBeUndefined();
  });

  it('takes a failure’s reason from the last line, as the script promises', () => {
    expect(
      failureReason('lots\nof\nupgrade_engine: upgradeImage failed, extent restored\n\n'),
    ).toBe('upgradeImage failed, extent restored');
    expect(failureReason('bash: no such file\n')).toBe('bash: no such file');
    expect(failureReason('')).toBeUndefined();
  });
});

describe('upgrading the database', () => {
  it('asks first, and touches nothing when the answer is no', async () => {
    const { calls, world } = makeWorld({ confirm: false, stoneUp: true, listenerUp: true });
    await expect(upgradeEngine(PLAN, world)).resolves.toBe('declined');
    expect(calls).toEqual([`confirm(4.0.0.a5,4.0.0.a8,${BACKUP})`]);
  });

  it('refuses before stopping anything when the disk cannot hold the backup', async () => {
    const { calls, world } = makeWorld({ noRoom: true, stoneUp: true });
    await expect(upgradeEngine(PLAN, world)).rejects.toThrow(DiskSpaceError);
    expect(calls).not.toContain('stopStone');
    expect(calls).not.toContain('script');
  });

  it('stops the previous engine’s processes, under the lock, before the script runs', async () => {
    const { calls, reports, world } = makeWorld({ stoneUp: true, listenerUp: true });
    await expect(upgradeEngine(PLAN, world)).resolves.toBe('upgraded');
    expect(calls).toEqual([
      `confirm(4.0.0.a5,4.0.0.a8,${BACKUP})`,
      'room',
      'progress',
      'lock',
      'logout',
      'stopStone',
      'stopNetldi',
      'script',
      'copydbf',
      'unlock',
      'forgetInstalls',
    ]);
    // The script's own lines reach the notification.
    expect(reports).toContain('backing up the extent');
  });

  it('forgets the Python and MCP installs only once the upgrade has succeeded', async () => {
    const { calls, world } = makeWorld({});
    await upgradeEngine(PLAN, world);
    expect(calls.indexOf('forgetInstalls')).toBeGreaterThan(calls.indexOf('script'));
  });

  it('never runs the script while the stone is still up', async () => {
    const { calls, world } = makeWorld({ stoneUp: true, stoneWillNotStop: true });
    const result = upgradeEngine(PLAN, world);
    await expect(result).rejects.toThrow(EngineUpgradeError);
    await expect(result).rejects.toThrow(/nothing was changed.*login failed/);
    expect(calls).not.toContain('script');
    expect(calls).not.toContain('forgetInstalls');
    expect(calls.at(-1)).toBe('unlock');
  });

  it('says the database is back as it was when the script restored it', async () => {
    const { calls, world } = makeWorld({ scriptFails: 'upgradeImage failed; extent restored' });
    const result = upgradeEngine(PLAN, world);
    await expect(result).rejects.toThrow(EngineUpgradeError);
    await expect(result).rejects.toThrow(/upgradeImage failed; extent restored/);
    await expect(result).rejects.toThrow(/back as GemStone 4\.0\.0\.a5 wrote it/);
    expect(calls).not.toContain('forgetInstalls');
  });

  it('points at the backup when the database cannot be confirmed as restored', async () => {
    const { world } = makeWorld({ scriptFails: 'killed', versionAfter: undefined });
    const result = upgradeEngine(PLAN, world);
    await expect(result).rejects.toThrow(/could not be confirmed as restored/);
    await expect(result).rejects.toThrow(BACKUP);
  });

  it('does not take a zero exit for an upgrade the extent does not show', async () => {
    const { calls, world } = makeWorld({ versionAfter: '4.0.0.a5' });
    await expect(upgradeEngine(PLAN, world)).rejects.toThrow(/reads as GemStone 4\.0\.0\.a5/);
    expect(calls).not.toContain('forgetInstalls');
  });
});

describe('running the script', () => {
  let dir = '';
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  /** A script that records its arguments and environment, then exits with `code`. */
  function fakeScript(code: number, lastLine: string): string {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdb-upgrade-'));
    const script = path.join(dir, 'upgrade_engine.sh');
    fs.writeFileSync(
      script,
      [
        'echo "$@" > "$(dirname "$0")/args"',
        'echo "$GEMSTONE" > "$(dirname "$0")/gemstone"',
        'echo "${UPGRADE_ENGINE_STONE_CONFIG:-unset}" > "$(dirname "$0")/stoneconfig"',
        'echo "upgrade_engine: backing up the extent"',
        'echo "noise from topaz" >&2',
        `echo "${lastLine}"`,
        `exit ${code}`,
        '',
      ].join('\n'),
    );
    return script;
  }

  it('passes the in-place interface and streams the output', async () => {
    const script = fakeScript(0, 'upgrade_engine: done');
    const seen: string[] = [];
    await runUpgradeScript({
      script,
      extent: '/x/extent0.dbf',
      stone: 'gemdbupgrade',
      from: '4.0.0.a5',
      env: { ...process.env, GEMSTONE: '/products/a8' },
      stoneConfig: '/db/log/upgrade-stone.conf',
      cwd: dir,
      onOutput: (text) => seen.push(text),
    });
    expect(fs.readFileSync(path.join(dir, 'stoneconfig'), 'utf8').trim()).toBe(
      '/db/log/upgrade-stone.conf',
    );
    expect(fs.readFileSync(path.join(dir, 'args'), 'utf8').trim()).toBe(
      '--in-place /x/extent0.dbf gemdbupgrade 4.0.0.a5',
    );
    expect(fs.readFileSync(path.join(dir, 'gemstone'), 'utf8').trim()).toBe('/products/a8');
    expect(latestUpgradeLine(seen.join(''))).toBe('done');
  });

  it('rejects with the script’s last line when it fails', async () => {
    const script = fakeScript(1, 'upgrade_engine: FAILED: upgradeImage; extent restored');
    await expect(
      runUpgradeScript({
        script,
        extent: '/x/extent0.dbf',
        stone: 'gemdbupgrade',
        from: '4.0.0.a5',
        env: process.env,
        cwd: dir,
        onOutput: () => undefined,
      }),
    ).rejects.toThrow('FAILED: upgradeImage; extent restored');
  });
});

describe('the stone configuration the script is handed', () => {
  let dir = '';
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('is named by the variable Grail reads', () => {
    expect(STONE_CONFIG_VARIABLE).toBe('UPGRADE_ENGINE_STONE_CONFIG');
  });

  // The brain-freeze gate on #180: the temporary stone ran with the product's
  // defaults, took the 8192 MB default maximum, and refused GemDB's extent,
  // pregrown to the key's 10240 MB. The cap is in system.conf and the key in
  // gemdb.conf, so the file the script gets must carry both.
  it('carries the key from the stone’s file and the cap from system.conf, in reading order', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdb-upgrade-conf-'));
    const system = path.join(dir, 'system.conf');
    const stone = path.join(dir, 'gemdb.conf');
    fs.writeFileSync(system, 'DBF_EXTENT_SIZES = 10240MB;\nDBF_PRE_GROW = TRUE;\n');
    fs.writeFileSync(stone, `KEYFILE = "${dir}/gemdb.key";\nDBF_EXTENT_SIZES = 2048MB;\n`);
    const out = writeStoneConfig(
      [system, stone, path.join(dir, 'missing.conf')],
      path.join(dir, 'log', 'upgrade-stone.conf'),
    );

    const text = fs.readFileSync(out, 'utf8');
    expect(text).toContain('DBF_EXTENT_SIZES = 10240MB;');
    expect(text).toContain(`KEYFILE = "${dir}/gemdb.key";`);
    // The stone reads system.conf first and its own file second, and a later
    // setting wins, so the developer's override in gemdb.conf must come last.
    expect(text.indexOf('2048MB')).toBeGreaterThan(text.indexOf('10240MB'));
    expect(text).not.toContain('missing.conf');
  });
});
