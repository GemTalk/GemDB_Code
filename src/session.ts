import * as fs from 'fs';
import * as path from 'path';
import { DB_PASSWORD, DB_USER, STONE_NAME, engineVersion } from './config';
import { GciLibrary } from './gci/gciLibrary';
import { log } from './log';
import { enginePath } from './paths';
import { sharedLibraryExtension } from './platform';
import { findNetldi, findStone } from './processes';

/**
 * Logged-in sessions against the GemDB database.
 *
 * Jasper has a session manager because it has logins: several stones, several
 * users, credentials to store and prompt for. GemDB has exactly one database
 * and one account, both fixed — but more than one *session*: the notebooks
 * share one (so a value committed in one notebook is visible in the next), and
 * every REPL terminal gets its own, which is what makes two terminals a live
 * demonstration of concurrent sessions rather than two windows into one.
 */

/** Thrown for anything the user could plausibly act on. */
export class SessionError extends Error {}

let library: GciLibrary | undefined;

/** Every session currently open, so stopping the database can drop them all. */
const liveSessions = new Set<GciSession>();

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

/** Does this error mean the session under it is gone, not just unhappy? */
function isDeadSession(message: string): boolean {
  return /not logged in|session.*(gone|terminated)|GCI_ERR_.*LOGIN/i.test(message);
}

const FETCH_PAGE_BYTES = 65536;
const POLL_START_MS = 5;
const POLL_CAP_MS = 50;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One logged-in session.
 *
 * `execute` is the synchronous path and blocks the extension host for its
 * duration; it is right for the short administrative queries (`isGrailInstalled`,
 * `resetScope`). Python goes through `executeAsync`, which submits the work
 * with `GciTsNbExecute` and polls — the event loop stays alive, so the UI keeps
 * painting during a long computation and, crucially, `interrupt()` can still be
 * delivered. A synchronous call cannot be interrupted from the same process,
 * because the thread that would send the break is the one that is blocked.
 */
export class GciSession {
  private busy = false;

  private constructor(
    private readonly gci: GciLibrary,
    private handle: unknown | undefined,
    readonly label: string,
  ) {}

  /** Log in, or throw a `SessionError` saying why that is impossible. */
  static login(label: string): GciSession {
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
    const session = new GciSession(gci, result.session, label);
    liveSessions.add(session);
    log(`Connected to GemDB as ${DB_USER} (${label})`);
    return session;
  }

  get connected(): boolean {
    return this.handle !== undefined;
  }

  /** Run Smalltalk synchronously and return its String result. */
  execute(code: string): string {
    const handle = this.requireHandle();
    const { result: inProgress } = this.gci.GciTsCallInProgress(handle);
    if (inProgress !== 0) {
      throw new SessionError('GemDB is busy running something else. Wait for it to finish.');
    }
    try {
      return this.gci.executeAndFetchString(handle, code);
    } catch (e) {
      throw this.asSessionError(e);
    }
  }

  /**
   * Run Smalltalk without blocking the extension host, and return its String
   * result. One call at a time per session — Python is single-threaded within
   * a session, and pretending otherwise here would only queue confusion.
   */
  async executeAsync(code: string): Promise<string> {
    const handle = this.requireHandle();
    if (this.busy) {
      throw new SessionError('This session is busy running something else.');
    }
    this.busy = true;
    try {
      const started = this.gci.GciTsNbExecute(
        handle,
        code,
        // The source is UTF-8; saying so is what keeps non-ASCII string
        // literals in user code intact. Same values the sync path passes.
        this.gci.utf8ClassOop(handle),
        1n, // OOP_ILLEGAL — no context receiver
        this.gci.nilOop(),
        0,
        0,
      );
      if (!started.success) {
        throw new SessionError(started.err.message || 'Could not start the execution.');
      }

      // Poll with a little backoff: quick results stay quick (5 ms), long runs
      // cost one no-op FFI call every 50 ms, and the event loop breathes in
      // between — which is exactly the window an interrupt arrives through.
      let wait = POLL_START_MS;
      for (;;) {
        const poll = this.gci.GciTsNbPoll(handle, 0);
        if (poll.result === 1) break;
        if (poll.result < 0) {
          throw new SessionError(poll.err.message || 'The execution failed.');
        }
        await sleep(wait);
        wait = Math.min(wait * 2, POLL_CAP_MS);
      }

      const { result: oop, err } = this.gci.GciTsNbResult(handle);
      if (oop === 1n /* OOP_ILLEGAL */) {
        throw new SessionError(err.message || 'The execution failed.');
      }
      try {
        return this.gci.performAndRelease(handle, oop, 'encodeAsUTF8', (utf8Oop) =>
          this.fetchString(utf8Oop),
        );
      } finally {
        this.gci.GciTsReleaseObjs(handle, [oop]);
      }
    } catch (e) {
      throw this.asSessionError(e);
    } finally {
      this.busy = false;
    }
  }

  /** Interrupt whatever the session is running. Safe when it is running nothing. */
  interrupt(): void {
    if (this.handle === undefined) return;
    this.gci.GciTsBreak(this.handle, false);
  }

  commit(): void {
    const handle = this.requireHandle();
    const { success, err } = this.gci.GciTsCommit(handle);
    if (!success) throw new SessionError(err.message || 'Commit failed.');
  }

  /** Log out, if logged in. Safe to call twice. */
  logout(): void {
    if (this.handle === undefined) return;
    try {
      this.gci.GciTsLogout(this.handle);
      log(`Disconnected from GemDB (${this.label})`);
    } catch {
      /* the database may already be gone */
    }
    this.handle = undefined;
    liveSessions.delete(this);
  }

  /**
   * Fetch a string object's bytes, paged, decoded once at the end — decoding
   * per page would tear a multi-byte character that straddles a boundary.
   */
  private fetchString(stringOop: bigint): string {
    const handle = this.requireHandle();
    const pages: Buffer[] = [];
    let start = 1n;
    for (;;) {
      const { bytesReturned, data, err } = this.gci.GciTsFetchBytes(
        handle,
        stringOop,
        start,
        FETCH_PAGE_BYTES,
      );
      if (bytesReturned < 0n) {
        throw new SessionError(err.message || 'Could not read the result.');
      }
      const got = Number(bytesReturned);
      pages.push(data.subarray(0, got));
      if (got < FETCH_PAGE_BYTES) break;
      start += BigInt(got);
    }
    return Buffer.concat(pages).toString('utf8');
  }

  private requireHandle(): unknown {
    if (this.handle === undefined) {
      throw new SessionError('GemDB is not connected. Start it before running Python.');
    }
    return this.handle;
  }

  /** A dropped connection must not leave a dead handle to fail the same way forever. */
  private asSessionError(e: unknown): SessionError {
    const message = e instanceof Error ? e.message : String(e);
    if (isDeadSession(message)) {
      this.handle = undefined;
      liveSessions.delete(this);
    }
    return new SessionError(message);
  }
}

// ---------------------------------------------------------------------------
// The default session — the one the notebooks and administrative queries share.
// ---------------------------------------------------------------------------

let current: GciSession | undefined;

/** The shared session, logging in if there is not one yet. */
export function resolveSession(): GciSession {
  if (current?.connected) return current;
  current = GciSession.login('notebooks');
  return current;
}

/** Run Smalltalk in the shared session and return its String result. */
export function execute(code: string): string {
  return resolveSession().execute(code);
}

/** Run Smalltalk in the shared session without blocking the extension host. */
export function executeAsync(code: string): Promise<string> {
  return resolveSession().executeAsync(code);
}

/** Commit the current transaction, so work survives the session. */
export function commit(): void {
  resolveSession().commit();
}

/** Interrupt whatever the shared session is running. */
export function interrupt(): void {
  current?.interrupt();
}

/** Log out the shared session, if logged in. Safe to call when there is none. */
export function logout(): void {
  current?.logout();
  current = undefined;
}

/**
 * Log out every session this window holds — the shared one and every REPL's.
 * This is what stopping the database calls: each of these is a login that
 * `stopstone` would otherwise refuse over.
 */
export function logoutAll(): void {
  for (const session of [...liveSessions]) session.logout();
  current = undefined;
}

/** True when the shared session is currently open. */
export function isConnected(): boolean {
  return current?.connected === true;
}
