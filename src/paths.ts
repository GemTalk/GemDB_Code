import * as fs from 'fs';
import * as path from 'path';
import { DB_DIR_NAME, engineVersion, rootPath } from './config';
import { platformKey } from './platform';

/**
 * Layout under the root path (`~/GemDB` by default):
 *
 *   GemStone64Bit<version>-<platform>/   the database engine, as extracted
 *   db/                                  the one database GemDB manages
 *     conf/  data/  log/  stat/
 *   grail/                               Grail, staged out of the extension
 *   locks/                               engine lock/monitor files
 *   log/                                 engine-global logs
 *
 * Grail is *staged* rather than run from inside the extension directory
 * because that directory changes path on every extension update
 * (`~/.vscode/extensions/gemdb.gemdb-<version>/`). Grail records its own
 * directory inside the database at install time, so an unstable path would
 * leave the database pointing at a version of Grail that no longer exists.
 */

export function engineDirName(version = engineVersion()): string {
  return `GemStone64Bit${version}-${platformKey() ?? 'unknown'}`;
}

/** Absolute path of the extracted engine, or undefined if it is not there. */
export function enginePath(version = engineVersion()): string | undefined {
  const dir = path.join(rootPath(), engineDirName(version));
  return fs.existsSync(dir) ? dir : undefined;
}

/** Where the engine will be extracted to, whether or not it exists yet. */
export function expectedEnginePath(version = engineVersion()): string {
  return path.join(rootPath(), engineDirName(version));
}

export function databasePath(): string {
  return path.join(rootPath(), DB_DIR_NAME);
}

export function databaseConfPath(): string {
  return path.join(databasePath(), 'conf');
}

export function databaseLogPath(): string {
  return path.join(databasePath(), 'log');
}

/**
 * The extent a release ships, with Python support already in it.
 *
 * A build artifact of `scripts/bundle-extent.sh`, like the Grail payload —
 * gitignored, and absent from a fresh checkout.
 */
export function bundledExtentPath(extensionPath: string): string {
  return path.join(extensionPath, 'extent', 'gemdb.dbf');
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
