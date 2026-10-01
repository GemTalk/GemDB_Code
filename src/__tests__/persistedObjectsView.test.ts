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
    if (code.includes('list(gemdb.root.items())')) {
      return [...this.committed]
        .map(([key, type]) => row(key, `<${type}>`, type, 0, 0, 0, 1))
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
    const taken = /"([^"]+)" in gemdb\.root/.exec(code);
    if (taken) return this.committed.has(taken[1]) || additions.has(taken[1]) ? 'true' : 'false';
    throw new Error(`the fake gem does not answer: ${code.slice(0, 80)}`);
  }
}

let gem: FakeGem;
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
    const entries = view.getChildren(root);

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
    const [waiting] = view.getChildren(notebook);
    expect(item(view, waiting)).toMatchObject({
      label: 'employee_barbara',
      description: 'Employee · added, not persisted yet',
      contextValue: 'gemdbSavedPending',
    });
    expect((item(view, notebook).tooltip as MarkdownString).value).toMatch(
      /\*\*Commit\*\* \(✓\) persists/,
    );
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

  it('says it needs a paused cell when there is none', async () => {
    setUp();
    const shown = vi.spyOn(window, 'showErrorMessage');

    await command('gemdb.saveVariable')(variable('self', 5));

    expect(shown.mock.calls[0][0]).toMatch(/while a GemDB notebook cell is paused/);
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
    expect(view.getChildren(rows[0]).map((e) => item(view, e).label)).toEqual(['employee_barbara']);
  });

  it('keeps the notebook an addition came from once it is committed, across a restart', async () => {
    const { view, store } = await withOneAddition();
    await topOf(view);

    await command('gemdb.savedObjects.commitNotebook')();
    const [root] = await topOf(view);

    const [entry] = view.getChildren(root);
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
    const [waiting] = view.getChildren(rows.find((r) => r.kind === 'notebook')!);

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
    const [waiting] = view.getChildren(rows.find((r) => r.kind === 'notebook')!);
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
    const [a, , c] = view.getChildren(root);
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

    await command('gemdb.savedObjects.remove')(view.getChildren(root)[0]);

    expect(gem.committed.has('a')).toBe(true);
  });

  it('acts on only the row right-clicked when it is not part of the selection', async () => {
    gem.committed.set('a', 'Employee').set('b', 'Employee');
    const { view } = setUp();
    const [root] = await topOf(view);
    const [a, b] = view.getChildren(root);
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
    const [entry] = view.getChildren(root);

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

    await command('gemdb.savedObjects.openStack')(view.getChildren(root)[0]);

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

  it('opens one saved stack at a time', async () => {
    gem.committed.set('stack_bp', 'dict');
    gem.stacks.set('stack_bp', snapshot('breakpoint.ipynb'));
    opened.length = 0;
    const { view } = setUp();
    const [root] = await topOf(view);
    const told = vi.spyOn(window, 'showInformationMessage');
    const entry = view.getChildren(root)[0];

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
    expect(view.getChildren(notebook).map((r) => item(view, r).label)).toEqual(['stack_bp']);
    debug.activeDebugSession = undefined;
  });
});

describe('the other row and title-bar actions', () => {
  it('copies the Python that reads each selected object, one per line', async () => {
    gem.committed.set('a', 'Employee').set('b', 'Employee');
    const { view } = setUp();
    const [root] = await topOf(view);
    const [a, b] = view.getChildren(root);

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
    const [entry] = view.getChildren(root);

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
    const [waiting] = view.getChildren(rows.find((r) => r.kind === 'notebook')!);

    await view.resolveTreeItem(item(view, waiting) as never, waiting);

    const hover = gem.queries.find((q) => q.code.includes('count := 12.'))!;
    expect(hover.session).toBe(NB);
    expect(hover.code).not.toContain('System abortTransaction.');
  });
});
