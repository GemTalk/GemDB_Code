import * as fs from 'fs';
import * as path from 'path';
import { dbPassword, dbUser, engineVersion, stoneName } from './config';
import { GCI_PERFORM_FLAG_ENABLE_DEBUG, OOP_ILLEGAL, OOP_NIL } from './gci/gciConstants';
import { GciError, GciLibrary } from './gci/gciLibrary';
import { parsePythonStack, pythonStackQuery } from './haltStack';
import { DotsByFile, armQuery, hookStopQuery, parseArmed } from './redDots';
import { errorMessage, log } from './log';
import { enginePath } from './paths';
import { explainLibraryLoadFailure, sharedLibraryExtension } from './platform';
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
 * The database client library would not load into this process. Unlike the
 * rest of `SessionError`, nothing in this process can change that — the same
 * binary meets the same libraries on every retry — so the GemDB Shell leaves
 * rather than offering a prompt whose every line would repeat the message.
 */
export class LibraryLoadError extends SessionError {}

/**
 * The evaluation was ended by `interrupt()` while it sat suspended in a
 * forwarder send. Distinct from `SessionError` so the query layer can report
 * it as Python would — KeyboardInterrupt — rather than as a failure of the
 * environment.
 */
export class ExecutionInterrupted extends SessionError {}

/**
 * The evaluation paused at `breakpoint()` and the user chose Stop in the
 * debugger. Its own class for the same reason as `ExecutionInterrupted`: it is
 * a decision, not a failure of the environment.
 */
export class ExecutionStopped extends SessionError {}

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

/**
 * `GCI_LOGIN_QUIET` — stop the client library narrating each login on stdout.
 *
 * Without it every login writes a line like
 * `gcits login: session 0x… lgc 0x… rpc gem processId 4726` (and a matching
 * one at logout) to the process's real stdout, from inside the C library. In
 * the extension host that is merely noise in the log; in a GemDB Shell it is
 * printed straight onto the user's terminal, and in `gemdb -c` it lands in
 * output a script may be piping somewhere.
 *
 * Defined here rather than in `gci/gciConstants.ts` because that directory is
 * vendored from Jasper byte-for-byte and carries no login flags at all. The
 * value is from the engine's own `include/gci.ht` (`GCI_LOGIN_QUIET = 0x10`,
 * in the flag enum `GciTsLogin`'s `loginFlags` takes).
 */
const GCI_LOGIN_QUIET = 0x10;

/** What kind of user interface a session belongs to. */
export type SessionKind = 'notebook' | 'file' | 'shell' | 'extension';

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

/**
 * The longest name the shared cache will take: 32 raises OutOfRange (error
 * 2061, measured on 3.7.5). It is a small budget on purpose — the name is a
 * label for a person reading a list of sessions, not an identifier. What joins
 * a session here to a row over there is the serial.
 */
const CACHE_NAME_LIMIT = 31;

/**
 * How each kind of owner introduces itself in that list.
 *
 * Capitalised the way the product is written, because this is a string a
 * person reads: "GemDB Shell" is the name of a thing (CLAUDE.md: write it that
 * way wherever a user can see it, and an administrator reading a session list
 * is a user), while "nb" and "run" are common nouns describing a role. It also
 * sits better beside GemStone's own `GcReclaim`, `SymbolGem` and `TopazR` than
 * an all-lowercase name would — the one lowercase entry in that column is the
 * stone's slot, which carries the stone's configured name rather than a
 * product's.
 *
 * `nb` stays abbreviated where `Shell` was spelled out, and the asymmetry is
 * deliberate: a shell's suffix is a pid, five or six characters and fixed, so
 * spelling out the tag costs nothing. A notebook's suffix is a filename of
 * unknown length, and every character the tag takes is one the name loses.
 * `GemDB nb ` leaves 22 for the title; `GemDB notebook ` would leave 16, which
 * ordinary names exceed.
 */
const CACHE_NAME_TAGS: Record<SessionKind, string> = {
  notebook: 'GemDB nb',
  file: 'GemDB py',
  shell: 'GemDB Shell',
  extension: 'GemDB Code',
};

/**
 * What to call this session where the whole machine can see it.
 *
 * `System cacheName:` writes into the shared page cache, so the name shows up
 * for every session on the host — other VS Code windows, topaz, Jasper, a
 * dashboard — via `System cacheStatisticsForAllSlots`, alongside the stock
 * `GcReclaim`, `SymbolGem` and `TopazL`. That is the point: without it a
 * GemDB session is anonymous, and "which of these ten is worth closing" has no
 * answer from outside the window that opened it.
 *
 * The `GemDB` prefix earns its five characters on a database this extension
 * did not install alone — it is the only thing saying which client a session
 * belongs to. Shells report their pid because a shell is its own process and
 * that is what leads back to the terminal; in the extension host `process.pid`
 * would be the same number for every notebook, which is why only 'shell' uses
 * it (shells never log in from the extension host — "Open GemDB Shell" runs
 * the wrapper in a terminal).
 *
 * Truncation is plain and lossy, and that is accepted: two notebooks whose
 * names agree for 22 characters get the same label, and the serial tells them
 * apart. Non-ASCII goes too, since the cache stores 8-bit code points.
 */
export function cacheNameFor(owner: SessionOwner, pid: number = process.pid): string {
  const tag = CACHE_NAME_TAGS[owner.kind];
  if (owner.kind === 'extension') return tag;
  if (owner.kind === 'shell') return `${tag} ${pid}`;
  // `.ipynb` or `.py` is what the tag already said, so spend the room on the name.
  const name = owner.label
    .replace(owner.kind === 'file' ? /\.py$/i : /\.ipynb$/i, '')
    .replace(/[^\x20-\x7e]/g, '')
    .trim();
  if (!name) return tag;
  return `${tag} ${name}`.slice(0, CACHE_NAME_LIMIT);
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

// ---------------------------------------------------------------------------
// breakpoint(): the gem halts, the client decides.
//
// Grail's breakpoint() ends in `Object>>pause`, which signals a Halt straight
// to the GCI client — past every exception handler on the stack, including the
// `on: AbstractException do:` the query layer wraps each evaluation in — so it
// surfaces here as GCI error 2709 with the suspended GsProcess in
// `err.context`. That process can be read (its frames, via Grail) and then
// resumed with GciTsContinueWith or discarded with GciTsClearStack; both
// measured on 4.0.0.a4 with flags 0 and again with `RUN_FLAGS`. A red dot
// arrives the same way, as error 6005 (`BREAKPOINT`), and takes the same path.
// ---------------------------------------------------------------------------

/** GCI error for a Halt — what Grail's breakpoint() signals. */
const HALT = 2709;

/** GCI error for a method breakpoint — a red dot, set with `setBreakAtStepPoint:`. */
const BREAKPOINT = 6005;

/**
 * Flags for a Python evaluation and every resume of it. With flags 0 the
 * gem's debugger is off and a red dot never fires; `ENABLE_DEBUG` turns it on
 * in a native run at no measured cost. Queries stay at 0, so a `__repr__` the
 * Variables view runs cannot stop at a red dot.
 */
const RUN_FLAGS = GCI_PERFORM_FLAG_ENABLE_DEBUG;

/** What a log line says was armed: each file's name and lines. */
function describeArmed(armed: Map<string, number[]>): string {
  if (armed.size === 0) return 'nothing loaded yet';
  return [...armed].map(([file, lines]) => `${path.basename(file)} ${lines.join(',')}`).join('; ');
}

/** Whether an error's `context` names a suspended process, which can be cleared. */
function isProcess(context: bigint): boolean {
  return context !== OOP_ILLEGAL && context !== OOP_NIL && context !== 0n;
}

/** What the user chose while the evaluation sat at a breakpoint(). */
export type HaltAnswer = 'continue' | 'stop';

/** One paused evaluation, as the host's handler sees it. */
export interface HaltRequest {
  session: GciSession;
  /** The suspended GsProcess — what a stack query reads. */
  process: bigint;
  /** What stopped it: a `breakpoint()` call, or a red dot (`redDots.ts`). */
  reason: 'breakpoint()' | 'red dot';
  /**
   * Replace the run's red dots while it is paused, so a dot added now stops
   * it later in this run. Answers the lines that now hold a break, by file.
   */
  rearm(dots: DotsByFile): Promise<Map<string, number[]>>;
  /**
   * Run Smalltalk while the evaluation stays paused — what the debugger reads
   * the stack and the Variables with. Nonblocking, one query at a time, and
   * soft-broken past a time budget; see `queryWhilePaused`. Refused once the
   * pause is settled.
   */
  query(code: string): Promise<string>;
  /** Runs if the evaluation is interrupted or its session closed while paused,
   * so the handler can take down its debugger (the halt is already answered). */
  onCancel(callback: () => void): void;
}

export type HaltHandler = (request: HaltRequest) => Promise<HaltAnswer>;

let haltHandler: HaltHandler | undefined;

/** The red dots of the moment, read at the start of each run. */
export type RedDotSource = () => DotsByFile;

let redDotSource: RedDotSource | undefined;

/**
 * Install where red dots come from — the editor's gutter. One per process,
 * like `setHaltHandler`; with none installed, no run is armed.
 */
export function setRedDotSource(source: RedDotSource | undefined): void {
  redDotSource = source;
}

/**
 * Install this process's answer to breakpoint(). One per process, like
 * `setInputHandler`. With none installed — the GemDB Shell — the evaluation
 * says where the breakpoint() was and carries on past it, the way CPython does
 * with the hook disabled, rather than failing a run the user did not ask to
 * end.
 */
export function setHaltHandler(handler: HaltHandler | undefined): void {
  haltHandler = handler;
}

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
  return `!tcp@localhost#server!${stoneName()}`;
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
  try {
    library = new GciLibrary(libPath);
  } catch (e) {
    // The linker's own words go to the log; the user gets the sentence.
    const raw = errorMessage(e);
    log(`Could not load ${libPath}: ${raw}`);
    throw new LibraryLoadError(explainLibraryLoadFailure(raw));
  }
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
 * How long a query run while paused may take before it is soft-broken, and
 * then how often it is broken again. A Variables row runs the user's own
 * `__repr__`, and one that never returns must not wedge the pause.
 */
const PAUSED_QUERY_BUDGET_MS = 2000;

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
 * What the debugger reads while an evaluation is paused at breakpoint() goes
 * through `queryWhilePaused`, nonblocking for the same reason.
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
  /** Resolves the pending breakpoint() pause as a stop, when one is pending. */
  private pendingHaltCancel: (() => void) | undefined;
  /** The queries run while paused, chained so only one is ever in flight. */
  private pausedQueries: Promise<void> = Promise.resolve();
  /** Whether a query run while paused is executing now, so a cancel can break it. */
  private pausedQueryRunning = false;
  /** The red dots this session's breaks were last set from; empty when none are set. */
  private redDots: DotsByFile = new Map();

  /** When this session last ran something, for "which is idlest". */
  private lastUsedAt = Date.now();
  /** GemStone's own session serial, so a session here can be found over there. */
  private sessionSerial: number | undefined;
  readonly openedAt = Date.now();

  private constructor(
    private readonly gci: GciLibrary,
    private handle: unknown | undefined,
    private currentOwner: SessionOwner,
  ) {}

  /** Who this session belongs to — a notebook's URI, or the extension itself. */
  get owner(): SessionOwner {
    return this.currentOwner;
  }

  /** What the logs call this session. */
  get label(): string {
    return this.currentOwner.label;
  }

  /**
   * Take on a new owner — a renamed notebook — keeping the session. The name
   * in the shared cache is re-sent, since the old one now points at a file
   * that is not there.
   */
  rename(owner: SessionOwner): void {
    this.currentOwner = owner;
    this.publishName();
  }

  /**
   * Publish who holds this session, where anything on the host can read it.
   *
   * Everything the registry knows is trapped in one extension host;
   * `System cacheName:` is what makes it visible to another window, to topaz,
   * and to whatever ends up reporting on sessions. It writes shared memory
   * rather than the repository, so it costs no commit and — the reason it
   * beats a committed registry — the entry dies with the process instead of
   * outliving a window that crashed. Best-effort: an unnamed session works.
   *
   * The doit answers a String because `execute` sends the result
   * `encodeAsUTF8` to fetch it; answering `true` made every login log a
   * MessageNotUnderstood after the name had already been set.
   */
  private publishName(): void {
    try {
      this.execute(
        `System cacheName: '${cacheNameFor(this.currentOwner).replace(/'/g, "''")}'. 'named'`,
      );
    } catch (e) {
      log(`Could not name the session (${this.label}): ${e instanceof Error ? e.message : e}`);
    }
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
      dbUser(),
      dbPassword(),
      GCI_LOGIN_QUIET,
      0,
    );
    if (!result.session) {
      // The database has a session limit — 10 on the Community Edition key
      // GemDB installs, and the system's own gems (SymbolGem, GcReclaim) spend
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
    // Nothing is sent here to make imports warm. Grail once gated that on a
    // session-local flag, `___canonicalClassesEnabled___`, which this login
    // turned on; the flag was retired when warm binding became the only path,
    // and what is warm is now decided by what has been committed — which is
    // exactly what installing Grail provides, since its last step deploys
    // gemdb and warms its caches. The send survived here for a while as a DNU,
    // logging a failure on every single login, which is worse than nothing.
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
    session.publishName();
    log(
      `Connected to GemDB as ${dbUser()} (${resolved.label}` +
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

      // The execution may pause any number of times to ask the user for a
      // line (Grail's input(), via the stdin provider — see the top of this
      // file), to hand over a chunk of output (print(), via the Transcript
      // forwarder), or at a breakpoint() — for the halt handler to answer, or
      // with none installed, to say so and carry on;
      // each pause is answered and resumed until a real result (or a real
      // error) comes back. GciTsContinueWith runs on a koffi worker thread,
      // so the event loop — and with it GciTsBreak — stays available while
      // the rest of the Python runs.
      this.armRedDots(handle);
      let { result: oop, err } = await this.submitAndWait(handle, code, undefined, RUN_FLAGS);
      while (
        oop === OOP_ILLEGAL &&
        (err.number === CLIENT_FORWARDER_SEND || err.number === HALT || err.number === BREAKPOINT)
      ) {
        // An import hook, or the same line again (`redDots.ts`): go on.
        if (
          err.number === BREAKPOINT &&
          !this.breakPending &&
          (await this.answerHookStop(err.context))
        ) {
          ({ result: oop, err } = await this.gci.GciTsContinueWithAsync(
            handle,
            err.context,
            OOP_ILLEGAL,
            null,
            RUN_FLAGS,
          ));
          continue;
        }
        if (err.number === HALT || err.number === BREAKPOINT) {
          // An interrupt sent while the gem was still running can land after
          // it reached breakpoint(): the user already asked to stop, so do
          // not open a debugger for them to dismiss.
          if (this.breakPending) {
            this.gci.GciTsClearStack(handle, err.context);
            throw new ExecutionInterrupted('The execution was interrupted.');
          }
          if (!haltHandler) {
            onOutput?.(this.breakpointNotice(err.context));
            ({ result: oop, err } = await this.gci.GciTsContinueWithAsync(
              handle,
              err.context,
              OOP_ILLEGAL,
              null,
              RUN_FLAGS,
            ));
            continue;
          }
          const answer = await this.awaitHalt(
            haltHandler,
            err.context,
            err.number === BREAKPOINT ? 'red dot' : 'breakpoint()',
          );
          // A query the debugger still has in flight goes first: GCI takes
          // one call at a time, and the last one queued drops the registry.
          await this.pausedQueries;
          // Closed while paused: the handle is gone, and GCI must not be
          // handed it again.
          if (this.handle === undefined) {
            throw new SessionError('The session was closed while paused at breakpoint().');
          }
          if (answer === 'stop' || this.breakPending) {
            this.gci.GciTsClearStack(handle, err.context);
            if (this.breakPending) throw new ExecutionInterrupted('The execution was interrupted.');
            throw new ExecutionStopped('Stopped at breakpoint() in the debugger.');
          }
          ({ result: oop, err } = await this.gci.GciTsContinueWithAsync(
            handle,
            err.context,
            OOP_ILLEGAL, // resume the halt as if it returned; no replacement value
            null,
            RUN_FLAGS,
          ));
          continue;
        }
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
          RUN_FLAGS,
        ));
      }
      if (oop === OOP_ILLEGAL) {
        throw new SessionError(err.message || 'The execution failed.');
      }
      return this.fetchResult(handle, oop);
    } catch (e) {
      throw this.asSessionError(e);
    } finally {
      this.busy = false;
      this.breakPending = false;
    }
  }

  /**
   * Submit Smalltalk without blocking and wait for its first answer — a
   * result, or the error or pause it stopped at. `whileWaiting` runs between
   * polls.
   */
  private async submitAndWait(
    handle: unknown,
    code: string,
    whileWaiting?: () => void,
    flags = 0,
  ): Promise<{ result: bigint; err: GciError }> {
    const started = this.gci.GciTsNbExecute(
      handle,
      code,
      // The source is UTF-8; saying so is what keeps non-ASCII string
      // literals in user code intact. Same values the sync path passes.
      this.gci.utf8ClassOop(handle),
      OOP_ILLEGAL, // no context receiver
      this.gci.nilOop(),
      flags,
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
      whileWaiting?.();
      await sleep(wait);
      wait = Math.min(wait * 2, POLL_CAP_MS);
    }
    return this.gci.GciTsNbResult(handle);
  }

  /** A result object as a String, releasing it. */
  private fetchResult(handle: unknown, oop: bigint): string {
    try {
      return this.gci.performAndRelease(handle, oop, 'encodeAsUTF8', (utf8Oop) =>
        this.fetchString(utf8Oop),
      );
    } finally {
      this.gci.GciTsReleaseObjs(handle, [oop]);
    }
  }

  /**
   * Run a query while an evaluation of this session is paused at
   * breakpoint(). Nonblocking, like `executeAsync`, because a Variables row
   * runs the user's own `__repr__`, and a synchronous call that never
   * returned would freeze the extension host with no way to send a break.
   * Past `PAUSED_QUERY_BUDGET_MS` the query is soft-broken, again each budget
   * after; the Variables query catches that break around a `__repr__` and
   * shows the rest without one.
   *
   * Queries run one at a time, chained, and the paused evaluation waits for
   * the chain before it resumes or ends. A query that itself stops — a
   * `__repr__` that reached breakpoint() or input(), or a break nothing
   * caught — has its stack cleared, which runs its `ensure:` blocks, and
   * fails.
   */
  private queryWhilePaused(code: string): Promise<string> {
    const run = this.pausedQueries.then(() => this.runPausedQuery(code));
    this.pausedQueries = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async runPausedQuery(code: string): Promise<string> {
    const handle = this.requireHandle();
    let deadline = Date.now() + PAUSED_QUERY_BUDGET_MS;
    this.pausedQueryRunning = true;
    try {
      const { result: oop, err } = await this.submitAndWait(handle, code, () => {
        if (Date.now() < deadline) return;
        deadline = Date.now() + PAUSED_QUERY_BUDGET_MS;
        this.gci.GciTsBreak(handle, false);
      });
      if (oop === OOP_ILLEGAL) {
        if (isProcess(err.context)) this.gci.GciTsClearStack(handle, err.context);
        throw new SessionError(err.message || 'The query failed.');
      }
      return this.fetchResult(handle, oop);
    } catch (e) {
      throw this.asSessionError(e);
    } finally {
      this.pausedQueryRunning = false;
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

  /**
   * Set this session's breaks from the red dots of the moment, before a run.
   * Skipped when there are none now and none were set before. A failure is
   * logged: the run goes ahead, and only its red dots are lost.
   */
  private armRedDots(handle: unknown): void {
    const dots = redDotSource?.() ?? new Map<string, number[]>();
    if (dots.size === 0 && this.redDots.size === 0) return;
    try {
      const armed = parseArmed(this.gci.executeAndFetchString(handle, armQuery(dots)));
      this.redDots = dots;
      if (dots.size > 0) log(`Red dots armed (${this.label}): ${describeArmed(armed)}`);
    } catch (e) {
      log(`Could not set the red dots (${this.label}): ${errorMessage(e)}`);
    }
  }

  /**
   * Whether a breakpoint stop is GemDB's to resume without the user: one of
   * the import hooks (`redDots.ts`), arming what that import built, or a
   * second break on a line the run just stopped at. A query that fails counts
   * as a red dot, so the user sees the stop rather than the run silently going on.
   */
  private async answerHookStop(process: bigint): Promise<boolean> {
    try {
      const raw = await this.runPausedQuery(hookStopQuery(process, this.redDots));
      if (raw === 'repeat') return true;
      if (!raw.startsWith('hook')) return false;
      const armed = parseArmed(raw);
      if (armed.size > 0) log(`Red dots armed on import (${this.label}): ${describeArmed(armed)}`);
      return true;
    } catch (e) {
      log(`Could not read a breakpoint stop (${this.label}): ${errorMessage(e)}`);
      return false;
    }
  }

  /**
   * The line a debugger-less host prints at a breakpoint(): where it was, and
   * that the run goes on. The same words `gemdb-run.tpz` prints in file mode.
   * Naming the place is best-effort — a stack Grail cannot read still gets the
   * sentence.
   */
  private breakpointNotice(process: bigint): string {
    let where = '';
    try {
      const [frame] = parsePythonStack(this.execute(pythonStackQuery(process)));
      if (frame && frame.line > 0) {
        where =
          frame.file === '<grail>' ? ` at line ${frame.line}` : ` at ${frame.file}:${frame.line}`;
      }
    } catch (e) {
      log(`Could not locate a breakpoint() (${this.label}): ${e instanceof Error ? e.message : e}`);
    }
    return `breakpoint()${where}: the debugger opens in notebooks and Debug Python File in GemDB; continuing.\n`;
  }

  /**
   * Hand a breakpoint() pause to the handler, with the same interrupt path
   * `awaitAnswer` gives input(): `interrupt()` or `logout()` during the pause
   * resolves it as a stop and tells the handler to take its debugger down.
   * A handler that throws stops the evaluation rather than leaving it paused.
   */
  private awaitHalt(
    handler: HaltHandler,
    process: bigint,
    reason: HaltRequest['reason'],
  ): Promise<HaltAnswer> {
    return new Promise((resolve) => {
      const cancels: Array<() => void> = [];
      let settled = false;
      const finish = (answer: HaltAnswer): void => {
        if (settled) return;
        settled = true;
        this.pendingHaltCancel = undefined;
        resolve(answer);
      };
      this.pendingHaltCancel = () => {
        // The handler hears first, so what it queues on the way out (dropping
        // the registry) is still accepted and still runs before the stop.
        for (const callback of cancels) callback();
        finish('stop');
        if (this.pausedQueryRunning && this.handle !== undefined) {
          this.gci.GciTsBreak(this.handle, false);
        }
      };
      const query = (code: string): Promise<string> =>
        settled
          ? Promise.reject(new SessionError('The breakpoint() pause is over.'))
          : this.queryWhilePaused(code);
      handler({
        session: this,
        process,
        reason,
        query,
        rearm: async (dots) => {
          const armed = parseArmed(await query(armQuery(dots, process)));
          this.redDots = dots;
          return armed;
        },
        onCancel: (callback) => cancels.push(callback),
      }).then(
        (answer) => finish(answer),
        () => finish('stop'),
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
    // Paused at breakpoint(): the gem is not executing, so a break has nothing
    // to land on. Ending the pause is what the user meant.
    if (this.pendingHaltCancel) {
      this.breakPending = true;
      this.pendingHaltCancel();
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
    // A pause must not outlive its session: end it (the evaluation's loop
    // sees the handle gone and stops touching GCI) and let the debugger close.
    this.pendingHaltCancel?.();
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
    // Deliberate, not failures.
    if (e instanceof ExecutionInterrupted || e instanceof ExecutionStopped) return e;
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

/**
 * Follow a session to its owner's new identity.
 *
 * Sessions are keyed by a notebook's URI, so renaming the file changes the
 * key. Without this the old session would be stranded in the map — still
 * logged in, spending one of ten, owned by a URI nothing will ask for again —
 * and the notebook would silently log in a second one. Re-keying keeps the
 * session, and re-sending the name keeps the shared cache honest about who
 * holds it; a stale name is worse than none, because it points an
 * administrator at a notebook that no longer exists.
 *
 * Answers whether there was a session to move, so the caller can skip the
 * work that only matters if there was.
 */
export function renameSession(oldKey: string, newOwner: SessionOwner): boolean {
  const session = sessions.get(oldKey);
  if (!session) return false;
  sessions.delete(oldKey);
  sessions.set(newOwner.key, session);
  session.rename(newOwner);
  return true;
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
