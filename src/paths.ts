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
 *   mcp/                                 the MCP server, staged out of the extension
 *   bin/                                 the generated `gemdb` command
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
