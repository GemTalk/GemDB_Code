import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FakeWebviewPanel, __clipboard, __webviewPanels } from '../__mocks__/vscode';
import { FIELD, RECORD } from '../haltStack';

/**
 * The Inspector panel's host side (src/inspector.ts), with the database
 * replaced by a fake that answers each query by what it asks: which session a
 * read goes to and how (the repr budget, past a breakpoint()), what the page
 * is told, what is refused, and when the registry is dropped. The page is the
 * fake panel's; the page's own drawing is inspectorView.test.ts's, and the
 * queries run for real in src/__integration__/inspector.test.ts.
 */

interface Call {
  where: string;
  code: string;
  budget: boolean;
  passHalts: boolean;
}
const calls: Call[] = [];
let answer: (code: string) => string = () => '';

vi.mock('../savedObjects', async (importOriginal) => {
  const real = await importOriginal<typeof import('../savedObjects')>();
  return {
    ...real,
    extensionQuery: vi.fn(async (code: string, opts?: { budget?: boolean }) => {
      calls.push({ where: 'extension', code, budget: opts?.budget === true, passHalts: false });
      return answer(code);
    }),
    inNotebook: vi.fn(
      async (ownerKey: string, code: string, opts?: { budget?: boolean; passHalts?: boolean }) => {
        calls.push({
          where: ownerKey,
          code,
          budget: opts?.budget === true,
          passHalts: opts?.passHalts === true,
        });
        return answer(code);
      },
    ),
  };
});

/** The owner kind the fake session reports for `NB`: a notebook, or a debugged file. */
let ownerKind = 'notebook';
vi.mock('../session', async (importOriginal) => {
  const real = await importOriginal<typeof import('../session')>();
  return {
    ...real,
    sessionForIfOpen: (key: string) =>
      key === NB || key === RENAMED
        ? { label: 'demo.ipynb', owner: { key, kind: ownerKind, label: 'demo.ipynb' } }
        : undefined,
  };
});

const vscodeMock = await import('../__mocks__/vscode');
const { InspectorPanel, registerInspector, wellFormed } = await import('../inspector');
const { INSPECTOR_REGISTRY } = await import('../inspectorQueries');

const NB = 'file:///demo.ipynb';
const RENAMED = 'file:///renamed.ipynb';

const record = (fields: (string | number)[]): string => fields.join(FIELD) + RECORD;
const pointRow = (handle: number) =>
  record(['', 'Point(3, 4)', 'Point', handle, 0, 3, handle, -1, 0, 'obj']);
const header = (handle: number) => pointRow(handle) + record(['123456', '0', '__main__', '0']);
const isOpen = (c: Call) => c.code.includes('isCommitted');
const isDrop = (c: Call) => c.code.includes("removeKey: #'GemDbInspectorRefs-");

/** The fake database: a header for every open, an attribute for every listing. */
function standardAnswers(code: string): string {
  if (code.includes('isCommitted')) return header(20 + calls.length);
  if (code.includes('withGroups := true')) return record(['x', '3', 'int', 0, 0, 0, 31, -1, 0, '']);
  // An Evaluate line, and an edit's first step: its value lands at handle 33.
  if (code.includes('kind := #value')) {
    return record(['value', '0', '', '']) + record(['result', '10', 'int', 0, 0, 0, 33, -1, 0, '']);
  }
  if (code.includes('setattr(_gemdb_c')) return record(['x', '10', 'int', 0, 0, 0, 32, -1, 0, '']);
  if (code.includes('want := #(')) return '41';
  if (code.includes("nextPutAll: 'ok'")) return ['ok', '0', '10', ''].join(FIELD);
  if (code.includes("removeKey: #'GemDbInspectorRefs-")) return 'dropped';
  return '';
}

registerInspector(process.cwd(), {} as never);

let panel: FakeWebviewPanel;

async function open(
  readIn: { session: 'extension' } | { session: 'notebook'; ownerKey: string },
): Promise<void> {
  await InspectorPanel.open({ readIn, from: 'GemDbPauseRefs', handle: 4, label: 'p' });
  panel = __webviewPanels[__webviewPanels.length - 1]!;
}

/** Send a page message and let the host's queries settle. */
async function receive(message: Record<string, unknown>): Promise<void> {
  panel.receive(message);
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

const postedOf = (command: string) => panel.posted.filter((m) => m.command === command);

beforeEach(() => {
  answer = standardAnswers;
  ownerKind = 'notebook';
  for (const p of __webviewPanels.splice(0)) p.dispose();
  calls.length = 0;
});

describe('opening', () => {
  it('copies the object before the page exists, then hands the page that copy', async () => {
    const created = vi.spyOn(vscodeMock.window, 'createWebviewPanel');
    await open({ session: 'notebook', ownerKey: NB });
    // The copy out of the pause's registry ran before the panel was made: a step taken while the
    // page loads cannot change what it opens on.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.code).toContain("SessionTemps current at: #'GemDbPauseRefs'");
    expect(created).toHaveBeenCalledTimes(1);
    created.mockRestore();
    await receive({ command: 'ready' });
    expect(calls).toHaveLength(1);
    const [root] = postedOf('addRoot');
    expect(root).toMatchObject({ columnId: 0, label: 'p', editable: true, handle: 21 });
  });

  it('opens a reloaded page from its own registry, never from the pause’s again', async () => {
    await open({ session: 'notebook', ownerKey: NB });
    await receive({ command: 'ready' });
    await receive({ command: 'ready' });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.code).not.toContain("#'GemDbPauseRefs'");
    expect(calls[1]!.code).toContain("SessionTemps current at: #'GemDbInspectorRefs-");
  });

  it('reads a committed object in the extension session, read-only', async () => {
    await open({ session: 'extension' });
    await receive({ command: 'ready' });
    expect(calls[0]!.where).toBe('extension');
    expect(postedOf('addRoot')[0]).toMatchObject({ editable: false });
    await receive({
      command: 'setSlot',
      columnId: 0,
      containerRef: 21,
      name: 'x',
      valueHandle: 31,
      selfHandle: 21,
      expression: '10',
    });
    expect(postedOf('setSlotResult')).toEqual([
      expect.objectContaining({ ok: false, error: 'This object is read-only here.' }),
    ]);
    expect(calls.some((c) => c.code.includes('setattr(_gemdb_c'))).toBe(false);
  });

  it('says why the object could not be opened, and opens no panel', async () => {
    answer = () => 'Error: that value is no longer available';
    const shown = vi.spyOn(vscodeMock.window, 'showErrorMessage');
    const before = __webviewPanels.length;
    await InspectorPanel.open({
      readIn: { session: 'notebook', ownerKey: NB },
      from: 'GemDbPauseRefs',
      handle: 4,
      label: 'p',
    });
    expect(__webviewPanels.length).toBe(before);
    expect(shown).toHaveBeenCalledWith('Could not inspect p: that value is no longer available');
    shown.mockRestore();
  });

  it('says a busy session is busy, and to refresh', async () => {
    await open({ session: 'notebook', ownerKey: NB });
    await receive({ command: 'ready' });
    answer = () => {
      throw new Error('This session is busy running something else.');
    };
    await receive({ command: 'fetchTab', columnId: 0, handle: 21, tab: 'attributes', start: 0 });
    expect(postedOf('columnError')[0]!.message).toMatch(/running something.*Refresh/);
  });

  it('titles the panel with what the page names, and nothing more', async () => {
    await open({ session: 'notebook', ownerKey: NB });
    await receive({ command: 'setTitle', title: 'counter · function' });
    expect(panel.title).toBe('Inspector: counter · function');
    await receive({ command: 'setTitle', title: '' });
    expect(panel.title).toBe('Inspector');
  });

  it('refuses a page message whose numbers are not whole numbers', async () => {
    expect(wellFormed({ command: 'fetchTab', handle: 3, start: 0 })).toBe(true);
    expect(wellFormed({ command: 'fetchTab', handle: '1]. System commitTransaction. [' })).toBe(
      false,
    );
    await open({ session: 'notebook', ownerKey: NB });
    calls.length = 0;
    await receive({
      command: 'fetchTab',
      columnId: 0,
      handle: '1]. System commit. [',
      tab: 'repr',
    });
    expect(calls).toEqual([]);
  });
});

describe('origin', () => {
  it('passes where the object came from to every column', async () => {
    const origin = { text: 'special_values.py', detail: 'Inspected from main' };
    await InspectorPanel.open({
      readIn: { session: 'notebook', ownerKey: NB },
      from: 'GemDbPauseRefs',
      handle: 4,
      label: 'p',
      origin,
    });
    panel = __webviewPanels[__webviewPanels.length - 1]!;
    await receive({ command: 'ready' });
    await receive({ command: 'inspectRow', sourceColumnId: 0, handle: 31, label: 'p.x' });
    expect(postedOf('addRoot')[0]!.origin).toEqual(origin);
    expect(postedOf('addChild')[0]!.origin).toEqual(origin);
  });
});

describe('rows', () => {
  it("reads a tab's rows from the panel's registry, from where it is asked, naming the object", async () => {
    await open({ session: 'notebook', ownerKey: NB });
    await receive({ command: 'fetchTab', columnId: 0, handle: 21, tab: 'items', start: 200 });
    const listing = calls.find((c) => c.code.includes('withGroups := true'))!;
    expect(listing.code).toContain("at: #'GemDbInspectorRefs-");
    expect(listing.code).toContain('start := 200.');
    expect(listing.code).toContain('count := 100.');
    expect(listing.budget).toBe(true);
    expect(postedOf('tabData')[0]).toMatchObject({ tab: 'items', start: 200, handle: 21 });
  });

  it('gives each panel a registry of its own', async () => {
    await open({ session: 'notebook', ownerKey: NB });
    await open({ session: 'notebook', ownerKey: NB });
    const keys = calls
      .filter(isOpen)
      .map((c) => /#'(GemDbInspectorRefs-[a-z0-9]+)'/.exec(c.code)?.[1]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('opens a row in a new column, re-registering its object', async () => {
    await open({ session: 'notebook', ownerKey: NB });
    calls.length = 0;
    await receive({ command: 'inspectRow', sourceColumnId: 0, handle: 31, label: 'p.x' });
    expect(calls[0]!.code).toContain("SessionTemps current at: #'GemDbInspectorRefs-");
    expect(postedOf('addChild')[0]).toMatchObject({ columnId: 1, sourceColumnId: 0, label: 'p.x' });
  });

  it('reads a whole group, and says so when there are more than it shows', async () => {
    await open({ session: 'notebook', ownerKey: NB });
    await receive({ command: 'fetchGroup', columnId: 0, handle: 21, groupRef: 60, size: 2500 });
    const read = calls.find((c) => c.code.includes('withGroups := true'))!;
    expect(read.code).toContain('count := 2000.');
    const rows = postedOf('groupData')[0]!.rows as { name: string; value: string }[];
    expect(rows.at(-1)).toMatchObject({ name: '...', value: '500 more not shown' });
  });

  it('names the object every reply is for, so a column that moved on can drop it', async () => {
    await open({ session: 'notebook', ownerKey: NB });
    await receive({ command: 'fetchTab', columnId: 0, handle: 21, tab: 'repr' });
    await receive({
      command: 'evaluate',
      columnId: 0,
      handle: 21,
      expression: 'x',
      mode: 'execute',
    });
    await receive({ command: 'goTo', columnId: 0, handle: 21, tab: 'items', text: '3' });
    for (const command of ['tabData', 'evalResult', 'goToResult']) {
      expect(postedOf(command)[0]).toMatchObject({ handle: 21 });
    }
  });

  it('follows its notebook when the notebook is renamed', async () => {
    await open({ session: 'notebook', ownerKey: NB });
    InspectorPanel.retarget(NB, RENAMED);
    calls.length = 0;
    await receive({ command: 'fetchTab', columnId: 0, handle: 21, tab: 'repr' });
    expect(calls[0]!.where).toBe(RENAMED);
  });
});

describe('Evaluate', () => {
  it("runs as a console line does in a notebook's session: no budget, past a breakpoint()", async () => {
    await open({ session: 'notebook', ownerKey: NB });
    calls.length = 0;
    await receive({
      command: 'evaluate',
      columnId: 0,
      handle: 21,
      expression: 'x',
      mode: 'execute',
    });
    expect(calls[0]).toMatchObject({ where: NB, budget: false, passHalts: true });
    expect(calls[0]!.code).not.toContain('abortTransaction');
  });

  it('runs with the budget in the extension session, and throws its changes away', async () => {
    await open({ session: 'extension' });
    calls.length = 0;
    await receive({
      command: 'evaluate',
      columnId: 0,
      handle: 21,
      expression: 'x',
      mode: 'execute',
    });
    expect(calls[0]).toMatchObject({ where: 'extension', budget: true });
    expect(calls[0]!.code).toContain('System abortTransaction');
  });

  it("sees a debugged file's __main__ names, and runs pasted text without its indent", async () => {
    ownerKind = 'file';
    await open({ session: 'notebook', ownerKey: NB });
    calls.length = 0;
    await receive({
      command: 'evaluate',
      columnId: 0,
      handle: 21,
      expression: '    self.x\n    + 1',
      mode: 'execute',
    });
    expect(calls[0]!.code).toContain('sys.modules["__main__"]');
    expect(calls[0]!.code).toContain("evaluateSource: 'self.x\n+ 1'");
  });

  it('shows the whole repr on Display, and opens a column on Inspect', async () => {
    await open({ session: 'notebook', ownerKey: NB });
    await receive({
      command: 'evaluate',
      columnId: 0,
      handle: 21,
      expression: 'x',
      mode: 'display',
    });
    expect(postedOf('evalResult')[0]).toMatchObject({ ok: true, text: '10' });
    await receive({
      command: 'evaluate',
      columnId: 0,
      handle: 21,
      expression: 'x',
      mode: 'inspect',
    });
    expect(postedOf('addChild')[0]).toMatchObject({ label: 'x', sourceColumnId: 0 });
  });

  it('shows only what was printed on Execute, and an error as a traceback', async () => {
    await open({ session: 'notebook', ownerKey: NB });
    answer = (code) =>
      code.includes('kind := #value')
        ? record(['value', '0', 'hello\n', '']) +
          record(['result', '10', 'int', 0, 0, 0, 33, -1, 0, ''])
        : standardAnswers(code);
    await receive({
      command: 'evaluate',
      columnId: 0,
      handle: 21,
      expression: 'x',
      mode: 'execute',
    });
    expect(postedOf('evalResult')[0]).toMatchObject({ ok: true, text: 'hello\n' });
    answer = (code) =>
      code.includes('kind := #value')
        ? record(['error', '0', '', '']) + record(['ZeroDivisionError', 'division by zero'])
        : standardAnswers(code);
    await receive({
      command: 'evaluate',
      columnId: 0,
      handle: 21,
      expression: '1/0',
      mode: 'display',
    });
    const failed = postedOf('evalResult')[1]!;
    expect(failed).toMatchObject({ ok: false, handle: 21 });
    expect(failed.text).toContain('ZeroDivisionError');
    expect(failed.text).toContain('division by zero');
  });
});

describe('source', () => {
  /** Answer the member's source query with `reply`, and ask for `owner.name`. */
  async function fetchSource(reply: string, owner = 'B', name = '__init__') {
    answer = (code) => (code.includes('_gemdb_member') ? reply : standardAnswers(code));
    await receive({
      command: 'fetchSource',
      columnId: 0,
      handle: 21,
      ownerIndex: 0,
      owner,
      name,
    });
    return postedOf('source').at(-1)!;
  }

  const cell = (text: string) => ({
    kind: vscodeMock.NotebookCellKind.Code,
    document: { getText: () => text },
  });

  it('finds a notebook function in the cell that defines it inside its own class', async () => {
    vscodeMock.workspace.notebookDocuments.push({
      uri: { toString: () => NB },
      getCells: () => [
        cell('class B:\n    def __init__(self, x):\n        self.x = x'),
        cell('class A:\n    def __init__(self):\n        pass'),
      ],
    });
    try {
      await open({ session: 'notebook', ownerKey: NB });
      const placed = await fetchSource(['where', '<grail>', '2'].join(FIELD));
      // The later cell is A's, at the same line: the owner check passes it by.
      expect(placed).toMatchObject({
        handle: 21,
        source: '    def __init__(self, x):\n        self.x = x',
      });
    } finally {
      vscodeMock.workspace.notebookDocuments.length = 0;
    }
  });

  it('reads a file on disk, and says where a member was when its lines are gone', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdb-inspector-'));
    const file = path.join(dir, 'shapes.py');
    fs.writeFileSync(file, 'class B:\n    def __init__(self):\n        pass\n');
    try {
      await open({ session: 'notebook', ownerKey: NB });
      expect(await fetchSource(['where', file, '2'].join(FIELD))).toMatchObject({
        source: '    def __init__(self):\n        pass',
      });
      expect((await fetchSource(['where', file, '3'].join(FIELD))).source).toBe(
        `# No source to show: it was defined in ${file}, line 3, and that is not open, or has changed since.`,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('shows a built-in method as the Smalltalk Grail implements it in, and says so', async () => {
    await open({ session: 'notebook', ownerKey: NB });
    const placed = await fetchSource(
      ['smalltalk', 'KeyValueDictionary', 'get: key\n^ self at: key', 'get: key _: d\n^ d'].join(
        FIELD,
      ),
      'dict',
      'get',
    );
    expect(placed).toMatchObject({
      source: 'get: key\n^ self at: key\n\nget: key _: d\n^ d',
      caption: 'dict.get is built in: Grail implements it in Smalltalk, in KeyValueDictionary.',
    });
  });
});

describe('diving', () => {
  it('reads the object in place, carrying the history step and whether to keep the tab', async () => {
    await open({ session: 'notebook', ownerKey: NB });
    await receive({
      command: 'diveHere',
      columnId: 0,
      handle: 31,
      label: 'p.x',
      remember: true,
      keepTab: true,
      historyIndex: 2,
    });
    expect(postedOf('replaceColumn').at(-1)).toMatchObject({
      columnId: 0,
      label: 'p.x',
      keepTab: true,
      historyIndex: 2,
    });
    expect(calls.filter(isOpen).at(-1)!.code).toContain(`at: 31`);
  });
});

describe('editing', () => {
  const edit = {
    command: 'setSlot',
    columnId: 0,
    containerRef: 21,
    selfHandle: 21,
    oop: '123456',
    name: 'x',
    expression: '10',
  };

  it('runs the expression with self and the notebook’s names, then stores the result by handle', async () => {
    await open({ session: 'notebook', ownerKey: NB });
    calls.length = 0;
    await receive({ ...edit, valueHandle: 31, expression: 'self.y + limit' });
    expect(calls[0]!.code).toContain('doitScopeNameFor:');
    expect(calls[0]!.code).toContain("at: 'file:///demo.ipynb'");
    expect(calls[0]).toMatchObject({ budget: false, passHalts: true });
    // The value the run left at handle 33 is what is stored.
    expect(calls[1]!.code).toContain('ifTrue: [reg at: 33]');
  });

  it('marks the row, keeps the mark across a Refresh, and puts back the value it first held', async () => {
    await open({ session: 'notebook', ownerKey: NB });
    await receive({ ...edit, valueHandle: 31 });
    await receive({ ...edit, valueHandle: 32, expression: '11' });
    expect(postedOf('setSlotResult').map((m) => m.ok)).toEqual([true, true]);
    // A Refresh registers the column's object again, at a new handle; the mark goes by its OOP.
    await receive({
      command: 'fetchTab',
      columnId: 0,
      handle: 77,
      oop: '123456',
      tab: 'attributes',
      start: 0,
    });
    expect((postedOf('tabData')[0]!.rows as { revertible?: boolean }[])[0]!.revertible).toBe(true);
    calls.length = 0;
    await receive({
      command: 'revertSlot',
      columnId: 0,
      containerRef: 77,
      selfHandle: 77,
      oop: '123456',
      name: 'x',
    });
    // The FIRST original, 31, not the value the first edit left, 32.
    expect(calls[0]!.code).toContain('ifTrue: [reg at: 31]');
    await receive({
      command: 'revertSlot',
      columnId: 0,
      containerRef: 77,
      selfHandle: 77,
      oop: '123456',
      name: 'x',
    });
    expect(postedOf('setSlotResult').pop()).toMatchObject({ ok: false });
  });

  it('reports a write the database refused', async () => {
    await open({ session: 'notebook', ownerKey: NB });
    answer = (code) =>
      code.includes('setattr(_gemdb_c')
        ? 'Error: AttributeError - read-only'
        : standardAnswers(code);
    await receive({ ...edit, valueHandle: 31 });
    expect(postedOf('setSlotResult')).toEqual([
      expect.objectContaining({ ok: false, error: 'AttributeError - read-only' }),
    ]);
  });

  it('reports an expression that raised', async () => {
    await open({ session: 'notebook', ownerKey: NB });
    answer = (code) =>
      code.includes('kind := #value')
        ? record(['error', '0', '', '']) + record(['NameError', "name 'limit' is not defined"])
        : standardAnswers(code);
    await receive({ ...edit, valueHandle: 31, expression: 'limit' });
    expect(postedOf('setSlotResult')).toEqual([
      expect.objectContaining({ ok: false, error: "NameError: name 'limit' is not defined" }),
    ]);
  });
});

describe('Go to', () => {
  it('takes a position for Items, counting from the end when negative', async () => {
    await open({ session: 'notebook', ownerKey: NB });
    await receive({ command: 'goTo', columnId: 0, handle: 21, tab: 'items', text: '-1' });
    await receive({ command: 'goTo', columnId: 0, handle: 21, tab: 'items', text: '[12]' });
    await receive({ command: 'goTo', columnId: 0, handle: 21, tab: 'items', text: 'abc' });
    expect(postedOf('goToResult').map((m) => m.index ?? m.error)).toEqual([
      -1,
      12,
      'abc is not a position.',
    ]);
  });

  it('looks a key up for Entries, and says so when a number is taken as a position', async () => {
    await open({ session: 'notebook', ownerKey: NB });
    await receive({ command: 'goTo', columnId: 0, handle: 21, tab: 'entries', text: 'SKU0042' });
    expect(postedOf('goToResult')[0]).toMatchObject({ index: 41 });
    answer = (code) => (code.includes('want := #(') ? '-1' : '');
    await receive({ command: 'goTo', columnId: 0, handle: 21, tab: 'entries', text: 'nope' });
    expect(postedOf('goToResult')[1]).toMatchObject({ error: 'No key reads as nope.' });
    await receive({ command: 'goTo', columnId: 0, handle: 21, tab: 'entries', text: '5' });
    expect(postedOf('goToResult')[2]).toMatchObject({
      index: 5,
      note: 'No key reads as 5: showing entry 5 by position.',
    });
  });
});

describe('the registry', () => {
  it('is dropped when its panel closes, each panel its own', async () => {
    await open({ session: 'notebook', ownerKey: NB });
    const first = panel;
    await open({ session: 'notebook', ownerKey: NB });
    first.dispose();
    await Promise.resolve();
    expect(calls.filter(isDrop)).toHaveLength(1);
    panel.dispose();
    await Promise.resolve();
    const drops = calls.filter(isDrop);
    expect(drops).toHaveLength(2);
    expect(drops[0]!.code).not.toBe(drops[1]!.code);
  });
});

describe('Add to Persisted Objects…', () => {
  it("hands the shared command the object's session, registry and name", async () => {
    const spy = vi.spyOn(vscodeMock.commands, 'executeCommand').mockResolvedValue(undefined);
    await open({ session: 'notebook', ownerKey: NB });
    await receive({ command: 'addToPersisted', handle: 31, name: 'p.tags' });
    expect(spy).toHaveBeenCalledWith(
      'gemdb.savedObjects.addFromInspector',
      expect.objectContaining({
        ownerKey: NB,
        notebook: 'demo.ipynb',
        handle: 31,
        name: 'p.tags',
        registry: expect.stringMatching(new RegExp(`^${INSPECTOR_REGISTRY}-`)),
      }),
    );
    spy.mockRestore();
  });

  it('declines in GemDB’s own session, where nothing would commit it', async () => {
    const spy = vi.spyOn(vscodeMock.commands, 'executeCommand').mockResolvedValue(undefined);
    await open({ session: 'extension' });
    await receive({ command: 'addToPersisted', handle: 31, name: 'p.tags' });
    expect(spy).not.toHaveBeenCalledWith('gemdb.savedObjects.addFromInspector', expect.anything());
    spy.mockRestore();
  });
});

describe('Copy', () => {
  it('copies what the page asks', async () => {
    await open({ session: 'notebook', ownerKey: NB });
    await receive({ command: 'copyText', text: 'p.tags', what: 'Expression' });
    expect(__clipboard.text).toBe('p.tags');
  });
});

describe('the page', () => {
  it('puts this load’s nonce on every script, and only scripts with it may run', async () => {
    await open({ session: 'notebook', ownerKey: NB });
    const html = panel.webview.html;
    const nonce = /script-src 'nonce-([^']+)'/.exec(html)?.[1];
    expect(nonce).toBeTruthy();
    const scripts = html.match(/^\s*<script\b[^>]*>/gm) ?? [];
    expect(scripts.length).toBe(4);
    for (const tag of scripts) expect(tag).toContain(`nonce="${nonce}"`);
    expect(html).toContain("default-src 'none'");
  });

  it('runs: its three scripts load, it says ready, and it draws the column it is sent', async () => {
    const { JSDOM } = await import('jsdom');
    await open({ session: 'notebook', ownerKey: NB });
    const fromPage: Record<string, unknown>[] = [];
    const dom = new JSDOM(panel.webview.html, {
      runScripts: 'dangerously',
      beforeParse(window) {
        Object.assign(window, {
          acquireVsCodeApi: () => ({
            postMessage: (m: Record<string, unknown>) => fromPage.push(m),
          }),
        });
        window.HTMLElement.prototype.scrollIntoView = () => {};
      },
    });
    expect(fromPage).toEqual([{ command: 'ready' }]);
    const h = {
      row: {
        name: '',
        value: 'Point(3, 4)',
        type: 'Point',
        ref: 7,
        indexed: 0,
        named: 3,
        handle: 7,
        size: -1,
        readOnly: false,
        kind: 'obj',
      },
      oop: '123456',
      committed: false,
      module: '__main__',
      isClass: false,
    };
    dom.window.postMessage(
      { command: 'addRoot', columnId: 0, handle: 7, label: 'p', header: h, editable: true },
      '*',
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    const doc = dom.window.document;
    expect(doc.querySelector('.obj-class')!.textContent).toBe('Point');
    expect(Array.from(doc.querySelectorAll('.tab-bar .tab')).map((t) => t.textContent)).toEqual([
      'Attributes',
      'Repr',
      'Class',
      'Evaluate',
    ]);
    expect(fromPage.map((m) => m.command)).toEqual(['ready', 'fetchTab', 'setTitle']);
    dom.window.close();
  });
});
