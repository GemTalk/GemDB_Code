import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __clipboard,
  __commands,
  __treeViews,
  MarkdownString,
  TreeItem,
  window,
} from '../__mocks__/vscode';
import type { Pause } from '../debugger';
import type { SavedRow } from '../savedObjects';

/**
 * The Persisted Objects view and its commands, driven the way VS Code drives
 * them — through the registered commands and the tree provider — against a
 * small fake of the database that answers the same queries the real one does:
 * additions wait in their notebook's transaction, a commit moves them into
 * gemdb.root, an abort drops them. That the queries themselves do this on a
 * real database is `breakpoint.test.ts`'s job.
 */

const F = '\u001f';
const R = '\u001e';
const row = (...fields: Array<string | number>): string => fields.join(F) + R;

const NB = 'file:///breakpoint.ipynb';
const OTHER = 'file:///other.ipynb';

/** gemdb.root as the database holds it: what is committed, and each notebook's additions. */
class FakeGem {
  committed = new Map<string, string>();
  pending = new Map<string, Map<string, string>>();
  queries: Array<{ session: string; code: string }> = [];

  private additions(session: string): Map<string, string> {
    let map = this.pending.get(session);
    if (!map) this.pending.set(session, (map = new Map()));
    return map;
  }

  private keysIn(code: string): string[] {
    const list = /for _key in \[(.*?)\]:/.exec(code)?.[1] ?? '';
    return JSON.parse(`[${list}]`) as string[];
  }

  /** Committed saved stacks, by key: what the snapshot answers when opened. */
  stacks = new Map<string, string>();

  /**
   * Objects that open, as the Persisted Objects registry holds them: an
   * entry's key (or a field's name) to its position there, and each
   * position's children, as `childrenQuery` answers them.
   */
  refs = new Map<string, number>();
  fields = new Map<number, string>();
  /** Containers of this many items, by registry position, answered a page at a time as asked. */
  lists = new Map<number, number>();
  /** Which of `lists` are dicts, keyed `'k0'`, `'k1'`, … rather than lists. */
  dicts = new Set<number>();

  /** An entry's row as a listing writes it: with a registry position when it opens. */
  private entryRow(key: string, type: string): string {
    const ref = this.refs.get(key) ?? 0;
    const items = this.lists.get(ref);
    if (items !== undefined) {
      const kind = this.dicts.has(ref) ? 'dict' : 'seq';
      return row(key, `<${type}>`, type, ref, items, 0, 1, items, 0, kind);
    }
    return row(key, `<${type}>`, type, ref, 0, ref ? 2 : 0, 1);
  }

  run(session: string, code: string): string {
    this.queries.push({ session, code });
    const additions = this.additions(session);
    if (code.includes('v.get("kind") == "gemdb.stack"')) {
      return JSON.stringify(
        [...this.stacks.keys()].map((key) => ({
          key,
          label: 'breakpoint.ipynb',
          saved_at: '2026-10-01 16:20',
          frames: 1,
        })),
      );
    }
    const openStack = /_s = gemdb\.root\["([^"]+)"\]/.exec(code);
    if (openStack) return this.stacks.get(openStack[1]) ?? 'Error: KeyError - ' + openStack[1];
    const slice = /list\(gemdb\.root\.items\(\)\)\[(\d+):(\d+)\]/.exec(code);
    if (slice) {
      return [...this.committed]
        .slice(Number(slice[1]), Number(slice[2]))
        .map(([key, type]) => this.entryRow(key, type))
        .join('');
    }
    if (code.includes('len(gemdb.root)')) return String(this.committed.size);
    const opened =
      /GemDbPersistedRefs' otherwise: nil\.\nobj := \(reg notNil and: \[(\d+) between/.exec(code);
    if (code.includes('want := #(')) {
      const ref = Number(/reg notNil and: \[(\d+) between/.exec(code)![1]);
      const names = [...code.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
      const total = this.lists.get(ref) ?? 0;
      const at = Array.from({ length: total }, (_, i) => `'k${i}'`).findIndex((n) =>
        names.includes(n),
      );
      return String(this.dicts.has(ref) ? at : -1);
    }
    if (opened) {
      const total = this.lists.get(Number(opened[1]));
      if (total === undefined) return this.fields.get(Number(opened[1])) ?? '';
      const start = Number(/start := (\d+)\./.exec(code)![1]);
      const count = Number(/count := (\d+)\./.exec(code)![1]);
      return Array.from({ length: Math.max(0, Math.min(start + count, total) - start) }, (_, i) =>
        row(
          this.dicts.has(Number(opened[1])) ? `'k${start + i}'` : `[${start + i}]`,
          String(start + i),
          'int',
          0,
          0,
          0,
          1,
          -1,
          0,
        ),
      ).join('');
    }
    const keys = /for _k in \[(.*?)\] if _k in gemdb\.root/.exec(code);
    if (keys) {
      return (JSON.parse(`[${keys[1]}]`) as string[])
        .filter((key) => additions.has(key))
        .map((key) => this.entryRow(key, additions.get(key)!))
        .join('');
    }
    if (code.includes('System needsCommit')) return additions.size > 0 ? 'true' : 'false';
    if (code.includes('count := 12.')) {
      return (
        row('value', '<Employee>', 'Employee', 0, 0, 1, 1) +
        row('name', "'Barbara'", 'str', 0, 0, 0, 2)
      );
    }
    if (code.includes('#(#name #id')) return `Employee${F}Barbara`;
    if (code.includes('_base = ')) {
      const base = /_base = "([^"]+)"/.exec(code)![1];
      const taken = (k: string) => this.committed.has(k) || additions.has(k);
      let key = base;
      for (let n = 2; taken(key); n++) key = `${base}_${n}`;
      return `'${key}'`;
    }
    const stack = /___gemdb_m\.root\["([^"]+)"\] = \{/.exec(code);
    if (stack) {
      additions.set(stack[1], 'dict');
      return 'saved';
    }
    const saved = /gemdb\.root\["([^"]+)"\] = _gemdb_value/.exec(code);
    if (saved) {
      additions.set(saved[1], 'Employee');
      return "'saved'";
    }
    if (code.includes('if _key in gemdb.root')) {
      for (const key of this.keysIn(code)) additions.delete(key);
      return "'removed'";
    }
    if (code.includes('del gemdb.root[_key]')) {
      for (const key of this.keysIn(code)) this.committed.delete(key);
      return "'removed'";
    }
    if (
      code.includes('gemdb.commit()\n"committed"') ||
      code.includes('gemdb.commit()\\n"committed"')
    ) {
      for (const [key, type] of additions) this.committed.set(key, type);
      additions.clear();
      return "'committed'";
    }
    if (code.includes('"aborted"')) {
      additions.clear();
      return "'aborted'";
    }
    if (code.includes("System abortTransaction. 'aborted'")) {
      additions.clear();
      return 'aborted';
    }
    const taken = /"([^"]+)" in gemdb\.root/.exec(code);
    if (taken) return this.committed.has(taken[1]) || additions.has(taken[1]) ? 'true' : 'false';
    throw new Error(`the fake gem does not answer: ${code.slice(0, 80)}`);
  }
}

let gem: FakeGem;
/** The sessions closed, by owner key. */
const closedSessions: string[] = [];
let running = true;
const connected: Array<{ key: string; label: string }> = [];
const paused = new Map<string, Pause>();

vi.mock('../session', () => ({
  executeAsync: (code: string) => Promise.resolve(gem.run('extension', code)),
  sessionRegistry: () =>
    connected.map((owner) => ({
      owner: { ...owner, kind: 'notebook' },
      serial: 1,
      openedAt: 0,
      idleMs: 0,
    })),
  PAUSED_QUERY_BUDGET_MS: 2000,
  interruptSessionFor: () => {},
  // A saved stack opened in the debugger works in a session of its own.
  sessionFor: (owner: { key: string }) => ({
    executeAsync: (code: string) => Promise.resolve(gem.run(owner.key, code)),
  }),
  closeSessionFor: (key: string) => closedSessions.push(key),
  sessionForIfOpen: (key: string) =>
    connected.some((o) => o.key === key)
      ? { executeAsync: (code: string) => Promise.resolve(gem.run(key, code)) }
      : undefined,
}));
vi.mock('../processes', () => ({ isRunning: () => running, listProcesses: () => [] }));
const opened: Pause[] = [];
vi.mock('../debugger', () => ({
  pauseForDebugSession: (id: string | undefined) => (id === 'debug-1' ? paused.get(NB) : undefined),
  pauseForOwner: (key: string) => paused.get(key),
  openPause: (pause: Pause) => {
    opened.push(pause);
    return Promise.resolve(true);
  },
  openCellTexts: () => [],
  rowHandles: () => ({ remember: () => {}, handleFor: () => undefined }),
  debugConsole: () => ({ evaluate: () => Promise.reject(new Error('not in these tests')) }),
  toDapVariable: (v: { name: string; value: string; ref: number }) => ({
    name: v.name,
    value: v.value,
    variablesReference: v.ref,
  }),
  scopesFor: (locals: number, globals: number) => [
    ...(locals ? [{ name: 'Locals', variablesReference: locals, expensive: false }] : []),
    ...(globals ? [{ name: 'Globals', variablesReference: globals, expensive: false }] : []),
  ],
}));

const { DEBUG_VIEW_ID, EMPTY_GUIDE, VIEW_DESCRIPTION, VIEW_ID, registerSavedObjects } =
  await import('../savedObjects');

/** A notebook paused at breakpoint(), whose queries run in its own session. */
function pauseIn(key: string): Pause {
  const pause: Pause = {
    label: 'breakpoint.ipynb',
    ownerKey: key,
    frames: [],
    scopes: () => [],
    variables: () => Promise.resolve([]),
    answer: () => {},
    handleFor: (_container, name) => (name === 'depth' ? 7 : undefined),
    query: (code) => Promise.resolve(gem.run(key, code)),
  };
  paused.set(key, pause);
  return pause;
}

function memento() {
  const values = new Map<string, unknown>();
  return {
    values,
    get: <T>(key: string): T | undefined => values.get(key) as T | undefined,
    update: (key: string, value: unknown) => {
      values.set(key, value);
      return Promise.resolve();
    },
  };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function setUp() {
  const store = memento();
  const view = registerSavedObjects({
    subscriptions: [],
    globalState: store,
  } as unknown as Parameters<typeof registerSavedObjects>[0]);
  return { view, store };
}

/** The view's top rows once read, as VS Code would see them after its refresh. */
async function topOf(view: ReturnType<typeof setUp>['view']): Promise<SavedRow[]> {
  view.refresh();
  view.getChildren();
  for (let i = 0; i < 20; i++) {
    await settle();
    const rows = view.getChildren();
    if (!(rows.length === 1 && rows[0].kind === 'message' && rows[0].text.startsWith('Reading'))) {
      return rows;
    }
  }
  throw new Error('the view never finished reading');
}

const item = (view: ReturnType<typeof setUp>['view'], r: SavedRow) =>
  view.getTreeItem(r) as unknown as TreeItem;

const command = (id: string) => __commands.get(id)!;

/** A Variables row's context, as VS Code hands it to a menu command. */
const variable = (name: string, variablesReference: number) => ({
  sessionId: 'debug-1',
  container: { variablesReference: 3 },
  variable: { name, value: '<Employee>', variablesReference },
});

beforeEach(() => {
  gem = new FakeGem();
  running = true;
  connected.length = 0;
  paused.clear();
  __treeViews.clear();
  __clipboard.text = '';
  vi.restoreAllMocks();
});

describe('the Persisted Objects view', () => {
  it('appears in the GemDB sidebar and in Run and Debug, many rows selectable at once', () => {
    setUp();

    expect([...__treeViews.keys()]).toEqual([VIEW_ID, DEBUG_VIEW_ID]);
    for (const view of __treeViews.values()) {
      expect(view.options).toMatchObject({ canSelectMany: true });
      expect(view.description).toBe(VIEW_DESCRIPTION);
    }
  });

  it('asks for the database to be started when it is not running', async () => {
    running = false;
    const { view } = setUp();

    const rows = await topOf(view);

    expect(rows).toEqual([{ kind: 'message', text: 'Start GemDB to see persisted objects.' }]);
  });

  it('explains, in its body, how to persist something when nothing is', async () => {
    const { view } = setUp();

    await topOf(view);

    expect(__treeViews.get(VIEW_ID)!.message).toBe(EMPTY_GUIDE);
  });

  it('lists what is committed under gemdb.root first, each with a check mark', async () => {
    gem.committed.set('ceo', 'Employee');
    const { view } = setUp();

    const [root] = await topOf(view);
    const entries = await view.getChildren(root);

    expect(item(view, root)).toMatchObject({
      label: 'gemdb.root',
      description: 'persisted · 1 object',
    });
    expect((item(view, root).tooltip as MarkdownString).value).toMatch(
      /^\*\*Persisting takes two steps/,
    );
    expect(entries.map((e) => item(view, e).label)).toEqual(['ceo']);
    expect(item(view, entries[0])).toMatchObject({
      description: 'Employee = <Employee>',
      contextValue: 'gemdbSavedObject',
    });
    expect(__treeViews.get(VIEW_ID)!.message).toBeUndefined();
  });
});

describe('adding an object from the debugger', () => {
  it('suggests a key, adds it without committing, and shows it waiting under its notebook', async () => {
    pauseIn(NB);
    connected.push({ key: NB, label: 'breakpoint.ipynb' });
    const { view } = setUp();
    const asked = vi
      .spyOn(window, 'showInputBox')
      .mockImplementation((options) => Promise.resolve((options as { value: string }).value));

    await command('gemdb.saveVariable')(variable('self', 5));
    await settle();
    const rows = await topOf(view);

    expect(asked.mock.calls[0][0]).toMatchObject({
      title: 'Add self to Persisted Objects',
      value: 'employee_barbara',
    });
    expect(gem.committed.size).toBe(0);
    const notebook = rows.find((r) => r.kind === 'notebook')!;
    const [waiting] = await view.getChildren(notebook);
    expect(item(view, waiting)).toMatchObject({
      label: 'employee_barbara',
      description: 'Employee · added, not persisted yet',
      contextValue: 'gemdbSavedPending',
    });
    expect((item(view, notebook).tooltip as MarkdownString).value).toMatch(
      /\*\*Commit\*\* \(✓\) persists/,
    );
  });

  it('shows a %persist from the Debug Console as waiting under its notebook, and reveals it', async () => {
    pauseIn(NB);
    connected.push({ key: NB, label: 'breakpoint.ipynb' });
    const { view } = setUp();
    // What %persist p did in the paused session, before telling the view.
    gem.pending.set(NB, new Map([['p', 'list']]));

    await command('gemdb.savedObjects.notePersisted')({
      key: 'p',
      type: 'list',
      ownerKey: NB,
      notebook: 'breakpoint.ipynb',
    });
    await vi.waitFor(() => expect(__treeViews.get(DEBUG_VIEW_ID)!.reveals).toHaveLength(1));
    const rows = await topOf(view);

    const notebook = rows.find((r) => r.kind === 'notebook')!;
    const [waiting] = await view.getChildren(notebook);
    expect(item(view, waiting)).toMatchObject({
      label: 'p',
      description: 'list · added, not persisted yet',
      contextValue: 'gemdbSavedPending',
    });
    expect(__treeViews.get(DEBUG_VIEW_ID)!.reveals[0].element).toMatchObject({
      kind: 'pending',
      save: { key: 'p' },
    });
  });

  it('opens Persisted Objects in Run and Debug on the new row, leaving focus in Variables', async () => {
    pauseIn(NB);
    connected.push({ key: NB, label: 'breakpoint.ipynb' });
    setUp();
    vi.spyOn(window, 'showInputBox').mockResolvedValue('kept');

    await command('gemdb.saveVariable')(variable('self', 5));
    await vi.waitFor(() => expect(__treeViews.get(DEBUG_VIEW_ID)!.reveals).toHaveLength(1));

    const [reveal] = __treeViews.get(DEBUG_VIEW_ID)!.reveals;
    expect(reveal.options).toEqual({ select: true, focus: false, expand: true });
    expect(reveal.element).toMatchObject({ kind: 'pending', save: { key: 'kept' } });
  });

  it('steps the suggested key past one already in use', async () => {
    pauseIn(NB);
    gem.committed.set('employee_barbara', 'Employee');
    setUp();
    const asked = vi.spyOn(window, 'showInputBox').mockResolvedValue(undefined);

    await command('gemdb.saveVariable')(variable('self', 5));

    expect(asked.mock.calls[0][0]).toMatchObject({ value: 'employee_barbara_2' });
  });

  it('warns while typing a key that would replace one, and refuses an empty key', async () => {
    pauseIn(NB);
    gem.committed.set('taken', 'Employee');
    setUp();
    let validate: ((text: string) => Promise<unknown>) | undefined;
    vi.spyOn(window, 'showInputBox').mockImplementation((options) => {
      validate = (options as { validateInput: (t: string) => Promise<unknown> }).validateInput;
      return Promise.resolve(undefined);
    });

    await command('gemdb.saveVariable')(variable('self', 5));

    expect(await validate!('')).toBe('Enter a key.');
    expect(await validate!('taken')).toMatchObject({
      message: expect.stringMatching(/replaces it/),
    });
    expect(await validate!('fresh')).toBeUndefined();
  });

  it('adds a plain value, which has no children, by its row’s handle', async () => {
    pauseIn(NB);
    setUp();
    vi.spyOn(window, 'showInputBox').mockResolvedValue('depth');

    await command('gemdb.saveVariable')(variable('depth', 0));

    const save = gem.queries.find((q) => q.code.includes('= _gemdb_value'))!;
    expect(save.code).toContain('7 between: 1 and: reg size');
    expect(gem.pending.get(NB)!.has('depth')).toBe(true);
  });

  it('says where it went and copies the Python that reads it back', async () => {
    pauseIn(NB);
    setUp();
    vi.spyOn(window, 'showInputBox').mockResolvedValue('employee_barbara');
    const told = vi.spyOn(window, 'showInformationMessage').mockResolvedValue('Copy Code' as never);

    await command('gemdb.saveVariable')(variable('self', 5));

    expect(told.mock.calls[0][0]).toMatch(
      /^Added to Persisted Objects as gemdb\.root\["employee_barbara"\]/,
    );
    expect(__clipboard.text).toBe('import gemdb\n\nsaved = gemdb.root["employee_barbara"]\n');
  });

  it('adds nothing when the user escapes the key box', async () => {
    pauseIn(NB);
    setUp();
    vi.spyOn(window, 'showInputBox').mockResolvedValue(undefined);

    await command('gemdb.saveVariable')(variable('self', 5));

    expect(gem.pending.get(NB)?.size ?? 0).toBe(0);
  });

  it('says it needs a paused cell or file run when there is none', async () => {
    setUp();
    const shown = vi.spyOn(window, 'showErrorMessage');

    await command('gemdb.saveVariable')(variable('self', 5));

    expect(shown.mock.calls[0][0]).toMatch(/notebook cell or Debug Python File run is paused/);
  });
});

describe('committing and aborting', () => {
  async function withOneAddition() {
    pauseIn(NB);
    connected.push({ key: NB, label: 'breakpoint.ipynb' });
    const setup = setUp();
    vi.spyOn(window, 'showInputBox').mockResolvedValue('employee_barbara');
    await command('gemdb.saveVariable')(variable('self', 5));
    return setup;
  }

  it('commits from the title bar the notebook that is paused, moving its additions into gemdb.root', async () => {
    const { view } = await withOneAddition();
    const told = vi.spyOn(window, 'showInformationMessage');

    await command('gemdb.savedObjects.commitNotebook')();
    const rows = await topOf(view);

    expect(gem.queries.some((q) => q.session === NB && q.code.includes('"committed"'))).toBe(true);
    expect(told).toHaveBeenCalledWith('Committed breakpoint.ipynb.');
    expect(rows.map((r) => r.kind)).toEqual(['root']);
    expect((await view.getChildren(rows[0])).map((e) => item(view, e).label)).toEqual([
      'employee_barbara',
    ]);
  });

  it('keeps the notebook an addition came from once it is committed, across a restart', async () => {
    const { view, store } = await withOneAddition();
    await topOf(view);

    await command('gemdb.savedObjects.commitNotebook')();
    const [root] = await topOf(view);

    const [entry] = await view.getChildren(root);
    expect(item(view, entry).description).toBe('from breakpoint.ipynb · Employee = <Employee>');
    expect(store.values.get('gemdb.persistedObjectOrigins')).toMatchObject({
      employee_barbara: { notebook: 'breakpoint.ipynb', type: 'Employee' },
    });
  });

  it('aborts only after the user confirms, and the addition is gone', async () => {
    const { view } = await withOneAddition();
    const warned = vi
      .spyOn(window, 'showWarningMessage')
      .mockResolvedValueOnce(undefined as never)
      .mockResolvedValueOnce('Discard Changes' as never);

    await command('gemdb.savedObjects.abortNotebook')();
    const afterCancel = gem.pending.get(NB)!.size;
    await command('gemdb.savedObjects.abortNotebook')();
    const rows = await topOf(view);

    expect(afterCancel).toBe(1);
    expect(warned.mock.calls[0][0]).toMatch(/including 1 added object/);
    expect(gem.pending.get(NB)!.size).toBe(0);
    expect(rows.map((r) => r.kind)).toEqual(['root']);
  });

  it('says to run a cell first when no notebook is connected', async () => {
    setUp();
    const told = vi.spyOn(window, 'showInformationMessage');

    await command('gemdb.savedObjects.commitNotebook')();

    expect(told.mock.calls[0][0]).toMatch(/No notebook is connected to GemDB yet/);
    expect(gem.queries).toEqual([]);
  });

  it('asks which notebook when it cannot tell, and commits the one picked', async () => {
    connected.push({ key: NB, label: 'breakpoint.ipynb' }, { key: OTHER, label: 'other.ipynb' });
    setUp();
    vi.spyOn(window, 'showQuickPick').mockImplementation((items) =>
      Promise.resolve((items as Array<{ label: string }>).find((i) => i.label === 'other.ipynb')),
    );

    await command('gemdb.savedObjects.commitNotebook')();

    expect(gem.queries.map((q) => q.session)).toEqual([OTHER]);
  });

  it('commits from an added object’s row the notebook it waits in', async () => {
    const { view } = await withOneAddition();
    const rows = await topOf(view);
    const [waiting] = await view.getChildren(rows.find((r) => r.kind === 'notebook')!);

    await command('gemdb.savedObjects.commit')(waiting);

    expect(gem.committed.has('employee_barbara')).toBe(true);
  });
});

describe('removing objects', () => {
  it('takes back an addition not yet committed, without asking', async () => {
    pauseIn(NB);
    connected.push({ key: NB, label: 'breakpoint.ipynb' });
    const { view } = setUp();
    vi.spyOn(window, 'showInputBox').mockResolvedValue('draft');
    await command('gemdb.saveVariable')(variable('self', 5));
    const rows = await topOf(view);
    const [waiting] = await view.getChildren(rows.find((r) => r.kind === 'notebook')!);
    const warned = vi.spyOn(window, 'showWarningMessage');

    await command('gemdb.savedObjects.remove')(waiting);
    const after = await topOf(view);

    expect(warned).not.toHaveBeenCalled();
    expect(gem.pending.get(NB)!.has('draft')).toBe(false);
    expect(after.map((r) => r.kind)).toEqual(['root']);
  });

  it('removes every selected committed entry in one commit, after one confirmation', async () => {
    gem.committed.set('a', 'Employee').set('b', 'Employee').set('c', 'Employee');
    const { view } = setUp();
    const [root] = await topOf(view);
    const [a, , c] = await view.getChildren(root);
    const warned = vi.spyOn(window, 'showWarningMessage').mockResolvedValue('Remove' as never);

    await command('gemdb.savedObjects.remove')(a, [a, c]);

    expect(warned).toHaveBeenCalledTimes(1);
    expect(warned.mock.calls[0][0]).toBe(
      'Remove 2 persisted objects (a, c) from Persisted Objects?',
    );
    expect(gem.queries.filter((q) => q.code.includes('del gemdb.root[_key]'))).toHaveLength(1);
    expect([...gem.committed.keys()]).toEqual(['b']);
  });

  it('removes nothing committed when the user cancels', async () => {
    gem.committed.set('a', 'Employee');
    const { view } = setUp();
    const [root] = await topOf(view);
    vi.spyOn(window, 'showWarningMessage').mockResolvedValue(undefined as never);

    await command('gemdb.savedObjects.remove')((await view.getChildren(root))[0]);

    expect(gem.committed.has('a')).toBe(true);
  });

  it('acts on only the row right-clicked when it is not part of the selection', async () => {
    gem.committed.set('a', 'Employee').set('b', 'Employee');
    const { view } = setUp();
    const [root] = await topOf(view);
    const [a, b] = await view.getChildren(root);
    vi.spyOn(window, 'showWarningMessage').mockResolvedValue('Remove' as never);

    await command('gemdb.savedObjects.remove')(b, [a]);

    expect([...gem.committed.keys()]).toEqual(['a']);
  });
});

describe('saved stacks', () => {
  const snapshot = (label: string) =>
    JSON.stringify({
      label,
      notebook: NB,
      saved_at: '2026-10-01 16:20',
      description: 'Saved at breakpoint()',
      frames: [
        {
          name: 'Employee.find',
          line: 2,
          column: 5,
          end_column: null,
          source_name: 'Cell [1]',
          path: 'vscode-notebook-cell:/gone#W0',
          text: 'def find(self):\n    breakpoint()',
        },
      ],
    }) + `${F}3 ${F}9`;

  it('shows a committed saved stack with an Open in Debugger button', async () => {
    gem.committed.set('stack_bp', 'dict');
    gem.stacks.set('stack_bp', snapshot('breakpoint.ipynb'));
    const { view } = setUp();

    const [root] = await topOf(view);
    const [entry] = await view.getChildren(root);

    expect(item(view, entry)).toMatchObject({
      label: 'stack_bp',
      contextValue: 'gemdbSavedStack',
      description: 'saved stack: open it in the debugger',
    });
  });

  it('opens the stack in the debugger, rebuilt from the database, with its saved source', async () => {
    gem.committed.set('stack_bp', 'dict');
    gem.stacks.set('stack_bp', snapshot('breakpoint.ipynb'));
    opened.length = 0;
    const { view } = setUp();
    const [root] = await topOf(view);

    await command('gemdb.savedObjects.openStack')((await view.getChildren(root))[0]);

    const [pause] = opened;
    expect(pause).toMatchObject({
      label: 'Saved stack: breakpoint.ipynb (2026-10-01 16:20)',
      saved: true,
      frames: [
        {
          name: 'Employee.find',
          source: { name: 'Cell [1] (saved 2026-10-01 16:20)', sourceReference: 1 },
        },
      ],
    });
    expect(pause.sourceText?.(1)).toBe('def find(self):\n    breakpoint()');
    expect(pause.scopes(1).map((s) => s.variablesReference)).toEqual([3, 9]);
    pause.answer('continue');
  });

  it('restores the only saved stack straight away from the GemDB panel, showing Run and Debug', async () => {
    gem.committed.set('stack_bp', 'dict');
    gem.stacks.set('stack_bp', snapshot('breakpoint.ipynb'));
    opened.length = 0;
    setUp();
    const picked = vi.spyOn(window, 'showQuickPick');
    const shown = vi.fn();
    __commands.set('workbench.view.debug', shown);

    await command('gemdb.restoreStack')();

    expect(shown).toHaveBeenCalledTimes(1);
    __commands.delete('workbench.view.debug');
    expect(picked).not.toHaveBeenCalled();
    expect(opened.map((p) => p.label)).toEqual([
      'Saved stack: breakpoint.ipynb (2026-10-01 16:20)',
    ]);
    opened[0].answer('stop');
  });

  it('lists the saved stacks, with notebook, time and frames, when there are several', async () => {
    for (const key of ['stack_a', 'stack_b', 'stack_c']) gem.stacks.set(key, snapshot(key));
    opened.length = 0;
    setUp();
    const picked = vi
      .spyOn(window, 'showQuickPick')
      .mockImplementation((items) => Promise.resolve((items as Array<{ key: string }>)[1]));

    await command('gemdb.restoreStack')();

    const items = picked.mock.calls[0][0] as Array<{ label: string; description: string }>;
    expect(items.map((i) => i.label)).toEqual(['stack_a', 'stack_b', 'stack_c']);
    expect(items[0].description).toBe('breakpoint.ipynb · 2026-10-01 16:20 · 1 frame');
    expect(opened.map((p) => p.label)).toEqual(['Saved stack: stack_b (2026-10-01 16:20)']);
    opened[0].answer('stop');
  });

  it('says how to save one when there is no saved stack', async () => {
    setUp();
    const told = vi.spyOn(window, 'showInformationMessage');

    await command('gemdb.restoreStack')();

    expect(told.mock.calls[0][0]).toMatch(
      /^No saved stacks yet\..*Add Stack to Persisted Objects…/,
    );
  });

  it('opens the stack in a session of its own, which closes with it', async () => {
    gem.committed.set('stack_bp', 'dict');
    gem.stacks.set('stack_bp', snapshot('breakpoint.ipynb'));
    opened.length = 0;
    closedSessions.length = 0;
    const { view } = setUp();
    const [root] = await topOf(view);

    await command('gemdb.savedObjects.openStack')((await view.getChildren(root))[0]);
    const [pause] = opened;
    const warned = vi.spyOn(window, 'showWarningMessage');
    pause.answer('stop');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(pause.ownerKey).toBe('saved-stack:stack_bp');
    expect(gem.queries.some((q) => q.session === 'saved-stack:stack_bp')).toBe(true);
    // Nothing was changed, so nothing is asked.
    expect(warned).not.toHaveBeenCalled();
    expect(closedSessions).toEqual(['saved-stack:stack_bp']);
  });

  it('asks about changes made in its Debug Console when it closes, and commits them if told to', async () => {
    gem.committed.set('stack_bp', 'dict');
    gem.stacks.set('stack_bp', snapshot('breakpoint.ipynb'));
    opened.length = 0;
    closedSessions.length = 0;
    const { view } = setUp();
    const [root] = await topOf(view);
    await command('gemdb.savedObjects.openStack')((await view.getChildren(root))[0]);
    const warned = vi.spyOn(window, 'showWarningMessage').mockResolvedValue('Commit' as never);
    // A console line changed something in the stack's session.
    gem.pending.set('saved-stack:stack_bp', new Map([['changed', 'Employee']]));

    opened[0].answer('stop');
    await vi.waitFor(() => expect(closedSessions).toHaveLength(1));

    expect(warned.mock.calls[0][0]).toMatch(/stack_bp.*has changes made in the Debug Console/);
    expect(warned.mock.calls[0][1]).toMatchObject({ modal: true });
    expect(gem.committed.get('changed')).toBe('Employee');
  });

  it('discards them when not told to commit', async () => {
    gem.committed.set('stack_bp', 'dict');
    gem.stacks.set('stack_bp', snapshot('breakpoint.ipynb'));
    gem.committed.delete('changed');
    opened.length = 0;
    closedSessions.length = 0;
    const { view } = setUp();
    const [root] = await topOf(view);
    await command('gemdb.savedObjects.openStack')((await view.getChildren(root))[0]);
    vi.spyOn(window, 'showWarningMessage').mockResolvedValue(undefined as never);
    gem.pending.set('saved-stack:stack_bp', new Map([['changed', 'Employee']]));

    opened[0].answer('stop');
    await vi.waitFor(() => expect(closedSessions).toHaveLength(1));

    expect(gem.committed.has('changed')).toBe(false);
  });

  it('opens one saved stack at a time', async () => {
    gem.committed.set('stack_bp', 'dict');
    gem.stacks.set('stack_bp', snapshot('breakpoint.ipynb'));
    opened.length = 0;
    const { view } = setUp();
    const [root] = await topOf(view);
    const told = vi.spyOn(window, 'showInformationMessage');
    const entry = (await view.getChildren(root))[0];

    await command('gemdb.savedObjects.openStack')(entry);
    await command('gemdb.savedObjects.openStack')(entry);

    expect(opened).toHaveLength(1);
    expect(told.mock.calls.at(-1)?.[0]).toMatch(/open in the debugger already/);
    opened[0].answer('stop');
  });

  it('adds the paused stack like a variable: under gemdb.root, waiting on the notebook’s commit', async () => {
    const pause = pauseIn(NB);
    pause.frames = [
      {
        id: 1,
        name: 'Employee.find',
        line: 2,
        column: 5,
        source: { name: 'Cell [1]', path: 'vscode-notebook-cell:/w#W0' },
      },
    ];
    pause.texts = [['def find(self):', '    breakpoint()']];
    pause.scopes = () => [
      { name: 'Locals', variablesReference: 4, presentationHint: 'locals', expensive: false },
    ];
    connected.push({ key: NB, label: 'breakpoint.ipynb' });
    const { view } = setUp();
    vi.spyOn(window, 'showInputBox').mockResolvedValue('stack_bp');
    const told = vi.spyOn(window, 'showInformationMessage');
    const { debug } = await import('../__mocks__/vscode');
    debug.activeDebugSession = { id: 'debug-1', type: 'gemdb' };

    await command('gemdb.saveStack')();
    const rows = await topOf(view);

    const save = gem.queries.find((q) => q.code.includes('"kind": "gemdb.stack"'))!;
    expect(save.session).toBe(NB);
    expect(save.code).toContain('___gemdb_l0');
    expect(told.mock.calls[0][0]).toMatch(
      /^Added this stack to Persisted Objects as gemdb\.root\["stack_bp"\]/,
    );
    const notebook = rows.find((r) => r.kind === 'notebook')!;
    expect((await view.getChildren(notebook)).map((r) => item(view, r).label)).toEqual([
      'stack_bp',
    ]);
    debug.activeDebugSession = undefined;
  });
});

describe('the other row and title-bar actions', () => {
  it('copies the Python that reads each selected object, one per line', async () => {
    gem.committed.set('a', 'Employee').set('b', 'Employee');
    const { view } = setUp();
    const [root] = await topOf(view);
    const [a, b] = await view.getChildren(root);

    await command('gemdb.savedObjects.copyAccess')(a, [a, b]);

    expect(__clipboard.text).toBe('gemdb.root["a"]\ngemdb.root["b"]');
  });

  it('explains persisting in a dialog from the ? button', async () => {
    setUp();
    const told = vi.spyOn(window, 'showInformationMessage');

    await command('gemdb.savedObjects.help')();

    expect(told.mock.calls[0][0]).toBe('How persisting works');
    expect((told.mock.calls[0][1] as { detail: string }).detail).toMatch(
      /^Persisting takes two steps: add, then commit\./,
    );
  });

  it('inspects a committed object on hover through GemDB’s own session', async () => {
    gem.committed.set('employee_barbara', 'Employee');
    const { view } = setUp();
    const [root] = await topOf(view);
    const [entry] = await view.getChildren(root);

    const resolved = (await view.resolveTreeItem(item(view, entry) as never, entry)) as TreeItem;

    const hover = gem.queries.find((q) => q.code.includes('count := 12.'))!;
    expect(hover.session).toBe('extension');
    expect(hover.code).toContain('System abortTransaction.');
    expect((resolved.tooltip as MarkdownString).value).toContain("name  'Barbara'");
  });

  it('inspects an addition not yet committed in its own notebook, without a fresh view', async () => {
    pauseIn(NB);
    connected.push({ key: NB, label: 'breakpoint.ipynb' });
    const { view } = setUp();
    vi.spyOn(window, 'showInputBox').mockResolvedValue('draft');
    await command('gemdb.saveVariable')(variable('self', 5));
    const rows = await topOf(view);
    const [waiting] = await view.getChildren(rows.find((r) => r.kind === 'notebook')!);

    await view.resolveTreeItem(item(view, waiting) as never, waiting);

    const hover = gem.queries.find((q) => q.code.includes('count := 12.'))!;
    expect(hover.session).toBe(NB);
    expect(hover.code).not.toContain('System abortTransaction.');
  });
});

describe('opening a persisted object in the view', () => {
  const COLLAPSED = 1;
  const LEAF = 0;

  /** gemdb.root holding `ceo`, an Employee whose `boss` opens in turn. */
  function withCeo(): void {
    gem.committed.set('ceo', 'Employee');
    gem.refs.set('ceo', 1);
    gem.fields.set(
      1,
      row('special variables', '', '', 2, 0, 3, 0, -1, 1) +
        row('boss', '<Employee>', 'Employee', 3, 0, 1, 3, -1, 0, 'obj') +
        row('name', "'Ada'", 'str', 0, 0, 0, 4, -1, 0),
    );
    gem.fields.set(3, row('name', "'Grace'", 'str', 0, 0, 0, 5, -1, 0));
  }

  const labels = (view: ReturnType<typeof setUp>['view'], rows: SavedRow[]) =>
    rows.map((r) => [item(view, r).label, item(view, r).description]);

  it('opens a committed entry with nothing paused, through GemDB’s own session', async () => {
    withCeo();
    const { view } = setUp();
    const [root] = await topOf(view);
    const [ceo] = await view.getChildren(root);

    expect(item(view, ceo).collapsibleState).toBe(COLLAPSED);
    const fields = await view.getChildren(ceo);

    expect(labels(view, fields)).toEqual([
      ['special variables', ''],
      ['boss', '<Employee>'],
      ['name', "'Ada'"],
    ]);
    const read = gem.queries.find((q) => q.code.includes("GemDbPersistedRefs' otherwise: nil"))!;
    expect(read.session).toBe('extension');
    // Not the pause's registry, which is dropped at every resume.
    expect(read.code).not.toContain('GemDbPauseRefs');
  });

  it('opens a field that has children of its own, and leaves a plain value a leaf', async () => {
    withCeo();
    const { view } = setUp();
    const [root] = await topOf(view);
    const [ceo] = await view.getChildren(root);
    const [, boss, name] = await view.getChildren(ceo);

    expect(item(view, boss).collapsibleState).toBe(COLLAPSED);
    expect(item(view, name).collapsibleState).toBe(LEAF);
    expect(labels(view, await view.getChildren(boss))).toEqual([['name', "'Grace'"]]);
    expect(view.getParent(boss)).toBe(ceo);
  });

  it('reads an opened object once, until the view is read again', async () => {
    withCeo();
    const { view } = setUp();
    const [root] = await topOf(view);
    const [ceo] = await view.getChildren(root);
    const opens = () => gem.queries.filter((q) => q.code.includes("GemDbPersistedRefs' otherwise"));

    const first = await view.getChildren(ceo);
    const again = await view.getChildren(ceo);

    expect(again).toBe(first);
    expect(opens()).toHaveLength(1);
  });

  it('reads nothing for a row from before the view was read again, whose position no longer holds', async () => {
    withCeo();
    const { view } = setUp();
    const [root] = await topOf(view);
    const [ceo] = await view.getChildren(root);

    await topOf(view);

    expect(await view.getChildren(ceo)).toEqual([]);
    expect(gem.queries.some((q) => q.code.includes("GemDbPersistedRefs' otherwise"))).toBe(false);
  });

  it('leaves an entry with no children, and a saved stack, closed', async () => {
    gem.committed.set('count', 'int').set('stack_bp', 'dict');
    gem.refs.set('stack_bp', 2);
    gem.stacks.set('stack_bp', '');
    const { view } = setUp();
    const [root] = await topOf(view);
    const [count, stack] = await view.getChildren(root);

    expect(item(view, count).collapsibleState).toBe(LEAF);
    // A saved stack opens in the debugger, from its own button.
    expect(item(view, stack).collapsibleState).toBe(LEAF);
  });

  it('opens an addition not committed yet in its own notebook, where alone it exists', async () => {
    pauseIn(NB);
    connected.push({ key: NB, label: 'breakpoint.ipynb' });
    gem.refs.set('draft', 1);
    gem.fields.set(1, row('name', "'Barbara'", 'str', 0, 0, 0, 2, -1, 0));
    const { view } = setUp();
    vi.spyOn(window, 'showInputBox').mockResolvedValue('draft');
    await command('gemdb.saveVariable')(variable('self', 5));
    const rows = await topOf(view);
    const [waiting] = await view.getChildren(rows.find((r) => r.kind === 'notebook')!);

    expect(item(view, waiting).collapsibleState).toBe(COLLAPSED);
    expect(labels(view, await view.getChildren(waiting))).toEqual([['name', "'Barbara'"]]);
    // Both what it holds and what it opens to are read where it is, with no fresh view.
    const listed = gem.queries.filter((q) => q.code.includes('if _k in gemdb.root'));
    const opened = gem.queries.filter((q) => q.code.includes("GemDbPersistedRefs' otherwise"));
    expect(new Set([...listed, ...opened].map((q) => q.session))).toEqual(new Set([NB]));
    expect(opened).toHaveLength(1);
    expect([...listed, ...opened].some((q) => q.code.includes('System abortTransaction.'))).toBe(
      false,
    );
  });

  it('says why an object could not be read, and tries again when opened again', async () => {
    withCeo();
    const { view } = setUp();
    const [root] = await topOf(view);
    const [ceo] = await view.getChildren(root);
    gem.fields.set(1, 'Error: the gem is busy');

    const [failed] = await view.getChildren(ceo);
    gem.fields.set(1, row('name', "'Ada'", 'str', 0, 0, 0, 4, -1, 0));

    expect(item(view, failed).label).toBe('Could not read it: the gem is busy');
    expect(labels(view, await view.getChildren(ceo))).toEqual([['name', "'Ada'"]]);
  });
});

describe('the ranges of a long container', () => {
  const parent: SavedRow = { kind: 'message', text: 'parent' };
  const spans = (rows: SavedRow[]) =>
    rows.map((r) => (r.kind === 'range' ? [r.start, r.end] : undefined));

  it('divides it into ranges of a page, nesting them when there are too many', async () => {
    const { PAGE } = await import('../pauseVariables');
    const { rangeRows } = await import('../savedObjects');

    expect(spans(rangeRows(parent, 0, 1200))).toEqual([
      [0, PAGE],
      [PAGE, 2 * PAGE],
      [2 * PAGE, 1200],
    ]);
    expect(spans(rangeRows(parent, 0, PAGE * PAGE + 1))).toEqual([
      [0, PAGE * PAGE],
      [PAGE * PAGE, PAGE * PAGE + 1],
    ]);
  });

  it('takes the page it is given, as gemdb.root gives its own', async () => {
    const { rangeRows } = await import('../savedObjects');

    expect(spans(rangeRows(parent, 0, 230, 200))).toEqual([
      [0, 200],
      [200, 230],
    ]);
  });
});

describe('a list longer than a page', () => {
  const COLLAPSED = 1;

  /** gemdb.root holding `orders`, a list of `n` items. */
  async function withOrders(n: number) {
    gem.committed.set('orders', 'list');
    gem.refs.set('orders', 1);
    gem.lists.set(1, n);
    const { view } = setUp();
    const [root] = await topOf(view);
    const [orders] = await view.getChildren(root);
    return { view, orders };
  }

  const labels = (view: ReturnType<typeof setUp>['view'], rows: SavedRow[]) =>
    rows.map((r) => item(view, r).label);
  const reads = () => gem.queries.filter((q) => q.code.includes("GemDbPersistedRefs' otherwise"));

  it('opens straight to its ranges, reading nothing until one is opened', async () => {
    const { PAGE } = await import('../pauseVariables');
    const { view, orders } = await withOrders(1200);

    const ranges = await view.getChildren(orders);

    expect(labels(view, ranges)).toEqual([
      `[0 … ${PAGE - 1}]`,
      `[${PAGE} … ${2 * PAGE - 1}]`,
      `[${2 * PAGE} … 1199]`,
    ]);
    expect(item(view, ranges[0]).collapsibleState).toBe(COLLAPSED);
    expect(reads()).toHaveLength(0);
  });

  it('reads a range’s items when it is opened, from where the range starts', async () => {
    const { PAGE } = await import('../pauseVariables');
    const { view, orders } = await withOrders(1200);
    const ranges = await view.getChildren(orders);

    const items = await view.getChildren(ranges[2]);
    const again = await view.getChildren(ranges[2]);

    expect(labels(view, items)).toEqual(
      Array.from({ length: 1200 - 2 * PAGE }, (_, i) => `[${2 * PAGE + i}]`),
    );
    expect(again).toBe(items);
    expect(reads()).toHaveLength(1);
    expect(reads()[0].code).toContain(`start := ${2 * PAGE}.`);
    // So a row deep in a range can be revealed: each knows the row it is under.
    expect(view.getParent(items[0])).toBe(ranges[2]);
    expect(view.getParent(ranges[2])).toBe(orders);
  });

  it('nests the ranges of a very long list', async () => {
    const { PAGE } = await import('../pauseVariables');
    const { view, orders } = await withOrders(PAGE * PAGE + 10);
    const [first, last] = await view.getChildren(orders);

    const inner = await view.getChildren(first);

    expect(labels(view, [first, last])).toEqual([
      `[0 … ${PAGE * PAGE - 1}]`,
      `[${PAGE * PAGE} … ${PAGE * PAGE + 9}]`,
    ]);
    expect(inner).toHaveLength(PAGE);
    expect(labels(view, await view.getChildren(inner[1]))[0]).toBe(`[${PAGE}]`);
  });

  it('leaves a list of exactly a page as its items', async () => {
    const { PAGE } = await import('../pauseVariables');
    const { view, orders } = await withOrders(PAGE);

    const rows = await view.getChildren(orders);

    expect(rows).toHaveLength(PAGE);
    expect(rows.every((r) => r.kind === 'field')).toBe(true);
  });

  it('reads nothing for a range from before the view was read again', async () => {
    const { view, orders } = await withOrders(1200);
    const ranges = await view.getChildren(orders);
    await topOf(view);

    expect(await view.getChildren(ranges[0])).toEqual([]);
    expect(reads()).toHaveLength(0);
  });
});

describe('gemdb.root with more entries than it lists at first', () => {
  it('counts them all and shows them as ranges, each read in the view the listing took', async () => {
    const { ROOT_LISTING_LIMIT } = await import('../pauseVariables');
    for (let i = 0; i < ROOT_LISTING_LIMIT + 30; i++) gem.committed.set(`k${i}`, 'int');
    const { view } = setUp();
    const [root] = await topOf(view);

    expect(item(view, root).description).toBe(`persisted · ${ROOT_LISTING_LIMIT + 30} objects`);
    const ranges = await view.getChildren(root);
    expect(ranges.map((r) => item(view, r).label)).toEqual([
      `[0 … ${ROOT_LISTING_LIMIT - 1}]`,
      `[${ROOT_LISTING_LIMIT} … ${ROOT_LISTING_LIMIT + 29}]`,
    ]);

    const entries = await view.getChildren(ranges[1]);

    expect(entries.map((r) => item(view, r).label)).toEqual(
      Array.from({ length: 30 }, (_, i) => `k${ROOT_LISTING_LIMIT + i}`),
    );
    // A range adds to the first listing's registry and view, rather than starting afresh.
    const read = gem.queries.find((q) => q.code.includes(`[${ROOT_LISTING_LIMIT}:`))!;
    expect(read.code).not.toContain('System abortTransaction.');
    expect(view.getParent(entries[0])).toBe(ranges[1]);
    expect(view.getParent(ranges[1])).toBe(root);
  });

  it('lists them as before when they all fit', async () => {
    gem.committed.set('a', 'int').set('b', 'int');
    const { view } = setUp();
    const [root] = await topOf(view);

    expect((await view.getChildren(root)).map((r) => r.kind)).toEqual(['entry', 'entry']);
    expect(gem.queries.some((q) => q.code.includes('len(gemdb.root)'))).toBe(false);
  });
});

describe('going to an item', () => {
  /** gemdb.root holding `orders`, a list (or a dict, keyed 'k0'…) of `n` items. */
  async function withOrders(n: number, dict = false) {
    gem.committed.set('orders', dict ? 'dict' : 'list');
    gem.refs.set('orders', 1);
    gem.lists.set(1, n);
    if (dict) gem.dicts.add(1);
    const { view } = setUp();
    const [root] = await topOf(view);
    const [orders] = await view.getChildren(root);
    return { view, orders };
  }

  const revealed = () => __treeViews.get(VIEW_ID)!.reveals.at(-1);
  const typing = (text: string) => vi.spyOn(window, 'showInputBox').mockResolvedValue(text);

  it('offers Go to Item… on a list, a set or a dict and on its ranges, not on other rows', async () => {
    const { view, orders } = await withOrders(1200);
    const [range] = await view.getChildren(orders);

    expect(item(view, orders).contextValue).toBe('gemdbSavedObject gemdbContainer');
    expect(item(view, range).contextValue).toBe('gemdbRange');
  });

  it('opens the ranges down to an index and selects that item', async () => {
    const { view, orders } = await withOrders(1200);
    typing('1100');

    await command('gemdb.savedObjects.goToItem')(orders);

    const shown = revealed()!;
    expect(item(view, shown.element as SavedRow).label).toBe('[1100]');
    expect(shown.options).toMatchObject({ select: true, focus: true });
    // Every row on the way is one VS Code can find by its parent.
    const range = view.getParent(shown.element as SavedRow)!;
    expect(item(view, range).label).toBe('[1000 … 1199]');
    expect(view.getParent(range)).toBe(orders);
  });

  it('counts a negative index from the end, and works from a range too', async () => {
    const { view, orders } = await withOrders(1200);
    const [first] = await view.getChildren(orders);
    typing('-1');

    await command('gemdb.savedObjects.goToItem')(first);

    expect(item(view, revealed()!.element as SavedRow).label).toBe('[1199]');
  });

  it('refuses an index outside the list before going anywhere', async () => {
    const { orders } = await withOrders(1200);
    let check: ((text: string) => unknown) | undefined;
    vi.spyOn(window, 'showInputBox').mockImplementation((options) => {
      check = (options as { validateInput: (text: string) => unknown }).validateInput;
      return Promise.resolve(undefined);
    });

    await command('gemdb.savedObjects.goToItem')(orders);

    expect(check!('1200')).toMatch(/from 0 to 1,199/);
    expect(check!('-1201')).toMatch(/from 0 to 1,199/);
    expect(check!('3.5')).toMatch(/from 0 to 1,199/);
    expect(check!('-1200')).toBeUndefined();
    expect(check!('[7]')).toBeUndefined();
    expect(__treeViews.get(VIEW_ID)!.reveals).toHaveLength(0);
  });

  it('finds a dict’s key where the dict holds it, typed with or without quotes', async () => {
    const { view, orders } = await withOrders(1200, true);
    typing('k742');

    await command('gemdb.savedObjects.goToItem')(orders);

    expect(item(view, revealed()!.element as SavedRow).label).toBe("'k742'");
    const asked = gem.queries.find((q) => q.code.includes('want := #('))!;
    expect(asked.session).toBe('extension');
    expect(asked.code).toContain("'''k742'''");
  });

  it('says so, and how keys are written, when a dict has no such key', async () => {
    const { orders } = await withOrders(1200, true);
    typing('nope');
    const warn = vi.spyOn(window, 'showWarningMessage');

    await command('gemdb.savedObjects.goToItem')(orders);

    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/^This dict has no key nope\. Keys are/),
    );
    expect(warn.mock.calls[0][0]).toContain('type [0] to [1,199]');
    expect(__treeViews.get(VIEW_ID)!.reveals).toHaveLength(0);
  });

  it('goes to a dict’s item by position in brackets, as its ranges are labelled', async () => {
    const { view, orders } = await withOrders(1200, true);
    typing('[742]');

    await command('gemdb.savedObjects.goToItem')(orders);

    expect(item(view, revealed()!.element as SavedRow).label).toBe("'k742'");
    // A position needs no lookup.
    expect(gem.queries.some((q) => q.code.includes('want := #('))).toBe(false);
  });

  it('takes a bare number a dict has no key for as a position, and says so', async () => {
    const { view, orders } = await withOrders(1200, true);
    typing('-1');
    const info = vi.spyOn(window, 'showInformationMessage');

    await command('gemdb.savedObjects.goToItem')(orders);

    expect(item(view, revealed()!.element as SavedRow).label).toBe("'k1199'");
    expect(info).toHaveBeenCalledWith(
      expect.stringMatching(/no key -1, so this is the item at position -1/),
    );
  });

  it('refuses a bracketed position outside the dict before going anywhere', async () => {
    const { orders } = await withOrders(1200, true);
    let check: ((text: string) => unknown) | undefined;
    vi.spyOn(window, 'showInputBox').mockImplementation((options) => {
      check = (options as { validateInput: (text: string) => unknown }).validateInput;
      return Promise.resolve(undefined);
    });

    await command('gemdb.savedObjects.goToItem')(orders);

    expect(check!('[1200]')).toMatch(/from 0 to 1,199/);
    // A bare word or number may be a key, which only the database can say.
    expect(check!('99999')).toBeUndefined();
    expect(check!('SKU1')).toBeUndefined();
  });
});
