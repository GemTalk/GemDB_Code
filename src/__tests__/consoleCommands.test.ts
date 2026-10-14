import { describe, expect, it } from 'vitest';
import {
  CONSOLE_COMMANDS,
  commandCompletions,
  helpText,
  isConsoleCommand,
  parseConsoleCommand,
} from '../consoleCommands';

/** GemDB's `%` commands in the Debug Console: reading a line, and what is suggested while typing one. */

describe('reading a % line', () => {
  it('takes only a line that starts with %, so Python is never mistaken for a command', () => {
    expect(isConsoleCommand('%persist p')).toBe(true);
    expect(isConsoleCommand('  %help')).toBe(true);
    expect(isConsoleCommand('x % 3')).toBe(false);
    expect(isConsoleCommand('help')).toBe(false);
    expect(parseConsoleCommand('p = 1')).toBeUndefined();
  });

  it('persists a name under its own name, or under the key given after as', () => {
    expect(parseConsoleCommand('%persist p')).toEqual({
      kind: 'persist',
      expression: 'p',
      key: 'p',
    });
    expect(parseConsoleCommand('%persist p as qty_check')).toEqual({
      kind: 'persist',
      expression: 'p',
      key: 'qty_check',
    });
    expect(parseConsoleCommand('%persist o.items[0] as "first item"')).toEqual({
      kind: 'persist',
      expression: 'o.items[0]',
      key: 'first item',
    });
  });

  it('asks for a key when what is persisted is not a plain name', () => {
    expect(parseConsoleCommand('%persist o.items[0]')).toEqual({
      kind: 'invalid',
      message: 'Give it a key: %persist o.items[0] as some_key',
    });
    expect(parseConsoleCommand('%persist')).toMatchObject({ kind: 'invalid' });
  });

  it('reads the commands that take nothing, and refuses extra words after them', () => {
    expect(parseConsoleCommand('%commit')).toEqual({ kind: 'commit' });
    expect(parseConsoleCommand('%names')).toEqual({ kind: 'names' });
    expect(parseConsoleCommand('%help')).toEqual({ kind: 'help' });
    expect(parseConsoleCommand('%commit now')).toMatchObject({ kind: 'invalid' });
  });

  it('names the commands when it does not know the one typed', () => {
    const unknown = parseConsoleCommand('%abort');
    expect(unknown).toMatchObject({ kind: 'invalid' });
    expect((unknown as { message: string }).message).toMatch(
      /%abort is not a GemDB command\. Commands: %persist, %commit, %names, %help\./,
    );
  });
});

describe('%help', () => {
  it('lists every command with how to type it and what it does', () => {
    const text = helpText();
    for (const c of CONSOLE_COMMANDS) {
      expect(text).toContain(c.usage);
      expect(text).toContain(c.summary);
    }
  });
});

describe('autocomplete', () => {
  it('lists the commands when % is typed, each with what it does, replacing the % onwards', () => {
    expect(commandCompletions('%', [])).toEqual(
      CONSOLE_COMMANDS.map((c) => ({
        label: c.name,
        detail: c.summary,
        type: 'keyword',
        start: 1,
        length: 1,
      })),
    );
  });

  it('narrows to the commands that match what is typed', () => {
    expect(commandCompletions('%pe', []).map((c) => c.label)).toEqual(['%persist']);
    expect(commandCompletions('  %c', [])).toEqual([
      expect.objectContaining({ label: '%commit', start: 3, length: 2 }),
    ]);
  });

  it('offers the console’s names after %persist', () => {
    expect(commandCompletions('%persist ', ['bad', 'p'])).toEqual([
      { label: 'bad', type: 'variable', start: 10, length: 0 },
      { label: 'p', type: 'variable', start: 10, length: 0 },
    ]);
    expect(commandCompletions('%persist b', ['bad', 'p']).map((c) => c.label)).toEqual(['bad']);
  });

  it('suggests nothing for Python', () => {
    expect(commandCompletions('len(', ['p'])).toEqual([]);
    expect(commandCompletions('x % ', ['p'])).toEqual([]);
  });
});
