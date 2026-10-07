import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  collectStatistics,
  isExternalDatabase,
  keepStatisticsDays,
  statisticsIntervalSeconds,
} from './config';
import { confsBesideSystemConf, setsOption } from './database';
import { errorMessage, log } from './log';
import { databaseConfPath, databaseStatPath } from './paths';

/**
 * Statistics recorded by the database itself, for GemDB Stats to chart.
 *
 * The stone starts a statmonitor of its own for every string in
 * `STN_STATMONITOR_ARGS` — documented in the engine's `bin/gemstone_data.conf`,
 * not in the `data/system.conf` GemDB copies beside the database, which only
 * has the remote-cache `GEM_STATMONITOR_ARGS`. Measured on 4.0.0.a4
 * (2026-10-06): the statmonitor is the stone's child, given the stone's name
 * by the stone, and exits when the stone stops, leaving its file complete. It
 * is not a session — it is in neither `System currentSessions` nor the cache's
 * slots — so it costs none of the ten. On an idle database a sample is about
 * 300 bytes compressed, so 20-second samples are about 1.3 MB a day.
 *
 * So it is on by default: statistics are only any use if they were already
 * being recorded when something went wrong. It sits on the automated side of
 * docs/automation-boundary.md: written under the root path, bounded by the
 * pruning below, and gone with the stone.
 *
 * Two things statmonitor will not do for GemDB. `-K` prunes only the files
 * of the statmonitor that wrote them, and each stone start is a new one, so
 * pruning across restarts is `pruneStatistics`. And the setting is read only
 * when the stone starts, so a change waits for the next start.
 */

/** A file GemDB's statmonitor wrote — the only files pruning ever deletes. */
const RECORDED_FILE = /^statmonitor_.+\.out(\.gz)?$/;

const DAY_MS = 24 * 60 * 60_000;

/**
 * The arguments for the stone's statmonitor, recording to `directory`; or
 * undefined for a directory no statmonitor can be given.
 *
 * - `-u0` writes every sample as it is taken, rather than every minute, so
 *   the file open in GemDB Stats is never more than a sample behind.
 * - `-z` compresses, about twelve to one (measured), and adds `.gz` to the
 *   name, which is what makes a click open the file in GemDB Stats.
 * - `-R -k '00:00'` starts a new file at midnight, named afresh from `-F`,
 *   and closes the old one complete (measured, with a time a minute ahead).
 * - The time of day in the name keeps a second start on the same day out of
 *   the first one's file.
 *
 * The stone splits the string into arguments itself, and a folder with a
 * space in it arrives whole inside single quotes (measured). A quote in the
 * path would end the quoting early, so a root path with one records nothing
 * rather than starting a statmonitor on half a path.
 */
export function statmonitorArgs(directory: string, intervalSeconds: number): string | undefined {
  if (/['"]/.test(directory)) return undefined;
  const pattern = path.join(directory, 'statmonitor_%%S_%Y-%m-%d_%H%M%S.out');
  return `-i${intervalSeconds} -u0 -z -R -k '00:00' -F'${pattern}'`;
}

const BEGIN = '# BEGIN GemDB statistics';
const END = '# END GemDB statistics';

function block(args: string): string {
  return [
    '',
    BEGIN,
    '# The stone starts statmonitor with these arguments, recording to db/stat.',
    '# GemDB Code rewrites this block before each start from the gemdb.statistics.*',
    '# settings, and removes it when they turn recording off. For arguments of',
    '# your own, set STN_STATMONITOR_ARGS in conf/gemdb.conf: GemDB then leaves',
    '# the setting to you.',
    `STN_STATMONITOR_ARGS = "${args}";`,
    END,
    '',
  ].join('\n');
}

function withoutBlock(conf: string): string {
  const start = conf.indexOf(BEGIN);
  const end = conf.indexOf(END, start);
  if (start < 0 || end < 0) return conf;
  return (
    conf.slice(0, start).replace(/\n*$/, '\n') + conf.slice(end + END.length).replace(/^\n+/, '')
  );
}

/**
 * `systemConf` with GemDB's statmonitor block for `args`, or without it when
 * `args` is undefined; undefined when that changes nothing.
 *
 * Unlike the space limits, the block is GemDB's to rewrite on every start
 * rather than added once, because the settings that decide it can change:
 * turning recording off has to take the block out again. A value set
 * anywhere else is the developer's, and then the block goes too — the stone
 * would start a statmonitor for both, and the developer's choice is the one
 * to keep.
 */
export function withStatmonitor(
  systemConf: string,
  otherConfs: string[],
  args: string | undefined,
): string | undefined {
  const without = withoutBlock(systemConf);
  const theirs = [without, ...otherConfs].some((conf) => setsOption(conf, 'STN_STATMONITOR_ARGS'));
  const next = args === undefined || theirs ? without : without.replace(/\n*$/, '\n') + block(args);
  return next === systemConf ? undefined : next;
}

/**
 * Configure the stone's statmonitor from the settings, before the stone
 * starts. Never throws: a database that starts without statistics is the one
 * every earlier release ran.
 */
export function ensureStatmonitor(): void {
  try {
    const systemConf = path.join(databaseConfPath(), 'system.conf');
    const directory = databaseStatPath();
    if (!fs.existsSync(systemConf)) return;
    const interval = statisticsIntervalSeconds();
    const args = collectStatistics() ? statmonitorArgs(directory, interval) : undefined;
    if (collectStatistics() && args === undefined) {
      log(`Not recording statistics: statmonitor cannot be given a path with a quote in it.`);
    }
    // createDatabase makes it, but statmonitor will not, and records nothing
    // without it.
    if (args !== undefined) fs.mkdirSync(directory, { recursive: true });
    const updated = withStatmonitor(
      fs.readFileSync(systemConf, 'utf-8'),
      confsBesideSystemConf(),
      args,
    );
    if (updated === undefined) return;
    fs.writeFileSync(systemConf, updated);
    log(
      updated.includes(BEGIN)
        ? `The database records statistics every ${interval} s to ${directory} from its next start.`
        : args === undefined
          ? 'The database stops recording statistics from its next start.'
          : 'The database configuration sets STN_STATMONITOR_ARGS itself, so GemDB leaves it alone.',
    );
  } catch (e) {
    log(`Could not configure the database to record statistics: ${errorMessage(e)}`);
  }
}

/** A statistics file, and when it was last written. */
export interface RecordedFile {
  path: string;
  modifiedMs: number;
}

/** The files GemDB's statmonitor wrote to `directory`, newest first. */
export function recordedFiles(directory: string = databaseStatPath()): RecordedFile[] {
  let names: string[];
  try {
    names = fs.readdirSync(directory);
  } catch {
    return [];
  }
  const files: RecordedFile[] = [];
  for (const name of names.filter((each) => RECORDED_FILE.test(each))) {
    const file = path.join(directory, name);
    try {
      files.push({ path: file, modifiedMs: fs.statSync(file).mtimeMs });
    } catch {
      // Pruned by another window between the listing and here.
    }
  }
  return files.sort((a, b) => b.modifiedMs - a.modifiedMs);
}

/**
 * The files to delete: those not written for `keepDays`, by when they were
 * last written. The file being written is written every sample, so it is
 * never among them. The newest is kept whatever its age, so a database left
 * stopped for a month still has its last record, and "Open Today's
 * Statistics" something to open. 0 keeps everything.
 */
export function staleFiles(files: RecordedFile[], keepDays: number, now: number): RecordedFile[] {
  if (keepDays <= 0) return [];
  const newest = files.reduce<RecordedFile | undefined>(
    (best, file) => (best === undefined || file.modifiedMs > best.modifiedMs ? file : best),
    undefined,
  );
  return files.filter((file) => file !== newest && now - file.modifiedMs > keepDays * DAY_MS);
}

/** Delete the statistics files older than `gemdb.statistics.keepDays`. */
export function pruneStatistics(
  directory: string = databaseStatPath(),
  keepDays: number = keepStatisticsDays(),
  now: number = Date.now(),
): void {
  const stale = staleFiles(recordedFiles(directory), keepDays, now);
  for (const file of stale) fs.rmSync(file.path, { force: true });
  if (stale.length > 0) {
    log(`Deleted ${stale.length} statistics file(s) older than ${keepDays} days.`);
  }
}

/** How often pruning looks, while the window is open. */
const PRUNE_EVERY_MS = 6 * 60 * 60_000;

/**
 * Prune now and every few hours, whether or not the database is running: a
 * stone left up for weeks starts a new file every midnight, and files from
 * before recording was turned off still age out. Only for the database GemDB
 * runs.
 */
export function startPruningStatistics(): vscode.Disposable {
  const prune = (): void => {
    if (isExternalDatabase()) return;
    try {
      pruneStatistics();
    } catch (e) {
      log(`Could not prune statistics: ${errorMessage(e)}`);
    }
  };
  prune();
  const timer = setInterval(prune, PRUNE_EVERY_MS);
  return new vscode.Disposable(() => clearInterval(timer));
}

/**
 * Open the newest statistics file in GemDB Stats: today's while the database
 * runs, or the last one recorded when it does not.
 */
export async function openTodaysStatistics(): Promise<void> {
  if (isExternalDatabase()) {
    void vscode.window.showInformationMessage(
      'GemDB Code records statistics only for a database it runs. Use GemDB: Open Statistics ' +
        'File… for files recorded elsewhere.',
    );
    return;
  }
  const latest = recordedFiles()[0];
  if (!latest) {
    void vscode.window.showInformationMessage(
      collectStatistics()
        ? 'No statistics have been recorded yet. The database records them while it runs, ' +
            'from the next time it starts.'
        : 'Recording statistics is off. Turn on gemdb.statistics.collect, and the database ' +
            'records them from the next time it starts.',
    );
    return;
  }
  await vscode.commands.executeCommand('gemdb.openInStats', vscode.Uri.file(latest.path));
}
