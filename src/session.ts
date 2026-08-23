import * as fs from 'fs';
import * as path from 'path';
import { DB_PASSWORD, DB_USER, STONE_NAME, engineVersion } from './config';
import { OOP_ILLEGAL } from './gci/gciConstants';
import { GciError, GciLibrary } from './gci/gciLibrary';
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

/**
 * The evaluation was ended by `interrupt()` while it sat suspended in a
 * forwarder send. Distinct from `SessionError` so the query layer can report
 * it as Python would — KeyboardInterrupt — rather than as a failure of the
 * environment.
 */
export class ExecutionInterrupted extends SessionError {}

/**
 * The database refused a login because every session is in use.
 *
 * Its own class because it is the one login failure a user can act on, and the
 * only one where the useful thing to say is a list of what is holding the
 * sessions rather than an error number.
 */
export class SessionLimitError extends SessionError {}

/**
 * GemStone's login errors for "no session available": the stone's limit, the
 * GCI's own, and too many sessions for one user id. GemDB always logs in as
 * DataCurator, so the last one is as reachable as the first.
 * (`$GEMSTONE/include/gcierr.ht`: GS_ERR_MAX_SESSIONS_LIMIT,
 * GS_ERR_GCI_SESSIONS_LIMIT, GS_ERR_ACTIVE_USER_LIMIT.)
 */
const SESSION_LIMIT_ERRORS = new Set([4039, 4041, 4050]);

/** What kind of user interface a session belongs to. */
export type SessionKind = 'notebook' | 'shell' | 'extension';

/**
 * Who a session is for.
 *
 * Sessions are per-notebook, which is what every other notebook tool does — in
 * VS Code's Jupyter extension each notebook gets its own kernel — and what
 * keeps one notebook's transaction out of another's. The cost is that sessions
 * are a scarce, shared resource: the database allows ten at once and the
 * system's own gems spend some of that. So every session records who asked for
 * it, and `sessionRegistry()` can answer which one has been idle longest and
 * might be worth closing.
 */
export interface SessionOwner {
  /** Stable identity — a notebook's URI, or a fixed id for the extension's own. */
  key: string;
  kind: SessionKind;
  /** What to show a person: a notebook's file name, say. */
  label: string;
}

/** A session, described for a human or for joining to `gemdb.sessions`. */
export interface SessionInfo {
  owner: SessionOwner;
  /** GemStone's session serial, if it could be read. */
  serial: number | undefined;
  openedAt: number;
  idleMs: number;
}

// ---------------------------------------------------------------------------
// input() and print(): the gem asks, the client answers.
//
// Grail's input() consults a per-session "stdin provider" — a ClientForwarder
// this module installs at first use. Sending it `nextLinePrompt:` suspends the
// gem and surfaces here as GCI error 2336 (RT_ERR_CLIENT_FWD_SEND), carrying
// the selector and arguments; the client reads a line from wherever the user
// actually is and resumes the gem with it via GciTsContinueWith. The host
// decides what "reads a line" means: the CLI shell reads its tty through the
// line editor, the editor shows an input box over the notebook.
//
// print() streams the same way, in the other direction. When a caller passes
// `onOutput`, the query layer points `Transcript` at a ClientForwarder for
// that one evaluation, so each print() surfaces here mid-execution as a
// `nextPutAll:` send — one send per print(), because Grail builds the whole
// line first — and the text reaches the user while the code is still running,
// instead of buffering until the evaluation ends. The reply is the forwarder
// itself (a stream returns self), so cascaded writes keep working.
// ---------------------------------------------------------------------------

/** GCI error signalled when Smalltalk sends a message to a ClientForwarder. */
const CLIENT_FORWARDER_SEND = 2336;

/** What one input() request produced, decided by wherever the user is. */
export type InputAnswer = { line: string } | { eof: true } | { interrupt: true };

/** One pending input() request, as the host's handler sees it. */
export interface InputRequest {
  /** The prompt input() was given; often empty. Display is the handler's job. */
  prompt: string;
  /** Runs if the evaluation is interrupted while the read is pending, so the
   * handler can tear down whatever UI it put up (the read itself is already
   * answered as an interrupt — do not resolve again). */
  onCancel(callback: () => void): void;
}

export type InputHandler = (request: InputRequest) => Promise<InputAnswer>;

/** Receives what the running Python printed, chunk by chunk, as it prints. */
export type OutputSink = (text: string) => void;

/**
 * What a Transcript write-selector means as client-side text: the argument
 * itself for the writes, a literal for the argumentless movements. Selectors
 * outside this map (and outside the stdin protocol) are answered with nil.
 */
const OUTPUT_SELECTORS: Record<string, 'argument' | string> = {
  'nextPutAll:': 'argument',
  'show:': 'argument',
  'nextPut:': 'argument',
  cr: '\n',
  lf: '\n',
  crlf: '\n',
  tab: '\t',
  space: ' ',
  flush: '',
};

let inputHandler: InputHandler | undefined;

/**
 * Install this process's answer to input(). One per process, deliberately:
 * the CLI has one tty and the extension host has one user, so per-session
 * handlers would only be extra wiring. Sessions with no handler installed
 * never install a provider, and Grail then answers input() with EOFError.
 */
export function setInputHandler(handler: InputHandler): void {
  inputHandler = handler;
}

/**
 * Registers this session's ClientForwarder as Grail's stdin provider.
 * Resolved by name so a database without Grail answers 'absent' instead of
 * failing to parse; harmless then — input() does not exist there either.
 */
const INSTALL_STDIN_PROVIDER = `| b |
b := System myUserProfile symbolList objectNamed: #'builtins'.
b ifNotNil: [b stdinProvider: ClientForwarder new].
(b isNil ifTrue: ['absent'] ifFalse: ['installed']) encodeAsUTF8`;

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
  /** Whether this session's stdin provider has been offered to Grail. */
  private stdinProviderInstalled = false;
  /** Resolves the pending input() request as an interrupt, when one is pending. */
  private pendingInputCancel: (() => void) | undefined;
  /**
   * An interrupt arrived while the evaluation might be idle inside a forwarder
   * send, where a break is discarded on resume (measured). The flag makes the
   * loop end the evaluation at its next forwarder stop with GciTsClearStack.
   */
  private breakPending = false;

  /** When this session last ran something, for "which is idlest". */
  private lastUsedAt = Date.now();
  /** GemStone's own session serial, so a session here can be found over there. */
  private sessionSerial: number | undefined;
  readonly openedAt = Date.now();

  private constructor(
    private readonly gci: GciLibrary,
    private handle: unknown | undefined,
    readonly owner: SessionOwner,
  ) {}

  /** What the logs call this session. */
  get label(): string {
    return this.owner.label;
  }

  /**
   * GemStone's serial for this session — the number `gemdb.sessions` reports
   * and `System descriptionOfSession:` takes. Undefined only if the probe
   * failed, which is not worth failing a login over.
   */
  get serial(): number | undefined {
    return this.sessionSerial;
  }

  /** Milliseconds since this session last ran anything for its owner. */
  get idleMs(): number {
    return Date.now() - this.lastUsedAt;
  }

  /** Log in, or throw a `SessionError` saying why that is impossible. */
  static login(owner: SessionOwner | string): GciSession {
    // A bare string is still accepted: cliMain logs in as 'shell', and a
    // standalone process has exactly one session and no registry to key.
    const resolved: SessionOwner =
      typeof owner === 'string' ? { key: owner, kind: 'shell', label: owner } : owner;
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
      // The database has a session limit — 10 on the Community Edition key
      // GemDB installs, and the system's own gems (GcUser, SymbolUser) spend
      // some of it. Hitting it is a normal consequence of opening notebooks,
      // not a fault, so it gets an error that says what is holding the
      // sessions rather than a bare error number.
      if (SESSION_LIMIT_ERRORS.has(result.err.number)) {
        throw new SessionLimitError(sessionLimitMessage(resolved, sessionRegistry()));
      }
      throw new SessionError(
        result.err.message || `Could not connect to GemDB (error ${result.err.number}).`,
      );
    }
    const session = new GciSession(gci, result.session, resolved);
    liveSessions.add(session);
    // Canonical modules are a session-local Grail flag, default off. The
    // shipped extent deploys gemdb (committed, caches warmed) precisely so
    // that a session's `import gemdb` leaves nothing to commit — but the
    // import only consults that deployed state when this flag is on. Without
    // it every session cold-imports, and gemdb's transaction() entry check
    // reports the import's own writes as the user's pending changes. Guarded
    // send, best-effort: a database this extension did not install may
    // predate the flag, and a session without it still works — just colder.
    try {
      session.execute(
        '(System myUserProfile symbolList objectNamed: #importlib) ' +
          'ifNotNil: [:imp | imp ___canonicalClassesEnabled___: true]. true',
      );
    } catch (e) {
      log(
        `Could not enable canonical modules (${resolved.label}): ${e instanceof Error ? e.message : e}`,
      );
    }
    // Record GemStone's own serial for this session, so what the extension
    // knows (which notebook owns it) can be joined to what the database knows
    // (`gemdb.sessions`, idle times, who is holding resources). Best-effort:
    // a session that works but cannot tell us its number is still usable.
    try {
      const serial = Number.parseInt(session.execute('System session printString'), 10);
      if (Number.isFinite(serial)) session.sessionSerial = serial;
    } catch (e) {
      log(`Could not read the session serial: ${e instanceof Error ? e.message : e}`);
    }
    log(
      `Connected to GemDB as ${DB_USER} (${resolved.label}` +
        `${session.sessionSerial === undefined ? '' : `, session ${session.sessionSerial}`})`,
    );
    return session;
  }

  get connected(): boolean {
    return this.handle !== undefined;
  }

  /** Run Smalltalk synchronously and return its String result. */
  execute(code: string): string {
    this.lastUsedAt = Date.now();
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
  async executeAsync(code: string, onOutput?: OutputSink): Promise<string> {
    this.lastUsedAt = Date.now();
    const handle = this.requireHandle();
    if (this.busy) {
      throw new SessionError('This session is busy running something else.');
    }
    this.busy = true;
    try {
      this.ensureStdinProvider(handle);

      const started = this.gci.GciTsNbExecute(
        handle,
        code,
        // The source is UTF-8; saying so is what keeps non-ASCII string
        // literals in user code intact. Same values the sync path passes.
        this.gci.utf8ClassOop(handle),
        OOP_ILLEGAL, // no context receiver
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

      // The execution may pause any number of times to ask the user for a
      // line (Grail's input(), via the stdin provider — see the top of this
      // file) or to hand over a chunk of output (print(), via the Transcript
      // forwarder); each pause is answered and resumed until a real result
      // (or a real error) comes back. GciTsContinueWith runs on a koffi
      // worker thread, so the event loop — and with it GciTsBreak — stays
      // available while the rest of the Python runs.
      let { result: oop, err } = this.gci.GciTsNbResult(handle);
      while (oop === OOP_ILLEGAL && err.number === CLIENT_FORWARDER_SEND) {
        // An interrupt cannot reach a gem that is idle inside a forwarder
        // send: a queued break is discarded on resume, and continuing the
        // send with an error only re-signals the SAME send (both measured).
        // A print loop is idle in a send most of the time, so this stop is
        // where an interrupt is made to land: clear the suspended process's
        // stack — which runs its unwind blocks, restoring Transcript — and
        // the evaluation is over.
        if (this.breakPending) {
          this.breakPending = false;
          this.gci.GciTsClearStack(handle, err.context);
          throw new ExecutionInterrupted('The execution was interrupted.');
        }
        const reply = await this.answerForwarderSend(handle, err, onOutput);
        ({ result: oop, err } = await this.gci.GciTsContinueWithAsync(
          handle,
          err.context,
          reply,
          null,
          0,
        ));
      }
      if (oop === OOP_ILLEGAL) {
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
      this.breakPending = false;
    }
  }

  /**
   * Offer this session as Grail's stdin provider, once, and only when this
   * process can actually answer (a handler is installed). A failure is logged
   * rather than raised: an older Grail without the hook still runs Python,
   * its input() just keeps failing the way it always did.
   */
  private ensureStdinProvider(handle: unknown): void {
    if (this.stdinProviderInstalled || !inputHandler) return;
    this.stdinProviderInstalled = true;
    try {
      const outcome = this.gci.executeAndFetchString(handle, INSTALL_STDIN_PROVIDER);
      if (outcome === 'installed') log(`Answering input() for this session (${this.label})`);
    } catch (e) {
      log(`Could not install the stdin provider (${this.label}): ${String(e)}`);
    }
  }

  /**
   * Answer one suspended ClientForwarder send and return the OOP to resume
   * with. Two protocols are known: `nextLinePrompt:` (the stdin provider —
   * input()) and the Transcript write selectors (streamed print()). Anything
   * else is answered with nil rather than left to hang the gem forever.
   */
  private async answerForwarderSend(
    handle: unknown,
    send: GciError,
    onOutput?: OutputSink,
  ): Promise<bigint> {
    const selector = this.fetchSelector(handle, send.args[2]);

    const meaning = OUTPUT_SELECTORS[selector];
    if (meaning !== undefined && onOutput) {
      const text =
        meaning === 'argument' ? this.fetchStringArgument(handle, send.args[3]) : meaning;
      // The gem writes line ends as it pleases (print() uses lf, `Transcript
      // cr` is a carriage return); the terminal and the notebook both want \n.
      if (text) onOutput(text.replace(/\r\n?/g, '\n'));
      // A stream returns self, so cascaded writes keep working.
      return send.args[0];
    }

    if (selector !== 'nextLinePrompt:' || !inputHandler) {
      log(`Unanswerable forwarder send ${selector || '(unreadable)'} (${this.label})`);
      return this.gci.nilOop();
    }
    const prompt = this.fetchStringArgument(handle, send.args[3]);
    log(`input() asked (${this.label})`);
    const answer = await this.awaitAnswer(inputHandler, prompt);
    log(`input() answered: ${Object.keys(answer).join(',')} (${this.label})`);
    if ('line' in answer) {
      // convertToUnicode — a raw Utf8 is byte-immutable and breaks ordinary
      // string operations in the resumed code (measured: shouldNotImplement
      // on replaceFrom:to:with:startingAt:).
      const reply = this.gci.GciTsNewUtf8String(handle, answer.line, true);
      if (reply.result !== OOP_ILLEGAL) return reply.result;
      log(`Could not build the input() reply (${this.label}): ${reply.err.message}`);
      return this.gci.nilOop();
    }
    if ('interrupt' in answer) {
      // The one non-line answer with semantics: Grail raises KeyboardInterrupt
      // at the input() call, where the user's own try/except can see it.
      const sym = this.gci.GciTsNewSymbol(handle, 'interrupt');
      if (sym.result !== OOP_ILLEGAL) return sym.result;
    }
    return this.gci.nilOop(); // end of input -> EOFError
  }

  /**
   * Run the handler with an interrupt path wired in: `interrupt()` during the
   * wait resolves the request as an interrupt (the gem is idle inside the
   * forwarder send, so a break would be discarded — measured) and tells the
   * handler to take down whatever it was showing.
   */
  private awaitAnswer(handler: InputHandler, prompt: string): Promise<InputAnswer> {
    return new Promise((resolve) => {
      const cancels: Array<() => void> = [];
      let settled = false;
      const finish = (answer: InputAnswer): void => {
        if (settled) return;
        settled = true;
        this.pendingInputCancel = undefined;
        resolve(answer);
      };
      this.pendingInputCancel = () => {
        finish({ interrupt: true });
        for (const callback of cancels) callback();
      };
      handler({ prompt, onCancel: (callback) => cancels.push(callback) }).then(
        (answer) => finish(answer),
        // A handler that throws must not leave the gem suspended forever.
        () => finish({ eof: true }),
      );
    });
  }

  /** The selector of a suspended forwarder send — Symbols are byte objects. */
  private fetchSelector(handle: unknown, selectorOop: bigint): string {
    const fetched = this.gci.GciTsFetchChars(handle, selectorOop, 1n, 256);
    return fetched.bytesReturned >= 0n ? fetched.data : '';
  }

  /** The first element of the send's argument Array, as UTF-8 text. */
  private fetchStringArgument(handle: unknown, argsOop: bigint): string {
    const args = this.gci.GciTsFetchOops(handle, argsOop, 1n, 1);
    if (args.result < 1) return '';
    let fetched = this.gci.GciTsFetchUtf8(handle, args.oops[0], 8192);
    if (fetched.bytesReturned < 0n && fetched.requiredSize > 8192n) {
      fetched = this.gci.GciTsFetchUtf8(handle, args.oops[0], Number(fetched.requiredSize));
    }
    return fetched.bytesReturned >= 0n ? fetched.data : '';
  }

  /** Interrupt whatever the session is running. Safe when it is running nothing. */
  interrupt(): void {
    if (this.handle === undefined) return;
    // While input() waits, a break cannot reach the gem — it is idle inside
    // the forwarder send, and a queued break is discarded on resume
    // (measured). Resolving the pending request as an interrupt does what the
    // user meant: the provider answers #interrupt and the gem raises
    // KeyboardInterrupt at the input() call.
    if (this.pendingInputCancel) {
      this.pendingInputCancel();
      return;
    }
    // The break below lands only if the gem is executing. If it is instead
    // idle in a Transcript forwarder send (streamed print()), it is discarded
    // on resume — the flag has the loop end the evaluation at its next
    // forwarder stop instead, with GciTsClearStack.
    if (this.busy) this.breakPending = true;
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
    if (e instanceof ExecutionInterrupted) return e; // deliberate, not a failure
    const message = e instanceof Error ? e.message : String(e);
    if (isDeadSession(message)) {
      this.handle = undefined;
      liveSessions.delete(this);
    }
    return new SessionError(message);
  }
}

// ---------------------------------------------------------------------------
// The sessions this window holds, one per owner.
// ---------------------------------------------------------------------------

/**
 * Every session this extension host has open, keyed by owner.
 *
 * A notebook gets its own session so it gets its own transaction: sharing one
 * would mean a commit in one notebook commits another's work, and
 * `gemdb.transaction()` refusing to start because a notebook the user is not
 * looking at left the session dirty. The extension keeps one of its own for
 * administrative queries — "is Grail installed", scope resets — which must not
 * depend on any notebook being open.
 */
const sessions = new Map<string, GciSession>();

/** The extension's own session: status queries and anything with no notebook. */
export const EXTENSION_OWNER: SessionOwner = {
  key: '__extension__',
  kind: 'extension',
  label: 'GemDB',
};

/** The session for one owner, logging in if there is not one yet. */
export function sessionFor(owner: SessionOwner): GciSession {
  const existing = sessions.get(owner.key);
  if (existing?.connected) return existing;
  const session = GciSession.login(owner);
  sessions.set(owner.key, session);
  return session;
}

/** The extension's own session, for queries that belong to no notebook. */
export function resolveSession(): GciSession {
  return sessionFor(EXTENSION_OWNER);
}

/**
 * What this window holds, idlest first — the order in which sessions are worth
 * reclaiming when the database has none left to give.
 */
export function sessionRegistry(): SessionInfo[] {
  return [...sessions.values()]
    .filter((s) => s.connected)
    .map((s) => ({
      owner: s.owner,
      serial: s.serial,
      openedAt: s.openedAt,
      idleMs: s.idleMs,
    }))
    .sort((a, b) => b.idleMs - a.idleMs);
}

/** One owner's session if it is already open, without logging one in. */
export function sessionForIfOpen(key: string): GciSession | undefined {
  const session = sessions.get(key);
  return session?.connected ? session : undefined;
}

/** Interrupt one owner's session, if it has one and it is running something. */
export function interruptSessionFor(key: string): void {
  sessions.get(key)?.interrupt();
}

/** Close one owner's session, if it has one. Its uncommitted work is lost. */
export function closeSessionFor(key: string): void {
  const session = sessions.get(key);
  if (!session) return;
  session.logout();
  sessions.delete(key);
}

/** Human-readable "3 minutes", for messages about idle sessions. */
function humanDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.round(minutes / 6) / 10} h`;
}

/**
 * What to tell someone whose login was refused for want of a session.
 *
 * The database's limit counts sessions this window knows nothing about — other
 * VS Code windows, the system's own gems, a `topaz` someone left open — so the
 * message says what it can see rather than claiming to explain the whole
 * number, and names the one worth closing first.
 *
 * Takes the held sessions rather than reading the registry, so the wording can
 * be tested without a database (the same reason `runStop` takes a `StopWorld`).
 */
export function sessionLimitMessage(wanted: SessionOwner, held: SessionInfo[]): string {
  const lines = [
    `GemDB could not open a session for ${wanted.label}: the database has no free sessions.`,
  ];
  if (held.length > 0) {
    const idlest = held[0];
    lines.push(
      `This window is holding ${held.length}: ` +
        held.map((s) => `${s.owner.label} (idle ${humanDuration(s.idleMs)})`).join(', ') +
        `. Closing ${idlest.owner.label} would free the one idle longest.`,
    );
  }
  lines.push(
    'Other windows, other tools, and the database’s own gems also use sessions. ' +
      'Close a notebook or a GemDB Shell and try again.',
  );
  return lines.join(' ');
}

/** Run Smalltalk in the extension's own session and return its String result. */
export function execute(code: string): string {
  return resolveSession().execute(code);
}

/** Run Smalltalk in the extension's own session without blocking the host. */
export function executeAsync(code: string, onOutput?: OutputSink): Promise<string> {
  return resolveSession().executeAsync(code, onOutput);
}

/** Commit the extension session's transaction, so work survives the session. */
export function commit(): void {
  resolveSession().commit();
}

/**
 * Interrupt every session this window is running.
 *
 * Deliberately all of them: this is the command-palette "stop what you are
 * doing", and with a session per notebook the user cannot be expected to say
 * which one. A session that is not executing ignores its break.
 */
export function interrupt(): void {
  for (const session of sessions.values()) session.interrupt();
}

/** Log out the extension's own session. Safe to call when there is none. */
export function logout(): void {
  closeSessionFor(EXTENSION_OWNER.key);
}

/**
 * Log out every session this window holds — the extension's own and every
 * notebook's. This is what stopping the database calls: each of these is a
 * login that `stopstone` would otherwise refuse over.
 */
export function logoutAll(): void {
  for (const session of [...liveSessions]) session.logout();
  sessions.clear();
}

/** True when this window holds any open session. */
export function isConnected(): boolean {
  return [...sessions.values()].some((s) => s.connected);
}
