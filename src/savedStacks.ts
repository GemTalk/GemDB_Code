import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { DapFrame, DapScope, Pause, scopesFor } from './debugger';
import { FIELD } from './haltStack';
import { runFileOf } from './fileOwner';
import { MAIN_MODULE, MainModule, REGISTRY } from './pauseVariables';
import { escapeString } from './pythonQueries';

/**
 * A paused stack saved under `gemdb.root`, and opened again later — after a
 * commit, in a new VS Code, with the notebook or file it came from closed or
 * gone.
 *
 * This is a **snapshot**, not a continuation: each frame's name, position and
 * full source text, its locals as the real objects, and the notebook's
 * globals. Opening it rebuilds the Call Stack and Variables views from those
 * objects, read-only. Nothing is resumed — there is no process to resume —
 * so Continue and Stop just close it.
 *
 * It is stored as an ordinary dict (`"kind": "gemdb.stack"`), so the
 * Persisted Objects view lists, commits, inspects and removes it like any
 * other object, and Python can read it: `gemdb.root["stack_…"]["frames"]`.
 */

export const STACK_KIND = 'gemdb.stack';

/** How many committed saved stacks GemDB last saw, so Restore shows only when there are some. */
let savedStackCount = 0;
const countListeners = new Set<() => void>();

/** The count last seen; 0 until GemDB has looked. */
export function knownSavedStacks(): number {
  return savedStackCount;
}

/**
 * Record how many committed saved stacks there are. The Restore buttons are
 * shown through the `gemdb.hasSavedStacks` context key, and the GemDB panel's
 * row through a listener, so none of them offers a list that would be empty.
 */
export function noteSavedStacks(count: number): void {
  if (count === savedStackCount) return;
  savedStackCount = count;
  void vscode.commands.executeCommand('setContext', 'gemdb.hasSavedStacks', count > 0);
  for (const listener of countListeners) listener();
}

/** Be told when the count of saved stacks changes. */
export function onSavedStacksChanged(listener: () => void): vscode.Disposable {
  countListeners.add(listener);
  return new vscode.Disposable(() => countListeners.delete(listener));
}

/** One frame of a saved stack, as it is stored (locals aside). */
export interface SavedFrame {
  name: string;
  line: number;
  column: number;
  end_column: number | null;
  /** What the Call Stack labelled its source: `Cell [1]`, `bpmod.py`. */
  source_name: string | null;
  /** The cell URI or file path it came from, when it had one. */
  path: string | null;
  /** The whole cell or file, so the frame can be shown when the original is gone. */
  text: string | null;
}

/** What a saved stack carries besides its objects. */
export interface SavedStackMeta {
  label: string;
  notebook: string | null;
  saved_at: string;
  description: string | null;
  frames: SavedFrame[];
}

/** A Python literal for a string, number or nothing. JSON's escapes are all valid Python. */
function py(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return 'None';
  return typeof value === 'number' ? String(Math.trunc(value)) : JSON.stringify(value);
}

/** The saved form of a live frame, from what the debugger showed for it. */
export function savedFrameOf(frame: DapFrame, lines: string[] | undefined): SavedFrame {
  return {
    name: frame.name,
    line: frame.line,
    column: frame.column,
    end_column: frame.endColumn ?? null,
    source_name: frame.source?.name ?? null,
    path: frame.source?.path ?? null,
    text: lines ? lines.join('\n') : null,
  };
}

/**
 * Smalltalk, for the paused session, that puts a snapshot of the stack under
 * `gemdb.root[key]`, not committed.
 *
 * The Python runs **in the notebook's own scope** so `globals()` is the
 * notebook's, and the frames' locals — already in the pause's registry — are
 * bound there under `___gemdb_…` names for the moment it runs, then removed.
 * A file run has no notebook scope: its globals are its `__main__` module's,
 * and the Python runs in a scratch scope. Dunder names and modules are left out
 * of the saved globals.
 */
export function saveStackQuery(
  key: string,
  meta: Omit<SavedStackMeta, 'frames'>,
  frames: SavedFrame[],
  localsRefs: number[],
  scopeKey: string | MainModule | undefined,
): string {
  const localName = (i: number) => `___gemdb_l${i}`;
  const framesPy = frames
    .map(
      (f, i) =>
        `{"name": ${py(f.name)}, "line": ${py(f.line)}, "column": ${py(f.column)}, ` +
        `"end_column": ${py(f.end_column)}, "source_name": ${py(f.source_name)}, ` +
        `"path": ${py(f.path)}, "text": ${py(f.text)}, ` +
        `"locals": ${localsRefs[i] ? localName(i) : 'None'}}`,
    )
    .join(',\n  ');
  const source = [
    'import gemdb as ___gemdb_m',
    `___gemdb_m.root[${py(key)}] = {`,
    `  "kind": ${py(STACK_KIND)}, "version": 1,`,
    `  "label": ${py(meta.label)}, "notebook": ${py(meta.notebook)},`,
    `  "saved_at": ${py(meta.saved_at)}, "description": ${py(meta.description)},`,
    `  "frames": [\n  ${framesPy}],`,
    `  "globals": {k: v for k, v in ${
      scopeKey === MAIN_MODULE ? '__import__("sys").modules["__main__"].__dict__' : 'globals()'
    }.items()`,
    '              if not k.startswith("__") and type(v).__name__ != "module"},',
    '}',
    '"saved"',
  ].join('\n');
  const binds = localsRefs
    .map((ref, i) => (ref ? `scope at: #'${localName(i)}' put: ((reg at: ${ref}) at: 2).` : ''))
    .filter(Boolean)
    .join('\n');
  const unbinds = [
    ...localsRefs.map((ref, i) => (ref ? `scope removeKey: #'${localName(i)}' ifAbsent: [].` : '')),
    "scope removeKey: #'___gemdb_m' ifAbsent: [].",
  ]
    .filter(Boolean)
    .join(' ');
  const scope =
    scopeKey === undefined || scopeKey === MAIN_MODULE
      ? 'SymbolDictionary new'
      : `((SessionTemps current at: #'__gemdbScopes') at: '${escapeString(scopeKey)}')`;
  return `| scope reg d r |
scope := ${scope}.
reg := SessionTemps current at: #'${REGISTRY}' otherwise: nil.
reg isNil ifTrue: [^ 'Error: the pause has no variables to save' encodeAsUTF8].
${binds}
d := System myUserProfile symbolList objectNamed: #'ModuleAst'.
r := [[(d evaluateSource: '${escapeString(source)}' usingModuleScope: scope) asString]
    ensure: [${unbinds}]]
  on: AbstractException do: [:e | 'Error: ' , e class name , ' - ' , e messageText asString].
r encodeAsUTF8`;
}

/**
 * Smalltalk, for the extension's own session, that reads a committed saved
 * stack and registers its frames' locals and its globals for the Variables
 * view. Answers the stack's metadata as JSON, then each frame's locals ref,
 * then the globals ref (0 for none), separated by the field character.
 */
export function openStackQuery(key: string): string {
  const source = [
    'import gemdb, json',
    `_s = gemdb.root[${py(key)}]`,
    '_m = {"label": _s.get("label"), "notebook": _s.get("notebook"),',
    '      "saved_at": _s.get("saved_at"), "description": _s.get("description"),',
    '      "frames": [dict((k, f.get(k)) for k in ("name", "line", "column", "end_column",',
    '                  "source_name", "path", "text")) for f in _s["frames"]]}',
    '(json.dumps(_m), [f.get("locals") for f in _s["frames"]], _s.get("globals"))',
  ].join('\n');
  return `| d r reg out lst g none field |
field := Character codePoint: 31.
none := System myUserProfile symbolList objectNamed: #'None'.
System abortTransaction.
reg := OrderedCollection new.
SessionTemps current at: #'${REGISTRY}' put: reg.
d := System myUserProfile symbolList objectNamed: #'ModuleAst'.
r := [d evaluateSource: '${escapeString(source)}' usingModuleScope: SymbolDictionary new]
  on: AbstractException do: [:e | e return: ('Error: ' , e class name , ' - ' , e messageText asString)].
r isString ifTrue: [^ r encodeAsUTF8].
out := WriteStream on: Unicode7 new.
out nextPutAll: (r at: 1) asString; nextPut: field.
lst := r at: 2.
1 to: lst size do: [:i | | l |
  l := lst at: i.
  (l notNil and: [l ~~ none and: [l size > 0]])
    ifTrue: [reg add: { #gemdbScope. l }. out print: reg size]
    ifFalse: [out nextPutAll: '0'].
  out nextPutAll: ' '].
out nextPut: field.
g := r at: 3.
(g notNil and: [g ~~ none and: [g size > 0]])
  ifTrue: [reg add: { #gemdbScope. g }. out print: reg size]
  ifFalse: [out nextPutAll: '0'].
out contents encodeAsUTF8`;
}

/** Parse `openStackQuery`'s answer. */
export function parseOpenedStack(raw: string): {
  meta: SavedStackMeta;
  locals: number[];
  globals: number;
} {
  if (raw.startsWith('Error: ')) throw new Error(raw.slice('Error: '.length));
  const [json, locals, globals] = raw.split(FIELD);
  const meta = JSON.parse(json ?? '{}') as SavedStackMeta;
  return {
    meta,
    locals: (locals ?? '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((n) => Number.parseInt(n, 10) || 0),
    globals: Number.parseInt(globals ?? '', 10) || 0,
  };
}

/** A committed saved stack, as a list of them shows it. */
export interface SavedStackSummary {
  key: string;
  label: string | null;
  saved_at: string | null;
  frames: number;
}

/**
 * Smalltalk, for the extension's session, that lists the committed saved
 * stacks as JSON: each one's key, notebook, when it was saved and how many
 * frames it has — enough to choose between several.
 */
export function savedStackKeysQuery(): string {
  const source = [
    'import gemdb, json',
    'json.dumps([{"key": k, "label": v.get("label"), "saved_at": v.get("saved_at"),',
    '             "frames": len(v.get("frames") or [])}',
    '            for k, v in gemdb.root.items()',
    `            if isinstance(k, str) and isinstance(v, dict) and v.get("kind") == ${py(STACK_KIND)}])`,
  ].join('\n');
  return `| d r |
System abortTransaction.
d := System myUserProfile symbolList objectNamed: #'ModuleAst'.
r := [(d evaluateSource: '${escapeString(source)}' usingModuleScope: SymbolDictionary new) asString]
  on: AbstractException do: [:e | '[]'].
r encodeAsUTF8`;
}

/** What the debugger can still open for a saved frame's source. */
export interface SourceWorld {
  /** Whether a file exists on disk. */
  fileExists(file: string): boolean;
  /** The lines of an open notebook cell with this URI, if one is open. */
  openCellLines(uri: string): string[] | undefined;
}

/**
 * The display path of a frame's saved copy: the original's location, then what this is.
 * `/w/notes/breakpoint.ipynb · Cell [1] (saved …)` for a cell, `/w/mod.py (saved …)` for
 * a file whose saved name already starts with the file's name.
 */
export function savedCopyPath(frame: SavedFrame, name: string): string {
  const original = frame.path ?? '';
  const file = original.startsWith('vscode-notebook-cell:')
    ? decodeURIComponent(original.replace(/^vscode-notebook-cell:/, '').replace(/#.*$/, ''))
    : original;
  const base = path.basename(file);
  return name.startsWith(base) ? path.join(path.dirname(file), name) : `${file} · ${name}`;
}

/**
 * Where a restored frame's source comes from.
 *
 * Always the copy saved with the stack, when there is one: a saved stack is a
 * snapshot, and showing the live notebook or file — even an unchanged one —
 * puts the paused-line highlight in an editor that looks like a run happening
 * now. The copy is read-only; its tab, its Call Stack row and that row's hover
 * say it is the saved copy, and when it was saved. Only a frame saved without text falls back to its original, and only
 * if that still exists, so nothing tries to open a file that is gone.
 */
export function restoredSource(
  frame: SavedFrame,
  sourceReference: number,
  world: SourceWorld,
  savedAt?: string,
): DapFrame['source'] | undefined {
  if (frame.text !== null) {
    const name = `${frame.source_name ?? 'source'} (saved${savedAt ? ` ${savedAt}` : ''})`;
    return {
      name,
      sourceReference,
      // With a sourceReference, VS Code only *displays* the path: the Call Stack's hover
      // shows it whole and the editor tab's title is its last segment. So it names where the
      // copy came from and says it is a saved copy, in both places.
      ...(frame.path ? { path: savedCopyPath(frame, name) } : {}),
      origin: `saved with the stack${savedAt ? ` on ${savedAt}` : ''}, not the file on disk`,
    };
  }
  if (!frame.path) return undefined;
  if (frame.path.startsWith('vscode-notebook-cell:')) {
    return world.openCellLines(frame.path)
      ? { name: frame.source_name ?? 'Cell', path: frame.path }
      : undefined;
  }
  return world.fileExists(frame.path)
    ? { name: frame.source_name ?? path.basename(frame.path), path: frame.path }
    : undefined;
}

/** The debugger's view of a saved stack: frames, scopes and the saved texts behind them. */
export function restoredFrames(
  meta: SavedStackMeta,
  locals: number[],
  globals: number,
  world: SourceWorld,
): { frames: DapFrame[]; scopes: Map<number, DapScope[]>; texts: Map<number, string> } {
  const scopes = new Map<number, DapScope[]>();
  const texts = new Map<number, string>();
  const frames = meta.frames.map((frame, index): DapFrame => {
    const id = index + 1;
    const source = restoredSource(frame, id, world, meta.saved_at);
    if (source?.sourceReference && frame.text !== null) texts.set(id, frame.text);
    // Globals belong to the frames of the notebook's cells or the run file, as when live.
    const ownFrame =
      frame.path === null ||
      frame.path.startsWith('vscode-notebook-cell:') ||
      frame.path === runFileOf(meta.notebook);
    scopes.set(id, scopesFor(locals[index] ?? 0, ownFrame ? globals : 0));
    return {
      id,
      name: frame.name,
      line: frame.line,
      column: frame.column,
      ...(frame.end_column ? { endLine: frame.line, endColumn: frame.end_column } : {}),
      ...(source ? { source } : { presentationHint: 'subtle' as const }),
    };
  });
  return { frames, scopes, texts };
}

/** The world as it is: the disk, and the notebooks open in this window. */
export function liveSourceWorld(
  openNotebookCells: () => Array<{ uri: string; lines: string[] }>,
): SourceWorld {
  return {
    fileExists: (file) => {
      try {
        return fs.statSync(file).isFile();
      } catch {
        return false;
      }
    },
    openCellLines: (uri) => openNotebookCells().find((cell) => cell.uri === uri)?.lines,
  };
}

/** A key worth keeping for a saved stack: the notebook and the time. */
export function stackKeyFor(label: string, at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const base = label
    .replace(/\.ipynb$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24);
  return `stack_${base || 'run'}_${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}_${pad(at.getHours())}${pad(at.getMinutes())}`;
}

/** What the Call Stack shows for an opened saved stack. */
export function savedPauseLabel(meta: SavedStackMeta): string {
  return `Saved stack: ${meta.label} (${meta.saved_at})`;
}

export type { Pause };
