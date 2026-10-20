import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { dedented, withoutComment } from './consoleCommands';
import { jupyterTraceback } from './consoleTraceback';
import { DEBUG_TYPE, DapFrame, pauseForDebugSession, placeFrame } from './debugger';
import {
  InspectorHeader,
  classQuery,
  dropInspectorRegistryQuery,
  inspectorEvaluateQuery,
  inspectorRegistry,
  openQuery,
  parseClassInfo,
  parseHeader,
  parseRepr,
  parseSource,
  reprQuery,
  SourceAnswer,
  sourceAt,
  sourceQuery,
} from './inspectorQueries';
import { errorMessage, log } from './log';
import {
  MAIN_MODULE,
  MainModule,
  PERSISTED_REGISTRY,
  PauseVariable,
  REGISTRY,
  childrenQuery,
  keyPositionQuery,
  parseChildren,
  parseConsoleReply,
  setVariableQuery,
} from './pauseVariables';
import {
  AddTarget,
  ReadIn,
  SavedObjectsProvider,
  SavedRow,
  extensionQuery,
  inNotebook,
  keyNames,
} from './savedObjects';
import { sessionForIfOpen } from './session';
import { VariableContext } from './variableCommands';

/**
 * The Inspector: an editor-tab webview that shows one object at a time in a
 * strip of columns, each with tabs for what the object has — its attributes,
 * its items or entries, its whole repr, its class — and an Evaluate tab that
 * runs Python with `self` bound to it. Double-clicking a row opens its object
 * in a new column to the right; Enter dives in place, with Back and Forward.
 *
 * It is Jasper's basic Inspector, ported. The column strip
 * (`resources/inspector/millerColumns.js`) and the evaluate pane's keys and
 * history (`resources/inspector/evaluatePane.js`) are Jasper's own files,
 * copied unchanged; what is drawn inside a column is GemDB's
 * (`resources/inspector/inspectorView.js`), because a Python object's shape is
 * not a Smalltalk one. Every query is in `inspectorQueries.ts`, and a row reads
 * exactly as the Variables view reads it, because it is `childrenQuery`'s row.
 *
 * An object is read in the session it lives in (`ReadIn`): the extension's own
 * for a committed object opened from Persisted Objects, the notebook's (or the
 * debugged file's) for anything else — through the pause while it is paused,
 * directly while it is idle. While that session runs a cell, a read fails
 * and the column says so; Refresh tries again. The object stays readable after
 * the pause it was found at resumes, because the panel's own registry holds
 * it, until the panel closes or its session ends.
 *
 * Edits (Edit Value…) and Add to Persisted Objects… are offered only in a
 * notebook's or a debugged file's session. An edit runs its text as an
 * Evaluate line does, and stores the value as Set Value in the Variables view
 * does, in that session's transaction. A committed object
 * opened from Persisted Objects is read in the extension's own session, whose
 * transaction nobody commits: nothing is offered that changes it, and what an
 * Evaluate line there changes is thrown away when it finishes.
 */

/** Rows per page of Items or Entries. */
export const INSPECTOR_PAGE = 100;

/** The most rows the Attributes tab lists, grouped; past it, a last row says how many more. */
const ATTRIBUTE_ROWS = 500;

/** The most rows a group (`class variables`, …) opens to; past it, a row says how many more. */
const GROUP_ROWS = 2000;

/** Preferred starting width of a column; it grows to fill spare space. */
const DEFAULT_COLUMN_WIDTH = 360;
/** Below this a column stops shrinking and the strip scrolls instead. */
const MIN_COLUMN_WIDTH = 280;

/** What an Inspector opens on: an object in a registry of the session it lives in. */
export interface InspectTarget {
  readIn: ReadIn;
  /** The registry it was found in: the pause's or Persisted Objects'. */
  from: string;
  handle: number;
  /** What the column header calls it: the row's name, which a child column extends. */
  label: string;
  /**
   * Where it was found, said quietly in the header beside the OOP: the paused frame's file
   * (`special_values.py`, its function on hover), or Persisted Objects.
   */
  origin?: { text: string; detail: string };
}

type Mode = 'display' | 'execute' | 'inspect';

/** The tabs whose data the webview asks for. */
type TabName = 'attributes' | 'items' | 'entries' | 'repr' | 'class';

type InspectorMessage =
  | { command: 'ready' }
  | {
      command: 'fetchTab';
      columnId: number;
      handle: number;
      /** The column object's OOP: what an edited row's ↺ is remembered by. */
      oop?: string;
      tab: TabName;
      /** First row wanted, from 0. */
      start?: number;
    }
  | {
      command: 'fetchGroup';
      columnId: number;
      handle: number;
      oop?: string;
      groupRef: number;
      /** How many rows the group holds, from its heading. */
      size?: number;
    }
  | { command: 'goTo'; columnId: number; handle: number; tab: TabName; text: string }
  | { command: 'inspectRow'; sourceColumnId: number; handle: number; label: string }
  | {
      command: 'diveHere';
      columnId: number;
      handle: number;
      label: string;
      remember: boolean;
      /** A refresh: stay on the tab the column shows. */
      keepTab?: boolean;
      /** For Back and Forward: the history position this dive lands on, echoed back. */
      historyIndex?: number;
    }
  | { command: 'evaluate'; columnId: number; handle: number; expression: string; mode: Mode }
  | {
      command: 'setSlot';
      columnId: number;
      /** The registry entry the row was listed under: the column's object, or a group of its. */
      containerRef: number;
      name: string;
      /** The row's own handle before the edit: what a revert puts back. */
      valueHandle: number;
      /** The column's object, which the expression sees as `self`. */
      selfHandle: number;
      oop?: string;
      expression: string;
    }
  | {
      command: 'revertSlot';
      columnId: number;
      containerRef: number;
      selfHandle: number;
      oop?: string;
      name: string;
    }
  | {
      command: 'fetchSource';
      columnId: number;
      handle: number;
      ownerIndex: number;
      owner: string;
      name: string;
    }
  | { command: 'addToPersisted'; handle: number; name: string }
  | { command: 'copyText'; text: string; what: string }
  | { command: 'setTitle'; title: string }
  | { command: 'closePanel' };

/** The message fields that become numbers in Smalltalk, and so must be whole numbers. */
const NUMERIC_FIELDS = [
  'columnId',
  'sourceColumnId',
  'handle',
  'containerRef',
  'groupRef',
  'valueHandle',
  'selfHandle',
  'start',
  'size',
  'ownerIndex',
  'historyIndex',
] as const;

/**
 * Whether every number a page message carries is a whole number. They are
 * written into Smalltalk as they come (`${handle} between: 1 and: …`), so one
 * that is not — from a page that something injected script into — would be
 * Smalltalk of its sender's choosing. The page is ours; this keeps it so.
 */
export function wellFormed(msg: Record<string, unknown>): boolean {
  return NUMERIC_FIELDS.every((field) => {
    const value = msg[field];
    return value === undefined || (Number.isSafeInteger(value) && (value as number) >= -1);
  });
}

let extensionRoot: string | undefined;

/** Where the webview's scripts are, under the installed extension. */
function scriptText(name: string): string {
  if (!extensionRoot) throw new Error('The Inspector is not registered.');
  return fs.readFileSync(path.join(extensionRoot, 'resources', 'inspector', name), 'utf8');
}

/** How a query runs: the repr budget, and whether it runs past a breakpoint() it reaches. */
interface QueryOptions {
  budget: boolean;
  passHalts?: boolean;
}

/** Reads, which run the user's `__repr__`: soft-broken past the budget, as Variables reads are. */
const READ: QueryOptions = { budget: true };

export class InspectorPanel {
  /** Every open panel, so a notebook's rename reaches the ones on it. */
  private static readonly panels = new Set<InspectorPanel>();

  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private nextColumnId = 1;
  /**
   * What each edited row held before its FIRST edit, by `rowKey`: a revert puts it back. Keyed by
   * the column object's OOP and the row's name, which a Refresh does not change, where the
   * registry positions a listing hands out do.
   */
  private readonly originals = new Map<string, number>();

  /**
   * Open an Inspector on `target`'s object. The object is copied into the
   * panel's own registry first, here, before the page exists: a pause's
   * registry is refilled at every stop and Persisted Objects' at every
   * re-read, so copying it once the page reported ready could copy whatever
   * a step or a refresh put at that position meanwhile. A failure says why,
   * and no panel opens.
   */
  static async open(target: InspectTarget): Promise<InspectorPanel | undefined> {
    const registry = inspectorRegistry();
    let header: InspectorHeader;
    try {
      header = parseHeader(
        await runIn(target.readIn, openQuery(target.from, target.handle, registry), READ),
      );
    } catch (e) {
      void vscode.window.showErrorMessage(`Could not inspect ${target.label}: ${errorMessage(e)}`);
      return undefined;
    }
    const panel = vscode.window.createWebviewPanel(
      'gemdbInspector',
      'Inspector',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] },
    );
    const inspector = new InspectorPanel(panel, target, registry, header);
    InspectorPanel.panels.add(inspector);
    return inspector;
  }

  /**
   * A notebook renamed (`renameOwner`): its session and names moved to the new
   * address, so the panels on it follow.
   */
  static retarget(oldKey: string, newKey: string): void {
    for (const inspector of InspectorPanel.panels) {
      const readIn = inspector.target.readIn;
      if (readIn.session === 'notebook' && readIn.ownerKey === oldKey) {
        inspector.target.readIn = { session: 'notebook', ownerKey: newKey };
      }
    }
  }

  /** The root column's object, in the panel's registry: what a reloaded page opens again. */
  private rootHandle: number;

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly target: InspectTarget,
    private readonly registry: string,
    private rootHeader: InspectorHeader | undefined,
  ) {
    this.panel = panel;
    this.rootHandle = rootHeader?.row.handle ?? 0;
    this.panel.webview.html = this.html();
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (msg: InspectorMessage) => void this.handle(msg),
      null,
      this.disposables,
    );
  }

  private dispose(): void {
    InspectorPanel.panels.delete(this);
    // Best effort: a session that is running a cell, or gone, keeps it or has lost it already.
    this.query(dropInspectorRegistryQuery(this.registry), READ).catch(() => undefined);
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }

  /** Whether edits are offered: not in the extension's own session (see the class comment). */
  private get editable(): boolean {
    return this.target.readIn.session === 'notebook';
  }

  /** Run Smalltalk in the session the object lives in. */
  private query(code: string, options: QueryOptions): Promise<string> {
    return runIn(this.target.readIn, code, options);
  }

  /** The session the object is read in, by name: its notebook's or debugged file's, or `committed`. */
  private where(): string {
    const readIn = this.target.readIn;
    if (readIn.session === 'extension') return 'committed';
    const label = sessionForIfOpen(readIn.ownerKey)?.label;
    return label ?? path.basename(vscode.Uri.parse(readIn.ownerKey).path);
  }

  private post(msg: Record<string, unknown>): void {
    void this.panel.webview.postMessage(msg);
  }

  /** Why a read failed, and whether trying again later could help. */
  private failure(columnId: number, e: unknown, extra: Record<string, unknown> = {}): void {
    const message = errorMessage(e);
    const busy = /busy/i.test(message);
    this.post({
      command: 'columnError',
      columnId,
      message: busy
        ? 'Its session is running something (a notebook cell, say). Refresh once it finishes.'
        : message,
      ...extra,
    });
  }

  /** Read a column's header, from a handle in the panel's registry, and post it as `kind`. */
  private async postColumn(
    kind: 'addRoot' | 'addChild' | 'replaceColumn',
    columnId: number,
    handle: number,
    label: string,
    extra: Record<string, unknown> = {},
    header?: InspectorHeader,
  ): Promise<void> {
    try {
      const read =
        header ??
        parseHeader(await this.query(openQuery(this.registry, handle, this.registry), READ));
      if (kind === 'addRoot') this.rootHandle = read.row.handle;
      this.post({
        command: kind,
        columnId,
        handle: read.row.handle,
        label,
        header: read,
        editable: this.editable,
        ...(this.target.origin ? { origin: this.target.origin } : {}),
        ...extra,
      });
    } catch (e) {
      if (kind === 'addRoot') {
        this.post({ command: 'rootError', message: errorMessage(e) });
      } else if (kind === 'replaceColumn') {
        // Said with the history position the dive was for, so the page leaves its cursor alone.
        this.failure(columnId, e, { failedDive: true });
      } else {
        this.failure(Number(extra.sourceColumnId), e);
      }
    }
  }

  private async handle(msg: InspectorMessage): Promise<void> {
    if (!wellFormed(msg as Record<string, unknown>)) {
      log(`Inspector: refused a malformed ${String(msg.command)} message from its page`);
      return;
    }
    try {
      switch (msg.command) {
        case 'ready': {
          // The first time, the header read at open; after a page reload, the root read again
          // from the panel's own registry, never from the pause's, which a later stop refilled.
          const header = this.rootHeader;
          this.rootHeader = undefined;
          await this.postColumn('addRoot', 0, this.rootHandle, this.target.label, {}, header);
          return;
        }
        case 'fetchTab':
          await this.fetchTab(msg.columnId, msg.handle, msg.oop, msg.tab, msg.start ?? 0);
          return;
        case 'fetchGroup':
          await this.fetchGroup(msg.columnId, msg.handle, msg.oop, msg.groupRef, msg.size);
          return;
        case 'goTo':
          await this.goTo(msg.columnId, msg.handle, msg.tab, msg.text);
          return;
        case 'inspectRow':
          await this.postColumn('addChild', this.nextColumnId++, msg.handle, msg.label, {
            sourceColumnId: msg.sourceColumnId,
          });
          return;
        case 'diveHere':
          await this.postColumn('replaceColumn', msg.columnId, msg.handle, msg.label, {
            remember: msg.remember,
            keepTab: msg.keepTab === true,
            ...(msg.historyIndex === undefined ? {} : { historyIndex: msg.historyIndex }),
          });
          return;
        case 'evaluate':
          await this.evaluate(msg.columnId, msg.handle, msg.expression, msg.mode);
          return;
        case 'setSlot':
          await this.setSlot(msg);
          return;
        case 'revertSlot':
          await this.revertSlot(msg);
          return;
        case 'fetchSource': {
          let placed: { source: string; caption?: string };
          try {
            placed = this.placeSource(
              parseSource(
                await this.query(
                  sourceQuery(msg.handle, msg.ownerIndex, msg.owner, msg.name, this.registry),
                  READ,
                ),
              ),
              msg.owner,
              msg.name,
            );
          } catch (e) {
            placed = { source: `# Could not read it: ${errorMessage(e)}` };
          }
          this.post({
            command: 'source',
            columnId: msg.columnId,
            handle: msg.handle,
            ownerIndex: msg.ownerIndex,
            owner: msg.owner,
            name: msg.name,
            ...placed,
          });
          return;
        }
        case 'addToPersisted':
          this.addToPersisted(msg.handle, msg.name);
          return;
        case 'copyText':
          await vscode.env.clipboard.writeText(msg.text);
          vscode.window.setStatusBarMessage(`${msg.what} copied`, 2000);
          return;
        case 'setTitle':
          // The variable and its type (`counter · function`), short enough to read on a tab.
          this.panel.title = msg.title ? `Inspector: ${msg.title}` : 'Inspector';
          return;
        case 'closePanel':
          this.panel.dispose();
          return;
      }
    } catch (e) {
      log(`Inspector: ${errorMessage(e)}`);
    }
  }

  private async fetchTab(
    columnId: number,
    handle: number,
    oop: string | undefined,
    tab: TabName,
    start: number,
  ): Promise<void> {
    try {
      // Every reply names the object it is for, so a column that has moved on can drop it.
      const payload: Record<string, unknown> = { command: 'tabData', columnId, handle, tab, start };
      if (tab === 'repr') {
        payload.repr = parseRepr(await this.query(reprQuery(handle, this.registry), READ));
      } else if (tab === 'class') {
        payload.info = parseClassInfo(await this.query(classQuery(handle, this.registry), READ));
      } else {
        const count = tab === 'attributes' ? ATTRIBUTE_ROWS : INSPECTOR_PAGE;
        const rows = parseChildren(
          await this.query(childrenQuery(handle, start, count, this.registry), READ),
        );
        payload.rows = this.stamp(oop, rows);
      }
      this.post(payload);
    } catch (e) {
      this.failure(columnId, e);
    }
  }

  /**
   * A group's rows (`class variables`, …), all of them up to `GROUP_ROWS`;
   * past that, a last row says how many more there are, as a long listing's
   * does, rather than the group ending as if it were complete.
   */
  private async fetchGroup(
    columnId: number,
    handle: number,
    oop: string | undefined,
    groupRef: number,
    size: number | undefined,
  ): Promise<void> {
    try {
      const count = Math.min(size && size > 0 ? size : ATTRIBUTE_ROWS, GROUP_ROWS);
      const rows: (PauseVariable & { revertible?: boolean })[] = this.stamp(
        oop,
        parseChildren(await this.query(childrenQuery(groupRef, 0, count, this.registry), READ)),
      );
      if (size !== undefined && size > count) {
        rows.push({
          name: '...',
          value: `${size - count} more not shown`,
          type: '',
          ref: 0,
          indexed: 0,
          named: 0,
          handle: 0,
          size: -1,
          readOnly: true,
        });
      }
      this.post({ command: 'groupData', columnId, handle, groupRef, rows });
    } catch (e) {
      this.failure(columnId, e);
    }
  }

  /**
   * Find an item by what the user typed and answer the page it is on: a
   * position for a list or a set (`-1` from the end), a key for a dict, as
   * Persisted Objects' Go to Item… finds one (`keyNames`, `keyPositionQuery`).
   * A number that is no key of a dict is taken as a position, and the answer
   * says so, as Go to Item… does.
   */
  private async goTo(columnId: number, handle: number, tab: TabName, text: string): Promise<void> {
    const typed = text.trim();
    let index: number | undefined;
    let note: string | undefined;
    const asNumber = /^\[?-?\d+\]?$/.test(typed) ? Number(typed.replace(/[[\]]/g, '')) : undefined;
    try {
      if (tab === 'entries') {
        const raw = await this.query(
          keyPositionQuery(handle, keyNames(typed), this.registry),
          READ,
        );
        // A lookup that failed is not a key that is missing: say why, as every other read does.
        if (raw.startsWith('Error: ')) throw new Error(raw.slice('Error: '.length));
        const pos = Number(raw);
        index = pos >= 0 ? pos : undefined;
      }
    } catch (e) {
      this.failure(columnId, e);
      return;
    }
    if (index === undefined && asNumber !== undefined) {
      index = asNumber;
      if (tab === 'entries') note = `No key reads as ${typed}: showing entry ${typed} by position.`;
    }
    this.post({
      command: 'goToResult',
      columnId,
      handle,
      tab,
      typed,
      ...(index === undefined
        ? { error: tab === 'entries' ? `No key reads as ${typed}.` : `${typed} is not a position.` }
        : { index, ...(note ? { note } : {}) }),
    });
  }

  /**
   * A member's source. Grail's own methods come as Smalltalk, with a caption
   * naming the Smalltalk class that implements them (it differs from method to
   * method: `list.append` is OrderedCollection's, `list.__add__`
   * SequenceableCollection's), drawn apart from the code so it is not read as
   * part of it. A Python function's or class's lines are read from where its
   * code says it was defined: a file from disk, and `<grail>`, a notebook cell,
   * found among the cells of the notebook the object lives in by its first
   * line, its name and the class it is in — the latest cell first, since a
   * notebook that defines a class again does so in a later cell. A notebook
   * that is not open, or a cell edited since it ran, leaves only where it was.
   */
  private placeSource(
    answer: SourceAnswer,
    owner: string,
    name: string,
  ): { source: string; caption?: string } {
    if (answer.kind === 'text') return { source: answer.text };
    if (answer.kind === 'smalltalk') {
      return {
        source: answer.sources.join('\n\n'),
        caption: `${owner}.${name} is built in: Grail implements it in Smalltalk, in ${answer.className}.`,
      };
    }
    const { file, line } = answer;
    const candidates: string[][] = [];
    if (file === '<grail>') {
      const readIn = this.target.readIn;
      const notebook =
        readIn.session === 'notebook'
          ? vscode.workspace.notebookDocuments.find((nb) => nb.uri.toString() === readIn.ownerKey)
          : undefined;
      for (const cell of notebook?.getCells() ?? []) {
        if (cell.kind === vscode.NotebookCellKind.Code) {
          candidates.unshift(cell.document.getText().split(/\r?\n/));
        }
      }
    } else if (file && fs.existsSync(file)) {
      candidates.push(fs.readFileSync(file, 'utf8').split(/\r?\n/));
    }
    // A class's own source names no class around it; a member's does.
    const within = answer.isClass ? undefined : owner;
    for (const lines of candidates) {
      const found = sourceAt(lines, line, name, within);
      if (found !== undefined) return { source: found };
    }
    const place =
      file === '<grail>' ? `a notebook cell, at its line ${line}` : `${file}, line ${line}`;
    return {
      source: `# No source to show: it was defined in ${place}, and that is not open, or has changed since.`,
    };
  }

  /**
   * Add an object under `gemdb.root` — **Add to Persisted Objects…**, the
   * same steps and words as on a Variables row (`addToPersistedObjects` in
   * savedObjects.ts). Only in a notebook's or a debugged file's session,
   * whose next commit writes it; in the extension's own session nobody would.
   */
  private addToPersisted(handle: number, name: string): void {
    const readIn = this.target.readIn;
    if (readIn.session !== 'notebook') {
      void vscode.window.showInformationMessage(
        'This object is read in GemDB’s own session, so adding it from here would never be ' +
          'committed. It is already persisted: Copy as Expression gives the way to reach it.',
      );
      return;
    }
    const target: AddTarget = {
      query: (code) => this.query(code, { budget: false }),
      ownerKey: readIn.ownerKey,
      notebook: this.where(),
      handle,
      name,
      registry: this.registry,
    };
    void vscode.commands.executeCommand('gemdb.savedObjects.addFromInspector', target);
  }

  /**
   * The program whose names an expression typed here sees: a notebook's
   * globals, or a debugged file's `__main__`; none in the extension's session.
   */
  private programScope(): string | MainModule | undefined {
    const readIn = this.target.readIn;
    if (readIn.session !== 'notebook') return undefined;
    const kind = sessionForIfOpen(readIn.ownerKey)?.owner.kind;
    return kind === 'notebook' ? readIn.ownerKey : kind === 'file' ? MAIN_MODULE : undefined;
  }

  /**
   * How the user's own code runs here. In a notebook's session, as a Debug
   * Console line does: no time limit, and straight past a breakpoint() it
   * reaches. In the extension's, with the repr budget, so a runaway line cannot
   * hold the session Persisted Objects reads with.
   */
  private userCode(): QueryOptions {
    return this.editable ? { budget: false, passHalts: true } : READ;
  }

  /** Identifies one edited row: the column object's OOP, and the row's name. */
  private rowKey(oop: string | undefined, name: string): string {
    return `${oop ?? ''}\u0000${name}`;
  }

  /** Mark the rows the user has edited, so the webview offers to put them back. */
  private stamp(
    oop: string | undefined,
    rows: PauseVariable[],
  ): (PauseVariable & { revertible?: boolean })[] {
    if (this.originals.size === 0 || !oop) return rows;
    return rows.map((row) =>
      this.originals.has(this.rowKey(oop, row.name)) ? { ...row, revertible: true } : row,
    );
  }

  private async setSlot(msg: {
    columnId: number;
    containerRef: number;
    name: string;
    expression: string;
    valueHandle: number;
    selfHandle: number;
    oop?: string;
  }): Promise<void> {
    const { columnId, containerRef, name, expression, valueHandle, selfHandle } = msg;
    if (!this.editable) {
      this.post({
        command: 'setSlotResult',
        columnId,
        handle: selfHandle,
        ok: false,
        error: 'This object is read-only here.',
      });
      return;
    }
    try {
      // The value first, as the Evaluate tab runs a line: with `self` bound to the column's object
      // and the program's names in scope, so `self.qty + 1` and `limit` both work. In
      // parentheses, each on a line of its own, so a statement (`n = 5`) fails as a SyntaxError
      // rather than storing None — Set Value's own rule (`setVariableQuery`).
      const reply = parseConsoleReply(
        await this.query(
          inspectorEvaluateQuery(
            selfHandle,
            `(\n${dedented(expression)}\n)`,
            this.programScope(),
            this.registry,
          ),
          this.userCode(),
        ),
      );
      if (reply.kind === 'error') {
        throw new Error(
          reply.error.message ? `${reply.error.type}: ${reply.error.message}` : reply.error.type,
        );
      }
      if (reply.kind === 'failed') throw new Error(reply.message);
      if (reply.kind === 'interrupted') throw new Error('Interrupted.');
      // Then stored as Set Value stores one (setattr, or assignment), by the object's handle. A
      // None answers `none`, with no row: the parentheses make a statement a SyntaxError, so
      // `none` here can only be the value None, which is stored as Set Value would store it.
      const raw = await this.query(
        reply.kind === 'value'
          ? setVariableQuery(0n, containerRef, name, '', 0, this.registry, reply.row.handle)
          : setVariableQuery(0n, containerRef, name, 'None', 0, this.registry),
        READ,
      );
      if (raw.startsWith('Error: ')) throw new Error(raw.slice('Error: '.length));
      const key = this.rowKey(msg.oop, name);
      // The FIRST original, so a revert after two edits restores what was there to begin with.
      if (msg.oop && !this.originals.has(key) && valueHandle > 0) {
        this.originals.set(key, valueHandle);
      }
      this.post({ command: 'setSlotResult', columnId, handle: selfHandle, ok: true });
    } catch (e) {
      this.post({
        command: 'setSlotResult',
        columnId,
        handle: selfHandle,
        ok: false,
        error: errorMessage(e),
      });
    }
  }

  private async revertSlot(msg: {
    columnId: number;
    containerRef: number;
    selfHandle: number;
    oop?: string;
    name: string;
  }): Promise<void> {
    const { columnId, containerRef, selfHandle, name } = msg;
    const key = this.rowKey(msg.oop, name);
    const original = this.originals.get(key);
    if (original === undefined) {
      this.post({
        command: 'setSlotResult',
        columnId,
        handle: selfHandle,
        ok: false,
        error: 'No earlier value is kept for this row.',
      });
      return;
    }
    try {
      const raw = await this.query(
        setVariableQuery(0n, containerRef, name, '', 0, this.registry, original),
        READ,
      );
      if (raw.startsWith('Error: ')) throw new Error(raw.slice('Error: '.length));
      this.originals.delete(key);
      this.post({ command: 'setSlotResult', columnId, handle: selfHandle, ok: true });
    } catch (e) {
      this.post({
        command: 'setSlotResult',
        columnId,
        handle: selfHandle,
        ok: false,
        error: errorMessage(e),
      });
    }
  }

  /**
   * Run the Evaluate tab's Python with `self` bound to the column's object.
   * Display shows the result's whole repr, Execute only what was printed,
   * Inspect opens the result in a new column. What the code prints comes first. Text
   * pasted with indentation every line shares runs without it, as in the Debug
   * Console (`dedented`).
   */
  private async evaluate(
    columnId: number,
    handle: number,
    typed: string,
    mode: Mode,
  ): Promise<void> {
    const readIn = this.target.readIn;
    const source = dedented(typed);
    const say = (ok: boolean, text: string): void =>
      this.post({ command: 'evalResult', columnId, handle, ok, text });
    let raw: string;
    try {
      raw = await this.query(
        inspectorEvaluateQuery(handle, source, this.programScope(), this.registry, !this.editable),
        this.userCode(),
      );
    } catch (e) {
      say(false, errorMessage(e));
      return;
    }
    const reply = parseConsoleReply(raw);
    const printed = reply.output;
    switch (reply.kind) {
      case 'failed':
        say(false, printed + reply.message);
        return;
      case 'interrupted':
        say(false, printed + 'Interrupted.');
        return;
      case 'error': {
        const place = placeFrame(
          readIn.session === 'notebook' ? readIn.ownerKey : '',
          source,
          'Inspector',
        );
        say(false, printed + jupyterTraceback(reply.error, place));
        return;
      }
      case 'none':
        say(true, printed);
        return;
      case 'value': {
        if (mode === 'inspect') {
          say(true, printed);
          await this.postColumn(
            'addChild',
            this.nextColumnId++,
            reply.row.handle,
            labelOf(source),
            {
              sourceColumnId: columnId,
            },
          );
          return;
        }
        if (mode === 'execute') {
          say(true, printed);
          return;
        }
        let text = reply.row.value;
        try {
          text = parseRepr(await this.query(reprQuery(reply.row.handle, this.registry), READ)).repr;
        } catch {
          // The short repr the row already carries will do.
        }
        say(true, printed + text);
        return;
      }
    }
  }

  /**
   * The page. Scripts run only with this load's nonce; styles are inline, as
   * Jasper's panel has them, because the view writes `style` attributes
   * (`display:none` on a hidden part), which a nonce cannot cover.
   */
  private html(): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const css = scriptText('inspector.css');
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>Inspector</title>
  <style>${css}</style>
</head>
<body>
  <div id="columnStrip"></div>
  <div id="rowCtxMenu" class="ctx-menu">
    <div class="ctx-item" data-action="inspect">Inspect</div>
    <div class="ctx-item" data-action="dive">Dive Here</div>
    <div class="ctx-sep" data-edit-sep></div>
    <div class="ctx-item" data-action="edit">Edit Value…</div>
    <div class="ctx-sep"></div>
    <div class="ctx-item" data-action="copyValue">Copy Value</div>
    <div class="ctx-item" data-action="copyExpression">Copy as Expression</div>
    <div class="ctx-sep" data-persist-sep></div>
    <div class="ctx-item" data-action="persist">Add to Persisted Objects…</div>
  </div>
  <div id="headerCtxMenu" class="ctx-menu">
    <div class="ctx-item" data-action="copy">Copy</div>
  </div>
  <script nonce="${nonce}">${scriptText('evaluatePane.js')}</script>
  <script nonce="${nonce}">${scriptText('millerColumns.js')}</script>
  <script nonce="${nonce}">${scriptText('inspectorView.js')}</script>
  <script nonce="${nonce}">
    InspectorView.init({
      strip: document.getElementById('columnStrip'),
      ctxMenu: document.getElementById('rowCtxMenu'),
      headerCtxMenu: document.getElementById('headerCtxMenu'),
      vscode: acquireVsCodeApi(),
      pageSize: ${INSPECTOR_PAGE},
      defaultColumnWidth: ${DEFAULT_COLUMN_WIDTH},
      minColumnWidth: ${MIN_COLUMN_WIDTH},
    });
  </script>
</body>
</html>`;
  }
}

/**
 * What an Inspect It result's column is called: the expression, when it is
 * one line, which a child column can extend (`(a or b).x`); a block of several
 * lines would put newlines in the header and the tab, so it is `(evaluated)`.
 */
function labelOf(source: string): string {
  const text = withoutComment(source).trim();
  return text.includes('\n') ? '(evaluated)' : text;
}

/** Run Smalltalk in the session a `ReadIn` names. */
function runIn(readIn: ReadIn, code: string, options: QueryOptions): Promise<string> {
  return readIn.session === 'extension'
    ? extensionQuery(code, { budget: options.budget })
    : inNotebook(readIn.ownerKey, code, options);
}

// ---------------------------------------------------------------------------
// Opening one: from a Variables or Watch row, the Debug Console, or Persisted Objects.
// ---------------------------------------------------------------------------

export const INSPECT_VARIABLE = 'gemdb.inspectVariable';
export const INSPECT_PERSISTED = 'gemdb.savedObjects.inspect';

const NOT_PAUSED =
  'Inspect works on a variable in Run and Debug, while a GemDB notebook cell or Debug Python File ' +
  'run is paused in the debugger.';

/**
 * What VS Code hands a command on a Watch row: a root watch comes as its
 * `expression`, a row opened under one as a `variable`, like a Variables row.
 */
type RowContext = VariableContext & {
  expression?: { name?: string; expression?: string; variablesReference?: number };
};

/**
 * Inspect the right-clicked Variables or Watch row's object, reached by its
 * handle in the pause's registry: the row's own reference when it opens, else
 * the handle its listing recorded, else, for a watch, the handle its last
 * evaluation answered (`Pause.watchHandle`), so a plain value inspects too.
 */
export async function inspectVariable(context: RowContext): Promise<void> {
  const session = vscode.debug.activeDebugSession;
  const pause = pauseForDebugSession(context.sessionId ?? session?.id);
  const variable = context.variable;
  const watched = context.expression;
  const name = variable?.name ?? watched?.expression ?? watched?.name;
  if (!session || session.type !== DEBUG_TYPE || !pause?.ownerKey || !name) {
    void vscode.window.showErrorMessage(NOT_PAUSED);
    return;
  }
  const reference = variable?.variablesReference ?? watched?.variablesReference ?? 0;
  const handle =
    reference > 0
      ? reference
      : (pause.handleFor?.(context.container?.variablesReference ?? 0, name) ??
        pause.watchHandle?.(dedented(name)));
  if (!handle) {
    void vscode.window.showErrorMessage(`"${name}" is not an object of its own.`);
    return;
  }
  await InspectorPanel.open({
    readIn: { session: 'notebook', ownerKey: pause.ownerKey },
    from: REGISTRY,
    handle,
    label: labelOf(name),
    origin: frameOrigin(pause, session),
  });
}

/** `%inspect` in the Debug Console (`debugger.ts`): open a console result. */
export async function inspectPaused(args: {
  ownerKey: string;
  handle: number;
  label: string;
  frame?: DapFrame;
  run: string;
}): Promise<void> {
  const file = args.frame?.source?.name ?? args.run;
  await InspectorPanel.open({
    readIn: { session: 'notebook', ownerKey: args.ownerKey },
    from: REGISTRY,
    handle: args.handle,
    label: args.label,
    origin: {
      text: file,
      detail: args.frame
        ? `Inspected from the Debug Console in ${args.frame.name}, in ${file}, paused at line ${args.frame.line}`
        : `Inspected from the Debug Console while ${args.run} was paused`,
    },
  });
}

/**
 * The file of the frame selected in Call Stack (the one whose Variables were
 * right-clicked), `special_values.py`, with its function and line for the
 * tooltip; the paused run's name alone when no frame is selected.
 */
function frameOrigin(
  pause: { label: string; frames: DapFrame[] },
  session: vscode.DebugSession,
): { text: string; detail: string } {
  const item = vscode.debug.activeStackItem;
  const frameId =
    item instanceof vscode.DebugStackFrame && item.session.id === session.id
      ? item.frameId
      : undefined;
  const frame = pause.frames.find((f) => f.id === frameId) ?? pause.frames[0];
  if (!frame) return { text: pause.label, detail: `Inspected while ${pause.label} was paused` };
  const file = frame.source?.name ?? pause.label;
  return {
    text: file,
    detail: `Inspected from ${frame.name}, in ${file}, paused at line ${frame.line}`,
  };
}

/** Inspect a Persisted Objects row's object, if the row still belongs to what the view shows. */
export async function inspectPersisted(
  view: SavedObjectsProvider,
  row: SavedRow | undefined,
): Promise<void> {
  const target = row ? view.inspectTarget(row) : undefined;
  if (!target) {
    void vscode.window.showErrorMessage(
      'That row is not an object of its own (a group heading is not), or Persisted Objects ' +
        'has been read again since it was shown: open it again and try once more.',
    );
    return;
  }
  await InspectorPanel.open({
    ...target,
    from: PERSISTED_REGISTRY,
    origin: {
      text: 'Persisted Objects',
      detail:
        target.readIn.session === 'extension'
          ? 'Inspected from Persisted Objects: committed under gemdb.root'
          : 'Inspected from Persisted Objects: added by its notebook, not committed yet',
    },
  });
}

export function registerInspector(
  extensionPath: string,
  view: SavedObjectsProvider,
): vscode.Disposable {
  extensionRoot = extensionPath;
  return vscode.Disposable.from(
    vscode.commands.registerCommand(INSPECT_VARIABLE, (c: RowContext) => inspectVariable(c)),
    // Internal, for %inspect in the Debug Console.
    vscode.commands.registerCommand('gemdb.inspector.openPaused', inspectPaused),
    vscode.commands.registerCommand(INSPECT_PERSISTED, (row: SavedRow) =>
      inspectPersisted(view, row),
    ),
  );
}
