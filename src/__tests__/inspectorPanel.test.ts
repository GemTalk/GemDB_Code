import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeWebviewPanel, __clipboard, __webviewPanels } from '../__mocks__/vscode';
import { FIELD, RECORD } from '../haltStack';

/**
 * The Inspector panel's host side (src/inspector.ts), with the database
 * replaced by a fake that answers each query by what it asks: which session a
 * read goes to, what the page is told, what is refused, and when the
 * registry is dropped. The page is the fake panel's; the page's own drawing is
 * inspectorView.test.ts's, and the queries run for real in
 * src/__integration__/inspector.test.ts.
 */

const calls: { where: string; code: string; budget: boolean }[] = [];
let answer: (code: string) => string = () => '';

vi.mock('../savedObjects', async (importOriginal) => {
  const real = await importOriginal<typeof import('../savedObjects')>();
  return {
    ...real,
    extensionQuery: vi.fn(async (code: string, opts?: { budget?: boolean }) => {
      calls.push({ where: 'extension', code, budget: opts?.budget === true });
      return answer(code);
    }),
    inNotebook: vi.fn(async (ownerKey: string, code: string, opts?: { budget?: boolean }) => {
      calls.push({ where: ownerKey, code, budget: opts?.budget === true });
      return answer(code);
    }),
  };
});

vi.mock('../session', async (importOriginal) => {
  const real = await importOriginal<typeof import('../session')>();
  return {
    ...real,
    sessionForIfOpen: (key: string) =>
      key === NB
        ? { label: 'demo.ipynb', owner: { key, kind: 'notebook', label: 'demo.ipynb' } }
        : undefined,
  };
});

const { InspectorPanel, registerInspector } = await import('../inspector');
const { INSPECTOR_REGISTRY } = await import('../inspectorQueries');

const NB = 'file:///demo.ipynb';

const record = (fields: (string | number)[]): string => fields.join(FIELD) + RECORD;
const pointRow = (handle: number) =>
  record(['', 'Point(3, 4)', 'Point', handle, 0, 3, handle, -1, 0, 'obj']);
const header = (handle: number) => pointRow(handle) + record(['123456', '0', '__main__', '0']);

/** The fake database: a header for every open, an attribute for every listing. */
function standardAnswers(code: string): string {
  if (code.includes('isCommitted')) return header(20 + calls.length);
  if (code.includes('withGroups := true')) return record(['x', '3', 'int', 0, 0, 0, 31, -1, 0, '']);
  if (code.includes('_gemdb_c')) return record(['x', '10', 'int', 0, 0, 0, 32, -1, 0, '']);
  if (code.includes('want := #(')) return '41';
  if (code.includes("removeKey: #'GemDbInspectorRefs'")) return 'dropped';
  return '';
}

registerInspector(process.cwd(), {} as never);

let panel: FakeWebviewPanel;

function open(readIn: { session: 'extension' } | { session: 'notebook'; ownerKey: string }) {
  InspectorPanel.open({ readIn, from: 'GemDbPauseRefs', handle: 4, label: 'p' });
  panel = __webviewPanels[__webviewPanels.length - 1]!;
}

/** Send a page message and let the host's queries settle. */
async function receive(message: Record<string, unknown>): Promise<void> {
  panel.receive(message);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const postedOf = (command: string) => panel.posted.filter((m) => m.command === command);

beforeEach(() => {
  calls.length = 0;
  answer = standardAnswers;
  for (const p of __webviewPanels.splice(0)) p.dispose();
  calls.length = 0;
});

describe('opening', () => {
  it("reads a notebook's object in the notebook's session, with the repr budget, and offers edits", async () => {
    open({ session: 'notebook', ownerKey: NB });
    await receive({ command: 'ready' });
    expect(calls[0]).toMatchObject({ where: NB, budget: true });
    expect(calls[0]!.code).toContain("SessionTemps current at: #'GemDbPauseRefs'");
    const [root] = postedOf('addRoot');
    expect(root).toMatchObject({ columnId: 0, label: 'p', editable: true });
    expect((root!.header as { row: { type: string } }).row.type).toBe('Point');
    expect(root!.handle).toBe((root!.header as { row: { handle: number } }).row.handle);
  });

  it('reads a committed object in the extension session, read-only', async () => {
    open({ session: 'extension' });
    await receive({ command: 'ready' });
    expect(calls[0]!.where).toBe('extension');
    expect(postedOf('addRoot')[0]).toMatchObject({ editable: false });
    await receive({
      command: 'setSlot',
      columnId: 0,
      containerRef: 21,
      name: 'x',
      valueHandle: 31,
      expression: '10',
    });
    expect(postedOf('setSlotResult')).toEqual([
      { command: 'setSlotResult', columnId: 0, ok: false, error: 'This object is read-only here.' },
    ]);
    expect(calls.some((c) => c.code.includes('_gemdb_c'))).toBe(false);
  });

  it('says why the object could not be opened', async () => {
    answer = () => 'Error: that value is no longer available';
    open({ session: 'notebook', ownerKey: NB });
    await receive({ command: 'ready' });
    expect(postedOf('rootError')).toEqual([
      { command: 'rootError', message: 'that value is no longer available' },
    ]);
  });

  it('says a busy session is busy, and to refresh', async () => {
    open({ session: 'notebook', ownerKey: NB });
    await receive({ command: 'ready' });
    answer = () => {
      throw new Error('This session is busy running something else.');
    };
    await receive({ command: 'fetchTab', columnId: 0, handle: 21, tab: 'attributes', start: 0 });
    expect(postedOf('columnError')[0]!.message).toMatch(/running something.*Refresh/);
  });

  it('titles the panel with the type and the session it reads in', async () => {
    open({ session: 'notebook', ownerKey: NB });
    await receive({ command: 'setTitle', title: 'Point' });
    expect(panel.title).toBe('Inspector: Point · demo.ipynb');
    open({ session: 'extension' });
    await receive({ command: 'setTitle', title: 'list' });
    expect(panel.title).toBe('Inspector: list · committed');
  });
});

describe('rows', () => {
  it("reads a tab's rows from the Inspector's registry, from where it is asked", async () => {
    open({ session: 'notebook', ownerKey: NB });
    await receive({ command: 'fetchTab', columnId: 0, handle: 21, tab: 'items', start: 200 });
    const listing = calls.find((c) => c.code.includes('withGroups := true'))!;
    expect(listing.code).toContain(`at: #'${INSPECTOR_REGISTRY}'`);
    expect(listing.code).toContain('start := 200.');
    expect(listing.code).toContain('count := 100.');
    expect(postedOf('tabData')[0]).toMatchObject({ tab: 'items', start: 200 });
  });

  it('opens a row in a new column, re-registering its object', async () => {
    open({ session: 'notebook', ownerKey: NB });
    await receive({ command: 'inspectRow', sourceColumnId: 0, handle: 31, label: 'p.x' });
    expect(calls[0]!.code).toContain(`SessionTemps current at: #'${INSPECTOR_REGISTRY}'`);
    expect(postedOf('addChild')[0]).toMatchObject({ columnId: 1, sourceColumnId: 0, label: 'p.x' });
  });
});

describe('editing', () => {
  it('writes the expression, marks the row, and puts back the value it first held', async () => {
    open({ session: 'notebook', ownerKey: NB });
    const edit = { command: 'setSlot', columnId: 0, containerRef: 21, name: 'x', expression: '10' };
    await receive({ ...edit, valueHandle: 31 });
    await receive({ ...edit, valueHandle: 32, expression: '11' });
    expect(postedOf('setSlotResult')).toEqual([
      { command: 'setSlotResult', columnId: 0, ok: true },
      { command: 'setSlotResult', columnId: 0, ok: true },
    ]);
    await receive({ command: 'fetchTab', columnId: 0, handle: 21, tab: 'attributes', start: 0 });
    expect((postedOf('tabData')[0]!.rows as { revertible?: boolean }[])[0]!.revertible).toBe(true);
    calls.length = 0;
    await receive({ command: 'revertSlot', columnId: 0, containerRef: 21, name: 'x' });
    // The FIRST original, 31, not the value the first edit left, 32.
    expect(calls[0]!.code).toContain('ifTrue: [reg at: 31]');
    await receive({ command: 'revertSlot', columnId: 0, containerRef: 21, name: 'x' });
    expect(postedOf('setSlotResult').pop()).toMatchObject({ ok: false });
  });

  it('reports a write the database refused', async () => {
    open({ session: 'notebook', ownerKey: NB });
    answer = (code) =>
      code.includes('_gemdb_c') ? 'Error: AttributeError - read-only' : standardAnswers(code);
    await receive({
      command: 'setSlot',
      columnId: 0,
      containerRef: 21,
      name: 'x',
      valueHandle: 31,
      expression: '10',
    });
    expect(postedOf('setSlotResult')).toEqual([
      { command: 'setSlotResult', columnId: 0, ok: false, error: 'AttributeError - read-only' },
    ]);
  });
});

describe('Go to', () => {
  it('takes a position for Items, counting from the end when negative', async () => {
    open({ session: 'notebook', ownerKey: NB });
    await receive({ command: 'goTo', columnId: 0, handle: 21, tab: 'items', text: '-1' });
    await receive({ command: 'goTo', columnId: 0, handle: 21, tab: 'items', text: '[12]' });
    await receive({ command: 'goTo', columnId: 0, handle: 21, tab: 'items', text: 'abc' });
    expect(postedOf('goToResult').map((m) => m.index ?? m.error)).toEqual([
      -1,
      12,
      'abc is not a position.',
    ]);
  });

  it('looks a key up for Entries', async () => {
    open({ session: 'notebook', ownerKey: NB });
    await receive({ command: 'goTo', columnId: 0, handle: 21, tab: 'entries', text: 'SKU0042' });
    expect(calls[0]!.code).toContain("'SKU0042'");
    expect(postedOf('goToResult')[0]).toMatchObject({ index: 41 });
    answer = (code) => (code.includes('want := #(') ? '-1' : '');
    await receive({ command: 'goTo', columnId: 0, handle: 21, tab: 'entries', text: 'nope' });
    expect(postedOf('goToResult')[1]).toMatchObject({ error: 'No key reads as nope.' });
  });
});

describe('the registry', () => {
  it('is dropped when the last panel on its session closes, not before', async () => {
    open({ session: 'notebook', ownerKey: NB });
    const first = panel;
    open({ session: 'notebook', ownerKey: NB });
    first.dispose();
    await Promise.resolve();
    expect(calls.some((c) => c.code.includes("removeKey: #'GemDbInspectorRefs'"))).toBe(false);
    panel.dispose();
    await Promise.resolve();
    expect(calls.filter((c) => c.code.includes("removeKey: #'GemDbInspectorRefs'"))).toEqual([
      expect.objectContaining({ where: NB }),
    ]);
  });
});

describe('Copy', () => {
  it('copies what the page asks', async () => {
    open({ session: 'notebook', ownerKey: NB });
    await receive({ command: 'copyText', text: 'p.tags', what: 'Expression' });
    expect(__clipboard.text).toBe('p.tags');
  });
});

describe('the page', () => {
  it('runs: its three scripts load, it says ready, and it draws the column it is sent', async () => {
    const { JSDOM } = await import('jsdom');
    open({ session: 'notebook', ownerKey: NB });
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
