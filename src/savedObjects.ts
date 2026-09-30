import * as vscode from 'vscode';
import { pauseForDebugSession, pauseForOwner } from './debugger';
import { errorMessage, log } from './log';
import {
  PauseVariable,
  ROOT_LISTING_LIMIT,
  abortQuery,
  commitQuery,
  freeKeyQuery,
  inspectQuery,
  keyTakenQuery,
  needsCommitQuery,
  parseChildren,
  parseSaveSuggestion,
  removeCommittedQuery,
  removeSavedQuery,
  rootListingQuery,
  saveSuggestionQuery,
  saveToRootQuery,
  unquote,
} from './pauseVariables';
import { isRunning, listProcesses } from './processes';
import { executeAsync, sessionForIfOpen, sessionRegistry } from './session';

/**
 * Saving an object from the debugger into the database, and the Saved Objects
 * view that shows what `gemdb.root` holds.
 *
 * Saving is `gemdb.root[key] = value`, run in the paused notebook's session,
 * and deliberately nothing more: it does not commit. A commit writes the whole
 * transaction — GemStone cannot commit one object — so committing from a
 * right-click would also save everything the paused cell had half-changed.
 * The object is in `gemdb.root` for that notebook at once, and in the
 * database at the notebook's next commit, whichever way that commit comes:
 * the user's own `gemdb.commit()`, or the Commit button in this view.
 *
 * The view groups by notebook because a transaction belongs to a session and
 * each notebook has its own: its Commit and Abort act on that notebook alone.
 * Below the notebooks, `gemdb.root` lists what is committed, read by the
 * extension's own session after a fresh view, so it shows what every other
 * session will see.
 */

/** The view under GemDB Code in the activity bar. */
export const VIEW_ID = 'gemdbSavedObjects';
/**
 * The same view in Run and Debug, shown during a GemDB debug session: saving
 * happens there, so what was saved and the Commit that keeps it are beside
 * the Variables it came from. One provider backs both, so they never differ.
 */
export const DEBUG_VIEW_ID = 'gemdbSavedObjectsDebug';

/** An object saved from the debugger, not yet known to be committed or discarded. */
export interface PendingSave {
  key: string;
  type: string;
  ownerKey: string;
}

/** A notebook with a session, and whether it has changes a commit would write. */
export interface NotebookState {
  key: string;
  label: string;
  /** Undefined while the notebook is running a cell and cannot be asked. */
  dirty: boolean | undefined;
}

/** One committed entry of `gemdb.root`. */
export interface RootEntry {
  key: string;
  type: string;
  value: string;
}

export type SavedRow =
  | { kind: 'notebook'; notebook: NotebookState; saves: PendingSave[] }
  | { kind: 'pending'; save: PendingSave }
  | { kind: 'root'; entries: RootEntry[] }
  | { kind: 'entry'; entry: RootEntry }
  | { kind: 'message'; text: string };

/** Names that say nothing about the object: `self`, a loop variable, a temp. */
const GENERIC_NAMES = new Set([
  'self',
  'cls',
  'obj',
  'item',
  'value',
  'val',
  'tmp',
  'temp',
  'result',
  'res',
  'data',
  'x',
  'y',
  'z',
]);

const KEY_CHARS = 40;

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, KEY_CHARS)
    .replace(/_+$/, '');
}

/**
 * A key worth keeping for an object about to be saved, before it is made
 * unique against what `gemdb.root` already has.
 *
 * What identifies the object comes first, because the same object is often
 * reached through a name that says nothing (`self`, `r`, `found`): its type
 * and its `name`-like attribute, `employee_barbara`. Failing that, the
 * variable's name, when it means something (`ceo`, `orders`, a dict entry's
 * `'config'`). Failing that, the type alone.
 */
export function suggestKey(parts: { name: string; type: string; label?: string }): string {
  const type = slug(parts.type);
  const label = parts.label === undefined ? '' : slug(parts.label);
  if (label) return slug(type ? `${type}_${label}` : label);
  const name = unquote(parts.name);
  const meaningful =
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && name.length > 1 && !GENERIC_NAMES.has(name);
  if (meaningful) return slug(name);
  return type || 'saved';
}

/** The Python that reads a saved object back. */
export function accessCode(key: string): string {
  return `gemdb.root[${JSON.stringify(key)}]`;
}

/** What the toast after a save says. */
export function savedNotice(key: string, notebook: string): string {
  return (
    `Saved as ${accessCode(key)}. ${notebook}'s next commit writes it to the database, ` +
    `along with the notebook's other changes. After that, any session reads it with ` +
    `${accessCode(key)}.`
  );
}

/**
 * The view's top-level rows. A notebook appears only while it holds objects
 * saved from the debugger that are not committed yet, with them under it;
 * `gemdb.root` follows with what is committed.
 */
export function topRows(
  running: boolean,
  notebooks: NotebookState[],
  pending: PendingSave[],
  root: RootEntry[] | string,
): SavedRow[] {
  if (!running) return [{ kind: 'message', text: 'Start GemDB to see saved objects.' }];
  const rows: SavedRow[] = notebooks
    .map((notebook): SavedRow & { kind: 'notebook' } => ({
      kind: 'notebook',
      notebook,
      saves: pending.filter((save) => save.ownerKey === notebook.key),
    }))
    .filter((row) => row.saves.length > 0);
  rows.push(
    typeof root === 'string' ? { kind: 'message', text: root } : { kind: 'root', entries: root },
  );
  return rows;
}

/**
 * Drop the pending saves that are settled: a notebook with nothing left to
 * commit has either committed them (they now show under `gemdb.root`) or
 * aborted them, and a notebook with no session has lost them.
 */
export function settlePending(pending: PendingSave[], notebooks: NotebookState[]): PendingSave[] {
  return pending.filter((save) => {
    const notebook = notebooks.find((n) => n.key === save.ownerKey);
    return notebook !== undefined && notebook.dirty !== false;
  });
}

/** A fenced block's text: one line per row, and nothing that could close the fence. */
function fenceLine(text: string): string {
  return text.replace(/\r?\n/g, ' ⏎ ').replace(/````/g, "'''");
}

/**
 * The hover for a saved object: key, type and whether it is committed, its
 * text, then its first children with their values, aligned.
 */
export function inspectMarkdown(
  key: string,
  committed: boolean,
  self: PauseVariable,
  children: PauseVariable[],
): string {
  const total = self.indexed + self.named;
  const width = Math.min(24, Math.max(0, ...children.map((c) => c.name.length)));
  const lines = children.map((c) => `${fenceLine(c.name).padEnd(width)}  ${fenceLine(c.value)}`);
  if (total > children.length) lines.push(`… ${total - children.length} more`);
  const state = committed ? 'committed' : 'saved, not committed yet';
  const parts = [
    `**${key}** · \`${self.type}\` · ${state}`,
    '````text\n' + fenceLine(self.value) + '\n````',
  ];
  if (lines.length > 0) parts.push('````text\n' + lines.join('\n') + '\n````');
  parts.push(`Read it with \`${accessCode(key)}\``);
  if (!committed) {
    parts.push(
      '_Only this notebook sees it until it commits. Commit and Abort on this row act on the ' +
        'whole notebook: the database commits a transaction, never one object._',
    );
  }
  return parts.join('\n\n');
}

/** Run Smalltalk in a notebook's session: through its pause if it is paused, else directly. */
async function inNotebook(ownerKey: string, code: string): Promise<string> {
  const pause = pauseForOwner(ownerKey);
  if (pause?.query) return pause.query(code);
  const session = sessionForIfOpen(ownerKey);
  if (!session) throw new Error('That notebook has no database session.');
  return session.executeAsync(code);
}

/** A Python-side answer that is an `Error: …` line, as an exception. */
function orThrow(answer: string): string {
  if (answer.startsWith('Error: ')) throw new Error(answer.slice('Error: '.length));
  return answer;
}

function toEntry(row: PauseVariable): RootEntry {
  return { key: row.name, type: row.type, value: row.value };
}

export class SavedObjectsProvider implements vscode.TreeDataProvider<SavedRow> {
  private readonly emitter = new vscode.EventEmitter<SavedRow | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private rows: SavedRow[] | undefined;
  private pending: PendingSave[] = [];
  private inFlight: Promise<void> | undefined;
  /**
   * Each parent's child rows, made once per load: `reveal` finds a row by
   * identity, so asking twice must answer the same objects.
   */
  private children = new WeakMap<SavedRow, SavedRow[]>();

  refresh(): void {
    this.rows = undefined;
    this.emitter.fire(undefined);
  }

  /** The notebook a row acts on: a notebook row's own, or a pending save's. */
  notebookOf(row: SavedRow): { notebook: NotebookState; saves: PendingSave[] } | undefined {
    if (row.kind === 'notebook') return row;
    if (row.kind !== 'pending') return undefined;
    const found = this.rows?.find(
      (r): r is Extract<SavedRow, { kind: 'notebook' }> =>
        r.kind === 'notebook' && r.notebook.key === row.save.ownerKey,
    );
    return found;
  }

  /** Forget a pending save that was taken back. */
  dropPending(key: string, ownerKey: string): void {
    this.pending = this.pending.filter((p) => !(p.key === key && p.ownerKey === ownerKey));
    this.refresh();
  }

  /** Note a save from the debugger, so it shows as not committed until it is. */
  notePending(save: PendingSave): void {
    this.pending = [...this.pending.filter((p) => p.key !== save.key), save];
    this.refresh();
  }

  getTreeItem(row: SavedRow): vscode.TreeItem {
    const { Expanded, None } = vscode.TreeItemCollapsibleState;
    switch (row.kind) {
      case 'notebook': {
        const { notebook } = row;
        const item = new vscode.TreeItem(notebook.label, row.saves.length > 0 ? Expanded : None);
        item.description =
          notebook.dirty === undefined
            ? 'running a cell'
            : notebook.dirty
              ? 'uncommitted changes'
              : 'nothing to commit';
        item.iconPath = new vscode.ThemeIcon('notebook');
        item.contextValue = notebook.dirty ? 'gemdbNotebookDirty' : 'gemdbNotebook';
        item.tooltip =
          'Commit writes everything this notebook has changed, saved objects included; ' +
          'Abort discards it.';
        return item;
      }
      case 'pending': {
        const item = new vscode.TreeItem(row.save.key, None);
        item.description = `${row.save.type} · saved, not committed yet`;
        item.iconPath = new vscode.ThemeIcon(
          'circle-outline',
          new vscode.ThemeColor('charts.orange'),
        );
        item.contextValue = 'gemdbSavedPending';
        // The tooltip is left for resolveTreeItem, which inspects the object on hover.
        return item;
      }
      case 'root': {
        const item = new vscode.TreeItem('gemdb.root', row.entries.length > 0 ? Expanded : None);
        const count = row.entries.length;
        item.description =
          count === 0
            ? 'nothing committed yet'
            : `committed · ${count}${count >= ROOT_LISTING_LIMIT ? '+' : ''} ` +
              (count === 1 ? 'object' : 'objects');
        item.iconPath = new vscode.ThemeIcon('database');
        return item;
      }
      case 'entry': {
        const item = new vscode.TreeItem(row.entry.key, None);
        item.description = `${row.entry.type} = ${row.entry.value}`;
        item.iconPath = new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green'));
        item.contextValue = 'gemdbSavedObject';
        return item;
      }
      case 'message':
        return new vscode.TreeItem(row.text, None);
    }
  }

  /**
   * Inspect a saved object when the pointer rests on it: its type, its text
   * and its first children, read when asked rather than for every row. A
   * committed one is read by the extension's own session; one not committed
   * yet exists only in its notebook's session, so it is read there.
   */
  async resolveTreeItem(item: vscode.TreeItem, row: SavedRow): Promise<vscode.TreeItem> {
    if (row.kind !== 'entry' && row.kind !== 'pending') return item;
    const key = row.kind === 'entry' ? row.entry.key : row.save.key;
    try {
      const raw = orThrow(
        row.kind === 'entry'
          ? await executeAsync(inspectQuery(key, true))
          : await inNotebook(row.save.ownerKey, inspectQuery(key, false)),
      );
      const [self, ...children] = parseChildren(raw);
      if (!self) throw new Error('nothing came back');
      const markdown = new vscode.MarkdownString(
        inspectMarkdown(key, row.kind === 'entry', self, children),
      );
      item.tooltip = markdown;
    } catch (e) {
      item.tooltip = `Could not inspect ${accessCode(key)}: ${errorMessage(e)}`;
    }
    return item;
  }

  getChildren(row?: SavedRow): SavedRow[] {
    if (row?.kind === 'notebook' || row?.kind === 'root') {
      let rows = this.children.get(row);
      if (!rows) {
        rows =
          row.kind === 'notebook'
            ? row.saves.map((save): SavedRow => ({ kind: 'pending', save }))
            : row.entries.map((entry): SavedRow => ({ kind: 'entry', entry }));
        this.children.set(row, rows);
      }
      return rows;
    }
    if (row) return [];
    if (this.rows) return this.rows;
    void this.load();
    return [{ kind: 'message', text: 'Reading gemdb.root…' }];
  }

  getParent(row: SavedRow): SavedRow | undefined {
    return this.rows?.find((top) => this.children.get(top)?.includes(row));
  }

  /**
   * Re-read, then show the row of a save just made in `treeView`: opening
   * the view if it is closed and selecting the row, but leaving the keyboard
   * where it was, so the user sees the save land without losing their place.
   */
  async revealSaved(treeView: vscode.TreeView<SavedRow>, key: string): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      this.refresh();
      await this.load();
      for (const top of this.rows ?? []) {
        if (top.kind !== 'notebook') continue;
        const row = this.getChildren(top).find((r) => r.kind === 'pending' && r.save.key === key);
        if (row) {
          await treeView.reveal(row, { select: true, focus: false, expand: true });
          return;
        }
      }
    }
  }

  private load(): Promise<void> {
    this.inFlight ??= this.read().finally(() => {
      this.inFlight = undefined;
      this.emitter.fire(undefined);
    });
    return this.inFlight;
  }

  private async read(): Promise<void> {
    this.children = new WeakMap();
    const running = isRunning(listProcesses());
    if (!running) {
      this.rows = topRows(false, [], [], []);
      return;
    }
    // Only a notebook holding a pending save is shown, so only those are asked.
    const notebooks = await Promise.all(
      sessionRegistry()
        .filter((info) => this.pending.some((save) => save.ownerKey === info.owner.key))
        .map(async (info): Promise<NotebookState> => {
          let dirty: boolean | undefined;
          try {
            dirty = (await inNotebook(info.owner.key, needsCommitQuery())) === 'true';
          } catch {
            dirty = undefined; // running a cell: the session cannot be asked now
          }
          return { key: info.owner.key, label: info.owner.label, dirty };
        }),
    );
    this.pending = settlePending(this.pending, notebooks);
    let root: RootEntry[] | string;
    try {
      root = parseChildren(await executeAsync(rootListingQuery())).map(toEntry);
    } catch (e) {
      root = `Could not read gemdb.root: ${errorMessage(e)}`;
    }
    this.rows = topRows(true, notebooks, this.pending, root);
  }
}

/** What VS Code hands a command run from a Variables row's context menu. */
interface VariableContext {
  sessionId?: string;
  container?: { variablesReference?: number };
  variable?: { name: string; value: string; variablesReference: number };
}

/** Save the right-clicked Variables row under `gemdb.root`, asking for the key. */
async function saveVariable(
  view: SavedObjectsProvider,
  treeViews: Map<string, vscode.TreeView<SavedRow>>,
  context: VariableContext,
): Promise<void> {
  const pause =
    pauseForDebugSession(context.sessionId) ??
    pauseForDebugSession(vscode.debug.activeDebugSession?.id);
  const variable = context.variable;
  if (!pause?.query || !pause.ownerKey || !variable) {
    void vscode.window.showErrorMessage('Save works on a row of a paused GemDB notebook cell.');
    return;
  }
  const query = pause.query;
  const handle =
    variable.variablesReference > 0
      ? variable.variablesReference
      : pause.handleFor?.(context.container?.variablesReference ?? 0, variable.name);
  if (!handle) {
    void vscode.window.showErrorMessage(`"${variable.name}" is not an object that can be saved.`);
    return;
  }
  try {
    const { type, label } = parseSaveSuggestion(await query(saveSuggestionQuery(handle)));
    const base = suggestKey({ name: variable.name, type, label });
    const suggested = unquote(orThrow(await query(freeKeyQuery(base))));
    const key = await vscode.window.showInputBox({
      title: `Save ${variable.name} to gemdb.root`,
      prompt: 'The key it is saved under. Python reads it back with gemdb.root[key].',
      value: suggested,
      ignoreFocusOut: true,
      validateInput: async (text) => {
        if (!text.trim()) return 'Enter a key.';
        const taken = await query(keyTakenQuery(text)).catch(() => 'false');
        return taken === 'true'
          ? {
              message: `gemdb.root already has "${text}"; saving replaces it.`,
              severity: vscode.InputBoxValidationSeverity.Warning,
            }
          : undefined;
      },
    });
    if (key === undefined) return;
    orThrow(await query(saveToRootQuery(handle, key)));
    view.notePending({ key, type, ownerKey: pause.ownerKey });
    log(`Saved ${variable.name} as ${accessCode(key)} (${pause.label}), not yet committed`);
    // Show it land: the Saved Objects beside the Variables, opened if closed.
    const shown = treeViews.get(DEBUG_VIEW_ID);
    if (shown) {
      view
        .revealSaved(shown, key)
        .catch((e: unknown) => log(`Could not show ${key}: ${errorMessage(e)}`));
    }
    const copy = 'Copy Code';
    const choice = await vscode.window.showInformationMessage(savedNotice(key, pause.label), copy);
    if (choice === copy) {
      await vscode.env.clipboard.writeText(`import gemdb\n\nsaved = ${accessCode(key)}\n`);
    }
  } catch (e) {
    void vscode.window.showErrorMessage(`Could not save ${variable.name}: ${errorMessage(e)}`);
  }
}

async function commitNotebook(view: SavedObjectsProvider, clicked: SavedRow): Promise<void> {
  const row = view.notebookOf(clicked);
  if (!row) return;
  try {
    orThrow(await inNotebook(row.notebook.key, commitQuery()));
    log(`Committed ${row.notebook.label} from Saved Objects`);
  } catch (e) {
    void vscode.window.showErrorMessage(
      `Could not commit ${row.notebook.label}: ${errorMessage(e)}`,
    );
  }
  view.refresh();
}

async function abortNotebook(view: SavedObjectsProvider, clicked: SavedRow): Promise<void> {
  const row = view.notebookOf(clicked);
  if (!row) return;
  const discard = 'Discard Changes';
  const saved = row.saves.length;
  const choice = await vscode.window.showWarningMessage(
    `Discard everything ${row.notebook.label} has not committed` +
      (saved > 0 ? `, including ${saved} saved ${saved === 1 ? 'object' : 'objects'}?` : '?'),
    { modal: true },
    discard,
  );
  if (choice !== discard) return;
  try {
    orThrow(await inNotebook(row.notebook.key, abortQuery()));
    log(`Aborted ${row.notebook.label} from Saved Objects`);
  } catch (e) {
    void vscode.window.showErrorMessage(
      `Could not abort ${row.notebook.label}: ${errorMessage(e)}`,
    );
  }
  view.refresh();
}

/**
 * Remove a saved object. One not committed yet is taken back in its own
 * notebook, which is where it is. A committed one is deleted by the
 * extension's session and committed on its own, after asking: every other
 * session stops seeing it, and a notebook's other changes are not touched.
 */
async function removeSaved(view: SavedObjectsProvider, row: SavedRow): Promise<void> {
  if (row.kind === 'pending') {
    try {
      orThrow(await inNotebook(row.save.ownerKey, removeSavedQuery(row.save.key)));
      log(`Took back the save of ${accessCode(row.save.key)}`);
      view.dropPending(row.save.key, row.save.ownerKey);
    } catch (e) {
      void vscode.window.showErrorMessage(`Could not remove ${row.save.key}: ${errorMessage(e)}`);
    }
    return;
  }
  if (row.kind !== 'entry') return;
  const remove = 'Remove';
  const choice = await vscode.window.showWarningMessage(
    `Remove ${accessCode(row.entry.key)} from the database?`,
    {
      modal: true,
      detail:
        'This commits the removal on its own, so every session stops seeing it. ' +
        "No notebook's other changes are committed with it.",
    },
    remove,
  );
  if (choice !== remove) return;
  try {
    orThrow(await executeAsync(removeCommittedQuery(row.entry.key)));
    log(`Removed ${accessCode(row.entry.key)} from Saved Objects`);
  } catch (e) {
    void vscode.window.showErrorMessage(`Could not remove ${row.entry.key}: ${errorMessage(e)}`);
  }
  view.refresh();
}

/** Register the view and its commands. Answers the view, for others to refresh. */
export function registerSavedObjects(context: vscode.ExtensionContext): SavedObjectsProvider {
  const view = new SavedObjectsProvider();
  const treeViews = new Map<string, vscode.TreeView<SavedRow>>();
  for (const id of [VIEW_ID, DEBUG_VIEW_ID]) {
    const treeView = vscode.window.createTreeView(id, { treeDataProvider: view });
    treeViews.set(id, treeView);
    context.subscriptions.push(
      treeView,
      treeView.onDidChangeVisibility((event) => {
        if (event.visible) view.refresh();
      }),
    );
  }
  context.subscriptions.push(
    vscode.commands.registerCommand('gemdb.saveVariable', (ctx: VariableContext) =>
      saveVariable(view, treeViews, ctx),
    ),
    vscode.commands.registerCommand('gemdb.savedObjects.refresh', () => view.refresh()),
    vscode.commands.registerCommand('gemdb.savedObjects.remove', (row: SavedRow) =>
      removeSaved(view, row),
    ),
    vscode.commands.registerCommand('gemdb.savedObjects.commit', (row: SavedRow) =>
      commitNotebook(view, row),
    ),
    vscode.commands.registerCommand('gemdb.savedObjects.abort', (row: SavedRow) =>
      abortNotebook(view, row),
    ),
    vscode.commands.registerCommand('gemdb.savedObjects.copyAccess', async (row: SavedRow) => {
      const key =
        row.kind === 'pending' ? row.save.key : row.kind === 'entry' ? row.entry.key : undefined;
      if (key !== undefined) await vscode.env.clipboard.writeText(accessCode(key));
    }),
  );
  return view;
}
