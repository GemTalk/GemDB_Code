import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

/**
 * Moving the database to a newer engine, in place: GemStone's `upgradeImage`
 * and Rowan's upgrade, as Grail's `scripts/upgrade_engine.sh --in-place` runs
 * them (GemTalk/Grail#1866). See `assertDatabaseMatchesEngine` for why every
 * pin move needs it, and Grail's `docs/Upgrading_GemStone.md` for what the
 * script does.
 *
 * The script owns the upgrade and its safety net: it copies the extent to
 * `<extent>.pre-<from>` before it changes anything, runs a temporary stone on
 * it under the new engine, and stops it again, and on any failure it copies
 * the backup back and exits non-zero with the reason on its last line. GemDB
 * owns what is around it: asking, stopping its own processes first, holding
 * the stone lock, showing progress, and what the start does next.
 */

/** Every progress line the script prints starts with this. */
export const UPGRADE_LINE_PREFIX = 'upgrade_engine: ';

/**
 * The stone the script runs the upgrade under. Not GemDB's own name: for the
 * few minutes it runs it is not the database GemDB starts, and a `gslist` (or
 * another window) that saw `gemdb` up would take it for one that is.
 */
export const UPGRADE_STONE_NAME = 'gemdbupgrade';

/** Where Grail's script is in the extension's payload. */
export function upgradeScriptPath(extensionPath: string): string {
  return path.join(extensionPath, 'grail', 'scripts', 'upgrade_engine.sh');
}

/** Where the script keeps the extent as it was: `<extent>.pre-<from>`. */
export function upgradeBackupPath(extent: string, from: string): string {
  return `${extent}.pre-${from}`;
}

/**
 * The most recent progress line in a chunk of the script's output, without its
 * prefix, or undefined when the chunk has none. Only prefixed lines count: the
 * rest is topaz and Rowan talking, which says nothing a user can read.
 */
export function latestUpgradeLine(text: string): string | undefined {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith(UPGRADE_LINE_PREFIX));
  const last = lines.pop();
  return last === undefined ? undefined : last.slice(UPGRADE_LINE_PREFIX.length).trim();
}

/**
 * The script's explanation of a failure, or undefined when it printed nothing.
 *
 * Its contract is that the last line explains, but stdout and stderr arrive
 * interleaved, so topaz's noise on one can land after it on the other. So the
 * last progress line wins when there is one, and the last line of any kind
 * otherwise (bash failing to run the script at all, say).
 */
export function failureReason(output: string): string | undefined {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return latestUpgradeLine(output) ?? lines.pop();
}

/**
 * The variable that hands the script the caller's own stone configuration.
 * Its KEYFILE, DBF_EXTENT_SIZES and the rest take effect for the temporary
 * stone; the script layers its own settings (the extent, its tranlogs,
 * passwordless logins) on top.
 */
export const STONE_CONFIG_VARIABLE = 'UPGRADE_ENGINE_STONE_CONFIG';

/**
 * One configuration file saying what GemDB's stone is started with.
 *
 * Needed because the temporary stone otherwise runs with the product's
 * defaults, and a GemDB extent is not a default one: it is pregrown to the key's
 * 10240 MB, and with no DBF_EXTENT_SIZES the stone takes the 8192 MB default
 * maximum and refuses it ("repository is already of size 10240 Mbytes, which is
 * larger than your maximum licensed repository size of 8192 Mbytes" -- the
 * brain-freeze gate, on #180). GemDB's stone reads two files, `system.conf`
 * (GEMSTONE_SYS_CONF: the extent, its size cap, the free-space threshold,
 * pregrow) and then its own `<stone>.conf` (GEMSTONE_EXE_CONF: KEYFILE, the
 * page cache), and neither alone carries both the key and the cap. So they
 * are concatenated in the order the stone reads them, which keeps its rule
 * that a later setting wins.
 */
export function stoneConfigText(files: { path: string; text: string }[]): string {
  return [
    "# What GemDB starts its stone with, for the engine upgrade's temporary stone.",
    '# Written by GemDB before each upgrade; edit the files it names instead.',
    ...files.map((f) => `\n# --- ${f.path}\n${f.text.replace(/\n*$/, '')}`),
    '',
  ].join('\n');
}

/**
 * Write {@link stoneConfigText} of the `sources` that exist to `out`, and
 * answer `out`. The sources in the order the stone reads them.
 */
export function writeStoneConfig(sources: string[], out: string): string {
  const files = sources
    .filter((file) => fs.existsSync(file))
    .map((file) => ({ path: file, text: fs.readFileSync(file, 'utf-8') }));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, stoneConfigText(files));
  return out;
}

/** How to run the script once. */
export interface UpgradeScriptRun {
  script: string;
  extent: string;
  stone: string;
  from: string;
  /** Must name the NEW engine as GEMSTONE, and GEMSTONE_GLOBAL_DIR. */
  env: NodeJS.ProcessEnv;
  /** The caller's stone configuration file, passed as {@link STONE_CONFIG_VARIABLE}. */
  stoneConfig?: string;
  cwd: string;
  /** Every chunk of output, as it arrives. */
  onOutput: (text: string) => void;
}

/** The script exited non-zero, or could not be run. */
export class UpgradeScriptError extends Error {
  constructor(
    message: string,
    /** The end of the script's output, for the log and the message. */
    readonly tail: string,
  ) {
    super(message);
  }
}

/**
 * Run `upgrade_engine.sh --in-place` and settle when it exits: resolve on 0,
 * reject with an {@link UpgradeScriptError} carrying the script's last line
 * otherwise. Through bash explicitly, so a lost executable bit on the
 * extension's own files cannot break it.
 */
export function runUpgradeScript(run: UpgradeScriptRun): Promise<void> {
  return new Promise((resolve, reject) => {
    const env = run.stoneConfig
      ? { ...run.env, [STONE_CONFIG_VARIABLE]: run.stoneConfig }
      : run.env;
    const child = spawn('bash', [run.script, '--in-place', run.extent, run.stone, run.from], {
      env,
      cwd: run.cwd,
    });
    let tail = '';
    const collect = (data: Buffer): void => {
      const text = data.toString();
      tail = (tail + text).slice(-4000);
      run.onOutput(text);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const reason =
        failureReason(tail) ?? (signal ? `stopped by ${signal}` : `exit code ${code ?? '?'}`);
      reject(new UpgradeScriptError(reason, tail.trim().split('\n').slice(-8).join('\n')));
    });
    child.on('error', (err) => reject(new UpgradeScriptError(err.message, '')));
  });
}

/** What the upgrade does to the machine and the user, so a test can stand in. */
export interface UpgradeWorld {
  /** Ask before anything changes. True to go ahead. */
  confirm(from: string, to: string, backup: string): Promise<boolean>;
  /** Run `work` under a progress notification, which `report` writes to. */
  withProgress<T>(work: (report: (message: string) => void) => Promise<T>): Promise<T>;
  /** Throws when the disk cannot hold the backup. */
  assertRoomForBackup(): void;
  /** Run `work` holding the stone lock, so no window starts the stone meanwhile. */
  withStoneLock(work: () => Promise<void>): Promise<void>;
  /** Log every session out: none may outlive the database they logged in to. */
  logout(): void;
  stoneUp(): boolean;
  listenerUp(): boolean;
  stopStone(): Promise<void>;
  stopNetldi(): Promise<void>;
  /** The upgrade itself; `report` gets each progress line. */
  runScript(report: (line: string) => void): Promise<void>;
  /** The engine version that wrote the extent now, if it can be read. */
  repositoryVersion(): string | undefined;
  /**
   * Forget that Grail and the MCP server are installed, so the start that
   * follows installs them again: the upgrade removes their compiled methods.
   */
  forgetInstalls(): void;
  log(message: string): void;
}

/** The upgrade failed; the message says what state the database is in. */
export class EngineUpgradeError extends Error {}

/**
 * Upgrade the database from `from` to `to`, or answer `declined` when the user
 * says no. Throws {@link EngineUpgradeError} when it fails, with the database
 * as the script left it: restored from the backup when it could be, and said
 * otherwise.
 *
 * Asked, not automated, by the rule in `docs/automation-boundary.md`: it
 * rewrites the user's only copy of their data. The backup makes it
 * recoverable, but only by hand.
 */
export async function upgradeEngine(
  plan: { from: string; to: string; extent: string },
  world: UpgradeWorld,
): Promise<'upgraded' | 'declined'> {
  const backup = upgradeBackupPath(plan.extent, plan.from);
  if (!(await world.confirm(plan.from, plan.to, backup))) {
    world.log(`Kept the database as GemStone ${plan.from} wrote it; it was not upgraded.`);
    return 'declined';
  }
  world.assertRoomForBackup();

  await world.withProgress((report) =>
    world.withStoneLock(async () => {
      // The previous engine's stone and listener may still be up: they outlive
      // the editor, and an extension update is what brings a new engine. Its
      // listener would hand every session an old gem, so it goes too.
      world.logout();
      let stopError: string | undefined;
      try {
        if (world.stoneUp()) {
          report('Stopping the database…');
          await world.stopStone();
        }
        if (world.listenerUp()) await world.stopNetldi();
      } catch (e) {
        stopError = e instanceof Error ? e.message : String(e);
        world.log(`Stopping the database for the upgrade: ${stopError}`);
      }
      // The upgrade's precondition, and not one to take on trust: the script puts
      // its backup back over the extent when it fails, which under a running
      // stone would be the corruption the backup is there to prevent.
      if (world.stoneUp()) {
        throw new EngineUpgradeError(
          'GemDB could not stop the database to upgrade it, so nothing was changed' +
            (stopError ? ` (${stopError.split('\n')[0]})` : '') +
            '. Close the notebooks and GemDB Shells using it, then start GemDB again.',
        );
      }

      report(`Upgrading your database to GemStone ${plan.to}…`);
      world.log(`Upgrading the database from GemStone ${plan.from} to ${plan.to}.`);
      try {
        await world.runScript((line) => report(line));
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        const now = world.repositoryVersion();
        const state =
          now === plan.from
            ? `The database is back as GemStone ${plan.from} wrote it, and nothing in it was lost`
            : `The database could not be confirmed as restored (it reads as ` +
              `${now ?? 'unreadable'}); the original is kept at ${backup}`;
        throw new EngineUpgradeError(
          `Upgrading the database from GemStone ${plan.from} to ${plan.to} failed: ${reason}. ` +
            `${state}. GemDB will not start it until it is upgraded. The GemDB output has ` +
            'the whole log; please report it.',
        );
      }
      // The script's word is its exit code; the extent's is what copydbf reads.
      const now = world.repositoryVersion();
      if (now !== undefined && now !== plan.to) {
        throw new EngineUpgradeError(
          `The upgrade to GemStone ${plan.to} reported success, but the database reads as ` +
            `GemStone ${now}. GemDB will not start it. The original is kept at ${backup}.`,
        );
      }
    }),
  );

  world.forgetInstalls();
  world.log(
    `Upgraded the database to GemStone ${plan.to}. The original is kept at ${backup}; ` +
      'delete it once you are happy with the upgraded database.',
  );
  return 'upgraded';
}
