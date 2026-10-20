/**
 * GemDB's own commands in the Debug Console: a line that starts with `%`.
 *
 * Everything typed into the console reaches the debug adapter first, so it can
 * take a `%` line as a command before treating it as Python — as CodeLLDB does
 * with `/` and Ruby's debugger with `,`. `%` is IPython's and Jupyter's sign
 * for the same idea (`%store`, `%timeit`), so a Python developer is likely to
 * guess it, and no Python line can start with it, so nothing a user means as
 * Python is ever taken for a command.
 *
 * This file only reads the line, describes the commands and words their
 * answers; the adapter runs them (`PauseDebugAdapter.runCommand`).
 */

import { Pending, pathText } from './pauseVariables';

/** One command, as `%help` and autocomplete describe it. */
export interface ConsoleCommandInfo {
  name: string;
  /** How it is typed. */
  usage: string;
  /** What it does, in one line. */
  summary: string;
}

export const CONSOLE_COMMANDS: ConsoleCommandInfo[] = [
  {
    name: '%persist',
    usage: '%persist p   or   %persist p as key',
    summary: 'Add p to Persisted Objects (gemdb.root); it is saved when the notebook commits.',
  },
  {
    name: '%inspect',
    usage: '%inspect p',
    summary: 'Open p, or any expression, in an Inspector beside the editor.',
  },
  {
    name: '%pending',
    usage: '%pending',
    summary:
      "List the persisted objects the notebook's next commit writes, each with a link to it.",
  },
  {
    name: '%commit',
    usage: '%commit',
    summary: "Commit the notebook's changes, as ✓ in Persisted Objects does.",
  },
  {
    name: '%names',
    usage: '%names',
    summary: 'List the names you have bound in the Debug Console at this pause.',
  },
  {
    name: '%help',
    usage: '%help',
    summary: "List GemDB's Debug Console commands.",
  },
];

/** A `%` line, read. */
export type ConsoleCommand =
  | { kind: 'persist'; expression: string; key: string }
  | { kind: 'inspect'; expression: string }
  | { kind: 'pending' }
  | { kind: 'commit' }
  | { kind: 'names' }
  | { kind: 'help' }
  | { kind: 'invalid'; message: string };

/** A Python identifier: a name a console line can bind. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * What was typed in the Debug Console or a watch, without the indentation
 * every line of it shares, as Python's `textwrap.dedent` takes it off: a line
 * pasted from a document or a chat often starts with a space, which Python
 * reads as an unexpected indent. A block keeps its own shape, since only the
 * common part goes; blank lines don't count towards it.
 */
export function dedented(source: string): string {
  const lines = source.split('\n');
  const indents = lines
    .filter((line) => line.trim() !== '')
    .map((line) => /^[ \t]*/.exec(line)?.[0].length ?? 0);
  const common = indents.length ? Math.min(...indents) : 0;
  if (common === 0) return source;
  return lines.map((line) => (line.trim() === '' ? line.trim() : line.slice(common))).join('\n');
}

/** Whether a console line is a GemDB command rather than Python. */
export function isConsoleCommand(line: string): boolean {
  return line.trimStart().startsWith('%');
}

/** Read a `%` line. Undefined for a line that is not one. */
export function parseConsoleCommand(line: string): ConsoleCommand | undefined {
  const text = line.trim();
  if (!text.startsWith('%')) return undefined;
  const [, word = '', rest = ''] = /^%(\S*)\s*([\s\S]*)$/.exec(text) ?? [];
  switch (word) {
    case 'persist': {
      if (!rest) return { kind: 'invalid', message: `Persist what? ${usageOf('%persist')}` };
      const as = /^([\s\S]+?)\s+as\s+(.+)$/.exec(rest);
      const expression = (as ? as[1] : rest).trim();
      const key = as ? unquoted(as[2].trim()) : expression;
      if (!as && !IDENTIFIER.test(expression)) {
        return {
          kind: 'invalid',
          message: `Give it a key: %persist ${expression} as some_key`,
        };
      }
      if (!key) return { kind: 'invalid', message: `Give it a key. ${usageOf('%persist')}` };
      return { kind: 'persist', expression, key };
    }
    case 'inspect':
      return rest
        ? { kind: 'inspect', expression: rest.trim() }
        : { kind: 'invalid', message: `Inspect what? ${usageOf('%inspect')}` };
    case 'pending':
    case 'commit':
    case 'names':
    case 'help':
      return rest
        ? { kind: 'invalid', message: `%${word} takes nothing after it.` }
        : { kind: word };
    default:
      return {
        kind: 'invalid',
        message: `${word ? `%${word} is not a GemDB command.` : 'A command goes after the %.'} ${commandList()}`,
      };
  }
}

/** A key typed in quotes, `"orders"` or `'orders'`, without them. */
function unquoted(text: string): string {
  const quoted = /^(["'])(.*)\1$/.exec(text);
  return quoted ? quoted[2] : text;
}

function usageOf(name: string): string {
  const info = CONSOLE_COMMANDS.find((c) => c.name === name);
  return info ? `Type ${info.usage}.` : '';
}

function commandList(): string {
  return `Commands: ${CONSOLE_COMMANDS.map((c) => c.name).join(', ')}.`;
}

/** What `%help` prints. */
export function helpText(): string {
  const width = Math.max(...CONSOLE_COMMANDS.map((c) => c.usage.length));
  return [
    "GemDB's Debug Console commands (Python still works as usual):",
    ...CONSOLE_COMMANDS.map((c) => `  ${c.usage.padEnd(width)}   ${c.summary}`),
    '',
    'What Persisted Objects holds is here by name (o for gemdb.root["o"]), and always as',
    'persisted.o, even when o means something else at this pause. Type persisted to list it.',
    '',
  ].join('\n');
}

/** The one-line tip the console shows at the first pause of a window. */
export const CONSOLE_TIP =
  'GemDB: type % in the Debug Console for its commands. %persist p keeps p in Persisted Objects; %help lists them all.\n';

/** One autocomplete suggestion, as the Debug Adapter Protocol spells it. */
export interface CompletionItem {
  label: string;
  text?: string;
  detail?: string;
  type?: 'function' | 'variable' | 'keyword';
  /**
   * Where in the typed text the completion replaces from, counted from 0.
   * The protocol says this follows the client's 1-based columns, but VS Code
   * reads it as a 0-based string index: it filters a suggestion by
   * `text.substring(start, start + length) + label`. Sent 1-based, that slice
   * started a character late, so typing `%p` matched `p%pending` and every
   * command dropped out of the list.
   */
  start?: number;
  length?: number;
}

/**
 * What to suggest for the text before the cursor. Only after a `%`: a command
 * name while it is being typed, and after `%persist `, the names bound in the
 * console (`names`). Anything else is Python, which this does not complete.
 */
export function commandCompletions(beforeCursor: string, names: string[]): CompletionItem[] {
  const word = /^(\s*)%([A-Za-z]*)$/.exec(beforeCursor);
  if (word) {
    const start = word[1].length;
    return CONSOLE_COMMANDS.filter((c) => c.name.startsWith(`%${word[2]}`)).map((c) => ({
      label: c.name,
      detail: c.summary,
      type: 'keyword',
      start,
      length: word[2].length + 1,
    }));
  }
  const persisting = /^\s*%persist\s+([A-Za-z0-9_]*)$/.exec(beforeCursor);
  if (persisting) {
    const typed = persisting[1];
    return names
      .filter((n) => n.startsWith(typed))
      .map((n) => ({
        label: n,
        type: 'variable',
        start: beforeCursor.length - typed.length,
        length: typed.length,
      }));
  }
  return [];
}

/** A Python name, the only kind of persisted key reachable as `persisted.key`. */
const PYTHON_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Suggestions for Persisted Objects while Python is typed, so a persisted
 * object can be found without knowing `persisted` exists:
 *
 * - after `persisted.`, the persisted keys;
 * - while a name is typed (not after a dot), `persisted.key` for each
 *   persisted key it starts, described as the `gemdb.root` entry it is.
 *
 * `keys` is what Persisted Objects holds. Keys that are not Python names are
 * left out: they are reachable only as `gemdb.root["…"]`.
 */
export function persistedCompletions(beforeCursor: string, keys: string[]): CompletionItem[] {
  const names = keys.filter((k) => PYTHON_NAME.test(k));
  const after = /(?:^|[^A-Za-z0-9_.])persisted\.([A-Za-z0-9_]*)$/.exec(beforeCursor);
  if (after) {
    const typed = after[1];
    return names
      .filter((k) => k.startsWith(typed))
      .map((k) => ({
        label: k,
        detail: `gemdb.root[${JSON.stringify(k)}] in Persisted Objects`,
        type: 'variable',
        start: beforeCursor.length - typed.length,
        length: typed.length,
      }));
  }
  const word = /(?:^|[^A-Za-z0-9_.])([A-Za-z_][A-Za-z0-9_]*)$/.exec(beforeCursor);
  if (!word) return [];
  const typed = word[1];
  return names
    .filter((k) => k.startsWith(typed))
    .map((k) => ({
      label: `persisted.${k}`,
      detail: `gemdb.root[${JSON.stringify(k)}] in Persisted Objects`,
      type: 'variable',
      start: beforeCursor.length - typed.length,
      length: typed.length,
    }));
}

/**
 * The link `%pending` puts on each object: a URI the extension handles
 * (`registerSavedObjects`), which shows the object in Persisted Objects. The
 * Debug Console turns anything shaped `scheme://…` into a link, and VS Code
 * asks once before it lets an extension open one of its own (a "don't ask
 * again" box ends that). `scheme` is `vscode.env.uriScheme`, which differs
 * between VS Code, Insiders and its forks.
 */
export function objectLink(scheme: string, oop: number): string {
  return `${scheme}://gemtalksystems.gemdb/persisted?oop=${oop}`;
}

/** Longest value `%pending` prints for one object. */
const PENDING_VALUE_CHARS = 60;

/**
 * What `%pending` prints: each object the next commit writes, by its path
 * under `gemdb.root`, its type and its value now, and a link that shows it in
 * Persisted Objects — which reads what is committed, so the link is also the
 * way to its value before. Sorted by path, so the objects of one entry sit
 * together; an object no path was found to comes last, and says so.
 * Internal objects (`PendingChange.internal`) — storage inside a Python
 * object, such as a big dict's buckets, or the database's own caches — are
 * written too, but have no Python path or value, so they are one line,
 * counted by type.
 */
export function pendingText(
  pending: Pending,
  label: string,
  link: (oop: number) => string,
): string {
  const unchanged = pending.unchanged ?? 0;
  const they = unchanged === 1 ? 'it' : 'they';
  if (pending.changes.length === 0) {
    return unchanged > 0
      ? `Nothing changes on commit: the ${unchanged === 1 ? 'object' : `${unchanged} objects`} ${label} ` +
          `changed ${unchanged === 1 ? 'reads' : 'read'} as committed again — reverted, or set to what ${they} already held.`
      : `Nothing to commit: ${label} has changed no persisted object since its last commit.`;
  }
  const NOT_FOUND = '(not found under gemdb.root)';
  const internal = pending.changes.filter((change) => change.internal);
  const rows = pending.changes
    .filter((change) => !change.internal)
    .map((change) => {
      const value =
        change.value.length > PENDING_VALUE_CHARS
          ? `${change.value.slice(0, PENDING_VALUE_CHARS - 1)}…`
          : change.value;
      return {
        path: change.steps ? pathText(change.steps) : NOT_FOUND,
        found: change.steps !== undefined,
        what: `${change.type} = ${value}`,
        oop: change.oop,
      };
    })
    .sort((a, b) => Number(b.found) - Number(a.found) || a.path.localeCompare(b.path));
  const width = Math.min(Math.max(0, ...rows.map((r) => r.path.length)), 48);
  const n = pending.total;
  const lines = [
    `${label}'s next commit writes ${n} persisted ${n === 1 ? 'object' : 'objects'}:`,
    // An object with no path has no link: the view would look for it the same way, and fail.
    ...rows.map((r) =>
      `  ${r.path.padEnd(width)}  ${r.what}${r.found ? `  ${link(r.oop)}` : ''}`.trimEnd(),
    ),
  ];
  if (internal.length > 0) {
    const types = new Map<string, number>();
    for (const change of internal) types.set(change.type, (types.get(change.type) ?? 0) + 1);
    const named = [...types].map(([type, count]) => (count > 1 ? `${type} ×${count}` : type));
    lines.push(
      `  + ${internal.length} outside gemdb.root (${named.join(', ')}): ` +
        "Grail's own records and storage, which Persisted Objects does not show",
    );
  }
  if (unchanged > 0) {
    lines.push(
      `  + ${unchanged} written back unchanged (reverted, or set to what ${they} already held): not listed`,
    );
  }
  if (pending.more > 0) lines.push(`  … and ${pending.more} more not listed.`);
  if (pending.cut) {
    lines.push(
      'The search for paths stopped early (too many objects, or it took too long), so an object it did not reach shows as not found.',
    );
  }
  lines.push(
    'Objects created since the last commit are written too, inside the objects above that hold them.',
    'Ctrl+click a link to show that object in Persisted Objects, where each changed object is marked M:',
    'its row reads what is committed, and its hover sets that beside what the next commit writes.',
  );
  return lines.join('\n');
}
