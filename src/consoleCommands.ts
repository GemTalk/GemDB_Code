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
 * This file only reads the line and describes the commands; the adapter runs
 * them (`PauseDebugAdapter.runCommand`).
 */

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
  | { kind: 'commit' }
  | { kind: 'names' }
  | { kind: 'help' }
  | { kind: 'invalid'; message: string };

/** A Python identifier: a name a console line can bind. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

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
  /** 1-based column in the typed text where the completion replaces from. */
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
    const start = word[1].length + 1;
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
        start: beforeCursor.length - typed.length + 1,
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
        start: beforeCursor.length - typed.length + 1,
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
      start: beforeCursor.length - typed.length + 1,
      length: typed.length,
    }));
}
