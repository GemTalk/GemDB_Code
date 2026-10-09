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
import { withStoneLock } from './lock';
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

export async function startStone(): Promise<void> {
  requireOwnDatabase('start');
  // Under the lock the generated `gemdb` wrapper also takes, because both
  // doors start the same stone and nothing downstream refuses a second one.
  // The re-check inside the lock is the point: whoever we queued behind was
  // most likely starting it, and without this we would start another. For the
  // same reason, a stone that comes up while we wait ends the wait.
  await withStoneLock(
    async () => {
      if (isRunning()) {
        log('The database is already running; nothing to start.');
        return;
      }
      logStep(`Starting the database`);
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
    },
    { satisfied: isRunningAsync },
  );
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
 * That race is not rare (#89): the window's start, the GemDB Shell's, and
 * releases before this one, which start the listener without any lock, can
 * all find it missing and start it together. The loser's `startnetldi` exits
 * 1 with "Server 'gemdbldi' is already running", and everything the caller
 * wanted is true, so a listener that is up and answering afterwards is not a
 * failure. One that is not still fails with startnetldi's own words.
 */
export async function startNetldi(): Promise<boolean> {
  requireOwnDatabase('start');
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
    if (findNetldi(await listProcessesAsync())?.status !== 'OK') throw e;
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
