import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawn } from 'child_process';
import {
  DB_PASSWORD,
  DB_USER,
  NETLDI_NAME,
  STONE_NAME,
  STOP_TIMEOUT_SECONDS,
  rootPath,
} from './config';
import { libraryPathVariable, sharedLibraryExtension } from './platform';
import { log, logStep } from './log';
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
  if (!gs)
    throw new Error('The database engine is not installed. Run "GemDB: Install GemDB" first.');

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

/** Run `gslist -cvl` and return what the engine reports. Never throws. */
export function listProcesses(): EngineProcess[] {
  const gs = enginePath();
  if (!gs) return [];
  const gslist = path.join(gs, 'bin', 'gslist');
  if (!fs.existsSync(gslist)) return [];
  try {
    const output = execFileSync(gslist, ['-cvl'], {
      encoding: 'utf-8',
      env: { ...process.env, ...engineEnvironment() },
    });
    return parseGslist(output);
  } catch {
    // gslist exits non-zero when nothing is running, which is not an error.
    return [];
  }
}

export function findStone(processes = listProcesses()): EngineProcess | undefined {
  return processes.find((p) => p.type === 'stone' && p.name === STONE_NAME);
}

export function findNetldi(processes = listProcesses()): EngineProcess | undefined {
  return processes.find((p) => p.type === 'netldi' && p.name === NETLDI_NAME);
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

/** True when the listener is up, so new sessions can connect. */
export function isListening(processes = listProcesses()): boolean {
  return findNetldi(processes) !== undefined;
}

export async function startStone(): Promise<void> {
  logStep(`Starting the database`);
  const env = engineEnvironment();
  await runEngineCommand(
    path.join(env.GEMSTONE, 'bin', 'startstone'),
    ['-l', path.join(databaseLogPath(), `${STONE_NAME}.log`), STONE_NAME],
    env,
    'Start database',
  );
}

export async function startNetldi(): Promise<void> {
  logStep('Starting the session listener');
  const env = engineEnvironment();
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
}

/**
 * Arguments for `stopstone`, with or without the override.
 *
 * `stopstone [-h] [-i] [-t timeout] [name [account [password]]]`, where `-i` is
 * "stop the stone immediately even if others are logged in". It has to come
 * before the stone name — after it, it is read as the account.
 *
 * Without `-i`, stopstone refuses while any session holds a login, and that is
 * the ordinary case rather than the exception: an open Python REPL terminal is
 * a logged-in session, and so is a notebook that has run a cell.
 */
export function stopStoneArgs(force: boolean): string[] {
  const flags = force ? ['-i'] : [];
  return [...flags, '-t', String(STOP_TIMEOUT_SECONDS), STONE_NAME, DB_USER, DB_PASSWORD];
}

export async function stopStone(force = false): Promise<void> {
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
