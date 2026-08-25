import * as fs from 'fs';
import * as path from 'path';
import { STONE_NAME } from './config';
import { log, logStep } from './log';
import {
  databaseExists,
  databasePath,
  ensureRootPath,
  extentPath,
  bundledExtentPath,
} from './paths';

/**
 * Create the one database GemDB manages.
 *
 * This is Jasper's database layout with the choices removed: the stone name,
 * the NetLDI name, the extent, and the directory are all fixed, so there is
 * nothing here for a new developer to decide. The configuration written below
 * is otherwise the same shape Jasper writes, because that is the shape the
 * engine's tooling expects to find.
 */
/**
 * What a call to `createDatabase` actually did.
 *
 * `preloaded` is true only when this call made the database *and* made it from
 * the shipped extent — which is the one case where Grail is already filed in
 * and the stamp may be written without doing the work. "The extension ships an
 * extent" is not the same question: an upgrade finds the database already
 * there, carrying whatever Grail was filed into it before.
 */
export interface DatabaseCreation {
  created: boolean;
  preloaded: boolean;
}

export function createDatabase(enginePath: string, extensionPath?: string): DatabaseCreation {
  if (databaseExists()) {
    log(`Database already exists at ${databasePath()}`);
    return { created: false, preloaded: false };
  }

  logStep('Creating the database');
  ensureRootPath();

  const dbPath = databasePath();
  for (const sub of ['conf', 'data', 'log', 'stat']) {
    fs.mkdirSync(path.join(dbPath, sub), { recursive: true });
  }

  // conf/<stone>.conf — the knobs a developer might reasonably raise later.
  // Everything the database needs lives under the database directory, so the
  // engine install stays disposable: GemDB can delete and re-extract it on a
  // version change without touching the user's data.
  fs.writeFileSync(
    path.join(dbPath, 'conf', `${STONE_NAME}.conf`),
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
    path.join(dbPath, 'conf', 'gem.conf'),
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
    path.join(dbPath, 'conf', 'system.conf'),
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
    fs.copyFileSync(keySource, path.join(dbPath, 'conf', 'gemdb.key'));
  } else {
    log(`No starter key at ${keySource} — the database may refuse to start.`);
  }

  // Copy the product's documented defaults next to the database, so a curious
  // developer can read them without going digging in the engine directory.
  const defaultConf = path.join(enginePath, 'data', 'system.conf');
  if (fs.existsSync(defaultConf)) {
    fs.copyFileSync(defaultConf, path.join(dbPath, 'conf', 'default.conf'));
  }

  const extentSource = initialExtent(enginePath, extensionPath);
  log(
    extentSource.preloaded
      ? 'Copying the GemDB extent, which already contains Python support…'
      : 'Copying the initial extent…',
  );
  fs.copyFileSync(extentSource.path, extentPath());
  // The extent ships read-only in the product tree; the engine must be able to
  // write to this copy.
  fs.chmodSync(extentPath(), 0o644);

  log(`Database created at ${dbPath}`);
  return { created: true, preloaded: extentSource.preloaded };
}

/** Delete the database directory, extent and all. */
export function removeDatabase(): void {
  const dbPath = databasePath();
  if (!fs.existsSync(dbPath)) return;
  fs.rmSync(dbPath, { recursive: true, force: true });
  log(`Removed the database at ${dbPath}`);
}

/**
 * Which extent a new database starts from.
 *
 * A release ships `extent/gemdb.dbf` — a database with Grail already filed in,
 * built once by `scripts/bundle-extent.sh` and tested once, so every user gets
 * the same bytes rather than running several hundred Smalltalk files through
 * topaz on their own machine.
 *
 * The engine's own `extent0.dbf` is the fallback, and it is not a vestige: a
 * checkout that has never run `bundle:extent` still produces a working
 * database, and `ensureRunning` files Grail into it the way it always has.
 * That path is also what a future in-place Grail upgrade will use, so it stays
 * exercised rather than rotting.
 */
function initialExtent(
  enginePath: string,
  extensionPath: string | undefined,
): { path: string; preloaded: boolean } {
  if (extensionPath) {
    const bundled = bundledExtentPath(extensionPath);
    if (fs.existsSync(bundled)) return { path: bundled, preloaded: true };
  }
  const stock = path.join(enginePath, 'bin', 'extent0.dbf');
  if (!fs.existsSync(stock)) {
    throw new Error(`The engine at ${enginePath} has no initial extent at ${stock}.`);
  }
  return { path: stock, preloaded: false };
}
