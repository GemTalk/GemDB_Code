import { describe, expect, it } from 'vitest';
import {
  CONSOLE_COMMANDS,
  commandCompletions,
  helpText,
  isConsoleCommand,
  objectLink,
  dedented,
  parseConsoleCommand,
  pendingText,
  persistedCompletions,
} from '../consoleCommands';
import {
  diffSnapshots,
  isLiteral,
  parsePending,
  parseSnapshot,
  parseSteps,
  pathText,
  revertPlan,
  stepNames,
  withoutUnchanged,
} from '../pauseVariables';

/** GemDB's `%` commands in the Debug Console: reading a line, and what is suggested while typing one. */

describe('reading a % line', () => {
  it('reads %inspect with any expression after it', () => {
    expect(parseConsoleCommand('%inspect p')).toEqual({ kind: 'inspect', expression: 'p' });
    expect(parseConsoleCommand('  %inspect  self.lines[0] ')).toEqual({
      kind: 'inspect',
      expression: 'self.lines[0]',
    });
    expect(parseConsoleCommand('%inspect')).toMatchObject({ kind: 'invalid' });
  });

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
      /%abort is not a GemDB command\. Commands: %persist, %inspect, %pending, %commit, %names, %help\./,
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
        start: 0,
        length: 1,
      })),
    );
  });

  it('narrows to the commands that match what is typed', () => {
    expect(commandCompletions('%per', []).map((c) => c.label)).toEqual(['%persist']);
    expect(commandCompletions('  %c', [])).toEqual([
      expect.objectContaining({ label: '%commit', start: 2, length: 2 }),
    ]);
  });

  it('survives VS Code’s filter, which reads start as a 0-based index into what was typed', () => {
    // As VS Code's Debug Console filters a suggestion: the text it replaces, then its label.
    const filterText = (typed: string, c: { label: string; start?: number; length?: number }) =>
      c.start && c.length ? typed.substring(c.start, c.start + c.length).concat(c.label) : c.label;
    for (const typed of ['%p', '%pe', '  %pen']) {
      const pending = commandCompletions(typed, []).find((c) => c.label === '%pending')!;
      expect(filterText(typed, pending).startsWith(typed.trim())).toBe(true);
    }
  });

  it('offers the console’s names after %persist', () => {
    expect(commandCompletions('%persist ', ['bad', 'p'])).toEqual([
      { label: 'bad', type: 'variable', start: 9, length: 0 },
      { label: 'p', type: 'variable', start: 9, length: 0 },
    ]);
    expect(commandCompletions('%persist b', ['bad', 'p']).map((c) => c.label)).toEqual(['bad']);
  });

  it('suggests nothing for Python', () => {
    expect(commandCompletions('len(', ['p'])).toEqual([]);
    expect(commandCompletions('x % ', ['p'])).toEqual([]);
  });
});

describe('autocomplete for Persisted Objects while Python is typed', () => {
  const keys = ['entry', 'o', 'orders', 'two words'];

  it('offers persisted.key for each persisted key the typed name starts, as the gemdb.root entry it is', () => {
    expect(persistedCompletions('o', keys)).toEqual([
      {
        label: 'persisted.o',
        detail: 'gemdb.root["o"] in Persisted Objects',
        type: 'variable',
        start: 0,
        length: 1,
      },
      {
        label: 'persisted.orders',
        detail: 'gemdb.root["orders"] in Persisted Objects',
        type: 'variable',
        start: 0,
        length: 1,
      },
    ]);
  });

  it('replaces only the name being typed, inside a longer line', () => {
    expect(persistedCompletions('len(ent', keys)).toEqual([
      expect.objectContaining({ label: 'persisted.entry', start: 4, length: 3 }),
    ]);
  });

  it('offers the keys after persisted.', () => {
    expect(persistedCompletions('persisted.', keys).map((c) => c.label)).toEqual([
      'entry',
      'o',
      'orders',
    ]);
    expect(persistedCompletions('x = persisted.or', keys)).toEqual([
      expect.objectContaining({ label: 'orders', start: 14, length: 2 }),
    ]);
  });

  it('offers nothing after another dot, or for a key that is not a Python name', () => {
    expect(persistedCompletions('order.o', keys)).toEqual([]);
    expect(persistedCompletions('two', keys)).toEqual([]);
    expect(persistedCompletions('len(', keys)).toEqual([]);
  });
});

describe('%pending', () => {
  const F = '\u001f';
  const R = '\u001e';
  const S = '\u001d';
  /** One object as `pendingQuery` writes it: its path, then its row, named by its number. */
  const change = (steps: string, oop: number, type: string, value: string) =>
    [steps, String(oop), value, type, '0', '0', '0', '1', '-1', '0', ''].join(F) + R;
  const trailer = (total: number, more: number, cut: boolean) =>
    ['#', total, more, cut ? '1' : '0'].join(F) + R;
  const link = (oop: number) => objectLink('vscode', oop);

  it('reads %pending with nothing after it', () => {
    expect(parseConsoleCommand('%pending')).toEqual({ kind: 'pending' });
    expect(parseConsoleCommand('%pending x')).toMatchObject({ kind: 'invalid' });
  });

  it('writes a path as Python reads it', () => {
    expect(pathText(parseSteps(`${S}k0:orders${S}i2${S}acustomer`)!)).toBe(
      'gemdb.root["orders"][2].customer',
    );
    expect(pathText(parseSteps(`${S}K3:42${S}d5:'a:b'`)!)).toBe("gemdb.root[42]['a:b']");
    expect(pathText(parseSteps(`${S}k1:tags${S}s4`)!)).toBe('gemdb.root["tags"]{4}');
    // gemdb.root's own dict: an entry was added, replaced or removed.
    expect(pathText(parseSteps('')!)).toBe('gemdb.root');
    expect(parseSteps('?')).toBeUndefined();
  });

  it('keeps each step’s position, for the view to open straight to it', () => {
    expect(parseSteps(`${S}k7:orders${S}d12:'SKU1'`)).toEqual([
      { kind: 'root', position: 7, key: 'orders', str: true },
      { kind: 'dictKey', position: 12, key: "'SKU1'" },
    ]);
  });

  it('lists each object by path, sorted, with its value now and a link to it', () => {
    const pending = parsePending(
      change(`${S}k0:orders${S}i2`, 501, 'Order', 'Order(total=12)') +
        change('', 300, 'dict', "{'orders': [...]}") +
        change('?', 9, 'Thing', '<Thing>') +
        change(`${S}k0:orders`, 400, 'list', '[Order(total=10), Order(total=12)]') +
        trailer(4, 0, false),
    );

    expect(pendingText(pending, 'a.ipynb', link)).toBe(
      [
        "a.ipynb's next commit writes 4 persisted objects:",
        "  gemdb.root                    dict = {'orders': [...]}  vscode://gemtalksystems.gemdb/persisted?oop=300",
        '  gemdb.root["orders"]          list = [Order(total=10), Order(total=12)]  vscode://gemtalksystems.gemdb/persisted?oop=400',
        '  gemdb.root["orders"][2]       Order = Order(total=12)  vscode://gemtalksystems.gemdb/persisted?oop=501',
        '  (not found under gemdb.root)  Thing = <Thing>',
        'Objects created since the last commit are written too, inside the objects above that hold them.',
        'Ctrl+click a link to show that object in Persisted Objects, where each changed object is marked M:',
        'its row reads what is committed, and its hover sets that beside what the next commit writes.',
      ].join('\n'),
    );
  });

  it('counts internal objects on one line, by type, rather than listing them', () => {
    const text = pendingText(
      parsePending(
        change(`${S}k0:a`, 1, 'list', '[1, 2]') +
          change('!', 2, 'SymbolDictionary', '{...}') +
          change('!', 3, 'RcCollisionBucket', '[...]') +
          change('!', 4, 'RcCollisionBucket', '[...]') +
          trailer(4, 0, false),
      ),
      'a.ipynb',
      link,
    );

    expect(text).toContain(
      "  + 3 outside gemdb.root (SymbolDictionary, RcCollisionBucket ×2): Grail's own records and storage, which Persisted Objects does not show",
    );
    expect(text).not.toContain('oop=3');
    expect(text).not.toContain('not found');
  });

  it('says how many it left out, and when the search stopped short', () => {
    const text = pendingText(
      parsePending(change(`${S}k0:a`, 1, 'list', 'x'.repeat(80)) + trailer(250, 249, true)),
      'a.ipynb',
      link,
    );

    expect(text).toMatch(/writes 250 persisted objects/);
    expect(text).toContain(`list = ${'x'.repeat(59)}…`);
    expect(text).toContain('… and 249 more not listed.');
    expect(text).toMatch(/stopped early/);
  });

  it('says there is nothing to commit when nothing persisted changed', () => {
    expect(pendingText(parsePending(trailer(0, 0, false)), 'a.ipynb', link)).toBe(
      'Nothing to commit: a.ipynb has changed no persisted object since its last commit.',
    );
  });
});

describe('comparing an object as committed with what its next commit writes', () => {
  const F = '\u001f';
  const R = '\u001e';
  const snapshot = (kind: string, ...entries: string[][]) =>
    parseSnapshot(`#${F}${kind}${R}` + entries.map((e) => e.join(F) + R).join(''));

  it('reports changed, added and removed entries, each with both sides', () => {
    const before = snapshot(
      'seq',
      ['[0]', 'v1', '1'],
      ['[1]', 'o100', '{...}'],
      ['[2]', 'v3', '3'],
    );
    const after = snapshot(
      'seq',
      ['[0]', 'v1', '1'],
      ['[1]', 'o100', '{changed}'],
      ['[2]', 'v4', '4'],
      ['[3]', 'o200', "{'n': 1}"],
    );

    expect(diffSnapshots(before, after)).toEqual({
      // [1] is the same object, changed in place: it is reported where it is, not here.
      changed: [{ name: '[2]', before: '3', after: '4' }],
      added: [{ name: '[3]', after: "{'n': 1}" }],
      removed: [],
    });
    expect(diffSnapshots(after, before).removed).toEqual([{ name: '[3]', before: "{'n': 1}" }]);
  });

  it('says why it did not compare a set or a very big container', () => {
    expect(diffSnapshots(snapshot('set'), snapshot('set')).notCompared).toMatch(/a set/);
    expect(diffSnapshots(snapshot('big'), snapshot('big')).notCompared).toMatch(/20,000/);
  });

  it('names a path’s rows as Persisted Objects names them', () => {
    expect(stepNames(parseSteps("\u001dk0:orders\u001di2\u001dacustomer\u001dd3:'a'")!)).toEqual([
      'orders',
      '[2]',
      'customer',
      "'a'",
    ]);
  });
});

describe('reverting a change to what is committed', () => {
  const F = '\u001f';
  const R = '\u001e';
  const snapshot = (kind: string, ...entries: string[][]) =>
    parseSnapshot(`#${F}${kind}${R}` + entries.map((e) => e.join(F) + R).join(''));

  it('writes back only plain literals, never an object’s repr', () => {
    for (const ok of ['10', '-2.5', '1e+20', 'True', 'None', "'a b'", '"it\'s"', "b'x'", "'\\n'"]) {
      expect(isLiteral(ok)).toBe(true);
    }
    for (const no of ["Customer('Ann')", '__import__("os")', "'a' + 'b'", 'inf', '']) {
      expect(isLiteral(no)).toBe(false);
    }
  });

  it('sets an attribute back, puts a committed object back by number, and deletes an added one', () => {
    const before = snapshot('obj', ['total', 'v10', '10'], ['owner', 'o77', 'Customer']);
    const after = snapshot(
      'obj',
      ['total', 'v15', '15'],
      ['owner', 'o88', 'Customer'],
      ['note', "v'x'", "'x'"],
    );

    expect(revertPlan('obj', before, diffSnapshots(before, after))).toEqual({
      source: [
        'setattr(_gemdb_obj, "total", 10)',
        'setattr(_gemdb_obj, "owner", _gemdb_o77)',
        'delattr(_gemdb_obj, "note")',
        '"reverted"',
      ].join('\n'),
      oops: [77],
    });
    // One entry alone, as from its own row.
    expect(revertPlan('obj', before, diffSnapshots(before, after), 'total').source).toBe(
      'setattr(_gemdb_obj, "total", 10)\n"reverted"',
    );
  });

  it('puts a dict’s entries back by key and a whole list back item by item', () => {
    const dictBefore = snapshot('dict', ["'a'", 'v1', '1']);
    const dictAfter = snapshot('dict', ["'a'", 'v2', '2'], ["'b'", 'v3', '3']);
    expect(revertPlan('dict', dictBefore, diffSnapshots(dictBefore, dictAfter)).source).toBe(
      "_gemdb_obj['a'] = 1\ndel _gemdb_obj['b']\n\"reverted\"",
    );
    const listBefore = snapshot('seq', ['[0]', 'o5', '{}'], ['[1]', "v'x'", "'x'"]);
    const listAfter = snapshot(
      'seq',
      ['[0]', 'o5', '{}'],
      ['[1]', "v'y'", "'y'"],
      ['[2]', 'v3', '3'],
    );
    expect(revertPlan('seq', listBefore, diffSnapshots(listBefore, listAfter))).toEqual({
      source: '_gemdb_obj[:] = [_gemdb_o5, \'x\']\n"reverted"',
      oops: [5],
    });
  });

  it('refuses, saying why, what it cannot put back', () => {
    const long = snapshot('obj', ['text', 'h5000:123', "'…'"]);
    const now = snapshot('obj', ['text', "v'short'", "'short'"]);
    expect(() => revertPlan('obj', long, diffSnapshots(long, now))).toThrow(/too long/);
    const weird = snapshot('dict', ['Key(1)', 'v1', '1']);
    expect(() =>
      revertPlan('dict', weird, diffSnapshots(weird, snapshot('dict', ['Key(1)', 'v2', '2']))),
    ).toThrow(/not a plain value/);
    expect(() =>
      revertPlan('set', snapshot('set'), diffSnapshots(snapshot('set'), snapshot('set'))),
    ).toThrow(/a set/);
  });
});

describe('leaving out what reads exactly as committed', () => {
  const F = '\u001f';
  const R = '\u001e';
  const S = '\u001d';
  const change = (steps: string, oop: number, type: string, value: string) =>
    [steps, String(oop), value, type, '0', '0', '0', '1', '-1', '0', ''].join(F) + R;
  const snapshot = (kind: string, ...entries: string[][]) =>
    parseSnapshot(`#${F}${kind}${R}` + entries.map((e) => e.join(F) + R).join(''));
  const pending = parsePending(
    change(`${S}k0:a`, 1, 'dict', "{'total': 10}") +
      change(`${S}k1:b`, 2, 'dict', "{'total': 99}") +
      change(`${S}k2:c`, 3, 'set', '{1}') +
      change('!', 4, 'RcCollisionBucket', '[...]') +
      ['#', '4', '0', '0'].join(F) +
      R,
  );

  it('drops an object whose entries all match what is committed, and counts it', () => {
    const before = new Map([
      [1, snapshot('dict', ["'total'", 'v10', '10'])],
      [2, snapshot('dict', ["'total'", 'v10', '10'])],
      [3, snapshot('set')],
    ]);
    const after = new Map([
      // Reverted: the same value is back.
      [1, snapshot('dict', ["'total'", 'v10', '10'])],
      [2, snapshot('dict', ["'total'", 'v99', '99'])],
      [3, snapshot('set')],
    ]);

    const left = withoutUnchanged(pending, before, after);

    // A set is not compared entry by entry, and an internal object is not compared at all: both stay.
    expect(left.changes.map((c) => c.oop)).toEqual([2, 3, 4]);
    expect(left.unchanged).toBe(1);
    expect(pendingText(left, 'a.ipynb', (oop) => `link${oop}`)).toContain(
      '  + 1 written back unchanged (reverted, or set to what it already held): not listed',
    );
  });

  it('says nothing changes when every object was reverted', () => {
    const same = new Map([
      [1, snapshot('dict', ["'total'", 'v10', '10'])],
      [2, snapshot('dict', ["'total'", 'v99', '99'])],
    ]);
    const onlyTwo = { ...pending, changes: pending.changes.slice(0, 2) };

    expect(pendingText(withoutUnchanged(onlyTwo, same, same), 'a.ipynb', String)).toBe(
      'Nothing changes on commit: the 2 objects a.ipynb changed read as committed again — reverted, or set to what they already held.',
    );
  });
});

describe('dedented', () => {
  it("takes a pasted line's leading space off", () => {
    expect(dedented(' corner._fields')).toBe('corner._fields');
    expect(dedented('\tx + 1')).toBe('x + 1');
  });

  it("keeps a block's own shape, taking off only what every line shares", () => {
    expect(dedented('    for i in range(3):\n        print(i)')).toBe(
      'for i in range(3):\n    print(i)',
    );
    expect(dedented('  a = 1\n\n  b = 2')).toBe('a = 1\n\nb = 2');
  });

  it('leaves unindented text as it is', () => {
    expect(dedented('x = 1\n  y')).toBe('x = 1\n  y');
  });
});
