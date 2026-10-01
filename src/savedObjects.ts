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
import { SessionOwner, executeAsync, sessionForIfOpen, sessionRegistry } from './session';

/**
 * Adding an object from the debugger to the database, and the Persisted
 * Objects view that shows what `gemdb.root` holds. (The user-visible name is
 * "Persisted Objects"; the code says "saved", and the view ids stay
 * `gemdbSavedObjects*` so VS Code keeps a user's layout.)
 *
 * The words are chosen for a new user: **add** puts an object under
 * `gemdb.root`, **persist** is what a commit does, and **remove** takes one
 * out — persisted the same way. Every tooltip says which of those a row is
 * waiting on.
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
  /** The notebook's name, kept so the origin outlives its session. */
  notebook: string;
  /** When it was added, as an ISO date. */
  at: string;
}

/** Where a committed entry came from, when it was added from the debugger. */
export interface Origin {
  notebook: string;
  /** Its type when added, so an entry since replaced by other code is not misattributed. */
  type: string;
  at: string;
}

/**
 * The origins to remember after a read. A pending save that settled (it is no
 * longer pending) and whose key is now committed was committed: it keeps its
 * notebook as its origin. One that settled without reaching gemdb.root was
 * aborted and leaves nothing. An origin whose key is no longer committed is
 * forgotten, so a key reused later starts clean.
 */
export function settleOrigins(
  before: PendingSave[],
  after: PendingSave[],
  committed: Set<string>,
  origins: Record<string, Origin>,
): Record<string, Origin> {
  const next: Record<string, Origin> = {};
  for (const [key, origin] of Object.entries(origins)) {
    if (committed.has(key)) next[key] = origin;
  }
  for (const save of before) {
    const settled = !after.some((p) => p.key === save.key && p.ownerKey === save.ownerKey);
    if (settled && committed.has(save.key)) {
      next[save.key] = { notebook: save.notebook, type: save.type, at: save.at };
    }
  }
  return next;
}

/** The origin of an entry, if it is still the object that was added. */
export function originOf(entry: RootEntry, origins: Record<string, Origin>): Origin | undefined {
  const origin = origins[entry.key];
  return origin && origin.type === entry.type ? origin : undefined;
}

/** `2026-10-01 16:20`, in local time, for a hover. */
function whenText(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
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

/** What the view's body says when nothing is persisted or waiting. */
export const EMPTY_GUIDE =
  'Nothing is persisted yet. Persisting takes two steps: add an object under gemdb.root — ' +
  'when a cell pauses at breakpoint(), right-click a variable in the Run and Debug pane’s ' +
  'Variables and choose Add to Persisted Objects…, or ' +
  'write gemdb.root["name"] = value in a cell — and then commit, with ✓ above or ' +
  'gemdb.commit(). Adding alone does not persist it.';

/**
 * The `gemdb.root` row's tooltip. It opens with the rule a new user misses —
 * putting an object under gemdb.root does not keep it; a commit does — before
 * it says what the list shows, so nobody reads the list as "put it here and
 * it is kept".
 */
export const ROOT_GUIDE = [
  '**Persisting takes two steps: add, then commit.**',
  '**1. Add** the object under `gemdb.root`. When a cell pauses at `breakpoint()`, the ' +
    '**Run and Debug** pane opens; right-click a variable in its **Variables** section and ' +
    'choose *Add to Persisted Objects…*. Or write `gemdb.root["name"] = value` in a cell. **This alone ' +
    'does not persist it.** Until a commit, only your notebook sees it, and an Abort or closing ' +
    'the notebook throws it away. It shows in orange under its notebook while it waits.',
  '**2. Commit**: ✓ in this view (also shown in Run and Debug while a cell is paused), or ' +
    '`gemdb.commit()` in code. Only now is it in the ' +
    'database, for every session, through restarts. A commit writes everything the notebook has ' +
    'changed, not only what was added.',
  'The entries under this row are the ones already committed. One added from the debugger ' +
    'still says which notebook it came from.',
  '**Removing** takes the same two steps: delete, then commit. *Remove from Persisted Objects* ' +
    'on an entry here does both at once, committing that removal on its own. In code, ' +
    '`del gemdb.root["name"]` and then `gemdb.commit()`.',
].join('\n\n');

/** The guide as plain text, for a dialog, which shows no Markdown. */
export function plainGuide(): string {
  return ROOT_GUIDE.replace(/\*\*|\*|`/g, '');
}

/** Shown beside the view's name, so the rule is in sight before any hover. */
export const VIEW_DESCRIPTION = 'add, then commit';

/** A notebook row's tooltip: its additions are waiting on its commit. */
export function notebookGuide(notebook: string): string {
  return [
    `**${notebook}: added, not persisted yet**`,
    'These objects are under `gemdb.root` for this notebook only. **Commit** (✓) persists ' +
      'them, together with everything else this notebook has changed. **Abort** (↺) ' +
      "discards them and the rest of the notebook's uncommitted changes.",
    'To drop just one, right-click it and choose *Remove from Persisted Objects*.',
  ].join('\n\n');
}

/** The Python that reads a saved object back. */
export function accessCode(key: string): string {
  return `gemdb.root[${JSON.stringify(key)}]`;
}

/** What the toast after a save says. */
export function savedNotice(key: string, notebook: string): string {
  return (
    `Added to Persisted Objects as ${accessCode(key)}. It persists when ${notebook} commits ` +
    `(✓ in Persisted Objects, or gemdb.commit()), along with the notebook's other changes. ` +
    `Then any session reads it with ${accessCode(key)}.`
  );
}

/**
 * The view's top-level rows. `gemdb.root` comes first — it is what persists,
 * and what everything else hangs from — then each notebook holding objects
 * added from the debugger that are not committed yet, with them under it.
 */
export function topRows(
  running: boolean,
  notebooks: NotebookState[],
  pending: PendingSave[],
  root: RootEntry[] | string,
): SavedRow[] {
  if (!running) return [{ kind: 'message', text: 'Start GemDB to see persisted objects.' }];
  const rows: SavedRow[] = [
    typeof root === 'string' ? { kind: 'message', text: root } : { kind: 'root', entries: root },
  ];
  const waiting = notebooks
    .map((notebook): SavedRow & { kind: 'notebook' } => ({
      kind: 'notebook',
      notebook,
      saves: pending.filter((save) => save.ownerKey === notebook.key),
    }))
    .filter((row) => row.saves.length > 0);
  return [...rows, ...waiting];
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
  origin?: Origin,
): string {
  const total = self.indexed + self.named;
  const width = Math.min(24, Math.max(0, ...children.map((c) => c.name.length)));
  const lines = children.map((c) => `${fenceLine(c.name).padEnd(width)}  ${fenceLine(c.value)}`);
  if (total > children.length) lines.push(`… ${total - children.length} more`);
  const state = committed ? 'persisted' : 'added, not persisted yet';
  const parts = [
    `**${key}** · \`${self.type}\` · ${state}`,
    '````text\n' + fenceLine(self.value) + '\n````',
  ];
  if (lines.length > 0) parts.push('````text\n' + lines.join('\n') + '\n````');
  parts.push(`Read it with \`${accessCode(key)}\``);
  if (origin) parts.push(`Added from **${origin.notebook}** on ${whenText(origin.at)}.`);
  parts.push(
    committed
      ? '_Persisted: every session sees it. **Remove** deletes it and commits the removal at ' +
          'once. In code, `del gemdb.root[…]` and then `gemdb.commit()`._'
      : '_Added, not persisted yet: only this notebook sees it. **Commit** persists it, with ' +
          'everything else this notebook changed, because the database commits a whole ' +
          'transaction, never one object. **Remove** takes it back._',
  );
  return parts.join('\n\n');
}

/**
 * Which notebook the title bar's Commit and Abort act on, when no row says:
 * the one paused at breakpoint() (where the user is looking), else the one in
 * the active editor, else the only one connected. Undefined means ask among
 * `connected`; an empty `connected` means there is nothing to act on.
 */
export function chooseNotebook(
  connected: SessionOwner[],
  pausedKey: string | undefined,
  activeKey: string | undefined,
): SessionOwner | undefined {
  return (
    connected.find((owner) => owner.key === pausedKey) ??
    connected.find((owner) => owner.key === activeKey) ??
    (connected.length === 1 ? connected[0] : undefined)
  );
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

/** Where the origins of committed additions are kept (global state). */
const ORIGINS_KEY = 'gemdb.persistedObjectOrigins';

export class SavedObjectsProvider implements vscode.TreeDataProvider<SavedRow> {
  private readonly emitter = new vscode.EventEmitter<SavedRow | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private rows: SavedRow[] | undefined;
  private pending: PendingSave[] = [];
  /** Committed entries added from the debugger, by key; kept across restarts. */
  private origins: Record<string, Origin>;
  private inFlight: Promise<void> | undefined;
  /**
   * Each parent's child rows, made once per load: `reveal` finds a row by
   * identity, so asking twice must answer the same objects.
   */
  private children = new WeakMap<SavedRow, SavedRow[]>();

  constructor(private readonly store?: vscode.Memento) {
    this.origins = store?.get<Record<string, Origin>>(ORIGINS_KEY) ?? {};
  }

  refresh(): void {
    this.rows = undefined;
    this.emitter.fire(undefined);
  }

  private setOrigins(origins: Record<string, Origin>): void {
    this.origins = origins;
    void this.store?.update(ORIGINS_KEY, origins);
  }

  /** Forget the origin of an entry that was removed. */
  forgetOrigin(key: string): void {
    const { [key]: _gone, ...rest } = this.origins;
    this.setOrigins(rest);
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

  /**
   * The guidance the view's body shows above its rows: only once read, with
   * the database running and nothing persisted or waiting to be.
   */
  get message(): string | undefined {
    const rows = this.rows;
    if (!rows) return undefined;
    const empty = rows.every((row) => row.kind === 'root' && row.entries.length === 0);
    return empty && rows.length > 0 ? EMPTY_GUIDE : undefined;
  }

  /** The saves a notebook holds that are not committed yet. */
  pendingFor(ownerKey: string): PendingSave[] {
    return this.pending.filter((save) => save.ownerKey === ownerKey);
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
        item.tooltip = new vscode.MarkdownString(notebookGuide(notebook.label));
        return item;
      }
      case 'pending': {
        const item = new vscode.TreeItem(row.save.key, None);
        item.description = `${row.save.type} · added, not persisted yet`;
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
            ? 'nothing persisted yet'
            : `persisted · ${count}${count >= ROOT_LISTING_LIMIT ? '+' : ''} ` +
              (count === 1 ? 'object' : 'objects');
        item.iconPath = new vscode.ThemeIcon('database');
        item.tooltip = new vscode.MarkdownString(ROOT_GUIDE);
        return item;
      }
      case 'entry': {
        const item = new vscode.TreeItem(row.entry.key, None);
        const origin = originOf(row.entry, this.origins);
        item.description =
          (origin ? `from ${origin.notebook} · ` : '') + `${row.entry.type} = ${row.entry.value}`;
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
        inspectMarkdown(
          key,
          row.kind === 'entry',
          self,
          children,
          row.kind === 'entry'
            ? originOf(row.entry, this.origins)
            : { notebook: row.save.notebook, type: row.save.type, at: row.save.at },
        ),
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
    let root: RootEntry[] | string;
    try {
      root = parseChildren(await executeAsync(rootListingQuery())).map(toEntry);
    } catch (e) {
      root = `Could not read gemdb.root: ${errorMessage(e)}`;
    }
    const before = this.pending;
    this.pending = settlePending(this.pending, notebooks);
    // A save that just settled into gemdb.root keeps its notebook as its origin.
    if (typeof root !== 'string') {
      const committed = new Set(root.map((entry) => entry.key));
      this.setOrigins(settleOrigins(before, this.pending, committed, this.origins));
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
    void vscode.window.showErrorMessage(
      'Add to Persisted Objects works on a variable in Run and Debug, while a GemDB notebook ' +
        'cell is paused at breakpoint().',
    );
    return;
  }
  const query = pause.query;
  const handle =
    variable.variablesReference > 0
      ? variable.variablesReference
      : pause.handleFor?.(context.container?.variablesReference ?? 0, variable.name);
  if (!handle) {
    void vscode.window.showErrorMessage(`"${variable.name}" is not an object that can be added.`);
    return;
  }
  try {
    const { type, label } = parseSaveSuggestion(await query(saveSuggestionQuery(handle)));
    const base = suggestKey({ name: variable.name, type, label });
    const suggested = unquote(orThrow(await query(freeKeyQuery(base))));
    const key = await vscode.window.showInputBox({
      title: `Add ${variable.name} to Persisted Objects`,
      prompt:
        'Its key under gemdb.root. It persists at the notebook’s next commit; Python reads it ' +
        'back with gemdb.root[key].',
      value: suggested,
      ignoreFocusOut: true,
      validateInput: async (text) => {
        if (!text.trim()) return 'Enter a key.';
        const taken = await query(keyTakenQuery(text)).catch(() => 'false');
        return taken === 'true'
          ? {
              message: `gemdb.root already has "${text}"; adding replaces it when the notebook commits.`,
              severity: vscode.InputBoxValidationSeverity.Warning,
            }
          : undefined;
      },
    });
    if (key === undefined) return;
    orThrow(await query(saveToRootQuery(handle, key)));
    view.notePending({
      key,
      type,
      ownerKey: pause.ownerKey,
      notebook: pause.label,
      at: new Date().toISOString(),
    });
    log(`Saved ${variable.name} as ${accessCode(key)} (${pause.label}), not yet committed`);
    // Show it land: the Persisted Objects beside the Variables, opened if closed.
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
    void vscode.window.showErrorMessage(`Could not add ${variable.name}: ${errorMessage(e)}`);
  }
}

/**
 * The notebook a Commit or Abort acts on: the clicked row's, or — from the
 * title bar, where nothing was clicked — one chosen by `chooseNotebook`,
 * asking when it cannot tell.
 */
async function targetOf(
  view: SavedObjectsProvider,
  clicked: SavedRow | undefined,
  verb: string,
): Promise<{ notebook: NotebookState; saves: PendingSave[] } | undefined> {
  if (clicked) return view.notebookOf(clicked);
  const connected = sessionRegistry()
    .filter((info) => info.owner.kind === 'notebook')
    .map((info) => info.owner);
  if (connected.length === 0) {
    void vscode.window.showInformationMessage(
      `No notebook is connected to GemDB yet. Run a cell, and ${verb} acts on that notebook's changes.`,
    );
    return undefined;
  }
  const pausedKey = connected.find((owner) => pauseForOwner(owner.key))?.key;
  const activeKey = vscode.window.activeNotebookEditor?.notebook.uri.toString();
  let owner = chooseNotebook(connected, pausedKey, activeKey);
  if (!owner) {
    const picked = await vscode.window.showQuickPick(
      connected.map((o) => ({ label: o.label, owner: o })),
      { title: `${verb} which notebook's changes?` },
    );
    owner = picked?.owner;
  }
  if (!owner) return undefined;
  return {
    notebook: { key: owner.key, label: owner.label, dirty: undefined },
    saves: view.pendingFor(owner.key),
  };
}

async function commitNotebook(view: SavedObjectsProvider, clicked?: SavedRow): Promise<void> {
  const row = await targetOf(view, clicked, 'Commit');
  if (!row) return;
  try {
    orThrow(await inNotebook(row.notebook.key, commitQuery()));
    log(`Committed ${row.notebook.label} from Persisted Objects`);
    if (!clicked) void vscode.window.showInformationMessage(`Committed ${row.notebook.label}.`);
  } catch (e) {
    void vscode.window.showErrorMessage(
      `Could not commit ${row.notebook.label}: ${errorMessage(e)}`,
    );
  }
  view.refresh();
}

async function abortNotebook(view: SavedObjectsProvider, clicked?: SavedRow): Promise<void> {
  const row = await targetOf(view, clicked, 'Abort');
  if (!row) return;
  const discard = 'Discard Changes';
  const saved = row.saves.length;
  const choice = await vscode.window.showWarningMessage(
    `Discard everything ${row.notebook.label} has not committed` +
      (saved > 0 ? `, including ${saved} added ${saved === 1 ? 'object' : 'objects'}?` : '?'),
    {
      modal: true,
      detail: 'Nothing it changed since its last commit will be persisted.',
    },
    discard,
  );
  if (choice !== discard) return;
  try {
    orThrow(await inNotebook(row.notebook.key, abortQuery()));
    log(`Aborted ${row.notebook.label} from Persisted Objects`);
  } catch (e) {
    void vscode.window.showErrorMessage(
      `Could not abort ${row.notebook.label}: ${errorMessage(e)}`,
    );
  }
  view.refresh();
}

/** The rows a command acts on: the whole selection when the clicked row is in it. */
function actedOn(clicked: SavedRow, selected: SavedRow[] | undefined): SavedRow[] {
  return selected && selected.length > 1 && selected.includes(clicked) ? selected : [clicked];
}

/** The keys a confirmation names: the first few, then how many more. */
export function keyList(keys: string[], shown = 8): string {
  const named = keys.slice(0, shown).join(', ');
  return keys.length > shown ? `${named} and ${keys.length - shown} more` : named;
}

/**
 * Remove the selected objects. One not committed yet is taken back in its own
 * notebook, which is where it is. Committed ones are deleted by the
 * extension's session and committed together, on their own, after asking:
 * every other session stops seeing them, a notebook's other changes are not
 * touched, and a conflict removes none of them rather than some.
 */
async function removeSaved(
  view: SavedObjectsProvider,
  clicked: SavedRow,
  selected?: SavedRow[],
): Promise<void> {
  const rows = actedOn(clicked, selected);
  const pending = rows.flatMap((row) => (row.kind === 'pending' ? [row.save] : []));
  const committed = rows.flatMap((row) => (row.kind === 'entry' ? [row.entry.key] : []));
  if (committed.length > 0) {
    const remove = 'Remove';
    const what =
      committed.length === 1
        ? accessCode(committed[0])
        : `${committed.length} persisted objects (${keyList(committed)})`;
    const choice = await vscode.window.showWarningMessage(
      `Remove ${what} from Persisted Objects?`,
      {
        modal: true,
        detail:
          'This commits the removal on its own, so every session stops seeing ' +
          (committed.length === 1 ? 'it' : 'them') +
          ". No notebook's other changes are committed with it." +
          (pending.length > 0
            ? ` The ${pending.length} not yet persisted ${pending.length === 1 ? 'is' : 'are'} taken back too.`
            : ''),
      },
      remove,
    );
    if (choice !== remove) return;
  }
  const byNotebook = new Map<string, PendingSave[]>();
  for (const save of pending) {
    byNotebook.set(save.ownerKey, [...(byNotebook.get(save.ownerKey) ?? []), save]);
  }
  for (const [ownerKey, saves] of byNotebook) {
    try {
      orThrow(await inNotebook(ownerKey, removeSavedQuery(saves.map((save) => save.key))));
      log(`Took back ${saves.map((save) => accessCode(save.key)).join(', ')}`);
      for (const save of saves) view.dropPending(save.key, save.ownerKey);
    } catch (e) {
      void vscode.window.showErrorMessage(
        `Could not remove ${keyList(saves.map((save) => save.key))}: ${errorMessage(e)}`,
      );
    }
  }
  if (committed.length > 0) {
    try {
      orThrow(await executeAsync(removeCommittedQuery(committed)));
      log(`Removed ${committed.map(accessCode).join(', ')} from Persisted Objects`);
      for (const key of committed) view.forgetOrigin(key);
    } catch (e) {
      void vscode.window.showErrorMessage(
        `Could not remove ${keyList(committed)}; none were removed: ${errorMessage(e)}`,
      );
    }
  }
  view.refresh();
}

/** Register the view and its commands. Answers the view, for others to refresh. */
export function registerSavedObjects(context: vscode.ExtensionContext): SavedObjectsProvider {
  const view = new SavedObjectsProvider(context.globalState);
  const treeViews = new Map<string, vscode.TreeView<SavedRow>>();
  for (const id of [VIEW_ID, DEBUG_VIEW_ID]) {
    // Many rows at once, so a handful of objects can be removed in one go.
    const treeView = vscode.window.createTreeView(id, {
      treeDataProvider: view,
      canSelectMany: true,
    });
    treeViews.set(id, treeView);
    treeView.description = VIEW_DESCRIPTION;
    context.subscriptions.push(view.onDidChangeTreeData(() => (treeView.message = view.message)));
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
    vscode.commands.registerCommand('gemdb.savedObjects.help', () =>
      vscode.window.showInformationMessage('How persisting works', {
        modal: true,
        detail: plainGuide(),
      }),
    ),
    vscode.commands.registerCommand(
      'gemdb.savedObjects.remove',
      (row: SavedRow, selected?: SavedRow[]) => removeSaved(view, row, selected),
    ),
    vscode.commands.registerCommand('gemdb.savedObjects.commit', (row: SavedRow) =>
      commitNotebook(view, row),
    ),
    vscode.commands.registerCommand('gemdb.savedObjects.abort', (row: SavedRow) =>
      abortNotebook(view, row),
    ),
    // The title bar's: always there, so a new user can find them before saving anything.
    vscode.commands.registerCommand('gemdb.savedObjects.commitNotebook', () =>
      commitNotebook(view),
    ),
    vscode.commands.registerCommand('gemdb.savedObjects.abortNotebook', () => abortNotebook(view)),
    vscode.commands.registerCommand(
      'gemdb.savedObjects.copyAccess',
      async (row: SavedRow, selected?: SavedRow[]) => {
        const keys = actedOn(row, selected).flatMap((r) =>
          r.kind === 'pending' ? [r.save.key] : r.kind === 'entry' ? [r.entry.key] : [],
        );
        if (keys.length > 0) await vscode.env.clipboard.writeText(keys.map(accessCode).join('\n'));
      },
    ),
  );
  return view;
}
