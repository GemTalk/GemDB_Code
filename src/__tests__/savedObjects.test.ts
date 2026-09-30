import { describe, expect, it, vi } from 'vitest';

/**
 * Saving from the debugger, without a database: what key is suggested, what
 * the user is told, and how the Saved Objects view arranges its rows. That a
 * save really lands in gemdb.root and survives a commit is
 * `breakpoint.test.ts`'s job.
 */

vi.mock('../session', () => ({}));
vi.mock('../processes', () => ({}));

const { accessCode, inspectMarkdown, savedNotice, settlePending, suggestKey, topRows } =
  await import('../savedObjects');

describe('suggesting a key for a saved object', () => {
  it('names an object by its type and what identifies it', () => {
    expect(suggestKey({ name: 'self', type: 'Employee', label: 'Barbara' })).toBe(
      'employee_barbara',
    );
  });

  it('makes a key Python-friendly: lower case, no spaces or punctuation', () => {
    expect(suggestKey({ name: 'r', type: 'Order', label: 'A-1042 (rush)' })).toBe(
      'order_a_1042_rush',
    );
  });

  it('uses a variable’s name when the object has nothing identifying and the name says something', () => {
    expect(suggestKey({ name: 'orders', type: 'list' })).toBe('orders');
    expect(suggestKey({ name: "'config'", type: 'dict' })).toBe('config');
  });

  it('falls back to the type for a name that says nothing', () => {
    expect(suggestKey({ name: 'self', type: 'Employee' })).toBe('employee');
    expect(suggestKey({ name: 'x', type: 'int' })).toBe('int');
    expect(suggestKey({ name: '[3]', type: 'tuple' })).toBe('tuple');
  });

  it('keeps a key short enough to type', () => {
    const key = suggestKey({ name: 'e', type: 'Employee', label: 'x'.repeat(100) });

    expect(key.length).toBeLessThanOrEqual(40);
    expect(key.endsWith('_')).toBe(false);
  });

  it('never suggests an empty key', () => {
    expect(suggestKey({ name: '[0]', type: '' })).toBe('saved');
  });
});

describe('telling the user where a saved object went', () => {
  it('names the key, when it is written, and the Python that reads it', () => {
    const notice = savedNotice('employee_barbara', 'breakpoint.ipynb');

    expect(notice).toContain('gemdb.root["employee_barbara"]');
    expect(notice).toMatch(/breakpoint\.ipynb's next commit writes it/);
    expect(notice).toMatch(/along with the notebook's other changes/);
  });

  it('quotes a key the way Python needs it', () => {
    expect(accessCode('it\'s "odd"')).toBe('gemdb.root["it\'s \\"odd\\""]');
  });
});

describe('the Saved Objects view', () => {
  const nb = (key: string, dirty: boolean | undefined) => ({ key, label: `${key}.ipynb`, dirty });
  const save = (key: string, ownerKey: string) => ({ key, type: 'Employee', ownerKey });

  it('asks for the database to be started when it is not running', () => {
    expect(topRows(false, [], [], [])).toEqual([
      { kind: 'message', text: 'Start GemDB to see saved objects.' },
    ]);
  });

  it('lists a notebook only while it holds saves not yet committed, then gemdb.root', () => {
    const entries = [{ key: 'ceo', type: 'Employee', value: '<Employee>' }];

    const rows = topRows(
      true,
      [nb('a', true), nb('b', true)],
      [save('barbara', 'a'), save('grace', 'a')],
      entries,
    );

    // b has uncommitted changes of its own, but nothing saved from the debugger.
    expect(rows.map((r) => r.kind)).toEqual(['notebook', 'root']);
    expect(rows[0]).toMatchObject({
      notebook: { key: 'a' },
      saves: [{ key: 'barbara' }, { key: 'grace' }],
    });
    expect(rows[1]).toEqual({ kind: 'root', entries });
  });

  it('says why gemdb.root could not be read, rather than showing it empty', () => {
    const rows = topRows(true, [], [], 'Could not read gemdb.root: busy');

    expect(rows).toEqual([{ kind: 'message', text: 'Could not read gemdb.root: busy' }]);
  });

  it('drops a pending save once its notebook has nothing left to commit', () => {
    const pending = [save('committed', 'a'), save('waiting', 'b'), save('running', 'c')];

    const kept = settlePending(pending, [nb('a', false), nb('b', true), nb('c', undefined)]);

    // A notebook running a cell cannot be asked, so its saves wait.
    expect(kept.map((s) => s.key)).toEqual(['waiting', 'running']);
  });

  it('drops a pending save whose notebook has closed its session', () => {
    expect(settlePending([save('lost', 'gone')], [])).toEqual([]);
  });
});

describe('inspecting a saved object on hover', () => {
  const row = (name: string, value: string, type = 'str', indexed = 0, named = 0) => ({
    name,
    value,
    type,
    ref: 0,
    indexed,
    named,
    handle: 1,
  });

  it('shows the type, the text, and the first children with their values aligned', () => {
    const markdown = inspectMarkdown(
      'employee_barbara',
      true,
      row('value', '<Employee object at 0x55ec8>', 'Employee', 0, 2),
      [row('name', "'Barbara'"), row('reports', 'list with 3 items', 'list')],
    );

    expect(markdown).toContain('**employee_barbara** · `Employee` · committed');
    expect(markdown).toContain('<Employee object at 0x55ec8>');
    expect(markdown).toContain("name     'Barbara'");
    expect(markdown).toContain('reports  list with 3 items');
    expect(markdown).toContain('gemdb.root["employee_barbara"]');
    expect(markdown).not.toMatch(/Only this notebook/);
  });

  it('says how many children the hover left out', () => {
    const children = Array.from({ length: 12 }, (_, i) => row(`[${i}]`, String(i), 'int'));

    const markdown = inspectMarkdown(
      'rows',
      true,
      row('value', 'list with 40 items', 'list', 40),
      children,
    );

    expect(markdown).toContain('… 28 more');
  });

  it('warns that an uncommitted object is this notebook’s alone, and commits with it', () => {
    const markdown = inspectMarkdown('draft', false, row('value', '1', 'int'), []);

    expect(markdown).toContain('saved, not committed yet');
    expect(markdown).toMatch(/Only this notebook sees it until it commits/);
  });

  it('keeps a value with line breaks or backticks from breaking the hover', () => {
    const markdown = inspectMarkdown('odd', true, row('value', 'a\n````\nb'), []);

    expect(markdown.split('````').length).toBe(3);
  });
});
