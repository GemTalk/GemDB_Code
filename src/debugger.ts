import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { runFileOf } from './fileOwner';
import { CellText, PythonFrame, firstLineOf, locateCell } from './haltStack';
import { errorMessage, log } from './log';
import { PlacedFrame, jupyterTraceback } from './consoleTraceback';
import {
  ConsoleScope,
  MAIN_MODULE,
  PAGE,
  PauseVariable,
  TracebackFrame,
  childrenQuery,
  clearRegistryQuery,
  consoleQuery,
  describeRowQuery,
  parseChildren,
  parseConsoleReply,
  parsePausedStack,
  pausedStackQuery,
} from './pauseVariables';
import { DotsByFile, armedLinesQuery, parseArmed } from './redDots';
import { HaltAnswer, HaltRequest, setHaltHandler, setRedDotSource } from './session';

/**
 * A debugger for Python paused at `breakpoint()` or at a red dot in a `.py` file.
 *
 * Nobody launches it. GemDB's selling point is that you just run the code, so
 * there is no Debug command and no launch configuration: when a notebook cell
 * reaches breakpoint(), or any run reaches a red dot (`redDots.ts`), the
 * session's halt handler starts a debug session
 * aimed at that paused evaluation, and VS Code's own Run and Debug view,
 * toolbar and stopped-line highlight appear mid-run. Continue resumes the
 * cell where it paused; Stop ends it.
 *
 * The session is a *launch*, though it launches nothing: VS Code gives an
 * attach session a Disconnect button in place of Stop, and to a Python user
 * Disconnect means "detach and let it run" — the opposite of what ending this
 * session does. The user ran the cell, so launch is the truthful shape. It
 * never saves on the way in (`suppressSaveBeforeStart`): reaching a
 * breakpoint() must not write the notebook to disk.
 *
 * Deliberately small for now: the call stack, the highlight, each frame's
 * Locals and the notebook's Globals, Continue and Stop, red dots in `.py`
 * files, the Debug Console and the Watch pane, and saving a row's object
 * under gemdb.root (`savedObjects.ts`). Stepping and Restart answer "not
 * yet" rather than pretending, and so do red dots in notebook cells and dots
 * with a condition, hit count or log message.
 *
 * The adapter is inline (`DebugAdapterInlineImplementation`) and speaks the
 * Debug Adapter Protocol directly rather than through `@vscode/debugadapter`:
 * the handful of requests it answers do not justify a dependency.
 */

export const DEBUG_TYPE = 'gemdb';

/** The one thread a paused evaluation has. */
const THREAD_ID = 1;

/** A stack frame as the Debug Adapter Protocol spells it. */
export interface DapFrame {
  id: number;
  name: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  /** A path VS Code opens, or a `sourceReference` the adapter answers with saved text. */
  source?: { name: string; path?: string; sourceReference?: number; origin?: string };
  presentationHint?: 'normal' | 'subtle';
}

/** A scope row, as the Debug Adapter Protocol spells it. */
export interface DapScope {
  name: string;
  variablesReference: number;
  presentationHint?: 'locals' | 'globals';
  expensive: boolean;
}

/** A variable row, as the Debug Adapter Protocol spells it. */
export interface DapVariable {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
  indexedVariables?: number;
  namedVariables?: number;
}

/** Where an `evaluate` came from: the Debug Console, or the Watch pane. */
export type ConsoleContext = 'repl' | 'watch';

/**
 * What one Debug Console line or watch came back with. `output` is what it
 * printed, sent to the console before the answer; on an error, `traceback`
 * reads as a Jupyter notebook's does.
 */
export type ConsoleAnswer =
  | {
      kind: 'value';
      output: string;
      /** The result's repr, without a type badge; '' for None or a statement. */
      value: string;
      type?: string;
      /** Opens the result like a Variables row; 0 for a leaf. */
      variablesReference: number;
      indexedVariables?: number;
      namedVariables?: number;
    }
  | { kind: 'error'; output: string; traceback: string }
  | { kind: 'interrupted'; output: string };

/** One evaluation sitting at a breakpoint(), waiting for the user. */
export interface Pause {
  label: string;
  /** The session owner the paused evaluation belongs to — a notebook's key. */
  ownerKey?: string;
  frames: DapFrame[];
  /** The Locals and Globals of one frame, by its DAP id. */
  scopes(frameId: number): DapScope[];
  /** The children of one expandable row, `count` of them from `start`. */
  variables(ref: number, start: number, count: number): Promise<DapVariable[]>;
  /** Settle the pause. Only the first call counts. */
  answer(choice: HaltAnswer): void;
  /**
   * The registry handle of the row called `name` under `containerRef`, as
   * last listed — how a command on a row reaches its object in the gem.
   */
  handleFor?(containerRef: number, name: string): number | undefined;
  /** Run a query in the paused session (see `HaltRequest.query`). */
  query?(code: string): Promise<string>;
  /**
   * Run Debug Console or watch input in frame `frameId`, with that frame's
   * names in scope, until it finishes or `signal` aborts it. Absent where
   * the pause offers no evaluation, such as a saved stack.
   */
  evaluate?(
    source: string,
    frameId: number,
    context: ConsoleContext,
    signal: AbortSignal,
    /** A registry entry to run with as `self`: a Variables row's object (`consoleQuery`). */
    selfHandle?: number,
  ): Promise<ConsoleAnswer>;
  /** The object of registry entry `handle`, as a console entry named `name`. */
  showRow?(handle: number, name: string): Promise<ConsoleAnswer>;
  /** Each frame's whole cell or file, by frame index, so the stack can be saved. */
  texts?: Array<string[] | undefined>;
  /** The saved source behind a frame's `sourceReference`, for a stack opened from the database. */
  sourceText?(sourceReference: number): string | undefined;
  /** What the stop says in the Call Stack; `Paused on breakpoint()` when absent. */
  description?: string;
  /** A saved stack opened again: nothing to resume, and nothing more to save. */
  saved?: boolean;
  /** Replace the run's red dots while paused (see `HaltRequest.rearm`); absent on a saved stack. */
  rearm?(dots: DotsByFile): Promise<Map<string, number[]>>;
  /** The red dots the run was armed with when it paused (see `HaltRequest.armedDots`). */
  armedDots?: DotsByFile;
  /** What stopped the run; absent on a saved stack. */
  reason?: HaltRequest['reason'];
}

/**
 * The scopes of a frame whose locals are at `locals` and globals at `globals`
 * (0 = none).
 *
 * Neither is marked expensive. VS Code opens the first scope that is not, so
 * a function's frame opens on its Locals, and a cell's top level — which has
 * no Locals, its names being the notebook's globals — opens on Globals rather
 * than showing nothing open at all.
 */
export function scopesFor(locals: number, globals: number): DapScope[] {
  const scopes: DapScope[] = [];
  if (locals > 0) {
    scopes.push({
      name: 'Locals',
      variablesReference: locals,
      presentationHint: 'locals',
      expensive: false,
    });
  }
  if (globals > 0) {
    scopes.push({
      name: 'Globals',
      variablesReference: globals,
      presentationHint: 'globals',
      expensive: false,
    });
  }
  return scopes;
}

/**
 * A row for the Variables view. A list or set — or a dict too big for one
 * page — says how many items it has, so VS Code pages it rather than asking
 * for ten million rows at once.
 */
export function toDapVariable(v: PauseVariable): DapVariable {
  return {
    name: v.name,
    value: v.value,
    ...(v.type ? { type: v.type } : {}),
    variablesReference: v.ref,
    ...(v.indexed > 0 ? { indexedVariables: v.indexed } : {}),
    ...(v.named > 0 ? { namedVariables: v.named } : {}),
  };
}

/** Pauses by id, so a launch request can find the one it was started for. */
const pauses = new Map<string, Pause>();
let nextPauseId = 1;
/** Pause ids by VS Code debug session id, for a command run on a Variables row. */
const pausesByDebugSession = new Map<string, string>();

/** The pause a debug session was started for, if it is still paused. */
export function pauseForDebugSession(sessionId: string | undefined): Pause | undefined {
  const id = sessionId === undefined ? undefined : pausesByDebugSession.get(sessionId);
  return id === undefined ? undefined : pauses.get(id);
}

/** Opens a debug session on a pause built outside the halt handler; set while registered. */
let opener: ((pause: Pause) => Promise<boolean>) | undefined;

/**
 * Open Run and Debug on a pause that no halt produced — a saved stack rebuilt
 * from the database. Answers whether the debugger started. The pause's own
 * `answer` runs when the session ends, however it ends.
 */
export function openPause(pause: Pause): Promise<boolean> {
  return opener ? opener(pause) : Promise.resolve(false);
}

/** Every code cell of every open notebook, for telling whether a saved frame's cell is still there. */
export function openCellTexts(): Array<{ uri: string; lines: string[] }> {
  return vscode.workspace.notebookDocuments.flatMap((notebook) =>
    notebook
      .getCells()
      .filter((cell) => cell.kind === vscode.NotebookCellKind.Code)
      .map((cell) => ({
        uri: cell.document.uri.toString(),
        lines: cell.document.getText().split(/\r?\n/),
      })),
  );
}

/** The pause a notebook's evaluation is sitting at, if any. */
export function pauseForOwner(ownerKey: string): Pause | undefined {
  return [...pauses.values()].find((pause) => pause.ownerKey === ownerKey);
}

/** The running cell per notebook, so a `<grail>` frame prefers it. */
const runningCells = new Map<string, string>();

/**
 * Record which cell a notebook is running, or that it finished (`undefined`).
 * Called by the notebook controller around each cell.
 */
export function noteRunningCell(ownerKey: string, cellUri: string | undefined): void {
  if (cellUri === undefined) runningCells.delete(ownerKey);
  else runningCells.set(ownerKey, cellUri);
}

/** Reads a file's lines for a frame outside the notebook; undefined if it cannot. */
export type LineReader = (file: string) => string[] | undefined;

/** A UTF-16 offset for a code-point offset into `text` — Grail counts one, VS Code the other. */
function utf16Offset(text: string, codePoints: number): number {
  return Array.from(text).slice(0, codePoints).join('').length;
}

/**
 * The columns of the statement a frame is paused on, 1-based and
 * end-exclusive in UTF-16 units, or undefined when there is nothing better
 * than the whole line.
 *
 * What VS Code does with them (read from the 1.134 workbench): it still paints
 * the whole line, and puts an arrow marker just before the start column when
 * that is past column 1. So the start column is what the user sees; the end
 * is reported for completeness.
 *
 * Grail's span is the first choice, converted from code points (so a line with
 * an emoji before the breakpoint lands right). A frame without one — a def in
 * a cell is a block, and Grail misplaces a block's span — gets the text it
 * does carry found on the line, or else the line from its first non-blank
 * character.
 */
function columnsOn(
  text: string | undefined,
  frame: PythonFrame,
): { column: number; endColumn: number } | undefined {
  if (text === undefined) {
    if (frame.endLine !== frame.line || frame.endColumn <= frame.column) return undefined;
    return { column: frame.column + 1, endColumn: frame.endColumn + 1 };
  }
  if (frame.endLine === frame.line && frame.endColumn > frame.column) {
    return {
      column: utf16Offset(text, frame.column) + 1,
      endColumn: utf16Offset(text, frame.endColumn) + 1,
    };
  }
  const wanted = firstLineOf(frame.lineText);
  const at = wanted ? text.indexOf(wanted) : -1;
  if (at >= 0) return { column: at + 1, endColumn: at + wanted.length + 1 };
  const start = text.search(/\S/);
  if (start < 0) return undefined;
  return { column: start + 1, endColumn: text.trimEnd().length + 1 };
}

/**
 * Turn Grail's frames into DAP frames with somewhere to show them.
 *
 * A frame with a real path points at that file. A `<grail>` frame came from
 * notebook code, so it is matched to its cell (see `locateCell`) and shown
 * there by the cell's URI — VS Code opens a `vscode-notebook-cell:` path as
 * the cell itself — and labelled the way the cell is labelled on screen. A
 * frame with nowhere to go is kept, dimmed: its name is still worth reading
 * in the stack. Each file is read once, however many frames are in it.
 */
export function toDapFrames(
  frames: PythonFrame[],
  running: CellText | undefined,
  cells: CellText[],
  readLines: LineReader = () => undefined,
  /** Receives each frame's whole cell or file, by frame index. */
  texts?: Array<string[] | undefined>,
): DapFrame[] {
  const files = new Map<string, string[] | undefined>();
  const linesOf = (file: string): string[] | undefined => {
    if (!files.has(file)) files.set(file, readLines(file));
    return files.get(file);
  };
  return frames.map((frame, index): DapFrame => {
    const id = index + 1;
    let source: DapFrame['source'];
    let text: string | undefined;
    if (frame.file === '<grail>') {
      const uri = locateCell(frame, running, cells);
      const cell = cells.find((c) => c.uri === uri);
      if (cell) {
        source = { name: cell.label ?? 'Cell', path: cell.uri };
        text = cell.lines[frame.line - 1];
        if (texts) texts[index] = cell.lines;
      }
    } else if (frame.file) {
      source = { name: path.basename(frame.file), path: frame.file };
      text = frame.line > 0 ? linesOf(frame.file)?.[frame.line - 1] : undefined;
      if (texts) texts[index] = linesOf(frame.file);
    }
    const columns = source && frame.line > 0 ? columnsOn(text, frame) : undefined;
    return {
      id,
      name: frame.name,
      line: frame.line,
      column: columns?.column ?? 1,
      ...(columns ? { endLine: frame.line, endColumn: columns.endColumn } : {}),
      ...(source ? { source } : { presentationHint: 'subtle' as const }),
    };
  });
}

// ---------------------------------------------------------------------------
// Red dots.
// ---------------------------------------------------------------------------

/** One gutter breakpoint, as much of it as red dots read. */
export interface GutterDot {
  /** The file's path, or undefined for something that is not a file on disk (a notebook cell). */
  file: string | undefined;
  /** 1-based. */
  line: number;
  enabled: boolean;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
}

/** Whether a dot asks for more than "stop here", which red dots cannot do yet. */
function isPlain(dot: Pick<GutterDot, 'condition' | 'hitCondition' | 'logMessage'>): boolean {
  return !dot.condition && !dot.hitCondition && !dot.logMessage;
}

/** Every spelling of a path the database might know a file by: as given, and with links resolved. */
export type PathSpellings = (file: string) => string[];

function spellingsOnDisk(file: string): string[] {
  try {
    const real = fs.realpathSync(file);
    return real === file ? [file] : [file, real];
  } catch {
    return [file];
  }
}

/**
 * The red dots GemDB can set: enabled, plain, in a `.py` file. Each file is
 * listed under every spelling of its path, because Grail names a module's
 * file by the path it found it at — one spelling through a link, another
 * without (`/uffda1` and `/export/uffda1` on this kind of host).
 */
export function redDotsOf(
  dots: GutterDot[],
  spellings: PathSpellings = spellingsOnDisk,
): DotsByFile {
  const byFile = new Map<string, number[]>();
  for (const dot of dots) {
    if (!dot.enabled || !dot.file?.endsWith('.py') || !isPlain(dot)) continue;
    const lines = byFile.get(dot.file) ?? [];
    if (!lines.includes(dot.line)) lines.push(dot.line);
    byFile.set(dot.file, lines);
  }
  const all = new Map<string, number[]>();
  for (const [file, lines] of byFile) {
    for (const spelling of spellings(file)) all.set(spelling, lines);
  }
  return all;
}

/** The gutter's breakpoints, as red dots read them. */
function gutterDots(): GutterDot[] {
  return vscode.debug.breakpoints
    .filter((b): b is vscode.SourceBreakpoint => b instanceof vscode.SourceBreakpoint)
    .map((b) => ({
      file: b.location.uri.scheme === 'file' ? b.location.uri.fsPath : undefined,
      line: b.location.range.start.line + 1,
      enabled: b.enabled,
      condition: b.condition,
      hitCondition: b.hitCondition,
      logMessage: b.logMessage,
    }));
}

const NOT_IN_CELLS =
  'Red dots work in .py files. In a notebook cell, put breakpoint() on the line instead.';
const NOT_PLAIN = "Conditions, hit counts and log messages on red dots aren't supported yet.";
const NOT_ARMED =
  "GemDB has no code for this line yet: it is blank, or its file hasn't been imported in this run.";
const NOT_LIVE = 'This is a saved stack: there is no run for a red dot to stop.';

/** A DAP `setBreakpoints` request's own breakpoints. */
interface WantedDot {
  line: number;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
}

/**
 * `dots` with one file's entry replaced by what a `setBreakpoints` request
 * asks for — the request is the newest word on that file — under every
 * spelling of it: those `dots` already had, found by shared spellings, and
 * those `spellings` gives for `file`. A request made under one spelling must
 * not leave the old lines standing under another.
 */
export function withFileDots(
  dots: DotsByFile,
  file: string,
  wanted: WantedDot[],
  spellings: PathSpellings = spellingsOnDisk,
): DotsByFile {
  const next = new Map(dots);
  const lines = file.endsWith('.py') ? [...new Set(wanted.filter(isPlain).map((w) => w.line))] : [];
  const mine = new Set(spellings(file));
  for (const key of dots.keys()) {
    if (!mine.has(key) && spellings(key).some((s) => mine.has(s))) mine.add(key);
  }
  for (const spelling of mine) {
    if (lines.length > 0) next.set(spelling, lines);
    else next.delete(spelling);
  }
  return next;
}

/** Whether two sets of red dots would set the same breaks. */
export function sameDots(a: DotsByFile, b: DotsByFile): boolean {
  if (a.size !== b.size) return false;
  for (const [file, lines] of a) {
    const other = b.get(file);
    if (!other || other.length !== lines.length) return false;
    if (lines.some((line) => !other.includes(line))) return false;
  }
  return true;
}

/** The DAP answer to a `setBreakpoints` request, given what is now armed in `file`. */
export function verifiedDots(
  file: string | undefined,
  wanted: WantedDot[],
  armed: readonly number[] | undefined,
  live: boolean,
): Array<{ verified: boolean; line: number; message?: string }> {
  return wanted.map((w) => {
    if (!file?.endsWith('.py')) return { verified: false, line: w.line, message: NOT_IN_CELLS };
    if (!isPlain(w)) return { verified: false, line: w.line, message: NOT_PLAIN };
    if (!live) return { verified: false, line: w.line, message: NOT_LIVE };
    if (armed?.includes(w.line)) return { verified: true, line: w.line };
    return { verified: false, line: w.line, message: NOT_ARMED };
  });
}

// ---------------------------------------------------------------------------
// The adapter.
// ---------------------------------------------------------------------------

interface DapRequest {
  seq: number;
  type: 'request';
  command: string;
  arguments?: Record<string, unknown>;
}

const NOT_YET_STEP = "Stepping isn't supported yet. Use Continue to resume or Stop to end the run.";
const NOT_HERE = 'Evaluating expressions is not available here.';
const NO_HOVER = "GemDB doesn't evaluate on hover: a hover must not run code.";
const INTERRUPTED = 'Interrupted.';
const WATCH_TOO_LONG =
  'Took too long for a watch (over 2 seconds). Run it in the Debug Console, which has no limit.';

/**
 * How long a console line runs before a notification offers to stop it. The
 * Debug Console has no stop button of its own, and VS Code shows no Pause in
 * the toolbar while the program is paused.
 */
export const OFFER_STOP_AFTER_MS = 4_000;
const NOT_YET_RESTART =
  "Restarting isn't supported yet. Use Continue to resume or Stop to end the run.";

/**
 * One debug session, for one pause.
 *
 * The session ends after Continue: the evaluation is running again and has
 * nothing to show until it pauses at the next breakpoint(), which starts a
 * session of its own. Ending the session any other way — Stop, closing the
 * window — stops the evaluation, since leaving it paused with no debugger
 * would strand the cell.
 */
export class PauseDebugAdapter implements vscode.DebugAdapter {
  private readonly emitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
  readonly onDidSendMessage = this.emitter.event;
  private seq = 1;
  private pause: Pause | undefined;
  private attached = false;
  private configured = false;
  private stoppedSent = false;
  private settled = false;
  private ended = false;
  /**
   * The red dots the run is armed with: what the session armed it from, taken
   * at launch, then each re-arm's. Not the gutter's — a dot added while the
   * run was still running is in the gutter but holds no break.
   */
  private dots: DotsByFile = new Map();
  /** False after a re-arm failed: the run's breaks are unknown until the next succeeds. */
  private dotsKnown = true;
  /** setBreakpoints requests answered one at a time, so each builds on the last. */
  private dotWork: Promise<void>;
  /** Resolves at launch: VS Code may send setBreakpoints before it, and they wait. */
  private markLaunched: () => void = () => {};
  /** Whether VS Code said, in `initialize`, that it reads the `invalidated` event. */
  private clientInvalidates = false;
  /** Console lines still running, by request seq, so `cancel` can stop one. */
  private readonly running = new Map<number, AbortController>();

  constructor(
    private readonly lookup: (id: string) => Pause | undefined,
    private readonly spellings: PathSpellings = spellingsOnDisk,
  ) {
    this.dotWork = new Promise((resolve) => (this.markLaunched = resolve));
  }

  handleMessage(message: vscode.DebugProtocolMessage): void {
    const request = message as DapRequest;
    if (request.type !== 'request') return;
    switch (request.command) {
      case 'initialize':
        this.clientInvalidates = request.arguments?.supportsInvalidatedEvent === true;
        this.respond(request, {
          supportsConfigurationDoneRequest: true,
          supportsTerminateRequest: true,
          // A console line can run for as long as the user's code does.
          supportsCancelRequest: true,
          // Claimed so Restart arrives as a request this adapter can decline.
          // Unclaimed, VS Code restarts by disconnecting — which stops the
          // cell — and relaunching at a pause that no longer exists.
          supportsRestartRequest: true,
        });
        this.event('initialized');
        return;
      case 'launch':
      case 'attach': {
        const id = String(request.arguments?.gemdbPause ?? '');
        this.pause = this.lookup(id);
        if (!this.pause) {
          // The pause ended — interrupted, its session closed — before VS Code
          // got here. There is nothing to show and nothing gone wrong, so the
          // session just ends, with no error for the user to dismiss.
          this.markLaunched();
          this.respond(request);
          this.end();
          return;
        }
        this.attached = true;
        this.dots = this.pause.armedDots ?? new Map();
        this.markLaunched();
        this.respond(request);
        this.maybeStopped();
        return;
      }
      case 'configurationDone':
        this.configured = true;
        this.respond(request);
        this.maybeStopped();
        return;
      case 'setBreakpoints': {
        const wanted = (request.arguments?.breakpoints as WantedDot[] | undefined) ?? [];
        const file = (request.arguments?.source as { path?: string } | undefined)?.path;
        this.dotWork = this.dotWork.then(() => this.setDots(request, file, wanted));
        return;
      }
      case 'setExceptionBreakpoints':
      case 'setFunctionBreakpoints':
        this.respond(request, { breakpoints: [] });
        return;
      case 'threads':
        this.respond(request, {
          threads: [{ id: THREAD_ID, name: this.pause?.label ?? 'GemDB' }],
        });
        return;
      case 'stackTrace': {
        const frames = this.pause?.frames ?? [];
        this.respond(request, { stackFrames: frames, totalFrames: frames.length });
        return;
      }
      case 'source': {
        // A saved stack's frame whose cell or file is gone shows the text saved with it.
        const ref = Number(
          (request.arguments?.source as { sourceReference?: number } | undefined)
            ?.sourceReference ??
            request.arguments?.sourceReference ??
            0,
        );
        const content = this.pause?.sourceText?.(ref);
        if (content === undefined) {
          this.fail(request, 'That source is not available.', false);
        } else {
          this.respond(request, { content, mimeType: 'text/x-python' });
        }
        return;
      }
      case 'scopes': {
        const frameId = Number(request.arguments?.frameId ?? 0);
        this.respond(request, { scopes: this.pause?.scopes(frameId) ?? [] });
        return;
      }
      case 'variables': {
        const ref = Number(request.arguments?.variablesReference ?? 0);
        const start = Number(request.arguments?.start ?? 0);
        // No count means "all". A row with more than a page reports its
        // children as indexed, which VS Code asks for a page at a time, so
        // capping here never hides a row.
        const count = Number(request.arguments?.count ?? 0) || PAGE;
        const pause = this.pause;
        if (!pause) {
          this.respond(request, { variables: [] });
          return;
        }
        void pause
          .variables(ref, start, Math.min(count, PAGE))
          .then((variables) => this.respond(request, { variables }));
        return;
      }
      case 'continue':
        this.respond(request, { allThreadsContinued: true });
        this.settle('continue');
        this.end();
        return;
      case 'restart':
        this.fail(request, NOT_YET_RESTART, true);
        return;
      case 'next':
      case 'stepIn':
      case 'stepOut':
      case 'stepBack':
      case 'reverseContinue':
      case 'restartFrame':
      case 'goto':
        this.fail(request, NOT_YET_STEP, true);
        return;
      case 'pause':
        // Only offered while running, and a paused evaluation is never running here.
        this.respond(request);
        return;
      case 'evaluate':
        this.evaluate(request);
        return;
      case 'gemdbShowRow':
        this.showRow(request);
        return;
      case 'cancel': {
        const id = Number(request.arguments?.requestId ?? 0);
        this.running.get(id)?.abort();
        this.respond(request);
        return;
      }
      case 'terminate':
        this.respond(request);
        this.settle('stop');
        this.end();
        return;
      case 'disconnect':
        this.respond(request);
        this.settle('stop');
        this.end();
        return;
      default:
        this.fail(request, `GemDB's debugger does not support '${request.command}' yet.`, false);
    }
  }

  /**
   * Answer one setBreakpoints request. A change to a `.py` file's dots re-arms
   * the paused run, so a dot added now stops it later in this run; an
   * unchanged set — VS Code re-sends every file's dots as the session starts —
   * leaves the run alone, since re-arming converts its stack to slower code,
   * and only asks what holds a break. After a failed re-arm nothing is known,
   * so the next request re-arms whatever it says.
   */
  private async setDots(request: DapRequest, file: string | undefined, wanted: WantedDot[]) {
    const pause = this.pause;
    const live = !!pause?.rearm;
    let armed: readonly number[] | undefined;
    if (pause?.rearm && file?.endsWith('.py')) {
      const next = withFileDots(this.dots, file, wanted, this.spellings);
      try {
        const lines =
          this.dotsKnown && sameDots(next, this.dots) && pause.query
            ? parseArmed(await pause.query(armedLinesQuery(next)))
            : await pause.rearm(next);
        this.dots = next;
        this.dotsKnown = true;
        armed = this.spellings(file)
          .map((spelling) => lines.get(spelling))
          .find((found) => found !== undefined);
      } catch (e) {
        this.dotsKnown = false;
        log(`Could not set red dots in ${path.basename(file)}: ${errorMessage(e)}`);
      }
    }
    this.respond(request, { breakpoints: verifiedDots(file, wanted, armed, live) });
  }

  /**
   * Answer a Debug Console line or a watch. Hover is refused: `initialize`
   * does not claim it, and a hover must never run code that could change
   * something.
   *
   * What the line printed goes to the console first, then the answer: its
   * value, which opens like a Variables row, or a failure whose message is a
   * Jupyter traceback, or "Interrupted.". After a console line, failed or not
   * — it may have changed something first — VS Code is told to read the
   * variables again. Never after a watch: VS Code re-runs the watches when it
   * re-reads, and each would invalidate the next.
   *
   * A console line runs as long as it takes; past `OFFER_STOP_AFTER_MS` a
   * notification offers to stop it, as DAP's `cancel` does. A watch keeps the
   * two-second budget the Variables rows have, since every watch re-runs at
   * every stop.
   */
  private evaluate(request: DapRequest): void {
    const context = String(request.arguments?.context ?? 'repl');
    const source = String(request.arguments?.expression ?? '');
    const pause = this.pause;
    if (context === 'hover') {
      this.fail(request, NO_HOVER, false);
      return;
    }
    if (!pause?.evaluate) {
      this.fail(request, NOT_HERE, false);
      return;
    }
    const kind: ConsoleContext = context === 'watch' ? 'watch' : 'repl';
    const frameId = Number(request.arguments?.frameId ?? pause.frames[0]?.id ?? 1);
    const { controller, finish } = this.track(request, kind === 'repl');
    pause.evaluate(source, frameId, kind, controller.signal).then(
      (answer) => {
        finish();
        if (answer.output) this.event('output', { category: 'stdout', output: answer.output });
        if (answer.kind === 'value') {
          this.respond(request, {
            result: answer.value,
            ...(answer.type ? { type: answer.type } : {}),
            variablesReference: answer.variablesReference,
            ...(answer.indexedVariables ? { indexedVariables: answer.indexedVariables } : {}),
            ...(answer.namedVariables ? { namedVariables: answer.namedVariables } : {}),
          });
        } else if (answer.kind === 'error') {
          this.fail(request, answer.traceback, false);
        } else {
          this.fail(
            request,
            kind === 'watch' && !controller.signal.aborted ? WATCH_TOO_LONG : INTERRUPTED,
            false,
          );
        }
        if (kind === 'repl' && this.clientInvalidates) {
          this.event('invalidated', { areas: ['variables'] });
        }
      },
      (e: unknown) => {
        finish();
        this.fail(request, errorMessage(e), false);
      },
    );
  }

  /**
   * Note a running console line under its request, so `cancel` can stop it,
   * and, when `offerStop`, offer to stop it from a notification once it has
   * run `OFFER_STOP_AFTER_MS`. `finish` when it is done.
   */
  private track(
    request: DapRequest,
    offerStop: boolean,
  ): { controller: AbortController; finish: () => void } {
    const controller = new AbortController();
    this.running.set(request.seq, controller);
    let finished = false;
    let markDone: () => void = () => {};
    const done = new Promise<void>((resolve) => (markDone = resolve));
    const offer = offerStop
      ? setTimeout(() => {
          if (finished) return;
          void vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: 'GemDB: the Debug Console is still running',
              cancellable: true,
            },
            (_progress, token) => {
              token.onCancellationRequested(() => controller.abort());
              return done;
            },
          );
        }, OFFER_STOP_AFTER_MS)
      : undefined;
    const finish = (): void => {
      finished = true;
      if (offer) clearTimeout(offer);
      this.running.delete(request.seq);
      markDone();
    };
    return { controller, finish };
  }

  /**
   * Put a Variables row in the Debug Console (`gemdbShowRow`), for the
   * row's menu (`variableCommands.ts`): its object, as an entry that expands
   * like the row, or with `expression`, what that gives with `self` bound to
   * the object, run in the frame `frameId` as a console line is. Shown as
   * `output` events, since there is no console request to answer: an echo of
   * the expression, what it printed, then the value, a traceback, or
   * "Interrupted.".
   */
  private showRow(request: DapRequest): void {
    const pause = this.pause;
    const handle = Number(request.arguments?.handle ?? 0);
    const name = String(request.arguments?.name ?? '');
    const expression =
      request.arguments?.expression === undefined
        ? undefined
        : String(request.arguments.expression);
    if (!pause?.showRow || !pause.evaluate || handle <= 0) {
      this.fail(request, NOT_HERE, true);
      return;
    }
    const frameId = Number(request.arguments?.frameId ?? pause.frames[0]?.id ?? 1);
    const { controller, finish } = this.track(request, expression !== undefined);
    if (expression !== undefined) {
      this.event('output', {
        category: 'console',
        output: `>>> ${expression}  # self is ${name}\n`,
      });
    }
    const answered =
      expression === undefined
        ? pause.showRow(handle, name)
        : pause.evaluate(expression, frameId, 'repl', controller.signal, handle);
    answered.then(
      (answer) => {
        finish();
        if (answer.output) this.event('output', { category: 'stdout', output: answer.output });
        if (answer.kind === 'value') {
          if (answer.value !== '' || answer.variablesReference > 0) {
            this.event('output', {
              category: 'console',
              output: `${expression === undefined ? `${name}: ` : ''}${answer.value}\n`,
              variablesReference: answer.variablesReference,
            });
          }
        } else {
          this.event('output', {
            category: 'stderr',
            output: `${answer.kind === 'error' ? answer.traceback : INTERRUPTED}\n`,
          });
        }
        if (expression !== undefined && this.clientInvalidates) {
          this.event('invalidated', { areas: ['variables'] });
        }
        this.respond(request);
      },
      (e: unknown) => {
        finish();
        this.fail(request, errorMessage(e), true);
      },
    );
  }

  dispose(): void {
    for (const controller of this.running.values()) controller.abort();
    // The session went away without Continue or Stop — a closed window, say.
    // Leaving the evaluation paused would strand its cell, so stop it.
    this.settle('stop');
    this.emitter.dispose();
  }

  /** Stopped is reported once both halves of the handshake are done. */
  private maybeStopped(): void {
    if (this.stoppedSent || !this.attached || !this.configured) return;
    this.stoppedSent = true;
    this.event('stopped', {
      reason: this.pause?.saved ? 'entry' : 'breakpoint',
      description: this.pause?.description ?? 'Paused on breakpoint()',
      threadId: THREAD_ID,
      allThreadsStopped: true,
    });
  }

  /** The first of Continue, Stop or disposal decides; the rest are echoes. */
  private settle(choice: HaltAnswer): void {
    if (this.settled || !this.pause) return;
    this.settled = true;
    this.pause.answer(choice);
  }

  private end(): void {
    if (this.ended) return;
    this.ended = true;
    this.event('terminated');
  }

  private respond(request: DapRequest, body?: object): void {
    this.send({
      type: 'response',
      request_seq: request.seq,
      success: true,
      command: request.command,
      ...(body ? { body } : {}),
    });
  }

  private fail(request: DapRequest, message: string, showUser: boolean): void {
    this.send({
      type: 'response',
      request_seq: request.seq,
      success: false,
      command: request.command,
      message,
      body: { error: { id: 1, format: message, showUser } },
    });
  }

  private event(event: string, body?: object): void {
    this.send({ type: 'event', event, ...(body ? { body } : {}) });
  }

  private send(message: object): void {
    this.emitter.fire({ seq: this.seq++, ...message } as vscode.DebugProtocolMessage);
  }
}

// ---------------------------------------------------------------------------
// Wiring: a halt becomes a debug session.
// ---------------------------------------------------------------------------

/**
 * The text of every code cell in the notebook a session belongs to, and the
 * running one. Each is labelled as the notebook shows it: by its execution
 * count, `Cell [7]`, when it has run, else by its position among all cells.
 */
function notebookCells(ownerKey: string): { running: CellText | undefined; cells: CellText[] } {
  const notebook = vscode.workspace.notebookDocuments.find((nb) => nb.uri.toString() === ownerKey);
  if (!notebook) return { running: undefined, cells: [] };
  const cells = notebook
    .getCells()
    .filter((cell) => cell.kind === vscode.NotebookCellKind.Code)
    .map((cell) => {
      const order = cell.executionSummary?.executionOrder;
      return {
        uri: cell.document.uri.toString(),
        lines: cell.document.getText().split(/\r?\n/),
        label: order === undefined ? `Cell ${cell.index + 1}` : `Cell [${order}]`,
      };
    });
  const runningUri = runningCells.get(ownerKey);
  return { running: cells.find((cell) => cell.uri === runningUri), cells };
}

/** A file's lines, for highlighting a frame in an imported module. */
function readFileLines(file: string): string[] | undefined {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/);
  } catch {
    return undefined;
  }
}

/** What the debugger shows of one pause: its frames and, by DAP frame id, their scopes. */
interface PauseView {
  frames: DapFrame[];
  scopes: Map<number, DapScope[]>;
  texts: Array<string[] | undefined>;
  /** Where each frame's Debug Console names come from, by DAP frame id. */
  consoles: Map<number, ConsoleScope>;
}

/**
 * Read the paused stack and register its variables, in one walk. A failure
 * costs the frames and variables, never the pause.
 *
 * The globals are offered only under the frames of the code that owns them: a
 * notebook's under a frame a cell compiled (`<grail>`), a run file's under its
 * own frames. A frame in an imported module has that module's globals, which
 * Grail does not hand over here, and showing the run's under it would mislead.
 * Its Debug Console does see them: the console finds the module by its file
 * when the frame's first line is typed (`consoleQuery`).
 */
async function readPause(request: HaltRequest): Promise<PauseView> {
  try {
    const owner = request.session.owner;
    const scopeKey =
      owner.kind === 'notebook' ? owner.key : owner.kind === 'file' ? MAIN_MODULE : undefined;
    const { frames, globals } = parsePausedStack(
      await request.query(
        pausedStackQuery(request.process, scopeKey, request.reason === 'red dot'),
      ),
    );
    const ownFile = owner.kind === 'file' ? runFileOf(owner.key) : '<grail>';
    const scopes = new Map<number, DapScope[]>();
    const consoles = new Map<number, ConsoleScope>();
    frames.forEach((frame, index) => {
      const own = frame.file === ownFile;
      scopes.set(index + 1, scopesFor(frame.locals ?? 0, own ? globals : 0));
      consoles.set(index + 1, {
        locals: frame.locals ?? 0,
        globals: own ? globals : 0,
        ...(!own && frame.file !== '<grail>' ? { moduleFile: frame.file } : {}),
      });
    });
    const { running, cells } = notebookCells(owner.key);
    const texts: Array<string[] | undefined> = [];
    return {
      frames: toDapFrames(frames, running, cells, readFileLines, texts),
      scopes,
      texts,
      consoles,
    };
  } catch (e) {
    log(`Could not read the stack at a pause: ${errorMessage(e)}`);
    return { frames: [], scopes: new Map(), texts: [], consoles: new Map() };
  }
}

/**
 * The children of one registered object. A failure shows as no children, not
 * an error. Each row's handle is noted under `handles`, keyed by its
 * container and name, which is all a Variables-row command is handed.
 */
async function readChildren(
  request: HaltRequest,
  handles: Map<string, number>,
  ref: number,
  start: number,
  count: number,
): Promise<DapVariable[]> {
  try {
    const rows = parseChildren(await request.query(childrenQuery(ref, start, count)));
    for (const row of rows) {
      if (row.handle > 0) handles.set(handleKey(ref, row.name), row.handle);
    }
    return rows.map(toDapVariable);
  } catch (e) {
    log(`Could not read variable ${ref} at breakpoint(): ${errorMessage(e)}`);
    return [];
  }
}

function handleKey(containerRef: number, name: string): string {
  return `${containerRef}\u0000${name}`;
}

/**
 * Where a console traceback's frame is, for `jupyterTraceback`: the first
 * frame is the console's own input; a `<grail>` frame is in the notebook cell
 * holding its line (`locateCell`, the call stack's own match); anything else
 * is a file, read from disk.
 */
function placeFrame(
  ownerKey: string,
  source: string,
): (frame: TracebackFrame, index: number) => PlacedFrame {
  const { running, cells } = notebookCells(ownerKey);
  return (frame, index) => {
    if (frame.file === '<grail>') {
      if (index === 0 && frame.name === '<module>') {
        return { label: 'Debug Console', isFile: false, lines: source.split(/\r?\n/) };
      }
      const uri = locateCell(
        { ...frame, column: 0, endLine: frame.line, endColumn: 0, lineText: frame.text },
        running,
        cells,
      );
      const cell = cells.find((c) => c.uri === uri);
      return cell
        ? { label: cell.label ?? 'Cell', isFile: false, lines: cell.lines }
        : { label: 'Cell', isFile: false };
    }
    if (frame.file === '<string>' || frame.file === '') {
      return { label: 'Debug Console', isFile: false, lines: source.split(/\r?\n/) };
    }
    return { label: `File ${frame.file}`, isFile: true, lines: readFileLines(frame.file) };
  };
}

/** A Variables row's object as a console entry (`Pause.showRow`). */
async function showRowAt(
  request: HaltRequest,
  handle: number,
  name: string,
): Promise<ConsoleAnswer> {
  const raw = await request.query(describeRowQuery(handle, name));
  if (raw.startsWith('Error: ')) {
    return { kind: 'error', output: '', traceback: raw.slice('Error: '.length) };
  }
  const [row] = parseChildren(raw);
  if (!row) return { kind: 'error', output: '', traceback: 'The row could not be read.' };
  const dap = toDapVariable(row);
  return {
    kind: 'value',
    output: '',
    value: dap.value,
    ...(dap.type ? { type: dap.type } : {}),
    variablesReference: dap.variablesReference,
  };
}

/**
 * Run a Debug Console line or a watch in one frame of a pause (`Pause.evaluate`).
 * The frame's console scope is made by its first line and found again by
 * `consoleRefs` after that. A console line runs without the paused queries'
 * time budget, a watch with it; both run straight past a breakpoint() in
 * code they call, as debugpy's evaluation does.
 */
async function evaluateAt(
  request: HaltRequest,
  view: PauseView,
  consoleRefs: Map<number, number>,
  source: string,
  frameId: number,
  context: ConsoleContext,
  signal: AbortSignal,
  selfHandle = 0,
): Promise<ConsoleAnswer> {
  const scope = view.consoles.get(frameId) ?? { locals: 0, globals: 0 };
  const reply = parseConsoleReply(
    await request.query(consoleQuery(scope, consoleRefs.get(frameId) ?? 0, source, selfHandle), {
      budget: context === 'watch',
      signal,
      passHalts: true,
    }),
  );
  if (reply.consoleRef > 0) consoleRefs.set(frameId, reply.consoleRef);
  const output = reply.output;
  switch (reply.kind) {
    case 'value': {
      const row = toDapVariable(reply.row);
      return {
        kind: 'value',
        output,
        value: row.value,
        ...(row.type ? { type: row.type } : {}),
        variablesReference: row.variablesReference,
        ...(row.indexedVariables ? { indexedVariables: row.indexedVariables } : {}),
        ...(row.namedVariables ? { namedVariables: row.namedVariables } : {}),
      };
    }
    case 'none':
      return { kind: 'value', output, value: '', variablesReference: 0 };
    case 'interrupted':
      return { kind: 'interrupted', output };
    case 'error':
      return {
        kind: 'error',
        output,
        traceback: jupyterTraceback(reply.error, placeFrame(request.session.owner.key, source)),
      };
    case 'failed':
      return { kind: 'error', output, traceback: reply.message };
  }
}

/**
 * Answer every breakpoint() and red dot in this window with a debug session.
 *
 * The halt handler registers the pause, starts a debug session aimed at it,
 * and waits for the adapter to settle it. If the session cannot start, the
 * evaluation is stopped with a message rather than left paused where nothing
 * can reach it.
 */
export function registerBreakpointDebugger(): vscode.Disposable {
  const sessionsByPause = new Map<string, vscode.DebugSession>();

  const factory = vscode.debug.registerDebugAdapterDescriptorFactory(DEBUG_TYPE, {
    createDebugAdapterDescriptor(session) {
      const id = String(session.configuration.gemdbPause ?? '');
      // A pause that already ended needs no session to stop later.
      if (pauses.has(id)) {
        sessionsByPause.set(id, session);
        pausesByDebugSession.set(session.id, id);
      }
      return new vscode.DebugAdapterInlineImplementation(
        new PauseDebugAdapter((wanted) => pauses.get(wanted)),
      );
    },
  });

  setRedDotSource(() => redDotsOf(gutterDots()));
  setHaltHandler(
    (request) =>
      new Promise<HaltAnswer>((resolve) => {
        const id = String(nextPauseId++);
        const label = request.session.owner.label;
        let settled = false;
        const answer = (choice: HaltAnswer): void => {
          if (settled) return;
          settled = true;
          pauses.delete(id);
          sessionsByPause.delete(id);
          for (const [sessionId, pauseId] of pausesByDebugSession) {
            if (pauseId === id) pausesByDebugSession.delete(sessionId);
          }
          // Queued before the evaluation resumes, which waits for it: the
          // registry holds the pause's objects, and only the paused session
          // can drop it. A closed session has nothing to drop.
          if (request.session.connected) {
            request
              .query(clearRegistryQuery())
              .catch((e: unknown) =>
                log(`Could not clear the variables of a pause: ${errorMessage(e)}`),
              );
          }
          log(`breakpoint() in ${label}: ${choice}`);
          resolve(choice);
        };
        const couldNotOpen = (): void => {
          void vscode.window.showErrorMessage(
            'GemDB could not open the debugger at breakpoint(), so the run was stopped.',
          );
          answer('stop');
        };

        // Interrupted or closed while paused: take the debugger down with it.
        request.onCancel(() => {
          const session = sessionsByPause.get(id);
          answer('stop');
          if (session) void vscode.debug.stopDebugging(session);
        });

        const where = request.reason === 'red dot' ? 'a red dot' : 'breakpoint()';
        log(`${where} in ${label}: paused`);
        void readPause(request).then((view) => {
          const { frames, scopes, texts } = view;
          if (settled) return;
          const handles = new Map<string, number>();
          const consoleRefs = new Map<number, number>();
          pauses.set(id, {
            label,
            ownerKey: request.session.owner.key,
            frames,
            scopes: (frameId) => scopes.get(frameId) ?? [],
            variables: (ref, start, count) => readChildren(request, handles, ref, start, count),
            answer,
            handleFor: (containerRef, name) => handles.get(handleKey(containerRef, name)),
            query: (code) => request.query(code),
            evaluate: (source, frameId, context, signal, selfHandle) =>
              evaluateAt(request, view, consoleRefs, source, frameId, context, signal, selfHandle),
            showRow: (handle, name) => showRowAt(request, handle, name),
            rearm: (dots) => request.rearm(dots),
            armedDots: request.armedDots,
            reason: request.reason,
            texts,
            ...(request.reason === 'red dot' ? { description: 'Paused on breakpoint' } : {}),
          });
          vscode.debug
            .startDebugging(
              undefined,
              {
                type: DEBUG_TYPE,
                request: 'launch',
                name: `GemDB: ${label}`,
                gemdbPause: id,
              },
              { suppressSaveBeforeStart: true },
            )
            .then(
              (started) => {
                if (!started) couldNotOpen();
              },
              (e: unknown) => {
                log(`Could not start the debugger: ${errorMessage(e)}`);
                couldNotOpen();
              },
            );
        });
      }),
  );

  opener = async (pause) => {
    const id = String(nextPauseId++);
    let settled = false;
    const opened: Pause = {
      ...pause,
      answer: (choice) => {
        if (settled) return;
        settled = true;
        pauses.delete(id);
        sessionsByPause.delete(id);
        for (const [sessionId, pauseId] of pausesByDebugSession) {
          if (pauseId === id) pausesByDebugSession.delete(sessionId);
        }
        pause.answer(choice);
      },
    };
    pauses.set(id, opened);
    try {
      const started = await vscode.debug.startDebugging(
        undefined,
        { type: DEBUG_TYPE, request: 'launch', name: `GemDB: ${pause.label}`, gemdbPause: id },
        { suppressSaveBeforeStart: true },
      );
      if (!started) opened.answer('stop');
      return started;
    } catch (e) {
      log(`Could not open the debugger on ${pause.label}: ${errorMessage(e)}`);
      opened.answer('stop');
      return false;
    }
  };

  return new vscode.Disposable(() => {
    opener = undefined;
    setHaltHandler(undefined);
    setRedDotSource(undefined);
    factory.dispose();
    for (const [id, pause] of [...pauses.entries()]) {
      const session = sessionsByPause.get(id);
      pause.answer('stop');
      if (session) void vscode.debug.stopDebugging(session);
    }
  });
}
