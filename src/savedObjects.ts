import * as vscode from 'vscode';
import {
  ConsoleHost,
  Pause,
  debugConsole,
  openCellTexts,
  openPause,
  pauseForDebugSession,
  pauseForOwner,
  rowHandles,
  toDapVariable,
} from './debugger';
import { errorMessage, log } from './log';
import { runFileOf } from './fileOwner';
import {
  ChildKind,
  ConsoleScope,
  MAIN_MODULE,
  ObjectDiff,
  PAGE,
  Pending,
  PendingChange,
  PathStep,
  PERSISTED_REGISTRY,
  REGISTRY,
  PauseVariable,
  ROOT_LISTING_LIMIT,
  abortQuery,
  childrenQuery,
  commitQuery,
  freeKeyQuery,
  inspectQuery,
  keyPositionQuery,
  keyTakenQuery,
  needsCommitQuery,
  parseChildren,
  Snapshot,
  diffSnapshots,
  parsePaths,
  parsePending,
  parseSaveSuggestion,
  parseSnapshot,
  parseSteps,
  pathText,
  pathToQuery,
  pathsToQuery,
  pendingQuery,
  revertPlan,
  revertQuery,
  snapshotQuery,
  stepNames,
  withoutUnchanged,
  persistedRowsQuery,
  removeCommittedQuery,
  removeSavedQuery,
  rootListingQuery,
  rootSizeQuery,
  saveSuggestionQuery,
  saveToRootQuery,
  unquote,
} from './pauseVariables';
import { isRunning, listProcesses } from './processes';
import {
  SAVED_STACK_NOTE,
  liveSourceWorld,
  openStackQuery,
  parseOpenedStack,
  restoredFrames,
  saveStackQuery,
  savedFrameOf,
  savedPauseLabel,
  SavedStackSummary,
  noteSavedStacks,
  savedStackKeysQuery,
  stackKeyFor,
} from './savedStacks';
import {
  EXTENSION_OWNER,
  PAUSED_QUERY_BUDGET_MS,
  SessionOwner,
  closeSessionFor,
  executeAsync,
  interruptSessionFor,
  sessionFor,
  sessionForIfOpen,
  sessionRegistry,
} from './session';

/**
 * Run Smalltalk in the extension's own session, one query at a time: the
 * view's reads share that session, and a session runs one evaluation at a
 * time. With `budget`, the query is soft-broken every
 * `PAUSED_QUERY_BUDGET_MS`, as a paused query is, so a slow `__repr__` in a
 * row being opened cuts that row short rather than holding the session.
 */
let extensionChain: Promise<unknown> = Promise.resolve();
export function extensionQuery(code: string, { budget = false } = {}): Promise<string> {
  const run = extensionChain.then(async () => {
    const timer = budget
      ? setInterval(() => interruptSessionFor(EXTENSION_OWNER.key), PAUSED_QUERY_BUDGET_MS)
      : undefined;
    try {
      return await executeAsync(code);
    } finally {
      clearInterval(timer);
    }
  });
  extensionChain = run.catch(() => undefined);
  return run;
}

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
 * Above the notebooks, `gemdb.root` lists what is committed, read by the
 * extension's own session after a fresh view, so it shows what every other
 * session will see.
 *
 * Every entry opens like a Variables row, with nothing paused, read in the
 * session that holds it (`ReadIn`): the extension's for what is committed, the
 * notebook's for an addition. The objects the rows open are kept in that
 * session's `PERSISTED_REGISTRY`, which each reading of the view starts afresh.
 */

/**
 * Added to a row's context value when it is a list, a set or a dict, so its
 * menu offers Go to Item…; the menus that match a row exactly allow for it.
 */
const CONTAINER = ' gemdbContainer';

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
  /** A stack saved from the debugger, which can be opened in it again. */
  stack?: boolean;
  /** Its position in the extension session's `PERSISTED_REGISTRY` when it has children; else 0. */
  ref?: number;
  /** Its position there whether or not it has children: what the Inspector opens it by. */
  handle?: number;
  /** How many children it has, when it has a `ref`. */
  children?: number;
  /** How many of those are items read by position, for a container — what its ranges divide. */
  indexed?: number;
  /** How its children are read (`ChildKind`): a list's, a set's or a dict's, or an object's. */
  kind?: ChildKind;
}

/**
 * The session a row's object is read in: the extension's own for what is
 * committed, or the notebook's whose addition it is, since an object not
 * committed yet exists only there.
 */
export type ReadIn = { session: 'extension' } | { session: 'notebook'; ownerKey: string };

export type SavedRow =
  | {
      kind: 'notebook';
      notebook: NotebookState;
      saves: PendingSave[];
      /** Each addition's row as its notebook read it, by key; absent while it runs a cell. */
      read?: Map<string, PauseVariable>;
    }
  | {
      kind: 'pending';
      save: PendingSave;
      ref?: number;
      /** Its position in the notebook's `PERSISTED_REGISTRY`, children or not (`RootEntry.handle`). */
      handle?: number;
      children?: number;
      indexed?: number;
      kids?: ChildKind;
    }
  /** What is committed: the first entries, and how many there are in all when that is known. */
  | { kind: 'root'; entries: RootEntry[]; total?: number }
  /** A committed entry; `parent` is the range it was read in, when `gemdb.root` shows ranges. */
  | { kind: 'entry'; entry: RootEntry; parent?: SavedRow }
  /** One of an opened object's attributes, items or entries, or a group of them. */
  | { kind: 'field'; field: PauseVariable; readIn: ReadIn; parent: SavedRow }
  /** Items `start` up to `end` of an opened container, or entries of `gemdb.root`, opened to read them. */
  | { kind: 'range'; parent: SavedRow; start: number; end: number }
  /** A notebook's Pending changes: what its next commit writes, read when opened. */
  | { kind: 'changes'; notebook: NotebookState }
  /** One object a notebook's next commit changes; clicking it shows it under `gemdb.root`. */
  | { kind: 'change'; change: PendingChange; parent: SavedRow; diff?: ObjectDiff }
  | { kind: 'message'; text: string; parent?: SavedRow };

/**
 * Where an expandable row's object is: the session to read it in, its
 * registry position, and how many children it has. Undefined for a row that
 * does not open. A saved stack does not: it opens in the debugger instead.
 */
export function openable(
  row: SavedRow,
): { readIn: ReadIn; ref: number; total: number; indexed: number; kind?: ChildKind } | undefined {
  switch (row.kind) {
    case 'entry':
      return row.entry.ref && !row.entry.stack
        ? {
            readIn: { session: 'extension' },
            ref: row.entry.ref,
            total: row.entry.children ?? 0,
            indexed: row.entry.indexed ?? 0,
            kind: row.entry.kind,
          }
        : undefined;
    case 'pending':
      return row.ref
        ? {
            readIn: { session: 'notebook', ownerKey: row.save.ownerKey },
            ref: row.ref,
            total: row.children ?? 0,
            indexed: row.indexed ?? 0,
            kind: row.kids,
          }
        : undefined;
    case 'field':
      return row.field.ref
        ? {
            readIn: row.readIn,
            ref: row.field.ref,
            total: row.field.indexed + row.field.named,
            indexed: row.field.indexed,
            kind: row.field.kind,
          }
        : undefined;
    default:
      return undefined;
  }
}

/** A list's, a set's or a dict's items: what Go to Item… finds one of, by position or by key. */
export type ItemsKind = 'seq' | 'coll' | 'dict';

/** How an opened row's items are read, when it is a list, a set or a dict; else undefined. */
export function itemsKind(row: SavedRow): ItemsKind | undefined {
  const kind = openable(row)?.kind;
  return kind === 'seq' || kind === 'coll' || kind === 'dict' ? kind : undefined;
}

/**
 * What the user typed for a dict's key, as the names its row could have: as
 * typed, and for a bare word, as a str's repr in either quote — so `SKU0042`
 * finds the row named `'SKU0042'`, and `42` still finds an int key.
 */
export function keyNames(text: string): string[] {
  const typed = text.trim();
  if (/^['"]/.test(typed)) return [typed];
  return [typed, `'${typed}'`, `"${typed}"`];
}

/** The rows under an opened object (or one of its ranges), from `childrenQuery`'s answer. */
export function fieldRows(parent: SavedRow, readIn: ReadIn, children: PauseVariable[]): SavedRow[] {
  return children.map((field) => ({ kind: 'field', field, readIn, parent }));
}

/**
 * Range rows covering items `start` up to `end` of an opened container (or
 * entries of `gemdb.root`): one per `page` items, or, for one too big for
 * that to fit in a page of rows, one per `page` × `page` items, each opening
 * to ranges in turn — as VS Code nests the Variables' groups. A container's
 * page is `PAGE`; `gemdb.root`'s is `ROOT_LISTING_LIMIT`, what it lists at first.
 *
 * A container longer than a page opens straight to its ranges, as it does in
 * the Variables, so nothing is read until a range is opened. Only a container
 * is divided: its items can be read from any position. An object never is;
 * past a page, its rows end in `childrenQuery`'s own `...` row.
 */
export function rangeRows(parent: SavedRow, start: number, end: number, page = PAGE): SavedRow[] {
  let span = page;
  while ((end - start) / span > page) span *= page;
  const rows: SavedRow[] = [];
  for (let at = start; at < end; at += span) {
    rows.push({ kind: 'range', parent, start: at, end: Math.min(at + span, end) });
  }
  return rows;
}

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

/** A notebook row's tooltip: its additions and its other changes are waiting on its commit. */
export function notebookGuide(notebook: string): string {
  return [
    `**${notebook}: not committed yet**`,
    'What it added is under `gemdb.root` for this notebook only, and *Pending changes* lists ' +
      'every persisted object it has changed. **Commit** (✓) persists all of it. **Abort** (↺) ' +
      "discards all of it: the additions and the rest of the notebook's uncommitted changes.",
    'To drop just one addition, right-click it and choose *Remove from Persisted Objects*. ' +
      'To undo one change, open it from *Pending changes* and choose *Revert to Committed Value*.',
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
    .filter((row) => row.saves.length > 0 || row.notebook.dirty === true);
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
 * the one paused in the debugger (where the user is looking), else the one in
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

/**
 * Run Smalltalk in a notebook's session: through its pause if it is paused,
 * else directly. With `budget`, a direct run is soft-broken every
 * `PAUSED_QUERY_BUDGET_MS`, as a paused query always is by default, for a read
 * that runs the user's `__repr__`. A caller that says `budget: false` gets no
 * budget at a pause either, and `passHalts` runs past a breakpoint() the query
 * reaches, as a Debug Console line does; with neither said, a paused query runs
 * as a Variables read does (`PausedQueryOptions`).
 *
 * Direct runs on one notebook are chained, one at a time, as the extension
 * session's are (`extensionQuery`) and a pause's are: a session runs one call
 * at a time, and a second one sent while the first runs fails as busy. Two
 * reads close together — an Inspector redrawing two groups after an edit —
 * would otherwise make the second fail with nothing else running.
 */
const notebookChains = new Map<string, Promise<unknown>>();
export async function inNotebook(
  ownerKey: string,
  code: string,
  options: { budget?: boolean; passHalts?: boolean } = {},
): Promise<string> {
  const pause = pauseForOwner(ownerKey);
  if (pause?.query) {
    const said = options.budget !== undefined || options.passHalts !== undefined;
    return said
      ? pause.query(code, { budget: options.budget ?? true, passHalts: options.passHalts === true })
      : pause.query(code);
  }
  const run = (notebookChains.get(ownerKey) ?? Promise.resolve()).then(async () => {
    const session = sessionForIfOpen(ownerKey);
    if (!session) throw new Error('That notebook has no database session.');
    const timer = options.budget
      ? setInterval(() => interruptSessionFor(ownerKey), PAUSED_QUERY_BUDGET_MS)
      : undefined;
    try {
      return await session.executeAsync(code);
    } finally {
      clearInterval(timer);
    }
  });
  const chained = run.catch(() => undefined);
  notebookChains.set(ownerKey, chained);
  void chained.then(() => {
    if (notebookChains.get(ownerKey) === chained) notebookChains.delete(ownerKey);
  });
  return run;
}

/** A Python-side answer that is an `Error: …` line, as an exception. */
function orThrow(answer: string): string {
  if (answer.startsWith('Error: ')) throw new Error(answer.slice('Error: '.length));
  return answer;
}

function toEntry(row: PauseVariable): RootEntry {
  return {
    key: row.name,
    type: row.type,
    value: row.value,
    ref: row.ref,
    ...(row.handle ? { handle: row.handle } : {}),
    children: row.indexed + row.named,
    indexed: row.indexed,
    kind: row.kind,
  };
}

/** Where the origins of committed additions are kept (global state). */
const ORIGINS_KEY = 'gemdb.persistedObjectOrigins';

/** The URI scheme of a changed row, which `registerSavedObjects`' decoration colours and badges. */
export const CHANGED_SCHEME = 'gemdb-changed';

/** The most changed objects `%pending` marks in the view. */
const MARKED_LIMIT = 50;

/** One object a notebook's next commit changes, as the view marks it. */
export interface MarkedObject {
  /** Its path, as Python reads it. */
  path: string;
  /** Its permanent number, by which a revert finds it in the notebook's session. */
  oop: number;
  /** It as committed: what a revert puts back. */
  before: Snapshot;
  /** How its entries are kept, as the notebook would commit it. */
  kind: Snapshot['kind'];
  diff: ObjectDiff;
}

/** Added to a marked row's context value, so its menu offers Revert to Committed Value. */
const CHANGED = ' gemdbChanged';

/** What `%pending` last told the view: one notebook's changed objects, and their changed entries. */
export interface Marked {
  ownerKey: string;
  label: string;
  /** Changed objects, by the names of the rows that lead to them (`rowKey`). */
  objects: Map<string, MarkedObject>;
  /** Entries of those objects whose value changes, by the same key. */
  entries: Map<string, { before: string; after: string }>;
}

/** A row's place in the view, as the names of the rows down to it; ranges are not counted. */
export function rowKey(names: string[]): string {
  return names.join('\u0000');
}

/**
 * Mark `object` at the row named by `names`, with its changed entries, in
 * place of what was marked there; an object with nothing left that differs
 * is unmarked.
 */
export function setMark(marked: Marked, names: string[], object: MarkedObject): void {
  const key = rowKey(names);
  const prefix = key === '' ? '' : `${key}\u0000`;
  for (const k of [...marked.entries.keys()]) {
    if (k.startsWith(prefix) && !k.slice(prefix.length).includes('\u0000'))
      marked.entries.delete(k);
  }
  const { changed, added, removed } = object.diff;
  if (!object.diff.notCompared && changed.length + added.length + removed.length === 0) {
    marked.objects.delete(key);
    return;
  }
  marked.objects.set(key, object);
  for (const c of changed) {
    marked.entries.set(rowKey([...names, c.name]), { before: c.before, after: c.after });
  }
}

/**
 * A changed object's row description: its one change, `total: 10 → 15`, or
 * how many there are of each kind.
 */
export function changeSummary(diff: ObjectDiff): string {
  if (diff.notCompared) return 'changed';
  const { changed, added, removed } = diff;
  if (changed.length + added.length + removed.length === 1) {
    if (changed[0]) return `changed: ${changed[0].name} ${changed[0].before} → ${changed[0].after}`;
    if (added[0]) return `changed: ${added[0].name} added`;
    return `changed: ${removed[0].name} removed`;
  }
  const parts = [
    changed.length ? `${changed.length} changed` : '',
    added.length ? `${added.length} added` : '',
    removed.length ? `${removed.length} removed` : '',
  ].filter(Boolean);
  return parts.length ? `changed: ${parts.join(', ')}` : 'changed';
}

/** How many entries a changed object's hover lists. */
const DIFF_ROWS = 30;

/**
 * A changed object's hover: entry by entry, what is committed and what the
 * next commit writes, each value labelled where it stands.
 */
export function diffMarkdown(object: Pick<MarkedObject, 'path' | 'diff'>, label: string): string {
  const code = (text: string) => '`' + text.replace(/`/g, "'") + '`';
  const lines = [
    `**${object.path.replace(/([*_[\]])/g, '\\$1')}**`,
    '',
    `Changed in ${label}, not committed yet.`,
    '',
  ];
  if (object.diff.notCompared) {
    lines.push(`Its entries are not shown: ${object.diff.notCompared}.`);
    return lines.join('\n');
  }
  // Each value says which side it is, beside it: a table's headings sat too far from them to read.
  const rows = [
    ...object.diff.changed.map(
      (c) => `- ${code(c.name)}: committed ${code(c.before)} → next commit ${code(c.after)}`,
    ),
    ...object.diff.added.map(
      (a) => `- ${code(a.name)}: added by the next commit: ${code(a.after)}`,
    ),
    ...object.diff.removed.map(
      (d) => `- ${code(d.name)}: removed by the next commit (committed ${code(d.before)})`,
    ),
  ];
  if (rows.length === 0) {
    lines.push('Written by the next commit, but no entry of its own differs.');
    return lines.join('\n');
  }
  lines.push(...rows.slice(0, DIFF_ROWS));
  if (rows.length > DIFF_ROWS) lines.push('', `… and ${rows.length - DIFF_ROWS} more.`);
  return lines.join('\n');
}

/**
 * A changed object's name, as the tree names its row, and the rows it is
 * under: `'customer'` in `pending_demo`. An item of a list or set takes its
 * container's name too (`orders[1]`), since `[1]` alone says nothing.
 */
export function shortPlace(steps: PathStep[]): { name: string; within: string } {
  const names = stepNames(steps);
  if (names.length === 0) return { name: 'gemdb.root', within: '' };
  let end = names.length - 1;
  let name = names[end];
  if (name.startsWith('[') && end > 0) {
    end--;
    name = names[end] + name;
  }
  return { name, within: names.slice(0, end).join(' › ') };
}

/**
 * The rows under a notebook's Pending changes: one per changed object, the
 * found ones by path and the unfound after them, then a line each for what is
 * counted rather than listed, as `%pending` words them.
 */
export function changeRows(
  parent: SavedRow,
  pending: Pending,
  diffs: Map<number, ObjectDiff> = new Map(),
): SavedRow[] {
  const listed = pending.changes
    .filter((c) => !c.internal)
    .sort(
      (a, b) =>
        Number(b.steps !== undefined) - Number(a.steps !== undefined) ||
        (a.steps ? pathText(a.steps) : '').localeCompare(b.steps ? pathText(b.steps) : ''),
    )
    .map((change): SavedRow => {
      const diff = diffs.get(change.oop);
      return diff ? { kind: 'change', change, parent, diff } : { kind: 'change', change, parent };
    });
  const note = (text: string): SavedRow => ({ kind: 'message', text, parent });
  const notes: SavedRow[] = [];
  const internal = pending.changes.filter((c) => c.internal).length;
  if (internal > 0) {
    notes.push(note(`+ ${internal} outside gemdb.root: Grail's own records and storage`));
  }
  const unchanged = pending.unchanged ?? 0;
  if (unchanged > 0) {
    notes.push(
      note(
        `+ ${unchanged} written back unchanged (reverted, or set to what ${unchanged === 1 ? 'it' : 'they'} held)`,
      ),
    );
  }
  if (pending.more > 0) notes.push(note(`… and ${pending.more} more not listed`));
  if (pending.cut)
    notes.push(note('The search for paths stopped early: some may show as not found.'));
  if (listed.length === 0 && notes.length === 0) notes.push(note('Nothing changes on commit.'));
  else if (listed.length === 0) notes.unshift(note('Nothing of yours changes on commit.'));
  return [...listed, ...notes];
}

export class SavedObjectsProvider implements vscode.TreeDataProvider<SavedRow> {
  private readonly emitter = new vscode.EventEmitter<SavedRow | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private rows: SavedRow[] | undefined;
  private pending: PendingSave[] = [];
  /** Committed entries added from the debugger, by key; kept across restarts. */
  private origins: Record<string, Origin>;
  private inFlight: Promise<void> | undefined;
  /** A refresh arrived while a read was running, so that read's rows are out of date. */
  private stale = false;
  /**
   * Each parent's child rows, made once per load: `reveal` finds a row by
   * identity, so asking twice must answer the same objects.
   */
  private children = new WeakMap<SavedRow, SavedRow[]>();
  /** What `%pending` last found changed, shown on the rows it names until it is committed or dropped. */
  private marked: Marked | undefined;
  /**
   * The notebooks whose Pending changes the user has open, by key, so a
   * re-reading of the view — after a cell, after a commit elsewhere — draws
   * the group open again rather than closed (`noteGroupOpen`).
   */
  private openGroups = new Set<string>();

  constructor(private readonly store?: vscode.Memento) {
    this.origins = store?.get<Record<string, Origin>>(ORIGINS_KEY) ?? {};
  }

  refresh(): void {
    this.rows = undefined;
    if (this.inFlight) this.stale = true;
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
    return this.markChanged(this.itemFor(row), row);
  }

  private itemFor(row: SavedRow): vscode.TreeItem {
    const { Collapsed, Expanded, None } = vscode.TreeItemCollapsibleState;
    const opens = openable(row) ? Collapsed : None;
    switch (row.kind) {
      case 'notebook': {
        const { notebook } = row;
        const item = new vscode.TreeItem(
          notebook.label,
          row.saves.length > 0 || notebook.dirty ? Expanded : None,
        );
        item.description =
          notebook.dirty === undefined
            ? 'running a cell'
            : notebook.dirty
              ? 'uncommitted changes'
              : 'nothing to commit';
        item.iconPath = new vscode.ThemeIcon(runFileOf(notebook.key) ? 'file-code' : 'notebook');
        item.contextValue = notebook.dirty ? 'gemdbNotebookDirty' : 'gemdbNotebook';
        item.tooltip = new vscode.MarkdownString(notebookGuide(notebook.label));
        return item;
      }
      case 'pending': {
        const item = new vscode.TreeItem(row.save.key, opens);
        item.description = `${row.save.type} · added, not persisted yet`;
        item.iconPath = new vscode.ThemeIcon(
          'circle-outline',
          new vscode.ThemeColor('charts.orange'),
        );
        item.contextValue = 'gemdbSavedPending' + (itemsKind(row) ? CONTAINER : '');
        // The tooltip is left for resolveTreeItem, which inspects the object on hover.
        return item;
      }
      case 'root': {
        const item = new vscode.TreeItem('gemdb.root', row.entries.length > 0 ? Expanded : None);
        // Its total when read, else what was listed, marked as maybe more when the listing was full.
        const count = row.total ?? row.entries.length;
        const more = row.total === undefined && count >= ROOT_LISTING_LIMIT;
        item.description =
          count === 0
            ? 'nothing persisted yet'
            : `persisted · ${count.toLocaleString('en-US')}${more ? '+' : ''} ` +
              (count === 1 ? 'object' : 'objects');
        item.iconPath = new vscode.ThemeIcon('database');
        item.tooltip = new vscode.MarkdownString(ROOT_GUIDE);
        return item;
      }
      case 'entry': {
        const item = new vscode.TreeItem(row.entry.key, opens);
        const origin = originOf(row.entry, this.origins);
        item.description = row.entry.stack
          ? (origin ? `from ${origin.notebook} · ` : '') + 'saved stack: open it in the debugger'
          : (origin ? `from ${origin.notebook} · ` : '') + `${row.entry.type} = ${row.entry.value}`;
        // A saved stack gets its own icon, so it stands out from saved values even when the
        // row is too narrow for its description.
        item.iconPath = new vscode.ThemeIcon(
          row.entry.stack ? 'debug-stackframe' : 'pass-filled',
          new vscode.ThemeColor('charts.green'),
        );
        item.contextValue = row.entry.stack
          ? 'gemdbSavedStack'
          : 'gemdbSavedObject' + (itemsKind(row) ? CONTAINER : '');
        return item;
      }
      case 'field': {
        const { field } = row;
        const item = new vscode.TreeItem(field.name, opens);
        // As the Variables show it: the type badge first, and a big container's size in place of its text.
        item.description = toDapVariable(field).value;
        if (field.type) item.tooltip = `${field.type}: ${field.value}`;
        item.contextValue = 'gemdbPersistedField' + (itemsKind(row) ? CONTAINER : '');
        return item;
      }
      case 'range': {
        // As VS Code labels the Variables' groups of a big container.
        const item = new vscode.TreeItem(`[${row.start} … ${row.end - 1}]`, Collapsed);
        // gemdb.root's ranges hold entries, which are found by key in the view itself.
        if (this.ownerOf(row)?.kind !== 'root') item.contextValue = 'gemdbRange';
        return item;
      }
      case 'changes': {
        const item = new vscode.TreeItem(
          'Pending changes',
          this.openGroups.has(row.notebook.key) ? Expanded : Collapsed,
        );
        // A stable id lets VS Code keep the group as the user left it across re-readings.
        item.id = `gemdb.pendingChanges:${row.notebook.key}`;
        item.description = 'what the next commit writes';
        item.iconPath = new vscode.ThemeIcon('diff');
        item.tooltip =
          `The persisted objects ${row.notebook.label} has changed and not committed yet, ` +
          'as %pending lists them. Click one to show it under gemdb.root, marked M.';
        return item;
      }
      case 'change': {
        const { change, diff } = row;
        // What tells the rows apart leads, since a long row is cut off at its end.
        const place = change.steps ? shortPlace(change.steps) : undefined;
        const item = new vscode.TreeItem(
          place?.name ?? `${change.type} (not found under gemdb.root)`,
          None,
        );
        const what = diff ? changeSummary(diff).replace(/^changed(: )?/, '') : '';
        item.description = [
          what || `${change.type} = ${change.value}`,
          place?.within ? `in ${place.within}` : '',
        ]
          .filter(Boolean)
          .join(' · ');
        item.iconPath = new vscode.ThemeIcon(
          'diff-modified',
          new vscode.ThemeColor('charts.orange'),
        );
        if (change.steps) {
          item.command = {
            command: 'gemdb.savedObjects.showObject',
            title: 'Show in gemdb.root',
            arguments: [change.oop, { fromPendingChanges: true }],
          };
          const path = pathText(change.steps);
          const label = row.parent.kind === 'changes' ? row.parent.notebook.label : 'the notebook';
          item.tooltip = new vscode.MarkdownString(
            (diff ? diffMarkdown({ path, diff }, label) : `**${path}**`) +
              '\n\nClick to show it under `gemdb.root`, marked M.',
          );
        }
        return item;
      }
      case 'message':
        return new vscode.TreeItem(row.text, None);
    }
  }

  /**
   * The Python that reaches `row`'s object from `gemdb.root`, as the
   * Inspector labels a column and Copy as Expression copies it:
   * `gemdb.root["warehouse"].orders[3]`. A range is not a step, and nor is a
   * group (`class variables`): its rows are the object's own attributes. An
   * item of a set has no position Python can index, so it reads `list(s)[i]`.
   */
  expressionOf(row: SavedRow): string | undefined {
    switch (row.kind) {
      case 'entry':
        return accessCode(row.entry.key);
      case 'pending':
        return accessCode(row.save.key);
      case 'range':
        return this.expressionOf(row.parent);
      case 'field': {
        if (!row.field.handle && row.field.ref) return this.expressionOf(row.parent);
        let parent: SavedRow = row.parent;
        while (parent.kind === 'range') parent = parent.parent;
        const base = this.expressionOf(parent);
        if (base === undefined) return undefined;
        const isGroup = parent.kind === 'field' && !parent.field.handle && parent.field.ref > 0;
        const kind = isGroup ? 'obj' : openable(parent)?.kind;
        const name = row.field.name;
        if (kind === 'seq') return `${base}${name}`;
        if (kind === 'coll') return `list(${base})${name}`;
        if (kind === 'dict') return `${base}[${name}]`;
        return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
          ? `${base}.${name}`
          : `getattr(${base}, ${JSON.stringify(name)})`;
      }
      default:
        return undefined;
    }
  }

  /** The names of the rows down to `row` (`rowKey`), for a row a path can name; else undefined. */
  private rowNames(row: SavedRow): string[] | undefined {
    switch (row.kind) {
      case 'root':
        return [];
      case 'entry':
        return [row.entry.key];
      case 'range':
        return this.rowNames(row.parent);
      case 'field': {
        const up = this.rowNames(row.parent);
        return up && [...up, row.field.name];
      }
      default:
        return undefined;
    }
  }

  /** What `%pending` marked at this row: a changed object, a changed entry of one, or neither. */
  private markOf(
    row: SavedRow,
  ): { object?: MarkedObject; entry?: { before: string; after: string } } | undefined {
    const names = this.marked && this.rowNames(row);
    if (!this.marked || !names) return undefined;
    const key = rowKey(names);
    const object = this.marked.objects.get(key);
    const entry = this.marked.entries.get(key);
    return object || entry ? { object, entry } : undefined;
  }

  /**
   * Mark a row `%pending` found changed: coloured and badged as a modified
   * file is (`CHANGED_SCHEME`), described by what changes, and for a changed
   * object, a hover setting what is committed beside what the next commit
   * writes. The row's own text stays what is committed, which is what the
   * view reads.
   */
  private markChanged(item: vscode.TreeItem, row: SavedRow): vscode.TreeItem {
    const mark = this.markOf(row);
    if (!mark || !this.marked) return item;
    item.contextValue = (item.contextValue ?? 'gemdbRoot') + CHANGED;
    item.resourceUri = vscode.Uri.from({
      scheme: CHANGED_SCHEME,
      path: `/${encodeURIComponent(rowKey(this.rowNames(row) ?? []))}`,
    });
    if (mark.object) {
      item.description = changeSummary(mark.object.diff);
      item.tooltip = new vscode.MarkdownString(diffMarkdown(mark.object, this.marked.label));
    } else if (mark.entry) {
      item.description = `${mark.entry.before} → ${mark.entry.after}`;
      item.tooltip = `Committed: ${mark.entry.before}\nNext commit: ${mark.entry.after}`;
    }
    return item;
  }

  /**
   * Mark what `%pending` found changed in `ownerKey`'s session: for each
   * object, where it is in what is committed, and how it differs, read once
   * as committed (GemDB's session, in the view this read takes) and once as
   * the notebook would commit it. Replaces whatever was marked before.
   */
  async noteChanges(ownerKey: string, label: string, oops: number[]): Promise<void> {
    this.refresh();
    await this.load();
    await this.markChanges(ownerKey, label, oops);
  }

  /** `noteChanges` in the view already read: no reading of it again. */
  private async markChanges(ownerKey: string, label: string, oops: number[]): Promise<void> {
    const shown = oops.slice(0, MARKED_LIMIT);
    const paths = parsePaths(orThrow(await extensionQuery(pathsToQuery(shown), { budget: true })));
    const marked: Marked = { ownerKey, label, objects: new Map(), entries: new Map() };
    for (const oop of shown) {
      const steps = paths.get(oop);
      if (!steps) continue;
      const before = parseSnapshot(
        orThrow(await extensionQuery(snapshotQuery(oop), { budget: true })),
      );
      const after = parseSnapshot(
        orThrow(await inNotebook(ownerKey, snapshotQuery(oop), { budget: true })),
      );
      setMark(marked, stepNames(steps), {
        path: pathText(steps),
        oop,
        before,
        kind: after.kind,
        diff: diffSnapshots(before, after),
      });
    }
    this.marked = marked;
    this.emitter.fire(undefined);
  }

  /**
   * Each object's committed contents (`snapshotQuery`), by number, in the
   * order asked, read by GemDB's own session in a fresh view.
   */
  async committedSnapshots(oops: number[], fresh = true): Promise<string[]> {
    if (fresh) await extensionQuery(`System abortTransaction. 'fresh' encodeAsUTF8`);
    const snapshots: string[] = [];
    for (const oop of oops) {
      snapshots.push(orThrow(await extensionQuery(snapshotQuery(oop), { budget: true })));
    }
    return snapshots;
  }

  /**
   * A notebook's Pending changes, opened: what `%pending` would list for it,
   * read in its own session with nothing paused, less what reads exactly as
   * committed again, and sorted by path. Each found object is a row that
   * shows it under `gemdb.root` when clicked; the rest are counted below
   * them. Opening the group also marks the same objects M, as `%pending`
   * does. What is committed is read in the view this load already took.
   */
  private async pendingChanges(row: SavedRow & { kind: 'changes' }): Promise<SavedRow[]> {
    if (!this.isCurrent(row)) return [];
    const kept = this.children.get(row);
    if (kept) return kept;
    const { key, label } = row.notebook;
    let rows: SavedRow[];
    let found: number[] = [];
    try {
      const listed = parsePending(orThrow(await inNotebook(key, pendingQuery(), { budget: true })));
      const oops = listed.changes.filter((c) => !c.internal).map((c) => c.oop);
      const committed = await this.committedSnapshots(oops, false);
      const before = new Map(oops.map((oop, i) => [oop, parseSnapshot(committed[i] ?? '')]));
      const after = new Map<number, Snapshot>();
      for (const oop of oops) {
        after.set(
          oop,
          parseSnapshot(orThrow(await inNotebook(key, snapshotQuery(oop), { budget: true }))),
        );
      }
      const pending = withoutUnchanged(listed, before, after);
      const diffs = new Map(
        oops.map((oop) => [oop, diffSnapshots(before.get(oop)!, after.get(oop)!)] as const),
      );
      rows = changeRows(row, pending, diffs);
      found = pending.changes.filter((c) => c.steps).map((c) => c.oop);
    } catch (e) {
      return [this.unread(row, { session: 'notebook', ownerKey: key }, e)];
    }
    if (!this.isCurrent(row)) return [];
    this.children.set(row, rows);
    if (found.length > 0) {
      this.markChanges(key, label, found).catch((e: unknown) =>
        log(`Could not mark ${label}'s pending changes: ${errorMessage(e)}`),
      );
    }
    return rows;
  }

  /** Note that a row was opened or closed, so a notebook's Pending changes stays as the user left it. */
  noteGroupOpen(row: SavedRow, open: boolean): void {
    if (row.kind !== 'changes') return;
    if (open) this.openGroups.add(row.notebook.key);
    else this.openGroups.delete(row.notebook.key);
  }

  /**
   * The changed object a marked row reverts, and the entry of it when the row
   * is one entry; undefined for a row with no mark.
   */
  revertTarget(
    row: SavedRow,
  ):
    | { key: string; object: MarkedObject; entry?: string; ownerKey: string; label: string }
    | undefined {
    const names = this.rowNames(row);
    if (!this.marked || !names) return undefined;
    const own = this.marked.objects.get(rowKey(names));
    const { ownerKey, label } = this.marked;
    if (own) return { key: rowKey(names), object: own, ownerKey, label };
    const up = rowKey(names.slice(0, -1));
    const parent = this.marked.objects.get(up);
    return parent && this.marked.entries.has(rowKey(names))
      ? { key: up, object: parent, entry: names[names.length - 1], ownerKey, label }
      : undefined;
  }

  /**
   * Put a marked object, or one entry of it, back as committed, in its
   * notebook's session — undoing the notebook's change there, committing
   * nothing — then compare it again, so a mark that no longer differs goes.
   */
  async revert(row: SavedRow): Promise<void> {
    const target = this.revertTarget(row);
    if (!target || !this.marked) return;
    const { object, entry, ownerKey } = target;
    const plan = revertPlan(object.kind, object.before, object.diff, entry);
    orThrow(await inNotebook(ownerKey, revertQuery(object.oop, plan)));
    const after = parseSnapshot(
      orThrow(await inNotebook(ownerKey, snapshotQuery(object.oop), { budget: true })),
    );
    const names = target.key === '' ? [] : target.key.split('\u0000');
    setMark(this.marked, names, {
      ...object,
      kind: after.kind,
      diff: diffSnapshots(object.before, after),
    });
    this.emitter.fire(undefined);
  }

  /**
   * Inspect a saved object when the pointer rests on it: its type, its text
   * and its first children, read when asked rather than for every row. A
   * committed one is read by the extension's own session; one not committed
   * yet exists only in its notebook's session, so it is read there.
   */
  async resolveTreeItem(item: vscode.TreeItem, row: SavedRow): Promise<vscode.TreeItem> {
    if (row.kind !== 'entry' && row.kind !== 'pending') return item;
    // A changed object's hover is its changes.
    if (this.markOf(row)?.object) return item;
    const key = row.kind === 'entry' ? row.entry.key : row.save.key;
    try {
      const raw = orThrow(
        row.kind === 'entry'
          ? await extensionQuery(inspectQuery(key, true))
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

  /** The top rows, and a notebook's or `gemdb.root`'s, are answered at once; an opened object's are read. */
  getChildren(row?: SavedRow & { kind: 'notebook' | 'root' }): SavedRow[];
  getChildren(row: SavedRow): SavedRow[] | Promise<SavedRow[]>;
  getChildren(row?: SavedRow): SavedRow[] | Promise<SavedRow[]> {
    if (row?.kind === 'notebook' || row?.kind === 'root') return this.listed(row);
    if (row?.kind === 'range') return this.ranged(row);
    if (row?.kind === 'changes') return this.pendingChanges(row);
    if (row) return this.opened(row);
    if (this.rows) return this.rows;
    void this.load();
    return [{ kind: 'message', text: 'Reading gemdb.root…' }];
  }

  /**
   * A notebook's additions, or what is committed: rows made once per load, so
   * `reveal` finds them. `gemdb.root` lists its first entries; when it holds
   * more than that, it shows all of them as ranges instead.
   */
  private listed(row: SavedRow & { kind: 'notebook' | 'root' }): SavedRow[] {
    let rows = this.children.get(row);
    if (!rows) {
      rows =
        row.kind === 'notebook'
          ? [
              ...row.saves.map((save): SavedRow => {
                const read = row.read?.get(save.key);
                const handle = read?.handle ? { handle: read.handle } : {};
                return read?.ref
                  ? {
                      kind: 'pending',
                      save,
                      ...handle,
                      ref: read.ref,
                      children: read.indexed + read.named,
                      indexed: read.indexed,
                      kids: read.kind,
                    }
                  : { kind: 'pending', save, ...handle };
              }),
              ...(row.notebook.dirty
                ? [{ kind: 'changes', notebook: row.notebook } as SavedRow]
                : []),
            ]
          : row.total !== undefined && row.total > row.entries.length
            ? rangeRows(row, 0, row.total, ROOT_LISTING_LIMIT)
            : row.entries.map((entry): SavedRow => ({ kind: 'entry', entry }));
      this.children.set(row, rows);
    }
    return rows;
  }

  /**
   * An opened object's attributes, items or entries, read in the session that
   * holds it and kept until the next load. Its registry position is only good
   * until then — each load starts the registry afresh — so a row from an
   * earlier load reads nothing. A failure, such as a notebook busy running a
   * cell, is shown and not kept, so opening the row again tries again. A
   * container longer than a page opens to its ranges, with nothing read yet.
   */
  private async opened(row: SavedRow): Promise<SavedRow[]> {
    const where = openable(row);
    if (!where || !this.isCurrent(row)) return [];
    const kept = this.children.get(row);
    if (kept) return kept;
    if (where.indexed > PAGE) {
      const ranges = rangeRows(row, 0, where.indexed);
      this.children.set(row, ranges);
      return ranges;
    }
    try {
      const rows = fieldRows(row, where.readIn, await this.readItems(row, 0, PAGE));
      if (this.isCurrent(row)) this.children.set(row, rows);
      return rows;
    } catch (e) {
      return [this.unread(row, where.readIn, e)];
    }
  }

  /**
   * A range: its items (or `gemdb.root`'s entries) when it is a page or less,
   * else the ranges it divides into. What it reads is kept, as an opened
   * object's children are.
   */
  private async ranged(row: SavedRow & { kind: 'range' }): Promise<SavedRow[]> {
    if (!this.isCurrent(row)) return [];
    const kept = this.children.get(row);
    if (kept) return kept;
    const owner = this.ownerOf(row);
    const page = owner?.kind === 'root' ? ROOT_LISTING_LIMIT : PAGE;
    if (row.end - row.start > page) {
      const rows = rangeRows(row, row.start, row.end, page);
      this.children.set(row, rows);
      return rows;
    }
    if (owner?.kind === 'root') {
      try {
        const rows = parseChildren(
          orThrow(
            await extensionQuery(rootListingQuery(row.start, row.end - row.start, false), {
              budget: true,
            }),
          ),
        ).map((field): SavedRow => ({ kind: 'entry', entry: toEntry(field), parent: row }));
        if (this.isCurrent(row)) this.children.set(row, rows);
        return rows;
      } catch (e) {
        return [this.unread(row, { session: 'extension' }, e)];
      }
    }
    const where = owner && openable(owner);
    if (!owner || !where) return [];
    try {
      const rows = fieldRows(
        row,
        where.readIn,
        await this.readItems(owner, row.start, row.end - row.start),
      );
      if (this.isCurrent(row)) this.children.set(row, rows);
      return rows;
    } catch (e) {
      return [this.unread(row, where.readIn, e)];
    }
  }

  /**
   * The row of a list's, set's or dict's item at `index` (from 0), as shown
   * under `container`: opening each range on the way, as the user would, so
   * every row on the path is one `reveal` can find. Undefined when there is no
   * such item, or the rows on the way could not be read.
   */
  async itemAt(container: SavedRow, index: number): Promise<SavedRow | undefined> {
    let at = container;
    for (;;) {
      const rows = await this.getChildren(at);
      const range = rows.find((r) => r.kind === 'range' && r.start <= index && index < r.end);
      if (range) {
        at = range;
        continue;
      }
      const item = rows[index - (at.kind === 'range' ? at.start : 0)];
      return item?.kind === 'field' ? item : undefined;
    }
  }

  /**
   * The row of the committed object whose permanent number is `oop`, found
   * under `gemdb.root` after a fresh read of the view: each step on its path
   * is opened as the user would open it, ranges too, so every row on the way
   * is one `reveal` can find. `reached` is how many steps were opened; fewer
   * than `steps` holds means the path stopped at `row`, the nearest one shown.
   * Undefined when the object is not under `gemdb.root` in what is committed.
   */
  async objectRow(
    oop: number,
    { reread = true } = {},
  ): Promise<{ row: SavedRow; steps: PathStep[]; reached: number } | undefined> {
    // Re-reading shows only "Reading gemdb.root…" for a moment, and VS Code then forgets which rows
    // were open; a click in Pending changes, just read, goes to the object in the view as it is.
    if (reread || !this.rows) {
      this.refresh();
      await this.load();
    }
    const root = this.rows?.find((r) => r.kind === 'root');
    if (!root) return undefined;
    // Read right after the view's own fresh listing, so its positions are the view's.
    const steps = parseSteps(orThrow(await extensionQuery(pathToQuery(oop), { budget: true })));
    if (!steps) return undefined;
    let row: SavedRow = root;
    let reached = 0;
    for (const step of steps) {
      const next = await this.stepFrom(row, step);
      if (!next) break;
      row = next;
      reached++;
    }
    return { row, steps, reached };
  }

  /** The row one step below `row`, opening it (and any ranges on the way); undefined if not shown. */
  private async stepFrom(row: SavedRow, step: PathStep): Promise<SavedRow | undefined> {
    switch (step.kind) {
      case 'root': {
        if (row.kind !== 'root') return undefined;
        // gemdb.root lists its entries, or, when it holds more, ranges of them.
        let at: SavedRow = row;
        for (;;) {
          const rows: SavedRow[] = await this.getChildren(at);
          const entry = rows.find((r) => r.kind === 'entry' && r.entry.key === step.key);
          if (entry) return entry;
          const range: SavedRow | undefined = rows.find(
            (r) => r.kind === 'range' && r.start <= step.position && step.position < r.end,
          );
          if (!range) return undefined;
          at = range;
        }
      }
      case 'attr':
        return (await this.getChildren(row)).find(
          (r) => r.kind === 'field' && r.field.name === step.name,
        );
      default:
        return this.itemAt(row, step.position);
    }
  }

  /**
   * Where a dict's key is among its entries (from 0), read in the session that
   * holds the dict; -1 when it has no such key.
   */
  async keyPosition(container: SavedRow, text: string): Promise<number> {
    const where = openable(container);
    if (!where) return -1;
    const query = keyPositionQuery(where.ref, keyNames(text), PERSISTED_REGISTRY);
    const raw =
      where.readIn.session === 'extension'
        ? await extensionQuery(query, { budget: true })
        : await inNotebook(where.readIn.ownerKey, query, { budget: true });
    return Number(orThrow(raw));
  }

  /** The container (or `gemdb.root`) a range row, or a range within a range, divides. */
  ownerOf(row: SavedRow): SavedRow | undefined {
    let at: SavedRow | undefined = row;
    while (at?.kind === 'range') at = at.parent;
    return at;
  }

  /** `count` of an opened object's children from `start`, read in the session that holds it. */
  private async readItems(row: SavedRow, start: number, count: number): Promise<PauseVariable[]> {
    const where = openable(row);
    if (!where) return [];
    const query = childrenQuery(where.ref, start, count, PERSISTED_REGISTRY);
    const raw =
      where.readIn.session === 'extension'
        ? await extensionQuery(query, { budget: true })
        : await inNotebook(where.readIn.ownerKey, query, { budget: true });
    return parseChildren(orThrow(raw));
  }

  /** The row that says why an object's children could not be read. */
  private unread(parent: SavedRow, readIn: ReadIn, e: unknown): SavedRow {
    const busy = readIn.session === 'notebook' && !pauseForOwner(readIn.ownerKey);
    return {
      kind: 'message',
      text: busy
        ? `Could not read it: ${errorMessage(e)}. If its notebook is running a cell, open it again once the cell finishes.`
        : `Could not read it: ${errorMessage(e)}`,
      parent,
    };
  }

  /** The row a row was read under, when it keeps one: a field's, a range's, an entry read in a range. */
  private static parentOf(row: SavedRow): SavedRow | undefined {
    return row.kind === 'field' ||
      row.kind === 'range' ||
      row.kind === 'entry' ||
      row.kind === 'change'
      ? row.parent
      : undefined;
  }

  /**
   * Where the Inspector finds a row's object: the session to read it in and its
   * position in this view's registry. A saved stack is one too: it is a dict
   * under `gemdb.root` (`savedStacks.ts`). Undefined for a row with no object of
   * its own (a group, a message) and for a row from before the view was last
   * read, whose position may now hold something else.
   */
  inspectTarget(row: SavedRow): { readIn: ReadIn; handle: number; label: string } | undefined {
    if (!this.isCurrent(row)) return undefined;
    switch (row.kind) {
      case 'entry': {
        // By its handle, so an entry with nothing inside (a str, an int, []) inspects too.
        const handle = row.entry.handle || row.entry.ref;
        return handle
          ? { readIn: { session: 'extension' }, handle, label: accessCode(row.entry.key) }
          : undefined;
      }
      case 'pending': {
        const handle = row.handle || row.ref;
        return handle
          ? {
              readIn: { session: 'notebook', ownerKey: row.save.ownerKey },
              handle,
              label: accessCode(row.save.key),
            }
          : undefined;
      }
      case 'field':
        return row.field.handle
          ? {
              readIn: row.readIn,
              handle: row.field.handle,
              label: this.expressionOf(row) ?? row.field.name,
            }
          : undefined;
      default:
        return undefined;
    }
  }

  /** Whether a row belongs to the rows shown now, so its registry position still holds. */
  private isCurrent(row: SavedRow): boolean {
    let at: SavedRow = row;
    for (let up = SavedObjectsProvider.parentOf(at); up; up = SavedObjectsProvider.parentOf(at)) {
      at = up;
    }
    return this.rows?.includes(at) === true || this.getParent(at) !== undefined;
  }

  getParent(row: SavedRow): SavedRow | undefined {
    const up = SavedObjectsProvider.parentOf(row);
    if (up) return up;
    if (row.kind === 'message' && row.parent) return row.parent;
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
        const row = this.listed(top).find((r) => r.kind === 'pending' && r.save.key === key);
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
      // Rows read from before a commit or a save must not be shown after it: read again.
      if (this.stale) {
        this.stale = false;
        this.rows = undefined;
        void this.load();
      }
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
    // Every notebook (and file run, and saved stack) is asked: one with changes to commit is
    // shown, with its Pending changes, whether or not anything was added from the debugger.
    const notebooks = await Promise.all(
      sessionRegistry()
        .filter((info) => info.owner.kind !== 'extension')
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
    // What each notebook's additions hold, read where they are, so their rows can open.
    const read = new Map<string, Map<string, PauseVariable>>();
    await Promise.all(
      notebooks
        .filter((notebook) => notebook.dirty !== undefined)
        .map(async (notebook) => {
          const keys = this.pending.filter((save) => save.ownerKey === notebook.key);
          try {
            const rows = parseChildren(
              orThrow(
                await inNotebook(notebook.key, persistedRowsQuery(keys.map((k) => k.key)), {
                  budget: true,
                }),
              ),
            );
            read.set(notebook.key, new Map(rows.map((row) => [row.name, row])));
          } catch (e) {
            log(`Could not read ${notebook.label}'s additions: ${errorMessage(e)}`);
          }
        }),
    );
    let root: RootEntry[] | string;
    let rootTotal: number | undefined;
    try {
      root = parseChildren(await extensionQuery(rootListingQuery())).map(toEntry);
      // Only a full first page can have more after it, so only then is it worth counting.
      if (root.length >= ROOT_LISTING_LIMIT) {
        const counted = Number(await extensionQuery(rootSizeQuery()).catch(() => ''));
        rootTotal = Number.isInteger(counted) && counted > 0 ? counted : undefined;
      }
      const stacks = new Set(
        (
          JSON.parse(
            await extensionQuery(savedStackKeysQuery()).catch(() => '[]'),
          ) as SavedStackSummary[]
        ).map((stack) => stack.key),
      );
      noteSavedStacks(stacks.size);
      root = root.map((entry) => (stacks.has(entry.key) ? { ...entry, stack: true } : entry));
    } catch (e) {
      root = `Could not read gemdb.root: ${errorMessage(e)}`;
    }
    // What %pending marked stays until its notebook has nothing left to commit, or no session.
    if (this.marked) {
      const owner = this.marked.ownerKey;
      let keep = pauseForOwner(owner) !== undefined || sessionForIfOpen(owner) !== undefined;
      if (keep) {
        try {
          keep = (await inNotebook(owner, needsCommitQuery())) === 'true';
        } catch {
          // Running a cell: it cannot be asked now, so its marks stay.
        }
      }
      if (!keep) this.marked = undefined;
    }
    const before = this.pending;
    this.pending = settlePending(this.pending, notebooks);
    // A save that just settled into gemdb.root keeps its notebook as its origin.
    if (typeof root !== 'string') {
      const committed = new Set(root.map((entry) => entry.key));
      this.setOrigins(settleOrigins(before, this.pending, committed, this.origins));
    }
    this.rows = topRows(true, notebooks, this.pending, root).map((row) =>
      row.kind === 'notebook' && read.has(row.notebook.key)
        ? { ...row, read: read.get(row.notebook.key) }
        : row.kind === 'root' && rootTotal !== undefined
          ? { ...row, total: rootTotal }
          : row,
    );
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
        'cell or Debug Python File run is paused in the debugger.',
    );
    return;
  }
  const handle =
    variable.variablesReference > 0
      ? variable.variablesReference
      : pause.handleFor?.(context.container?.variablesReference ?? 0, variable.name);
  if (!handle) {
    void vscode.window.showErrorMessage(`"${variable.name}" is not an object that can be added.`);
    return;
  }
  await addToPersistedObjects(view, treeViews, {
    query: pause.query,
    ownerKey: pause.ownerKey,
    notebook: pause.label,
    handle,
    name: variable.name,
    registry: REGISTRY,
  });
}

/** An object to add under `gemdb.root`: where it is, and what to call it while asking. */
export interface AddTarget {
  /** Runs a query in the session that holds the object. */
  query: (code: string) => Promise<string>;
  ownerKey: string;
  /** The notebook's (or debugged file's) name, for the toast and the view. */
  notebook: string;
  /** Its position in `registry`. */
  handle: number;
  /** What the user knows it as: a Variables row's name, an Inspector row's expression. */
  name: string;
  /** The pause's registry, or the Inspector's. */
  registry: string;
}

/**
 * Add an object under `gemdb.root`, asking for the key: what **Add to
 * Persisted Objects…** does, from a Variables row and from the Inspector
 * alike, so the two read and behave the same. It does not commit.
 */
export async function addToPersistedObjects(
  view: SavedObjectsProvider,
  treeViews: Map<string, vscode.TreeView<SavedRow>>,
  target: AddTarget,
): Promise<void> {
  const { query, handle, name, registry } = target;
  try {
    const { type, label } = parseSaveSuggestion(await query(saveSuggestionQuery(handle, registry)));
    const base = suggestKey({ name, type, label });
    const suggested = unquote(orThrow(await query(freeKeyQuery(base))));
    const key = await vscode.window.showInputBox({
      title: `Add ${name} to Persisted Objects`,
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
    orThrow(await query(saveToRootQuery(handle, key, registry)));
    view.notePending({
      key,
      type,
      ownerKey: target.ownerKey,
      notebook: target.notebook,
      at: new Date().toISOString(),
    });
    log(`Saved ${name} as ${accessCode(key)} (${target.notebook}), not yet committed`);
    // Show it land: the Persisted Objects beside the Variables, opened if closed.
    const shown = treeViews.get(DEBUG_VIEW_ID);
    if (shown) {
      view
        .revealSaved(shown, key)
        .catch((e: unknown) => log(`Could not show ${key}: ${errorMessage(e)}`));
    }
    const copy = 'Copy Code';
    const choice = await vscode.window.showInformationMessage(
      savedNotice(key, target.notebook),
      copy,
    );
    if (choice === copy) {
      await vscode.env.clipboard.writeText(`import gemdb\n\nsaved = ${accessCode(key)}\n`);
    }
  } catch (e) {
    void vscode.window.showErrorMessage(`Could not add ${name}: ${errorMessage(e)}`);
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
    .filter((info) => ['notebook', 'file', 'stack'].includes(info.owner.kind))
    .map((info) => info.owner);
  if (connected.length === 0) {
    void vscode.window.showInformationMessage(
      `No notebook is connected to GemDB yet. Run a cell, and ${verb} acts on that notebook's changes.`,
    );
    return undefined;
  }
  const pausedKey = connected.find((owner) => pauseForOwner(owner.key))?.key;
  const activeKey =
    vscode.window.activeNotebookEditor?.notebook.uri.toString() ??
    vscode.window.activeTextEditor?.document.uri.fsPath;
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
      orThrow(await extensionQuery(removeCommittedQuery(committed)));
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

/** `2026-10-01 16:20`, local time: how a saved stack says when it was saved. */
function localStamp(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/**
 * Save the paused stack under `gemdb.root`, like any added object: in the
 * notebook's session, not committed. The snapshot holds each frame's place
 * and source text, its locals as the real objects, and the notebook's
 * globals, so it can be opened again after a commit and a restart.
 */
async function saveStack(
  view: SavedObjectsProvider,
  treeViews: Map<string, vscode.TreeView<SavedRow>>,
): Promise<void> {
  const pause = pauseForDebugSession(vscode.debug.activeDebugSession?.id);
  if (pause?.saved) {
    void vscode.window.showInformationMessage('This is a saved stack already.');
    return;
  }
  if (!pause?.query || !pause.ownerKey) {
    void vscode.window.showErrorMessage(
      'Add Stack to Persisted Objects works while a GemDB notebook cell or Debug Python File ' +
        'run is paused in the debugger.',
    );
    return;
  }
  const query = pause.query;
  const now = new Date();
  try {
    const suggested = unquote(orThrow(await query(freeKeyQuery(stackKeyFor(pause.label, now)))));
    const key = await vscode.window.showInputBox({
      title: 'Add this stack to Persisted Objects',
      prompt:
        'Its key under gemdb.root. It persists at the notebook’s next commit; after that, ' +
        'Persisted Objects can open it in the debugger again, even in a later VS Code.',
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
    const frames = pause.frames.map((frame, index) => savedFrameOf(frame, pause.texts?.[index]));
    const localsRefs = pause.frames.map(
      (frame) =>
        pause.scopes(frame.id).find((scope) => scope.presentationHint === 'locals')
          ?.variablesReference ?? 0,
    );
    orThrow(
      await query(
        saveStackQuery(
          key,
          {
            label: pause.label,
            notebook: pause.ownerKey,
            saved_at: localStamp(now),
            description:
              pause.reason === 'red dot' ? 'Saved at a red dot' : 'Saved at breakpoint()',
          },
          frames,
          localsRefs,
          runFileOf(pause.ownerKey) ? MAIN_MODULE : pause.ownerKey,
        ),
      ),
    );
    view.notePending({
      key,
      type: 'stack',
      ownerKey: pause.ownerKey,
      notebook: pause.label,
      at: now.toISOString(),
    });
    log(`Saved the stack as ${accessCode(key)} (${pause.label}), not yet committed`);
    const shown = treeViews.get(DEBUG_VIEW_ID);
    if (shown) {
      view
        .revealSaved(shown, key)
        .catch((e: unknown) => log(`Could not show ${key}: ${errorMessage(e)}`));
    }
    void vscode.window.showInformationMessage(
      `Added this stack to Persisted Objects as ${accessCode(key)}: ${frames.length} frames, ` +
        `their locals and the notebook's globals. It persists when the notebook commits; then ` +
        `Persisted Objects can open it in the debugger, even after VS Code restarts.`,
    );
  } catch (e) {
    void vscode.window.showErrorMessage(`Could not add the stack: ${errorMessage(e)}`);
  }
}

/** Whether a saved stack is open now: one at a time, since they share a registry. */
let savedStackOpen = false;

/** Note it, and tell the menus: an opened saved stack has nothing more to add. */
function setSavedStackOpen(open: boolean): void {
  savedStackOpen = open;
  void vscode.commands.executeCommand('setContext', 'gemdb.savedStackOpen', open);
}

/** The session a saved stack works in while it is open: one of its own, as a notebook has. */
export function stackOwner(key: string): SessionOwner {
  return { key: `saved-stack:${key}`, kind: 'stack', label: `Saved stack ${key}` };
}

/**
 * Run Smalltalk in `owner`'s session, one query at a time, cut short as a
 * paused query is (`PausedQueryOptions`): soft-broken when `signal` aborts
 * and, with `budget`, every `PAUSED_QUERY_BUDGET_MS`.
 */
export function stackQuery(owner: SessionOwner): ConsoleHost['query'] {
  let chain: Promise<unknown> = Promise.resolve();
  return (code, { budget = true, signal } = {}) => {
    let running = false;
    const interrupt = (): void => {
      if (running) interruptSessionFor(owner.key);
    };
    const run = chain.then(async () => {
      running = true;
      signal?.addEventListener('abort', interrupt);
      const timer = budget ? setInterval(interrupt, PAUSED_QUERY_BUDGET_MS) : undefined;
      if (signal?.aborted) interrupt();
      try {
        return await sessionFor(owner).executeAsync(code);
      } finally {
        running = false;
        clearInterval(timer);
        signal?.removeEventListener('abort', interrupt);
      }
    });
    chain = run.catch(() => undefined);
    return run;
  };
}

/**
 * A saved stack's Debug Console, in the stack's own session. Each frame's
 * console is made first and what that wrote is undone (making one writes,
 * measured: a frame's first line always left something to commit, the same
 * line again never), so the session starts with nothing to commit, and what it
 * has to commit later is only what the user changed — what closing the stack
 * asks about.
 */
export async function savedStackConsole(
  query: ConsoleHost['query'],
  ownerKey: string,
  consoles: Map<number, ConsoleScope>,
): Promise<ReturnType<typeof debugConsole>> {
  const con = debugConsole({ query, ownerKey, consoles });
  for (const frameId of consoles.keys()) {
    await con.evaluate!('None', frameId, 'repl', new AbortController().signal).catch(
      () => undefined,
    );
  }
  await query(`System abortTransaction. 'aborted' encodeAsUTF8`, { budget: false });
  return con;
}

/**
 * Close a saved stack's session when its debugger ends. Changes made in its
 * Debug Console and not committed are asked about first: committing them
 * changes the saved stack for good, and closing the session discards them.
 */
async function closeSavedStack(
  key: string,
  owner: SessionOwner,
  query: ConsoleHost['query'],
): Promise<void> {
  try {
    if ((await query(needsCommitQuery(), { budget: false })) === 'true') {
      const commit = 'Commit';
      const choice = await vscode.window.showWarningMessage(
        `${accessCode(key)} has changes made in the Debug Console that are not committed.`,
        {
          modal: true,
          detail:
            'Commit saves them, and the saved stack keeps the changed values from now on. ' +
            'Otherwise they are discarded, and the stack stays as it was saved.',
        },
        commit,
      );
      if (choice === commit) orThrow(await query(commitQuery(), { budget: false }));
    }
  } catch (e) {
    void vscode.window.showErrorMessage(
      `Could not commit the changes to ${accessCode(key)}: ${errorMessage(e)}`,
    );
  } finally {
    closeSessionFor(owner.key);
    // What it had added to Persisted Objects and not committed went with it.
    Promise.resolve(vscode.commands.executeCommand('gemdb.savedObjects.refresh')).catch(
      () => undefined,
    );
  }
}

/**
 * Open a committed saved stack in Run and Debug: the Call Stack, the
 * highlighted lines and the Variables, rebuilt from the objects saved with it,
 * and a Debug Console on them. It gets a session of its own
 * (`stackOwner`), so what its console changes waits there, as a notebook's
 * changes do, until `%commit` or ✓ commits it or closing the stack discards
 * it. Each frame shows the copy of its source saved with it, never the live
 * cell or file.
 */
async function openSavedStack(key: string): Promise<void> {
  if (savedStackOpen) {
    void vscode.window.showInformationMessage(
      'A saved stack is open in the debugger already. Stop it, then open this one.',
    );
    return;
  }
  const owner = stackOwner(key);
  const query = stackQuery(owner);
  setSavedStackOpen(true);
  let started = false;
  try {
    const { meta, locals, globals } = parseOpenedStack(
      await query(openStackQuery(key), { budget: false }),
    );
    const { frames, scopes, texts, consoles } = restoredFrames(
      meta,
      locals,
      globals,
      liveSourceWorld(openCellTexts),
    );
    const con = await savedStackConsole(query, owner.key, consoles);
    const rows = rowHandles();
    const pause: Pause = {
      label: savedPauseLabel(meta),
      ownerKey: owner.key,
      frames,
      scopes: (frameId) => scopes.get(frameId) ?? [],
      variables: async (ref, start, count) => {
        try {
          // Set Value is not offered here: the Debug Console is where a saved stack is changed.
          const children = parseChildren(await query(childrenQuery(ref, start, count)));
          rows.remember(ref, children);
          return children.map((row) => toDapVariable({ ...row, readOnly: true }));
        } catch (e) {
          log(`Could not read a saved stack's variable ${ref}: ${errorMessage(e)}`);
          return [];
        }
      },
      handleFor: rows.handleFor,
      query: (code) => query(code, { budget: false }),
      answer: () => {
        setSavedStackOpen(false);
        void closeSavedStack(key, owner, query);
      },
      ...con,
      sourceText: (ref) => texts.get(ref),
      openingNote: SAVED_STACK_NOTE,
      description: `Saved stack from ${meta.saved_at}`,
      saved: true,
    };
    started = await openPause(pause);
    if (!started) {
      void vscode.window.showErrorMessage(
        `GemDB could not open ${accessCode(key)} in the debugger.`,
      );
    } else {
      log(`Opened the saved stack ${accessCode(key)} (${frames.length} frames)`);
      // VS Code shows Run and Debug for a new session only when debug.openDebug says to,
      // which by default is the first session in a window. Restoring is asking to see it.
      await vscode.commands.executeCommand('workbench.view.debug');
    }
  } catch (e) {
    void vscode.window.showErrorMessage(`Could not open the saved stack: ${errorMessage(e)}`);
  } finally {
    if (!started) {
      setSavedStackOpen(false);
      closeSessionFor(owner.key);
    }
  }
}

/** How a saved stack reads in a list of them. */
export function stackChoice(stack: SavedStackSummary): { label: string; description: string } {
  const frames = `${stack.frames} ${stack.frames === 1 ? 'frame' : 'frames'}`;
  return {
    label: stack.key,
    description: [stack.label, stack.saved_at, frames].filter(Boolean).join(' · '),
  };
}

/**
 * The GemDB panel's *Restore a Saved Stack…*: list the committed saved stacks
 * and open the one picked in Run and Debug — straight away when there is only
 * one.
 */
async function restoreStack(): Promise<void> {
  if (!isRunning(listProcesses())) {
    void vscode.window.showInformationMessage('Start GemDB to restore a saved stack.');
    return;
  }
  let stacks: SavedStackSummary[];
  try {
    stacks = JSON.parse(await extensionQuery(savedStackKeysQuery())) as SavedStackSummary[];
    noteSavedStacks(stacks.length);
  } catch (e) {
    void vscode.window.showErrorMessage(`Could not list the saved stacks: ${errorMessage(e)}`);
    return;
  }
  if (stacks.length === 0) {
    void vscode.window.showInformationMessage(
      'No saved stacks yet. Pause a cell at breakpoint(), choose Add Stack to Persisted ' +
        'Objects… on the Call Stack, and commit; then it can be restored here.',
    );
    return;
  }
  if (stacks.length === 1) {
    await openSavedStack(stacks[0].key);
    return;
  }
  const picked = await vscode.window.showQuickPick(
    stacks.map((stack) => ({ ...stackChoice(stack), key: stack.key })),
    { title: 'Restore which saved stack?', matchOnDescription: true },
  );
  if (picked) await openSavedStack(picked.key);
}

/** Register the view and its commands. Answers the view, for others to refresh. */
/**
 * A position typed for Go to Item…: a whole number, or one in brackets as the
 * range rows write them (`[42]`), negative to count from the end. Answers the
 * number and whether it was bracketed, or undefined for anything else.
 */
export function typedPosition(text: string): { n: number; bracketed: boolean } | undefined {
  const typed = text.trim();
  const inBrackets = /^\[\s*(-?\d+)\s*\]$/.exec(typed);
  if (inBrackets) return { n: Number(inBrackets[1]), bracketed: true };
  return /^-?\d+$/.test(typed) ? { n: Number(typed), bracketed: false } : undefined;
}

/**
 * Go to Item…: ask for a position (any list, set or dict) or a key (a dict),
 * then open the container's ranges down to that item and select it, in the
 * views showing Persisted Objects (or the main one, when neither is showing).
 *
 * For a dict, what is typed is tried as a key first. A bracketed position
 * (`[42]`, as the ranges are labelled) is always a position; a bare number
 * that is not a key, but is a position, goes there and says so; anything
 * else that is not a key says why nothing was found.
 */
async function goToItem(
  view: SavedObjectsProvider,
  treeViews: Map<string, vscode.TreeView<SavedRow>>,
  clicked: SavedRow,
): Promise<void> {
  const container = clicked.kind === 'range' ? view.ownerOf(clicked) : clicked;
  const kind = container && itemsKind(container);
  const where = container && openable(container);
  if (!container || !kind || !where) return;
  const count = where.total;
  const n = (k: number) => k.toLocaleString('en-US');
  const positions = `a position from 0 to ${n(count - 1)}, or -1 to -${n(count)} from the end`;
  const inRange = (p: number) => p < count && p >= -count;
  const text = await vscode.window.showInputBox({
    title: 'Go to Item',
    prompt:
      kind === 'dict'
        ? `A key, as Python writes it — 'SKU0042' (or just SKU0042) for a str, 42 for an int — ` +
          `or a position in brackets, [0] to [${n(count - 1)}].`
        : `A position from 0 to ${n(count - 1)}, or a negative one to count from the end.`,
    ignoreFocusOut: true,
    validateInput: (typed) => {
      if (!typed.trim())
        return kind === 'dict' ? 'Enter a key or a position.' : 'Enter a position.';
      const at = typedPosition(typed);
      // A dict's bare word or number may be a key; only the database can say.
      if (kind === 'dict' && !at?.bracketed) return undefined;
      return at && inRange(at.n) ? undefined : `Enter ${positions}.`;
    },
  });
  if (text === undefined) return;
  const typed = text.trim();
  const at = typedPosition(typed);
  let index: number;
  if (kind !== 'dict' || at?.bracketed) {
    if (!at || !inRange(at.n)) {
      void vscode.window.showWarningMessage(`No item ${typed} here: enter ${positions}.`);
      return;
    }
    index = at.n;
  } else {
    try {
      index = await view.keyPosition(container, typed);
    } catch (e) {
      void vscode.window.showErrorMessage(`Could not look for ${typed}: ${errorMessage(e)}`);
      return;
    }
    if (index < 0 && at && inRange(at.n)) {
      index = at.n;
      void vscode.window.showInformationMessage(
        `This dict has no key ${typed}, so this is the item at position ${typed}. ` +
          `Type [${typed}] to go by position directly.`,
      );
    } else if (index < 0) {
      void vscode.window.showWarningMessage(
        `This dict has no key ${typed}. Keys are matched as Python writes them: ` +
          `'SKU0042' or SKU0042 for a str, 42 for an int. To go by position, type [0] to [${n(count - 1)}].`,
      );
      return;
    }
  }
  if (index < 0) index += count;
  const item = await view.itemAt(container, index);
  if (!item) {
    void vscode.window.showWarningMessage(
      `Could not show item ${n(index)}; refresh the view and try again.`,
    );
    return;
  }
  const showing = [...treeViews.values()].filter((tv) => tv.visible);
  for (const tv of showing.length > 0 ? showing : [treeViews.get(VIEW_ID)!]) {
    await tv.reveal(item, { select: true, focus: true, expand: false });
  }
}

/**
 * Show the committed object whose permanent number is `oop` in Persisted
 * Objects, opening the rows down to it and selecting it, in the views showing
 * Persisted Objects (or the main one, when neither is showing). This is where
 * `%pending`'s links go: what it selects is the object as committed, so its
 * row reads the value the next commit replaces.
 */
async function showObject(
  view: SavedObjectsProvider,
  treeViews: Map<string, vscode.TreeView<SavedRow>>,
  oop: number,
  { fromPendingChanges = false } = {},
): Promise<void> {
  let found: Awaited<ReturnType<SavedObjectsProvider['objectRow']>>;
  try {
    // From Pending changes, the view was just read: going to the object keeps it, and the list, open.
    found = await view.objectRow(oop, { reread: !fromPendingChanges });
  } catch (e) {
    void vscode.window.showErrorMessage(`Could not look for that object: ${errorMessage(e)}`);
    return;
  }
  if (!found) {
    void vscode.window.showWarningMessage(
      'That object is not under gemdb.root in what is committed: it may have been removed since, ' +
        'or be further down than the search reaches. Type %pending again for fresh links.',
    );
    return;
  }
  const showing = [...treeViews.values()].filter((tv) => tv.visible);
  for (const tv of showing.length > 0 ? showing : [treeViews.get(VIEW_ID)!]) {
    await tv.reveal(found.row, { select: true, focus: true, expand: false });
  }
  if (found.reached < found.steps.length) {
    void vscode.window.showWarningMessage(
      `Could not open all of ${pathText(found.steps)}: this is as far down as the view shows.`,
    );
  }
}

/**
 * Revert to Committed Value: after the user confirms, put a marked object, or
 * one entry of it, back as committed in its notebook's session. Its change
 * is discarded and nothing is committed; the notebook can change it again.
 */
async function revertChange(view: SavedObjectsProvider, row: SavedRow): Promise<void> {
  const target = view.revertTarget(row);
  if (!target) return;
  const { object, entry, label } = target;
  const change = entry && object.diff.changed.find((c) => c.name === entry);
  const what = entry ? `${object.path}'s ${entry}` : object.path;
  const detail = change
    ? `It goes back to ${change.before}, discarding ${label}'s change to ${change.after}. Nothing is committed.`
    : `This discards ${label}'s uncommitted changes to it. Nothing is committed.`;
  const choice = await vscode.window.showWarningMessage(
    `Revert ${what} to its committed value?`,
    { modal: true, detail },
    'Revert',
  );
  if (choice !== 'Revert') return;
  try {
    await view.revert(row);
  } catch (e) {
    void vscode.window.showErrorMessage(`Could not revert ${what}: ${errorMessage(e)}`);
  }
}

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
      treeView.onDidExpandElement((event) => view.noteGroupOpen(event.element, true)),
      treeView.onDidCollapseElement((event) => view.noteGroupOpen(event.element, false)),
    );
  }
  context.subscriptions.push(
    vscode.commands.registerCommand('gemdb.saveVariable', (ctx: VariableContext) =>
      saveVariable(view, treeViews, ctx),
    ),
    // Internal, for the Inspector (`inspector.ts`): its Add to Persisted Objects….
    vscode.commands.registerCommand('gemdb.savedObjects.addFromInspector', (target: AddTarget) =>
      addToPersistedObjects(view, treeViews, target),
    ),
    vscode.commands.registerCommand('gemdb.savedObjects.refresh', () => view.refresh()),
    vscode.commands.registerCommand('gemdb.savedObjects.goToItem', (row: SavedRow) =>
      row ? goToItem(view, treeViews, row) : undefined,
    ),
    // Internal, for `%persist` in the Debug Console (`debugger.ts`): show the
    // save as pending, as Add to Persisted Objects does.
    vscode.commands.registerCommand(
      'gemdb.savedObjects.notePersisted',
      (save: Omit<PendingSave, 'at'>) => {
        view.notePending({ ...save, at: new Date().toISOString() });
        const shown = treeViews.get(DEBUG_VIEW_ID);
        if (shown) {
          view
            .revealSaved(shown, save.key)
            .catch((e: unknown) => log(`Could not show ${save.key}: ${errorMessage(e)}`));
        }
      },
    ),
    vscode.commands.registerCommand('gemdb.savedObjects.revert', (row: SavedRow) =>
      row ? revertChange(view, row) : undefined,
    ),
    // Internal, for `%pending` (`debugger.ts`): what is committed, to leave out what reads the same.
    vscode.commands.registerCommand('gemdb.savedObjects.committedSnapshots', (oops: number[]) =>
      view.committedSnapshots(oops),
    ),
    // Internal, for `%pending` (`debugger.ts`): mark what the notebook's next commit changes.
    vscode.commands.registerCommand(
      'gemdb.savedObjects.notePendingChanges',
      (changes: { ownerKey: string; label: string; oops: number[] }) =>
        view
          .noteChanges(changes.ownerKey, changes.label, changes.oops)
          .catch((e: unknown) => log(`Could not mark the pending changes: ${errorMessage(e)}`)),
    ),
    // A changed row reads as a modified file does, in the same colour, with an M.
    vscode.window.registerFileDecorationProvider({
      provideFileDecoration(uri: vscode.Uri) {
        return uri.scheme === CHANGED_SCHEME
          ? new vscode.FileDecoration(
              'M',
              'Changed: the next commit writes it',
              new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'),
            )
          : undefined;
      },
    }),
    // Internal: where `%pending`'s links in the Debug Console go, through the URI handler below.
    vscode.commands.registerCommand(
      'gemdb.savedObjects.showObject',
      (oop: number, options?: { fromPendingChanges?: boolean }) =>
        showObject(view, treeViews, oop, options),
    ),
    // GemDB's only URI handler: `objectLink` (`consoleCommands.ts`) writes the links it takes.
    vscode.window.registerUriHandler({
      handleUri(uri: vscode.Uri) {
        const oop = Number(new URLSearchParams(uri.query).get('oop'));
        if (uri.path === '/persisted' && Number.isSafeInteger(oop) && oop > 0) {
          void showObject(view, treeViews, oop);
        }
      },
    }),
    vscode.commands.registerCommand('gemdb.saveStack', () => saveStack(view, treeViews)),
    vscode.commands.registerCommand('gemdb.restoreStack', () => restoreStack()),
    vscode.commands.registerCommand('gemdb.savedObjects.openStack', (row: SavedRow) =>
      row?.kind === 'entry' ? openSavedStack(row.entry.key) : undefined,
    ),
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
  // Look once, quietly, shortly after startup, so the Restore buttons are right before anyone
  // opens Persisted Objects.
  const look = setTimeout(() => {
    if (!isRunning(listProcesses())) return;
    extensionQuery(savedStackKeysQuery())
      .then((raw) => noteSavedStacks((JSON.parse(raw) as unknown[]).length))
      .catch(() => undefined);
  }, 2000);
  look.unref?.();
  context.subscriptions.push(new vscode.Disposable(() => clearTimeout(look)));
  return view;
}
