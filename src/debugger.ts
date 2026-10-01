import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CellText, PythonFrame, firstLineOf, locateCell } from './haltStack';
import { errorMessage, log } from './log';
import {
  PAGE,
  PauseVariable,
  childrenQuery,
  clearRegistryQuery,
  parseChildren,
  parsePausedStack,
  pausedStackQuery,
} from './pauseVariables';
import { HaltAnswer, HaltRequest, setHaltHandler } from './session';

/**
 * A debugger for Python paused at `breakpoint()`.
 *
 * Nobody launches it. GemDB's selling point is that you just run the code, so
 * there is no Debug command and no launch configuration: when a notebook cell
 * reaches breakpoint(), the session's halt handler starts a debug session
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
 * Locals and the notebook's Globals, Continue and Stop, and saving a row's
 * object under gemdb.root (`savedObjects.ts`). Stepping, evaluation
 * and Restart answer "not yet" rather than pretending, and red-dot breakpoints
 * report themselves unverified, because Grail has no step or breakpoint
 * support to build them on.
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
  /** Each frame's whole cell or file, by frame index, so the stack can be saved. */
  texts?: Array<string[] | undefined>;
  /** The saved source behind a frame's `sourceReference`, for a stack opened from the database. */
  sourceText?(sourceReference: number): string | undefined;
  /** What the stop says in the Call Stack; `Paused on breakpoint()` when absent. */
  description?: string;
  /** A saved stack opened again: nothing to resume, and nothing more to save. */
  saved?: boolean;
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
// The adapter.
// ---------------------------------------------------------------------------

interface DapRequest {
  seq: number;
  type: 'request';
  command: string;
  arguments?: Record<string, unknown>;
}

const NOT_YET_STEP = "Stepping isn't supported yet. Use Continue to resume or Stop to end the run.";
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

  constructor(private readonly lookup: (id: string) => Pause | undefined) {}

  handleMessage(message: vscode.DebugProtocolMessage): void {
    const request = message as DapRequest;
    if (request.type !== 'request') return;
    switch (request.command) {
      case 'initialize':
        this.respond(request, {
          supportsConfigurationDoneRequest: true,
          supportsTerminateRequest: true,
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
          this.respond(request);
          this.end();
          return;
        }
        this.attached = true;
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
        // Honest about red dots: they are not wired to anything yet.
        const wanted =
          (request.arguments?.breakpoints as Array<{ line: number }> | undefined) ?? [];
        this.respond(request, {
          breakpoints: wanted.map((b) => ({
            verified: false,
            line: b.line,
            message: 'GemDB stops only at breakpoint() for now.',
          })),
        });
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
        this.fail(request, "Evaluating expressions isn't supported yet.", false);
        return;
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

  dispose(): void {
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
}

/**
 * Read the paused stack and register its variables, in one walk. A failure
 * costs the frames and variables, never the pause.
 *
 * The notebook's globals are offered only under a frame a cell compiled
 * (`<grail>`): a frame in an imported module has that module's globals, which
 * Grail does not hand over here, and showing the notebook's under it would
 * mislead.
 */
async function readPause(request: HaltRequest): Promise<PauseView> {
  try {
    const owner = request.session.owner;
    const { frames, globals } = parsePausedStack(
      await request.query(
        pausedStackQuery(request.process, owner.kind === 'notebook' ? owner.key : undefined),
      ),
    );
    const scopes = new Map<number, DapScope[]>();
    frames.forEach((frame, index) =>
      scopes.set(index + 1, scopesFor(frame.locals ?? 0, frame.file === '<grail>' ? globals : 0)),
    );
    const { running, cells } = notebookCells(owner.key);
    const texts: Array<string[] | undefined> = [];
    return { frames: toDapFrames(frames, running, cells, readFileLines, texts), scopes, texts };
  } catch (e) {
    log(`Could not read the stack at breakpoint(): ${errorMessage(e)}`);
    return { frames: [], scopes: new Map(), texts: [] };
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
 * Answer every breakpoint() in this window with a debug session.
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

        log(`breakpoint() in ${label}: paused`);
        void readPause(request).then(({ frames, scopes, texts }) => {
          if (settled) return;
          const handles = new Map<string, number>();
          pauses.set(id, {
            label,
            ownerKey: request.session.owner.key,
            frames,
            scopes: (frameId) => scopes.get(frameId) ?? [],
            variables: (ref, start, count) => readChildren(request, handles, ref, start, count),
            answer,
            handleFor: (containerRef, name) => handles.get(handleKey(containerRef, name)),
            query: (code) => request.query(code),
            texts,
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
    factory.dispose();
    for (const [id, pause] of [...pauses.entries()]) {
      const session = sessionsByPause.get(id);
      pause.answer('stop');
      if (session) void vscode.debug.stopDebugging(session);
    }
  });
}
