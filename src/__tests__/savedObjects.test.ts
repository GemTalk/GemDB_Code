import { describe, expect, it, vi } from 'vitest';

/**
 * Saving from the debugger, without a database: what key is suggested, what
 * the user is told, and how the Persisted Objects view arranges its rows. That a
 * save really lands in gemdb.root and survives a commit is
 * `breakpoint.test.ts`'s job.
 */

vi.mock('../session', () => ({}));
vi.mock('../processes', () => ({}));

const {
  EMPTY_GUIDE,
  ROOT_GUIDE,
  VIEW_DESCRIPTION,
  accessCode,
  chooseNotebook,
  originOf,
  settleOrigins,
  notebookGuide,
  plainGuide,
  inspectMarkdown,
  keyList,
  savedNotice,
  settlePending,
  suggestKey,
  topRows,
} = await import('../savedObjects');

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

    expect(notice).toContain('Added to Persisted Objects as gemdb.root["employee_barbara"]');
    expect(notice).toMatch(/It persists when breakpoint\.ipynb commits/);
    expect(notice).toMatch(/along with the notebook's other changes/);
  });

  it('quotes a key the way Python needs it', () => {
    expect(accessCode('it\'s "odd"')).toBe('gemdb.root["it\'s \\"odd\\""]');
  });
});

describe('the Persisted Objects view', () => {
  const nb = (key: string, dirty: boolean | undefined) => ({ key, label: `${key}.ipynb`, dirty });
  const save = (key: string, ownerKey: string) => ({
    key,
    type: 'Employee',
    ownerKey,
    notebook: `${ownerKey}.ipynb`,
    at: '2026-10-01T16:20:00.000Z',
  });

  it('asks for the database to be started when it is not running', () => {
    expect(topRows(false, [], [], [])).toEqual([
      { kind: 'message', text: 'Start GemDB to see persisted objects.' },
    ]);
  });

  it('lists gemdb.root first, then a notebook only while it holds additions not yet committed', () => {
    const entries = [{ key: 'ceo', type: 'Employee', value: '<Employee>' }];

    const rows = topRows(
      true,
      [nb('a', true), nb('b', true)],
      [save('barbara', 'a'), save('grace', 'a')],
      entries,
    );

    // gemdb.root first; b has uncommitted changes of its own, but nothing added from the debugger.
    expect(rows.map((r) => r.kind)).toEqual(['root', 'notebook']);
    expect(rows[0]).toEqual({ kind: 'root', entries });
    expect(rows[1]).toMatchObject({
      notebook: { key: 'a' },
      saves: [{ key: 'barbara' }, { key: 'grace' }],
    });
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

    expect(markdown).toContain('**employee_barbara** · `Employee` · persisted');
    expect(markdown).toContain('<Employee object at 0x55ec8>');
    expect(markdown).toContain("name     'Barbara'");
    expect(markdown).toContain('reports  list with 3 items');
    expect(markdown).toContain('gemdb.root["employee_barbara"]');
    expect(markdown).toMatch(/Remove\*\* deletes it and commits the removal at once/);
    expect(markdown).not.toMatch(/only this notebook sees it/);
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

    expect(markdown).toContain('added, not persisted yet');
    expect(markdown).toMatch(/only this notebook sees it\. \*\*Commit\*\* persists it/);
    expect(markdown).toMatch(/Remove\*\* takes it back/);
  });

  it('keeps a value with line breaks or backticks from breaking the hover', () => {
    const markdown = inspectMarkdown('odd', true, row('value', 'a\n````\nb'), []);

    expect(markdown.split('````').length).toBe(3);
  });
});

describe('choosing the notebook the title bar’s Commit and Abort act on', () => {
  const owner = (key: string) => ({ key, kind: 'notebook' as const, label: `${key}.ipynb` });
  const a = owner('a');
  const b = owner('b');

  it('acts on the notebook paused at breakpoint(), where the user is looking', () => {
    expect(chooseNotebook([a, b], 'b', 'a')).toBe(b);
  });

  it('acts on the notebook in the active editor when none is paused', () => {
    expect(chooseNotebook([a, b], undefined, 'a')).toBe(a);
  });

  it('acts on the only connected notebook, wherever the editor is', () => {
    expect(chooseNotebook([a], undefined, 'elsewhere')).toBe(a);
  });

  it('leaves the choice to the user when it cannot tell', () => {
    expect(chooseNotebook([a, b], undefined, undefined)).toBeUndefined();
  });
});

describe('explaining Persisted Objects to someone new', () => {
  it('says, when empty, that persisting is adding and then committing', () => {
    expect(EMPTY_GUIDE).toMatch(/two steps: add .* and then commit/s);
    expect(EMPTY_GUIDE).toContain('Adding alone does not persist it.');
    expect(EMPTY_GUIDE).toContain('Add to Persisted Objects…');
    expect(EMPTY_GUIDE).toContain('gemdb.root["name"] = value');
  });

  it('opens the gemdb.root guide with the commit, before describing the list', () => {
    const [first] = ROOT_GUIDE.split('\n\n');

    expect(first).toBe('**Persisting takes two steps: add, then commit.**');
    expect(ROOT_GUIDE.indexOf('This alone does not persist it')).toBeLessThan(
      ROOT_GUIDE.indexOf('already committed'),
    );
  });

  it('says where to right-click: the Variables in Run and Debug', () => {
    expect(ROOT_GUIDE).toMatch(
      /\*\*Run and Debug\*\* pane opens; right-click a variable in its \*\*Variables\*\*/,
    );
    expect(EMPTY_GUIDE).toMatch(/right-click a variable in the Run and Debug pane’s Variables/);
  });

  it('puts the rule beside the view’s name, where no hover is needed', () => {
    expect(VIEW_DESCRIPTION).toBe('add, then commit');
  });

  it('gives the help dialog the whole guide without Markdown marks', () => {
    const plain = plainGuide();

    expect(plain).toMatch(/^Persisting takes two steps: add, then commit\./);
    expect(plain).not.toMatch(/[*`]/);
  });

  it('explains removing as the same two steps', () => {
    expect(ROOT_GUIDE).toMatch(/\*\*Removing\*\* takes the same two steps: delete, then commit/);
    expect(ROOT_GUIDE).toContain('del gemdb.root["name"]');
  });

  it('says on a notebook what Commit and Abort do to what it added', () => {
    const guide = notebookGuide('breakpoint.ipynb');

    expect(guide).toMatch(/\*\*Commit\*\* \(✓\) persists/);
    expect(guide).toMatch(/\*\*Abort\*\* \(↺\)\s+discards/);
    expect(guide).toContain('Remove from Persisted Objects');
  });
});

describe('remembering where a persisted object came from', () => {
  const save = (key: string, ownerKey = 'nb') => ({
    key,
    type: 'Employee',
    ownerKey,
    notebook: 'breakpoint.ipynb',
    at: '2026-10-01T16:20:00.000Z',
  });

  it('keeps the notebook as the origin of an addition that was committed', () => {
    const origins = settleOrigins([save('barbara')], [], new Set(['barbara']), {});

    expect(origins).toEqual({
      barbara: { notebook: 'breakpoint.ipynb', type: 'Employee', at: '2026-10-01T16:20:00.000Z' },
    });
  });

  it('records nothing for an addition that was aborted, or that is still waiting', () => {
    const aborted = settleOrigins([save('gone')], [], new Set(), {});
    const waiting = settleOrigins([save('later')], [save('later')], new Set(['later']), {});

    expect(aborted).toEqual({});
    expect(waiting).toEqual({});
  });

  it('forgets an origin once its key is no longer in gemdb.root', () => {
    const kept = { notebook: 'a.ipynb', type: 'E', at: 'x' };

    const origins = settleOrigins([], [], new Set(['still']), { still: kept, removed: kept });

    expect(Object.keys(origins)).toEqual(['still']);
  });

  it('does not credit a notebook for an entry other code has since replaced', () => {
    const origins = { k: { notebook: 'a.ipynb', type: 'Employee', at: 'x' } };

    expect(originOf({ key: 'k', type: 'Employee', value: '' }, origins)?.notebook).toBe('a.ipynb');
    expect(originOf({ key: 'k', type: 'str', value: "'x'" }, origins)).toBeUndefined();
  });

  it('says in the hover where and when it was added', () => {
    const markdown = inspectMarkdown(
      'barbara',
      true,
      { name: 'value', value: '<E>', type: 'Employee', ref: 0, indexed: 0, named: 0, handle: 1 },
      [],
      { notebook: 'breakpoint.ipynb', type: 'Employee', at: '2026-10-01T16:20:00.000Z' },
    );

    expect(markdown).toMatch(/Added from \*\*breakpoint\.ipynb\*\* on 2026-10-01 \d\d:\d\d\./);
  });
});

describe('naming several objects at once', () => {
  it('lists every key when there are a few', () => {
    expect(keyList(['a', 'b', 'c'])).toBe('a, b, c');
  });

  it('names the first few and counts the rest', () => {
    const keys = Array.from({ length: 11 }, (_, i) => `k${i}`);

    expect(keyList(keys)).toBe('k0, k1, k2, k3, k4, k5, k6, k7 and 3 more');
  });
});
