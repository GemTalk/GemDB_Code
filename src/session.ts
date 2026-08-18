import * as fs from 'fs';
import * as path from 'path';
import { DB_PASSWORD, DB_USER, STONE_NAME, engineVersion } from './config';
import { GciLibrary } from './gci/gciLibrary';
import { log } from './log';
import { enginePath } from './paths';
import { sharedLibraryExtension } from './platform';
import { findNetldi, findStone } from './processes';

/**
 * A logged-in session against the GemDB database.
 *
 * Jasper has a session manager because it has logins: several stones, several
 * users, credentials to store and prompt for. GemDB has exactly one database
 * and one account, both fixed, so a session is just a handle that is either
 * open or not — and the only interesting question is how to reach it.
 */
export interface Session {
  gci: GciLibrary;
  handle: unknown;
}

let current: Session | undefined;
let library: GciLibrary | undefined;

/** Thrown for anything the user could plausibly act on. */
export class SessionError extends Error {}

/**
 * Path to the engine's thread-safe GCI shared library.
 *
 * This is the native library the extension loads into its own process to talk
 * to the database — it ships with the engine, so there is nothing extra to
 * install.
 */
export function gciLibraryPath(): string {
  const engine = enginePath();
  if (!engine) throw new SessionError('The database engine is not installed.');
  return path.join(engine, 'lib', `libgcits-${engineVersion()}-64.${sharedLibraryExtension()}`);
}

/**
 * The network address of the session listener.
 *
 * GemDB names its listener `gemdbldi` rather than the conventional `gs64ldi`,
 * to avoid colliding with a listener another tool may already be running. The
 * conventional name is the one `/etc/services` maps to a fixed port, so ours
 * has none — the port is read back from the engine's own process list instead.
 * That also removes the `/etc/services` edit Jasper has to walk users through.
 */
function gemNrs(): string {
  const netldi = findNetldi();
  if (!netldi?.port) {
    throw new SessionError('GemDB is not running. Start it before running Python.');
  }
  return `!tcp@localhost#netldi:${netldi.port}#task!gemnetobject`;
}

function stoneNrs(): string {
  return `!tcp@localhost#server!${STONE_NAME}`;
}

/** Load the GCI library once per extension host; koffi caches the handle. */
function getLibrary(): GciLibrary {
  if (library) return library;
  const libPath = gciLibraryPath();
  if (!fs.existsSync(libPath)) {
    throw new SessionError(
      `The database client library is missing at ${libPath}. Reinstall GemDB to restore it.`,
    );
  }
  library = new GciLibrary(libPath);
  return library;
}

/**
 * Return the open session, logging in if there is not one yet.
 *
 * One session is shared by every notebook and every "run file" — the database
 * is transactional, and a single session is what makes a value written in one
 * notebook visible in the next.
 */
export function resolveSession(): Session {
  if (current) return current;

  if (!findStone()) {
    throw new SessionError('GemDB is not running. Start it before running Python.');
  }

  const gci = getLibrary();
  const result = gci.GciTsLogin(
    stoneNrs(),
    // No host user or password: the listener is started with -g, so it runs
    // sessions as the user who started it and asks for no OS credentials.
    null,
    null,
    false,
    gemNrs(),
    DB_USER,
    DB_PASSWORD,
    0,
    0,
  );
  if (!result.session) {
    throw new SessionError(
      result.err.message || `Could not connect to GemDB (error ${result.err.number}).`,
    );
  }

  current = { gci, handle: result.session };
  log(`Connected to GemDB as ${DB_USER}`);
  return current;
}

/** Run Smalltalk in the database and return its String result. */
export function execute(code: string): string {
  const session = resolveSession();
  const { result: inProgress } = session.gci.GciTsCallInProgress(session.handle);
  if (inProgress !== 0) {
    throw new SessionError('GemDB is busy running something else. Wait for it to finish.');
  }
  try {
    return session.gci.executeAndFetchString(session.handle, code);
  } catch (e) {
    // A dropped connection — the database was stopped underneath us — should
    // not leave a dead handle behind to fail the same way forever.
    const message = e instanceof Error ? e.message : String(e);
    if (/not logged in|session.*(gone|terminated)|GCI_ERR_.*LOGIN/i.test(message)) {
      current = undefined;
    }
    throw new SessionError(message);
  }
}

/** Commit the current transaction, so work survives the session. */
export function commit(): void {
  const session = resolveSession();
  const { success, err } = session.gci.GciTsCommit(session.handle);
  if (!success) throw new SessionError(err.message || 'Commit failed.');
}

/** Interrupt whatever the session is running. */
export function interrupt(): void {
  if (!current) return;
  current.gci.GciTsBreak(current.handle, false);
}

/** Log out, if logged in. Safe to call when there is no session. */
export function logout(): void {
  if (!current) return;
  try {
    current.gci.GciTsLogout(current.handle);
    log('Disconnected from GemDB');
  } catch {
    /* the database may already be gone */
  }
  current = undefined;
}

/** True when a session is currently open. */
export function isConnected(): boolean {
  return current !== undefined;
}
