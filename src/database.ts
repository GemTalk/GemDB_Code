import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { STONE_NAME, rootPath } from './config';
import { log, logStep } from './log';
import { isOnNfs } from './networkFileSystem';
import { databaseExists, databasePath, ensureRootPath, extentPath } from './paths';

/**
 * Create the one database GemDB manages.
 *
 * This is Jasper's database layout with the choices removed: the stone name,
 * the NetLDI name, the extent, and the directory are all fixed, so there is
 * nothing here for a new developer to decide. The configuration written below
 * is otherwise the same shape Jasper writes, because that is the shape the
 * engine's tooling expects to find.
 */
export function createDatabase(enginePath: string): boolean {
  // Before the check below, which a leftover never changes the answer to: a
  // build a crash cut short is only ever found here, and nothing else would
  // remove it. Called with the setup lock held (by prepareFiles), so no other
  // window can be building into it at the time.
  const staging = stagingPath();
  if (fs.existsSync(staging)) {
    fs.rmSync(staging, { recursive: true, force: true });
    log(`Removed ${staging}, left by a database creation that did not finish`);
  }

  if (databaseExists()) {
    log(`Database already exists at ${databasePath()}`);
    return false;
  }

  // Before the build, so a `db/` that cannot be replaced is refused before the
  // extent copy rather than after it.
  const dbPath = databasePath();
  clearDatabaseDirWithoutExtent(dbPath);

  logStep('Creating the database');
  ensureRootPath();

  // Built beside its final path and renamed onto it once complete, so the
  // process dying part way through leaves `db.tmp` rather than a `db/` whose
  // extent is truncated — which `databaseExists` would take for a finished
  // database, and the stone would then refuse to open. Nothing is fsynced, so
  // a power loss just after creation is not covered. The configuration names
  // the FINAL paths throughout, because that is where the engine will read it
  // from.
  for (const sub of ['conf', 'data', 'log', 'stat']) {
    fs.mkdirSync(path.join(staging, sub), { recursive: true });
  }

  // conf/<stone>.conf — the knobs a developer might reasonably raise later.
  // Everything the database needs lives under the database directory, so the
  // engine install stays disposable: GemDB can delete and re-extract it on a
  // version change without touching the user's data.
  fs.writeFileSync(
    path.join(staging, 'conf', `${STONE_NAME}.conf`),
    [
      '# GemDB stone configuration.',
      '# Raise SHR_PAGE_CACHE_SIZE_KB if you work with more data than fits here.',
      '',
      'SHR_PAGE_CACHE_SIZE_KB = 100000;',
      `KEYFILE = "${path.join(dbPath, 'conf', 'gemdb.key')}";`,
      '',
    ].join('\n'),
  );

  // conf/gem.conf — the per-session limits. Python workloads build far more
  // temporary objects than Smalltalk ones do (every int, str, and tuple is an
  // object), so the stock 50 MB temporary-object cache is not enough; 500 MB
  // is the same figure Jasper settled on for large code loads.
  fs.writeFileSync(
    path.join(staging, 'conf', 'gem.conf'),
    [
      '# GemDB session configuration.',
      '',
      '# Python creates a lot of short-lived objects; the 50 MB default runs out.',
      'GEM_TEMPOBJ_CACHE_SIZE = 500000;',
      'GEM_TEMPOBJ_POMGEN_PRUNE_ON_VOTE = 90;',
      '',
      '# Set to FALSE if you hit native-code errors while stepping in a debugger.',
      'GEM_NATIVE_CODE_ENABLED = TRUE;',
      '',
    ].join('\n'),
  );

  // conf/system.conf — where the extent and transaction logs live.
  fs.writeFileSync(
    path.join(staging, 'conf', 'system.conf'),
    [
      '# GemDB system configuration. Edit conf/gemdb.conf or conf/gem.conf instead;',
      '# see conf/default.conf for every setting the engine understands.',
      '',
      `DBF_EXTENT_NAMES = "${path.join(dbPath, 'data', 'extent0.dbf')}";`,
      'STN_TRAN_FULL_LOGGING = TRUE;',
      `STN_TRAN_LOG_DIRECTORIES = "${path.join(dbPath, 'data')}/";`,
      'STN_TRAN_LOG_SIZES = 1000;',
      '',
    ].join('\n'),
  );

  // The community starter key ships with the engine and is what lets a
  // freshly-created database start at all.
  const keySource = path.join(enginePath, 'sys', 'community.starter.key');
  if (fs.existsSync(keySource)) {
    fs.copyFileSync(keySource, path.join(staging, 'conf', 'gemdb.key'));
  } else {
    log(`No starter key at ${keySource} — the database may refuse to start.`);
  }

  // Copy the product's documented defaults next to the database, so a curious
  // developer can read them without going digging in the engine directory.
  const defaultConf = path.join(enginePath, 'data', 'system.conf');
  if (fs.existsSync(defaultConf)) {
    fs.copyFileSync(defaultConf, path.join(staging, 'conf', 'default.conf'));
  }

  const stock = path.join(enginePath, 'bin', 'extent0.dbf');
  if (!fs.existsSync(stock)) {
    throw new Error(`The engine at ${enginePath} has no initial extent at ${stock}.`);
  }
  log('Copying the initial extent…');
  const extent = path.join(staging, 'data', 'extent0.dbf');
  fs.copyFileSync(stock, extent);
  // The extent ships read-only in the product tree; the engine must be able to
  // write to this copy.
  fs.chmodSync(extent, 0o644);

  // `clearDatabaseDirWithoutExtent` has already removed any `db/` it could, so
  // a rename that still finds one there is refused the same way.
  try {
    fs.renameSync(staging, dbPath);
  } catch (e) {
    try {
      fs.rmSync(staging, { recursive: true, force: true });
    } catch (cleanup) {
      log(
        `Could not remove ${staging}: ${cleanup instanceof Error ? cleanup.message : String(cleanup)}`,
      );
    }
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'ENOTEMPTY' && code !== 'EEXIST') throw e;
    // Something created `db/` since it was cleared. If that is a database,
    // it is the one to keep, not a reason to tell the user to delete it.
    if (databaseExists()) {
      log(`Database already exists at ${dbPath}`);
      return false;
    }
    throw notADatabaseError(dbPath, fs.readdirSync(dbPath));
  }

  log(`Database created at ${dbPath}`);
  return true;
}

/**
 * Remove a `db/` that holds no extent, unless something in it is not GemDB's.
 *
 * GemDB keeps per-database records in `db/` (`.gemdb-grail-failed` today, the
 * "filed in" stamps soon), and writes them there for an external database
 * too, whose extent is elsewhere. Switching back to a local database then finds
 * a `db/` with no extent in it. Those records describe the other database, so
 * they are discarded rather than carried into the new one: a stamp saying Grail
 * is filed in would be false of a fresh extent. Finder's `.DS_Store` and the
 * `._*` files macOS writes on some volumes are discarded too. Anything else is
 * not GemDB's to judge, so the directory is left alone and setup is refused.
 */
function clearDatabaseDirWithoutExtent(dbPath: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(dbPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  const foreign = entries.filter((name) => !isLeftByGemdbOrOs(name));
  if (foreign.length > 0) throw notADatabaseError(dbPath, foreign);
  fs.rmSync(dbPath, { recursive: true, force: true });
  if (entries.length > 0)
    log(`Removed ${dbPath}, which held no database, only ${entries.join(', ')}`);
}

function isLeftByGemdbOrOs(name: string): boolean {
  return name.startsWith('.gemdb-') || name === '.DS_Store' || name.startsWith('._');
}

function notADatabaseError(dbPath: string, contents?: string[]): Error {
  const holding = contents ? ` (it holds ${contents.join(', ')})` : '';
  return new Error(
    `${dbPath} already exists but holds no database${holding}. GemDB will not create one inside it: ` +
      `move it aside or delete it, then start GemDB again.`,
  );
}

/** Where `createDatabase` builds the database before renaming it into place. */
function stagingPath(): string {
  return `${databasePath()}.tmp`;
}

/** Delete the database directory, extent and all. */
export function removeDatabase(): void {
  const dbPath = databasePath();
  if (!fs.existsSync(dbPath)) return;
  fs.rmSync(dbPath, { recursive: true, force: true });
  log(`Removed the database at ${dbPath}`);
}

/**
 * The engine version that wrote an extent, as `copydbf -i` reports it.
 *
 * Pure, so the parsing can be tested without a database. `copydbf` prints a
 * block of file facts; the line that matters is
 *
 *     GemStone Version: 4.0.0.a4, Mon Sep 28 14:13:59 2026 (branch HEAD), c12a2f4e
 *
 * and only the part before the first comma identifies the release.
 */
export function parseRepositoryVersion(output: string): string | undefined {
  const match = output.match(/^\s*GemStone Version:\s*([^,\n]+)/m);
  return match?.[1].trim();
}

/**
 * What `copydbf -i` says about the database on disk, or undefined if it cannot
 * say. Never throws: an unreadable extent is the engine's problem to report
 * when it opens it, not a reason to refuse to start.
 */
export function repositoryVersion(enginePath: string): string | undefined {
  if (!databaseExists()) return undefined;
  try {
    const output = execFileSync(path.join(enginePath, 'bin', 'copydbf'), ['-i', extentPath()], {
      encoding: 'utf-8',
      // A header read, not a copy. If it has not answered by now something is
      // wrong with the file, which is exactly the case we must not hang on.
      timeout: 30_000,
    });
    return parseRepositoryVersion(output);
  } catch {
    return undefined;
  }
}

/** Raised when the database on disk was written by a different engine. */
export class DatabaseVersionError extends Error {}

/**
 * Refuse to touch a database an older engine wrote.
 *
 * This exists because the failure it replaces is so much worse than an error
 * message. Measured on 2026-09-11, moving from 3.7.5 to 4.0.0.Alpha1: the
 * extent format is unchanged (`compatibilityLevel: 855` either way), so the
 * 4.0 stone **starts** on a 3.7.5 repository and `gslist` reports it OK — the
 * status bar says the database is running. Every login then fails with
 * GemStone error 4045, "The Gem and dbf versions are incompatible", so the
 * first notebook cell, the shell and the MCP server all fail at once with an
 * error that names neither the cause nor the cure.
 *
 * The same holds one alpha to the next, and that is the case a user actually
 * meets: measured 2026-09-16, an Alpha1 extent still reads
 * `compatibilityLevel: 855` under the a2 engine, so the a2 stone starts on it
 * and every login fails exactly as above. Measured again 2026-09-24 for a2 ->
 * a3, with the same result: 855 either way, the a3 stone starts on an a2
 * extent, `gslist` says OK, and the login fails with 4045. So every pin move
 * puts every existing database on the far side of this guard.
 *
 * There is no in-place upgrade to offer instead: 3.7.5 shipped
 * `bin/upgradeImage`, and no 4.0 alpha ships one (checked again on a3), so
 * converting the image is not something GemDB could do on the user's behalf
 * even if it wanted to. Saying
 * so and stopping is the honest move, and at this stage of the product — very
 * few users, all of them close by — losing a scratch database is the cheaper
 * end of the trade against silently running against a repository that cannot
 * answer.
 *
 * Checked before the stone starts rather than at login, because a stone that
 * starts is what makes this confusing in the first place.
 */
export function assertDatabaseMatchesEngine(enginePath: string, engineVersion: string): void {
  const repository = repositoryVersion(enginePath);
  if (!repository || repository === engineVersion) return;
  throw new DatabaseVersionError(
    `The database at ${databasePath()} was created by GemStone ${repository}, ` +
      `but this release of GemDB runs GemStone ${engineVersion}. ` +
      'There is no in-place upgrade — GemStone 4.0 ships no upgradeImage — so the ' +
      `database has to be recreated: delete ${databasePath()} and start GemDB again. ` +
      'Anything stored in it is lost, so copy out whatever you still need first.',
  );
}

/** Raised when the database would be, or is, on a file system the stone refuses. */
export class DatabaseOnNfsError extends Error {}

/** True when the database directory is, or would be created, on NFS. */
export function databaseOnNfs(): boolean {
  return isOnNfs(databasePath());
}

/**
 * Refuse to set up or start a database on NFS (#69).
 *
 * Checked in the same two places as `assertDatabaseMatchesEngine`, for the same
 * reasons: before setup downloads anything, and before the stone starts,
 * because a database created on NFS before this check existed reaches the
 * start without going through setup. See `isOnNfs` for why it is asked at all.
 */
export function assertDatabaseIsLocal(): void {
  if (databaseOnNfs()) throw databaseOnNfsError();
}

/** The one way to say it, whichever of the checks or the stone noticed. */
export function databaseOnNfsError(): DatabaseOnNfsError {
  return new DatabaseOnNfsError(
    `GemDB keeps its database in ${rootPath()}, which is on an NFS mount, and the ` +
      'database engine will not open its files there. Choose a folder on a local disk ' +
      'for GemDB instead.',
  );
}
