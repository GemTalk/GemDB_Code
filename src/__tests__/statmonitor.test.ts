import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __resetSettings, __setSetting } from '../__mocks__/vscode';
import {
  RecordedFile,
  ensureStatmonitor,
  pruneStatistics,
  recordedFiles,
  staleFiles,
  statmonitorArgs,
  withStatmonitor,
} from '../statmonitor';
import { statisticsRow } from '../statusView';

/**
 * The database recording its own statistics: the stone's statmonitor
 * configured from the settings, the files it leaves pruned, and the panel's
 * row about it.
 *
 * What these guard is an existing database's `system.conf`, which GemDB
 * rewrites before every start. Turning recording off has to take GemDB's lines
 * out again, a value the developer set has to win, and the second start must
 * change nothing.
 */

const SYSTEM_CONF = [
  '# GemDB system configuration.',
  '',
  'DBF_EXTENT_NAMES = "/home/me/GemDB/db/data/extent0.dbf";',
  'STN_TRAN_FULL_LOGGING = TRUE;',
  '',
].join('\n');

const ARGS = statmonitorArgs('/home/me/GemDB/db/stat', 20) ?? '';

const DAY = 24 * 60 * 60_000;
const NOW = Date.parse('2026-10-06T12:00:00Z');

describe('the statmonitor arguments', () => {
  it('record compressed samples at the interval, to a new file each day, named for the stone', () => {
    const args = statmonitorArgs('/home/me/GemDB/db/stat', 20);

    expect(args).toBe(
      "-i20 -u0 -z -R -k '00:00' " +
        "-F'/home/me/GemDB/db/stat/statmonitor_%%S_%Y-%m-%d_%H%M%S.out'",
    );
  });

  it('keep a folder with a space in it whole', () => {
    const args = statmonitorArgs('/home/me/My GemDB/db/stat', 20);

    expect(args).toContain("-F'/home/me/My GemDB/db/stat/");
  });

  it('are refused for a folder with a quote in it, which would break the quoting', () => {
    expect(statmonitorArgs("/home/me/O'Brien/db/stat", 20)).toBeUndefined();
    expect(statmonitorArgs('/home/me/"x"/db/stat', 20)).toBeUndefined();
  });
});

describe('the statmonitor block in system.conf', () => {
  it('is added after what is already there', () => {
    const conf = withStatmonitor(SYSTEM_CONF, [], ARGS);

    expect(conf?.startsWith(SYSTEM_CONF)).toBe(true);
    expect(conf).toContain(`STN_STATMONITOR_ARGS = "${ARGS}";`);
  });

  it('changes nothing the second time', () => {
    const once = withStatmonitor(SYSTEM_CONF, [], ARGS) ?? '';

    expect(withStatmonitor(once, [], ARGS)).toBeUndefined();
  });

  it('is replaced, not repeated, when the settings change', () => {
    const once = withStatmonitor(SYSTEM_CONF, [], ARGS) ?? '';

    const twice = withStatmonitor(once, [], statmonitorArgs('/home/me/GemDB/db/stat', 5)) ?? '';

    expect(twice.match(/^STN_STATMONITOR_ARGS/gm)).toHaveLength(1);
    expect(twice).toContain('-i5 ');
  });

  it('is taken out when recording is turned off, leaving the file as it was', () => {
    const once = withStatmonitor(SYSTEM_CONF, [], ARGS) ?? '';

    expect(withStatmonitor(once, [], undefined)).toBe(SYSTEM_CONF);
  });

  it('keeps whatever the developer wrote after it', () => {
    const once = withStatmonitor(SYSTEM_CONF, [], ARGS) ?? '';
    const edited = `${once}SHR_PAGE_CACHE_SIZE_KB = 200000;\n`;

    const off = withStatmonitor(edited, [], undefined);

    expect(off).toBe(`${SYSTEM_CONF}SHR_PAGE_CACHE_SIZE_KB = 200000;\n`);
  });

  it("gives way to arguments the developer set in the stone's own file", () => {
    const once = withStatmonitor(SYSTEM_CONF, [], ARGS) ?? '';

    const conf = withStatmonitor(once, ['STN_STATMONITOR_ARGS = "-i1";\n'], ARGS);

    expect(conf).toBe(SYSTEM_CONF);
  });

  it('gives way to arguments the developer set elsewhere in system.conf', () => {
    const theirs = `${SYSTEM_CONF}STN_STATMONITOR_ARGS = "-i1";\n`;

    expect(withStatmonitor(theirs, [], ARGS)).toBeUndefined();
  });
});

describe('configuring the database before it starts', () => {
  let root: string;

  beforeEach(() => {
    __resetSettings();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdb-stat-'));
    __setSetting('gemdb.rootPath', root);
    fs.mkdirSync(path.join(root, 'db', 'conf'), { recursive: true });
    fs.writeFileSync(path.join(root, 'db', 'conf', 'system.conf'), SYSTEM_CONF);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const systemConf = () => fs.readFileSync(path.join(root, 'db', 'conf', 'system.conf'), 'utf-8');

  it('records every 20 seconds by default, into the database’s stat folder', () => {
    ensureStatmonitor();

    expect(systemConf()).toContain(`-i20 `);
    expect(systemConf()).toContain(`-F'${path.join(root, 'db', 'stat')}/statmonitor_`);
    expect(fs.existsSync(path.join(root, 'db', 'stat'))).toBe(true);
  });

  it('follows the interval setting', () => {
    __setSetting('gemdb.statistics.intervalSeconds', 5);

    ensureStatmonitor();

    expect(systemConf()).toContain('-i5 ');
  });

  it('falls back to 20 seconds for an interval statmonitor would refuse', () => {
    __setSetting('gemdb.statistics.intervalSeconds', 0.5);

    ensureStatmonitor();

    expect(systemConf()).toContain('-i20 ');
  });

  it('records nothing when recording is turned off', () => {
    ensureStatmonitor();
    __setSetting('gemdb.statistics.collect', false);

    ensureStatmonitor();

    expect(systemConf()).toBe(SYSTEM_CONF);
  });
});

describe('pruning statistics files', () => {
  const file = (name: string, ageDays: number): RecordedFile => ({
    path: `/stat/${name}`,
    modifiedMs: NOW - ageDays * DAY,
  });

  it('deletes files not written for longer than the days kept', () => {
    const files = [file('new', 0), file('recent', 13), file('old', 15)];

    expect(staleFiles(files, 14, NOW).map((f) => f.path)).toEqual(['/stat/old']);
  });

  it('keeps the newest file however old it is', () => {
    const files = [file('last', 40), file('older', 41)];

    expect(staleFiles(files, 14, NOW).map((f) => f.path)).toEqual(['/stat/older']);
  });

  it('keeps everything when the days kept is 0', () => {
    expect(staleFiles([file('a', 0), file('b', 400)], 0, NOW)).toEqual([]);
  });

  describe('on disk', () => {
    let dir: string;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdb-stat-'));
    });

    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    const write = (name: string, ageDays: number) => {
      fs.writeFileSync(path.join(dir, name), '');
      const at = new Date(NOW - ageDays * DAY);
      fs.utimesSync(path.join(dir, name), at, at);
    };

    it('touches only the files GemDB’s statmonitor writes', () => {
      write('statmonitor_gemdb_2026-10-06_000000.out.gz', 0);
      write('statmonitor_gemdb_2026-09-01_000000.out.gz', 35);
      write('statmon12345.out', 35);
      write('notes.txt', 35);

      pruneStatistics(dir, 14, NOW);

      expect(fs.readdirSync(dir).sort()).toEqual([
        'notes.txt',
        'statmon12345.out',
        'statmonitor_gemdb_2026-10-06_000000.out.gz',
      ]);
    });

    it('lists the newest file first', () => {
      write('statmonitor_gemdb_2026-10-05_000000.out.gz', 1);
      write('statmonitor_gemdb_2026-10-06_000000.out.gz', 0);

      const files = recordedFiles(dir);

      expect(path.basename(files[0].path)).toBe('statmonitor_gemdb_2026-10-06_000000.out.gz');
    });

    it('finds nothing in a folder that is not there', () => {
      expect(recordedFiles(path.join(dir, 'missing'))).toEqual([]);
    });
  });
});

describe('the Statistics row', () => {
  const facts = {
    collect: true,
    running: true,
    intervalSeconds: 20,
    keepDays: 14,
    now: NOW,
  };
  const latest = (ageMs: number): RecordedFile => ({
    path: '/home/me/GemDB/db/stat/statmonitor_gemdb_2026-10-06_000000.out.gz',
    modifiedMs: NOW - ageMs,
  });

  it('says it is recording while the newest file is still being written', () => {
    const row = statisticsRow({ ...facts, latest: latest(5_000) });

    expect(row.description).toBe('recording every 20 s');
    expect(row.command?.command).toBe('gemdb.openTodaysStatistics');
  });

  it('says a database started before recording was turned on starts at its next start', () => {
    const row = statisticsRow({ ...facts, latest: undefined });

    expect(row.description).toBe('starts when the database restarts');
  });

  it('says recording continues until a restart after it is turned off', () => {
    const row = statisticsRow({ ...facts, collect: false, latest: latest(5_000) });

    expect(row.description).toBe('recording until the database restarts');
  });

  it('opens the last file recorded while the database is stopped', () => {
    const row = statisticsRow({ ...facts, running: false, latest: latest(3 * DAY) });

    expect(row.description).toBe('recorded while the database runs');
    expect(row.command?.command).toBe('gemdb.openTodaysStatistics');
    expect(row.tooltip).toContain('statmonitor_gemdb_2026-10-06_000000.out.gz');
  });

  it('leads to the settings when recording is off and there is nothing to open', () => {
    const row = statisticsRow({ ...facts, collect: false, latest: undefined });

    expect(row.description).toBe('off');
    expect(row.command?.command).toBe('workbench.action.openSettings');
  });
});
