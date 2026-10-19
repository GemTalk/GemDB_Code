import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { jupyterTraceback } from './consoleTraceback';
import { DEBUG_TYPE, pauseForDebugSession, placeFrame } from './debugger';
import {
  INSPECTOR_REGISTRY,
  InspectorHeader,
  classQuery,
  dropInspectorRegistryQuery,
  inspectorEvaluateQuery,
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
 * the pause it was found at resumes, because the Inspector's own registry
 * holds it, until its session ends.
 *
 * Edits (Edit Value…) are offered only in a notebook's or a debugged file's
 * session, where they join that session's transaction exactly as Set Value in
 * the Variables view does; a committed object opened from Persisted Objects is
 * read-only here, since a change in the extension's own session would be a
 * transaction nobody commits.
 */

/** Rows per page of Items or Entries. */
export const INSPECTOR_PAGE = 100;

/** Attributes are listed whole, grouped; a group cannot be paged into. */
const ATTRIBUTE_ROWS = 500;

/** Preferred starting width of a column; it grows to fill spare space. */
const DEFAULT_COLUMN_WIDTH = 360;
/** Below this a column stops shrinking and the strip scrolls instead. */
const MIN_COLUMN_WIDTH = 280;

/** What an Inspector opens on: an object in a registry of the session it lives in. */
export interface InspectTarget {
  readIn: ReadIn;
  /** The registry it was found in: the pause's, Persisted Objects', or the Inspector's own. */
  from: string;
  handle: number;
  /** What the column header calls it: the row's name, which a child column extends. */
  label: string;
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
      tab: TabName;
      /** First row wanted, from 0. */
      start?: number;
    }
  | { command: 'fetchGroup'; columnId: number; groupRef: number }
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
      expression: string;
    }
  | { command: 'revertSlot'; columnId: number; containerRef: number; name: string }
  | { command: 'fetchSource'; columnId: number; handle: number; owner: string; name: string }
  | { command: 'copyText'; text: string; what: string }
  | { command: 'setTitle'; title: string }
  | { command: 'closePanel' };

let extensionRoot: string | undefined;

/** Where the webview's scripts are, under the installed extension. */
function scriptText(name: string): string {
  if (!extensionRoot) throw new Error('The Inspector is not registered.');
  return fs.readFileSync(path.join(extensionRoot, 'resources', 'inspector', name), 'utf8');
}

/** The session a `ReadIn` names, as a key: one Inspector registry per session. */
function sessionKey(readIn: ReadIn): string {
  return readIn.session === 'extension' ? 'extension' : readIn.ownerKey;
}

export class InspectorPanel {
  /** Open panels per session, so the session's registry is dropped when the last one closes. */
  private static readonly panels = new Map<string, Set<InspectorPanel>>();

  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private nextColumnId = 1;
  /** What each edited row held before its FIRST edit, by `rowKey`: a revert puts it back. */
  private readonly originals = new Map<string, number>();

  static open(target: InspectTarget): InspectorPanel {
    const panel = vscode.window.createWebviewPanel(
      'gemdbInspector',
      'Inspector',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] },
    );
    const inspector = new InspectorPanel(panel, target);
    const key = sessionKey(target.readIn);
    let set = InspectorPanel.panels.get(key);
    if (!set) InspectorPanel.panels.set(key, (set = new Set()));
    set.add(inspector);
    return inspector;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly target: InspectTarget,
  ) {
    this.panel = panel;
    this.panel.webview.html = this.html();
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (msg: InspectorMessage) => void this.handle(msg),
      null,
      this.disposables,
    );
  }

  private dispose(): void {
    const key = sessionKey(this.target.readIn);
    const set = InspectorPanel.panels.get(key);
    set?.delete(this);
    if (set && set.size === 0) {
      InspectorPanel.panels.delete(key);
      // Best effort: a session that is running a cell, or gone, keeps it or has lost it already.
      this.query(dropInspectorRegistryQuery(), false).catch(() => undefined);
    }
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }

  /** Whether edits are offered: not in the extension's own session (see the class comment). */
  private get editable(): boolean {
    return this.target.readIn.session === 'notebook';
  }

  /** Run Smalltalk in the session the object lives in. */
  private query(code: string, budget = true): Promise<string> {
    const readIn = this.target.readIn;
    return readIn.session === 'extension'
      ? extensionQuery(code, { budget })
      : inNotebook(readIn.ownerKey, code, { budget });
  }

  /** What every title says after the object: which session it is read in. */
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
  private failure(columnId: number, e: unknown): void {
    const message = errorMessage(e);
    const busy = /busy/i.test(message);
    this.post({
      command: 'columnError',
      columnId,
      message: busy
        ? 'Its session is running something (a notebook cell, say). Refresh once it finishes.'
        : message,
    });
  }

  private async header(from: string, handle: number): Promise<InspectorHeader> {
    return parseHeader(await this.query(openQuery(from, handle)));
  }

  /** Read a column's header and post it as `kind`. */
  private async postColumn(
    kind: 'addRoot' | 'addChild' | 'replaceColumn',
    columnId: number,
    from: string,
    handle: number,
    label: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      const header = await this.header(from, handle);
      this.post({
        command: kind,
        columnId,
        handle: header.row.handle,
        label,
        header,
        editable: this.editable,
        ...extra,
      });
    } catch (e) {
      if (kind === 'addRoot') {
        this.post({ command: 'rootError', message: errorMessage(e) });
      } else {
        this.failure(kind === 'replaceColumn' ? columnId : Number(extra.sourceColumnId), e);
      }
    }
  }

  private async handle(msg: InspectorMessage): Promise<void> {
    try {
      switch (msg.command) {
        case 'ready':
          this.post({ command: 'where', where: this.where() });
          await this.postColumn(
            'addRoot',
            0,
            this.target.from,
            this.target.handle,
            this.target.label,
          );
          return;
        case 'fetchTab':
          await this.fetchTab(msg.columnId, msg.handle, msg.tab, msg.start ?? 0);
          return;
        case 'fetchGroup':
          try {
            const rows = parseChildren(
              await this.query(childrenQuery(msg.groupRef, 0, ATTRIBUTE_ROWS, INSPECTOR_REGISTRY)),
            );
            this.post({
              command: 'groupData',
              columnId: msg.columnId,
              groupRef: msg.groupRef,
              rows: this.stamp(msg.groupRef, rows),
            });
          } catch (e) {
            this.failure(msg.columnId, e);
          }
          return;
        case 'goTo':
          await this.goTo(msg.columnId, msg.handle, msg.tab, msg.text);
          return;
        case 'inspectRow':
          await this.postColumn(
            'addChild',
            this.nextColumnId++,
            INSPECTOR_REGISTRY,
            msg.handle,
            msg.label,
            { sourceColumnId: msg.sourceColumnId },
          );
          return;
        case 'diveHere':
          await this.postColumn(
            'replaceColumn',
            msg.columnId,
            INSPECTOR_REGISTRY,
            msg.handle,
            msg.label,
            { remember: msg.remember, keepTab: msg.keepTab === true },
          );
          return;
        case 'evaluate':
          await this.evaluate(msg.columnId, msg.handle, msg.expression, msg.mode);
          return;
        case 'setSlot':
          await this.setSlot(
            msg.columnId,
            msg.containerRef,
            msg.name,
            msg.expression,
            msg.valueHandle,
          );
          return;
        case 'revertSlot':
          await this.revertSlot(msg.columnId, msg.containerRef, msg.name);
          return;
        case 'fetchSource': {
          let placed: { source: string; caption?: string };
          try {
            placed = this.placeSource(
              parseSource(await this.query(sourceQuery(msg.handle, msg.owner, msg.name))),
              msg.owner,
              msg.name,
            );
          } catch (e) {
            placed = { source: `# Could not read it: ${errorMessage(e)}` };
          }
          this.post({
            command: 'source',
            columnId: msg.columnId,
            owner: msg.owner,
            name: msg.name,
            ...placed,
          });
          return;
        }
        case 'copyText':
          await vscode.env.clipboard.writeText(msg.text);
          vscode.window.setStatusBarMessage(`${msg.what} copied`, 2000);
          return;
        case 'setTitle':
          this.panel.title = msg.title
            ? `Inspector: ${msg.title} · ${this.where()}`
            : `Inspector · ${this.where()}`;
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
    tab: TabName,
    start: number,
  ): Promise<void> {
    try {
      const payload: Record<string, unknown> = { command: 'tabData', columnId, tab, start };
      if (tab === 'repr') {
        payload.repr = parseRepr(await this.query(reprQuery(handle)));
      } else if (tab === 'class') {
        payload.info = parseClassInfo(await this.query(classQuery(handle)));
      } else {
        const count = tab === 'attributes' ? ATTRIBUTE_ROWS : INSPECTOR_PAGE;
        const rows = parseChildren(
          await this.query(childrenQuery(handle, start, count, INSPECTOR_REGISTRY)),
        );
        payload.rows = this.stamp(handle, rows);
      }
      this.post(payload);
    } catch (e) {
      this.failure(columnId, e);
    }
  }

  /**
   * Find an item by what the user typed and answer the page it is on: a
   * position for a list or a set (`-1` from the end), a key for a dict, as
   * Persisted Objects' Go to Item… finds one (`keyNames`, `keyPositionQuery`).
   */
  private async goTo(columnId: number, handle: number, tab: TabName, text: string): Promise<void> {
    const typed = text.trim();
    let index: number | undefined;
    const asNumber = /^\[?-?\d+\]?$/.test(typed) ? Number(typed.replace(/[[\]]/g, '')) : undefined;
    try {
      if (tab === 'entries') {
        const pos = Number(
          await this.query(keyPositionQuery(handle, keyNames(typed), INSPECTOR_REGISTRY)),
        );
        index = pos >= 0 ? pos : undefined;
      }
    } catch (e) {
      this.failure(columnId, e);
      return;
    }
    if (index === undefined && asNumber !== undefined) index = asNumber;
    this.post({
      command: 'goToResult',
      columnId,
      tab,
      ...(index === undefined
        ? { error: tab === 'entries' ? `No key reads as ${typed}.` : `${typed} is not a position.` }
        : { index }),
    });
  }

  /**
   * A member's source. Grail's own methods come as Smalltalk, with a caption
   * naming the Smalltalk class that implements them (it differs from method to
   * method: `list.append` is OrderedCollection's, `list.__add__`
   * SequenceableCollection's), drawn apart from the code so it is not read as
   * part of it; a Python function's lines are read from where its code says it was
   * defined: a file from disk, and `<grail>`, a notebook cell,
   * found among the cells of the notebook the object lives in by its first
   * line and its name, as the debugger finds a frame's cell. A notebook that is
   * not open, or a cell edited since it ran, leaves only where it was.
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
          candidates.push(cell.document.getText().split(/\r?\n/));
        }
      }
    } else if (file && fs.existsSync(file)) {
      candidates.push(fs.readFileSync(file, 'utf8').split(/\r?\n/));
    }
    for (const lines of candidates) {
      const found = sourceAt(lines, line, name);
      if (found !== undefined) return { source: found };
    }
    const place =
      file === '<grail>' ? `a notebook cell, at its line ${line}` : `${file}, line ${line}`;
    return {
      source: `# No source to show: it was defined in ${place}, and that is not open, or has changed since.`,
    };
  }

  /** Identifies one row that can be edited: the registry entry it was listed under, and its name. */
  private rowKey(containerRef: number, name: string): string {
    return `${containerRef}\u0000${name}`;
  }

  /** Mark the rows the user has edited, so the webview offers to put them back. */
  private stamp(
    containerRef: number,
    rows: PauseVariable[],
  ): (PauseVariable & { revertible?: boolean })[] {
    if (this.originals.size === 0) return rows;
    return rows.map((row) =>
      this.originals.has(this.rowKey(containerRef, row.name)) ? { ...row, revertible: true } : row,
    );
  }

  private async setSlot(
    columnId: number,
    containerRef: number,
    name: string,
    expression: string,
    valueHandle: number,
  ): Promise<void> {
    if (!this.editable) {
      this.post({
        command: 'setSlotResult',
        columnId,
        ok: false,
        error: 'This object is read-only here.',
      });
      return;
    }
    try {
      const raw = await this.query(
        setVariableQuery(0n, containerRef, name, expression, 0, INSPECTOR_REGISTRY),
      );
      if (raw.startsWith('Error: ')) throw new Error(raw.slice('Error: '.length));
      const key = this.rowKey(containerRef, name);
      // The FIRST original, so a revert after two edits restores what was there to begin with.
      if (!this.originals.has(key) && valueHandle > 0) this.originals.set(key, valueHandle);
      this.post({ command: 'setSlotResult', columnId, ok: true });
    } catch (e) {
      this.post({ command: 'setSlotResult', columnId, ok: false, error: errorMessage(e) });
    }
  }

  private async revertSlot(columnId: number, containerRef: number, name: string): Promise<void> {
    const key = this.rowKey(containerRef, name);
    const original = this.originals.get(key);
    if (original === undefined) {
      this.post({
        command: 'setSlotResult',
        columnId,
        ok: false,
        error: 'No earlier value is kept for this row.',
      });
      return;
    }
    try {
      const raw = await this.query(
        setVariableQuery(0n, containerRef, name, '', 0, INSPECTOR_REGISTRY, original),
      );
      if (raw.startsWith('Error: ')) throw new Error(raw.slice('Error: '.length));
      this.originals.delete(key);
      this.post({ command: 'setSlotResult', columnId, ok: true });
    } catch (e) {
      this.post({ command: 'setSlotResult', columnId, ok: false, error: errorMessage(e) });
    }
  }

  /**
   * Run the Evaluate tab's Python with `self` bound to the column's object.
   * Display shows the result's whole repr, Execute only that it ran, Inspect
   * opens the result in a new column. What the code prints comes first.
   */
  private async evaluate(
    columnId: number,
    handle: number,
    source: string,
    mode: Mode,
  ): Promise<void> {
    const readIn = this.target.readIn;
    const scopeKey =
      readIn.session === 'notebook' && sessionForIfOpen(readIn.ownerKey)?.owner.kind === 'notebook'
        ? readIn.ownerKey
        : undefined;
    let raw: string;
    try {
      // No time limit: this is the user's own code, as a Debug Console line is.
      raw = await this.query(inspectorEvaluateQuery(handle, source, scopeKey), false);
    } catch (e) {
      this.post({ command: 'evalResult', columnId, ok: false, text: errorMessage(e) });
      return;
    }
    const reply = parseConsoleReply(raw);
    const printed = reply.output;
    switch (reply.kind) {
      case 'failed':
        this.post({ command: 'evalResult', columnId, ok: false, text: printed + reply.message });
        return;
      case 'interrupted':
        this.post({ command: 'evalResult', columnId, ok: false, text: printed + 'Interrupted.' });
        return;
      case 'error': {
        const place = placeFrame(
          readIn.session === 'notebook' ? readIn.ownerKey : '',
          source,
          'Inspector',
        );
        this.post({
          command: 'evalResult',
          columnId,
          ok: false,
          text: printed + jupyterTraceback(reply.error, place),
        });
        return;
      }
      case 'none':
        this.post({ command: 'evalResult', columnId, ok: true, text: printed });
        return;
      case 'value': {
        if (mode === 'inspect') {
          this.post({ command: 'evalResult', columnId, ok: true, text: printed });
          await this.postColumn(
            'addChild',
            this.nextColumnId++,
            INSPECTOR_REGISTRY,
            reply.row.handle,
            source.trim(),
            {
              sourceColumnId: columnId,
            },
          );
          return;
        }
        if (mode === 'execute') {
          this.post({ command: 'evalResult', columnId, ok: true, text: printed });
          return;
        }
        let text = reply.row.value;
        try {
          text = parseRepr(await this.query(reprQuery(reply.row.handle))).repr;
        } catch {
          // The short repr the row already carries will do.
        }
        this.post({ command: 'evalResult', columnId, ok: true, text: printed + text });
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
    <div class="ctx-sep"></div>
    <div class="ctx-item" data-action="edit">Edit Value…</div>
    <div class="ctx-sep"></div>
    <div class="ctx-item" data-action="copyValue">Copy Value</div>
    <div class="ctx-item" data-action="copyExpression">Copy as Expression</div>
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

// ---------------------------------------------------------------------------
// Opening one: from a Variables row, or from a Persisted Objects row.
// ---------------------------------------------------------------------------

export const INSPECT_VARIABLE = 'gemdb.inspectVariable';
export const INSPECT_PERSISTED = 'gemdb.savedObjects.inspect';

const NOT_PAUSED =
  'Inspect works on a variable in Run and Debug, while a GemDB notebook cell or Debug Python File ' +
  'run is paused in the debugger.';

/** Inspect the right-clicked Variables row's object, reached by its handle in the pause's registry. */
export function inspectVariable(context: VariableContext): void {
  const session = vscode.debug.activeDebugSession;
  const pause = pauseForDebugSession(context.sessionId ?? session?.id);
  const variable = context.variable;
  if (!session || session.type !== DEBUG_TYPE || !pause?.ownerKey || !variable) {
    void vscode.window.showErrorMessage(NOT_PAUSED);
    return;
  }
  const handle =
    variable.variablesReference > 0
      ? variable.variablesReference
      : pause.handleFor?.(context.container?.variablesReference ?? 0, variable.name);
  if (!handle) {
    void vscode.window.showErrorMessage(`"${variable.name}" is not an object of its own.`);
    return;
  }
  InspectorPanel.open({
    readIn: { session: 'notebook', ownerKey: pause.ownerKey },
    from: REGISTRY,
    handle,
    label: variable.name,
  });
}

/** Inspect a Persisted Objects row's object, if the row still belongs to what the view shows. */
export function inspectPersisted(view: SavedObjectsProvider, row: SavedRow | undefined): void {
  const target = row ? view.inspectTarget(row) : undefined;
  if (!target) {
    void vscode.window.showErrorMessage(
      'That row has nothing to inspect, or Persisted Objects has been read again since. Try it once more.',
    );
    return;
  }
  InspectorPanel.open({ ...target, from: PERSISTED_REGISTRY });
}

export function registerInspector(
  extensionPath: string,
  view: SavedObjectsProvider,
): vscode.Disposable {
  extensionRoot = extensionPath;
  return vscode.Disposable.from(
    vscode.commands.registerCommand(INSPECT_VARIABLE, (c: VariableContext) => inspectVariable(c)),
    vscode.commands.registerCommand(INSPECT_PERSISTED, (row: SavedRow) =>
      inspectPersisted(view, row),
    ),
  );
}
