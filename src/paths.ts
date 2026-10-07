import * as fs from 'fs';
import * as path from 'path';
import { DB_DIR_NAME, engineVersion, externalDatabase, rootPath } from './config';
import { platformKey } from './platform';

/**
 * Layout under the root path (`~/GemDB` by default):
 *
 *   GemStone64Bit<version>-<platform>/   the database engine, as extracted
 *   db/                                  the one database GemDB manages
 *     conf/  data/  log/  stat/
 *   grail/                               Grail, staged out of the extension
 *   mcp/                                 the MCP server, staged out of the extension
 *   bin/                                 the generated `gemdb` command
 *   brain-freeze/                        the demo, once installed (the user's own clone)
 *   locks/                               engine lock/monitor files
 *   log/                                 engine-global logs
 *   mcp-router.json                      the MCP router GemDB forked, if any
 *
 * Grail is *staged* rather than run from inside the extension directory
 * because that directory changes path on every extension update
 * (`~/.vscode/extensions/gemdb.gemdb-<version>/`). Grail records its own
 * directory inside the database at install time, so an unstable path would
 * leave the database pointing at a version of Grail that no longer exists.
 */

/** What every engine directory's name starts with, before the version. */
const ENGINE_DIR_PREFIX = 'GemStone64Bit';

export function engineDirName(version = engineVersion()): string {
  return `${ENGINE_DIR_PREFIX}${version}-${platformKey() ?? 'unknown'}`;
}

/**
 * Absolute path of the extracted engine, or undefined if it is not there.
 *
 * For an external database this is the administrator's product directory,
 * whatever version asked for: there is exactly one engine, and it is theirs.
 */
export function enginePath(version = engineVersion()): string | undefined {
  const external = externalDatabase();
  const dir = external ? external.gemstone : path.join(rootPath(), engineDirName(version));
  return fs.existsSync(dir) ? dir : undefined;
}

/** Where the engine will be extracted to, whether or not it exists yet. */
export function expectedEnginePath(version = engineVersion()): string {
  return path.join(rootPath(), engineDirName(version));
}

export function databasePath(): string {
  return path.join(rootPath(), DB_DIR_NAME);
}

/**
 * Record of the last failed attempt to file Grail into the database.
 *
 * Beside the database rather than beside the stamp: staging deletes the Grail
 * directory wholesale, and first-run preparation stages at activation, so a
 * record kept there would vanish before anyone looked at it. What failed is
 * the database's Python, so it lives, and is deleted, with the database.
 */
export function grailFailurePath(): string {
  return path.join(databasePath(), '.gemdb-grail-failed');
}

export function databaseConfPath(): string {
  return path.join(databasePath(), 'conf');
}

export function databaseLogPath(): string {
  return path.join(databasePath(), 'log');
}

/** Where the stone's statmonitor records statistics; see statmonitor.ts. */
export function databaseStatPath(): string {
  return path.join(databasePath(), 'stat');
}

export function extentPath(): string {
  return path.join(databasePath(), 'data', 'extent0.dbf');
}

/** Where Grail is staged to, and what GRAIL_DIR points at. */
export function grailPath(): string {
  return path.join(rootPath(), 'grail');
}

/**
 * Marker recording which Grail build is filed into the database.
 *
 * Written only after a successful install, never merely after the files are
 * copied — the copy is on disk, but what matters is what is in the database.
 */
export function grailStampPath(): string {
  return path.join(grailPath(), '.gemdb-grail-stamp');
}

/**
 * Marker recording which build of the generated `gemdb` command is staged.
 *
 * Holds a fingerprint of what `writeCliScripts` would produce — the wrapper,
 * the topaz driver and the shell bundle — so staging can be skipped when it
 * would rewrite the same bytes, and, more to the point, is NOT skipped when it
 * would not. Its own stamp rather than the extension's version because a
 * developer running the extension host rebuilds the bundle far more often than
 * they change the version.
 */
export function cliStampPath(): string {
  return path.join(rootPath(), 'bin', '.gemdb-cli-stamp');
}

export function locksPath(): string {
  return path.join(rootPath(), 'locks');
}

/** Create the root path and the engine-global directories it expects. */
export function ensureRootPath(): void {
  fs.mkdirSync(rootPath(), { recursive: true });
  fs.mkdirSync(locksPath(), { recursive: true });
  fs.mkdirSync(path.join(rootPath(), 'log'), { recursive: true });
}

/** True when the database directory has been created and holds an extent. */
export function databaseExists(): boolean {
  return fs.existsSync(extentPath());
}

/** True when the Grail payload has been copied out of the extension. */
export function grailStagedOnDisk(): boolean {
  return fs.existsSync(path.join(grailPath(), 'GRAIL_VERSION'));
}

/** Which engine directories the root path holds, as `diskSnapshot` reports it. */
export const ENGINE_ON_DISK = {
  none: 'none',
  current: 'current', // the engine this build pins
  other: 'other', // only an engine for this platform that this build does not pin
} as const;
export type EngineOnDisk = (typeof ENGINE_ON_DISK)[keyof typeof ENGINE_ON_DISK];

export interface DiskSnapshot {
  databaseOnDisk: boolean;
  engineOnDisk: EngineOnDisk;
  grailOnDisk: boolean;
}

/**
 * What GemDB's files look like on disk right now, as facts.
 *
 * Telemetry's marker-based skip reasons record why the unattended setup is off
 * (its history); this records what is *there*, and the two together tell an engine pin move (a
 * database and an older engine, no current one) from a wiped root path (nothing
 * at all). It deliberately does not say why. Existence checks and one directory
 * listing only, never a `copydbf`: it runs during activation, which is
 * measured, and it must not throw, so an unreadable root path reads as no
 * engine.
 */
export function diskSnapshot(): DiskSnapshot {
  return {
    databaseOnDisk: databaseExists(),
    engineOnDisk: engineOnDisk(),
    grailOnDisk: grailStagedOnDisk(),
  };
}

function engineOnDisk(): EngineOnDisk {
  if (enginePath() !== undefined) return ENGINE_ON_DISK.current;
  // The name is `GemStone64Bit<version>-<platformKey>`; an engine for another
  // platform (a shared or copied root path) is not one this machine could run,
  // and with no platform key there is no engine this machine could run at all.
  const key = platformKey();
  if (key === undefined) return ENGINE_ON_DISK.none;
  const suffix = `-${key}`;
  const current = engineDirName();
  try {
    const other = fs.readdirSync(rootPath()).some(
      (name) =>
        name.length > ENGINE_DIR_PREFIX.length + suffix.length && // has a version
        name.startsWith(ENGINE_DIR_PREFIX) &&
        name.endsWith(suffix) &&
        name !== current,
    );
    return other ? ENGINE_ON_DISK.other : ENGINE_ON_DISK.none;
  } catch {
    return ENGINE_ON_DISK.none;
  }
}

/**
 * True when Grail has been successfully filed into the database.
 *
 * Distinct from `grailStagedOnDisk`: the files can be in place while the
 * database has no Python in it, which is exactly the state after the automatic
 * first-run preparation, since filing Grail in needs a running database.
 */
export function grailInstalled(): boolean {
  return fs.existsSync(grailStampPath());
}

/** The Grail build currently installed in the database, or undefined. */
export function installedGrailStamp(): string | undefined {
  try {
    return fs.readFileSync(grailStampPath(), 'utf8').trim();
  } catch {
    return undefined;
  }
}

/**
 * Where the MCP server payload is staged, and what its installer runs in.
 *
 * Staged out of the extension for two reasons, neither of them Grail's. The
 * database records nothing about this directory — the payload is `.gs` class
 * file-outs, and once they are filed in the files on disk are only of interest
 * to whoever wants to re-run the installer. What makes a stable copy worth
 * having is that the installer *writes*: `install.sh` leaves `load.out` and a
 * `.topazini` beside itself, and an extension directory is both versioned and
 * not ours to litter. The user also gets `run-server.sh` and `stop-server.sh`
 * at a path that does not move on every update.
 */
export function mcpPath(): string {
  return path.join(rootPath(), 'mcp');
}

/**
 * Marker recording which MCP build is filed into the database.
 *
 * Inside the payload directory, like Grail's, which means the same ordering
 * rule applies: stage first, stamp second, because staging replaces the
 * directory wholesale. Here that ordering is structural rather than something
 * to remember — the stamp is written only after a successful file-in, and a
 * file-in needs the payload already on disk.
 */
export function mcpStampPath(): string {
  return path.join(mcpPath(), '.gemdb-mcp-stamp');
}

/** True when the MCP payload has been copied out of the extension. */
export function mcpStagedOnDisk(): boolean {
  return fs.existsSync(path.join(mcpPath(), 'MCP_VERSION'));
}

/** True when the MCP classes have been filed into the database. */
export function mcpInstalled(): boolean {
  return fs.existsSync(mcpStampPath());
}

/** The MCP build currently installed in the database, or undefined. */
export function installedMcpStamp(): string | undefined {
  try {
    return fs.readFileSync(mcpStampPath(), 'utf8').trim();
  } catch {
    return undefined;
  }
}

/**
 * What GemDB knows about the MCP router it forked: its port, its gem session
 * id and its host pid.
 *
 * Outside `mcp/` deliberately. Staging replaces that directory wholesale, and
 * a running router must survive an update that restages the payload — losing
 * the pid would leave a gem holding the port with nothing able to name it.
 * Beside the root path's other bookkeeping instead, and rewritten on every
 * fork.
 */
export function mcpRouterStatePath(): string {
  return path.join(rootPath(), 'mcp-router.json');
}
