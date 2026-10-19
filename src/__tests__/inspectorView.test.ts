// @vitest-environment jsdom
/// <reference lib="dom" />
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * The Inspector's webview, driven as the panel drives it: the three scripts
 * are evaluated in jsdom so they register their globals, as the three
 * injected <script> tags do (src/inspector.ts).
 *
 * What is pinned here is what the user sees and what the panel is asked for:
 * a tab only for structure the object has, a page at a time with a jump, a
 * group of attributes that opens in place, a child column labelled with the
 * Python that reaches it, and an edit that sends the typed expression with
 * where the row lives. The queries themselves are tested against a real
 * database (src/__integration__/inspector.test.ts).
 */
beforeAll(() => {
  for (const file of ['evaluatePane.js', 'millerColumns.js', 'inspectorView.js']) {
    new Function(
      fs.readFileSync(path.resolve(__dirname, '../../resources/inspector', file), 'utf8'),
    )();
  }
});

interface Row {
  name: string;
  value: string;
  type: string;
  ref: number;
  indexed: number;
  named: number;
  handle: number;
  size: number;
  readOnly: boolean;
  kind?: string;
  revertible?: boolean;
}

interface Header {
  row: Row;
  oop: string;
  committed: boolean;
  module: string;
  isClass: boolean;
}

interface Column {
  id: number;
  handle: number;
  label: string;
  title: string;
  history: { handle: number; label: string }[];
  historyIndex: number;
  activeTab: string;
  el: { root: HTMLElement; contentPane: HTMLElement; error: HTMLElement };
}

interface View {
  columns: { get(id: number): Column | undefined; columns: Column[] };
  handleHostMessage(msg: Record<string, unknown>): void;
}

interface Api {
  init(opts: unknown): View;
  tabsFor(h: Header | null): { id: string; label: string }[];
  childExpression(base: string, tab: string, name: string): string;
}

const api = (): Api => (globalThis as unknown as { InspectorView: Api }).InspectorView;

function row(over: Partial<Row> = {}): Row {
  return {
    name: 'x',
    value: '3',
    type: 'int',
    ref: 0,
    indexed: 0,
    named: 0,
    handle: 50,
    size: -1,
    readOnly: false,
    ...over,
  };
}

function header(over: Partial<Row> = {}, rest: Partial<Header> = {}): Header {
  return {
    row: row({ name: '', value: 'Point(3, 4)', type: 'Point', handle: 7, kind: 'obj', ...over }),
    oop: '123456',
    committed: false,
    module: '__main__',
    isClass: false,
    ...rest,
  };
}

let posted: Record<string, unknown>[];
let view: View;

beforeEach(() => {
  document.body.innerHTML =
    '<div id="strip"></div>' +
    '<div id="ctx" class="ctx-menu">' +
    ['inspect', 'dive', 'edit', 'copyValue', 'copyExpression']
      .map((a) => `<div class="ctx-item" data-action="${a}"></div>`)
      .join('') +
    '</div>' +
    '<div id="headerCtx" class="ctx-menu"><div class="ctx-item" data-action="copy"></div></div>';
  posted = [];
  Element.prototype.scrollIntoView = vi.fn();
  view = api().init({
    strip: document.getElementById('strip'),
    ctxMenu: document.getElementById('ctx'),
    headerCtxMenu: document.getElementById('headerCtx'),
    vscode: { postMessage: (m: Record<string, unknown>) => posted.push(m) },
    pageSize: 100,
    defaultColumnWidth: 360,
    minColumnWidth: 280,
  });
});

function openRoot(h: Header = header(), label = 'p', editable = true): Column {
  view.handleHostMessage({
    command: 'addRoot',
    columnId: 0,
    handle: h.row.handle,
    label,
    header: h,
    editable,
  });
  return view.columns.get(0)!;
}

function sendRows(columnId: number, tab: string, rows: Row[], start = 0) {
  view.handleHostMessage({ command: 'tabData', columnId, tab, start, rows });
}

const sent = (command: string) => posted.filter((m) => m.command === command);
const tabIds = (col: Column) =>
  Array.from(col.el.root.querySelectorAll('.tab-bar .tab')).map(
    (t) => (t as HTMLElement).dataset.tab,
  );
const click = (el: Element | null) => (el as HTMLElement).click();

describe('which tabs an object gets', () => {
  const ids = (kind?: string) =>
    api()
      .tabsFor(header({ kind }))
      .map((t) => t.id);

  it('gives an object its attributes', () => {
    expect(ids('obj')).toEqual(['attributes', 'repr', 'class', 'eval']);
    expect(ids('ivars')).toEqual(['attributes', 'repr', 'class', 'eval']);
  });

  it('gives a list or a set its items, and a dict its entries', () => {
    expect(ids('seq')).toEqual(['items', 'repr', 'class', 'eval']);
    expect(ids('coll')).toEqual(['items', 'repr', 'class', 'eval']);
    expect(ids('dict')).toEqual(['entries', 'repr', 'class', 'eval']);
  });

  it('gives a number or a str only what every object has', () => {
    expect(ids(undefined)).toEqual(['repr', 'class', 'eval']);
  });

  it('opens on the first tab and asks for it', () => {
    const col = openRoot();
    expect(tabIds(col)).toEqual(['attributes', 'repr', 'class', 'eval']);
    expect(col.activeTab).toBe('attributes');
    expect(sent('fetchTab')).toEqual([
      { command: 'fetchTab', columnId: 0, handle: 7, tab: 'attributes', start: 0 },
    ]);
  });
});

describe('the column header', () => {
  it('names the type and the expression it was opened with, and the OOP', () => {
    const col = openRoot();
    expect(col.el.root.querySelector('.obj-class')!.textContent).toBe('Point');
    expect(col.el.root.querySelector('.obj-label')!.textContent).toBe('p');
    expect(col.el.root.querySelector('.header-oop')!.textContent).toBe('oop 123456');
  });

  it('says whether the object is committed', () => {
    let col = openRoot(header({}, { committed: true }));
    expect(col.el.root.querySelector('.header-badge')!.textContent).toBe('committed');
    col = openRoot(header());
    expect(col.el.root.querySelector('.header-badge')!.textContent).toBe('not committed');
  });

  it('titles the panel by the type', () => {
    openRoot();
    expect(sent('setTitle').pop()).toEqual({ command: 'setTitle', title: 'Point' });
  });
});

describe('the expression a child column is labelled with', () => {
  const expr = (tab: string, name: string) => api().childExpression('p', tab, name);

  it('follows an attribute with a dot, or getattr when it is not a name', () => {
    expect(expr('attributes', 'tags')).toBe('p.tags');
    expect(expr('attributes', 'not a name')).toBe('getattr(p, "not a name")');
  });

  it('indexes an item by position and an entry by its key', () => {
    expect(expr('items', '[2]')).toBe('p[2]');
    expect(expr('entries', "'origin'")).toBe("p['origin']");
  });

  it('labels a double-clicked row so, and opens it to the right', () => {
    const col = openRoot();
    sendRows(0, 'attributes', [
      row({ name: 'tags', handle: 51, type: 'dict', size: 1, kind: 'dict' }),
    ]);
    col.el.contentPane
      .querySelector('tr[data-row="0"]')!
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(sent('inspectRow')).toEqual([
      { command: 'inspectRow', sourceColumnId: 0, handle: 51, label: 'p.tags' },
    ]);
  });
});

describe('attribute groups', () => {
  const group = row({
    name: 'special variables',
    value: '',
    type: '',
    handle: 0,
    ref: 60,
    named: 3,
  });

  it('shows a group as a heading with its count, and opens it in place', () => {
    const col = openRoot();
    sendRows(0, 'attributes', [group, row()]);
    const heading = col.el.contentPane.querySelector('tr[data-group="60"]')!;
    expect(heading.textContent).toContain('special variables');
    expect(heading.textContent).toContain('3');
    click(heading);
    expect(sent('fetchGroup')).toEqual([{ command: 'fetchGroup', columnId: 0, groupRef: 60 }]);
    view.handleHostMessage({
      command: 'groupData',
      columnId: 0,
      groupRef: 60,
      rows: [row({ name: '__module__', value: "'__main__'", type: 'str', handle: 61 })],
    });
    expect(col.el.contentPane.querySelector('tr[data-row="0.0"]')!.textContent).toContain(
      '__module__',
    );
  });

  it('edits a row inside a group against the group, not the column', () => {
    const col = openRoot();
    sendRows(0, 'attributes', [group]);
    click(col.el.contentPane.querySelector('tr[data-group="60"]'));
    view.handleHostMessage({
      command: 'groupData',
      columnId: 0,
      groupRef: 60,
      rows: [row({ name: 'count', handle: 61 })],
    });
    const tr = col.el.contentPane.querySelector('tr[data-row="0.0"]')!;
    tr.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    click(document.querySelector('#ctx [data-action="edit"]'));
    const input = col.el.contentPane.querySelector('.row-editor') as HTMLInputElement;
    input.value = '4';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(sent('setSlot')).toEqual([
      {
        command: 'setSlot',
        columnId: 0,
        containerRef: 60,
        name: 'count',
        valueHandle: 61,
        expression: '4',
      },
    ]);
  });
});

describe('editing', () => {
  it('sends the typed expression with the row it changes and the value it held', () => {
    const col = openRoot();
    sendRows(0, 'attributes', [row({ name: 'x', handle: 50 })]);
    col.el.contentPane
      .querySelector('tr[data-row="0"]')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    click(document.querySelector('#ctx [data-action="edit"]'));
    const input = col.el.contentPane.querySelector('.row-editor') as HTMLInputElement;
    input.value = 'self.y + 1';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(sent('setSlot')).toEqual([
      {
        command: 'setSlot',
        columnId: 0,
        containerRef: 7,
        name: 'x',
        valueHandle: 50,
        expression: 'self.y + 1',
      },
    ]);
  });

  it('offers no Edit Value on a read-only row, nor anywhere in a read-only column', () => {
    let col = openRoot();
    sendRows(0, 'attributes', [row({ readOnly: true })]);
    col.el.contentPane
      .querySelector('tr[data-row="0"]')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    const edit = document.querySelector('#ctx [data-action="edit"]') as HTMLElement;
    expect(edit.style.display).toBe('none');
    col = openRoot(header(), 'p', false);
    sendRows(0, 'attributes', [row()]);
    col.el.contentPane
      .querySelector('tr[data-row="0"]')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    expect(edit.style.display).toBe('none');
  });

  it('reads the tab again after a write, and offers to put an edited row back', () => {
    const col = openRoot();
    sendRows(0, 'attributes', [row()]);
    posted.length = 0;
    view.handleHostMessage({ command: 'setSlotResult', columnId: 0, ok: true });
    expect(sent('fetchTab')).toHaveLength(1);
    sendRows(0, 'attributes', [row({ value: '4', revertible: true })]);
    click(col.el.contentPane.querySelector('[data-revert="0"]'));
    expect(sent('revertSlot')).toEqual([
      { command: 'revertSlot', columnId: 0, containerRef: 7, name: 'x' },
    ]);
  });

  it('shows why a write failed', () => {
    const col = openRoot();
    sendRows(0, 'attributes', [row()]);
    view.handleHostMessage({
      command: 'setSlotResult',
      columnId: 0,
      ok: false,
      error: 'NameError - y',
    });
    expect(col.el.contentPane.querySelector('.edit-error')!.textContent).toBe('NameError - y');
  });
});

describe('paging Items and Entries', () => {
  const items = (start: number, n: number) =>
    Array.from({ length: n }, (_, i) => row({ name: `[${start + i}]`, handle: 100 + i }));

  it('says which rows are shown, and steps a page at a time', () => {
    const col = openRoot(header({ kind: 'seq', type: 'list', size: 250 }));
    sendRows(0, 'items', items(0, 100));
    expect(col.el.contentPane.querySelector('.pager .toolbar-label')!.textContent).toBe(
      '1–100 of 250',
    );
    expect(
      (col.el.contentPane.querySelector('[data-page="-1"]') as HTMLButtonElement).disabled,
    ).toBe(true);
    posted.length = 0;
    click(col.el.contentPane.querySelector('[data-page="1"]'));
    expect(sent('fetchTab')).toEqual([
      { command: 'fetchTab', columnId: 0, handle: 7, tab: 'items', start: 100 },
    ]);
    sendRows(0, 'items', items(200, 50), 200);
    expect(col.el.contentPane.querySelector('.pager .toolbar-label')!.textContent).toBe(
      '201–250 of 250',
    );
    expect(
      (col.el.contentPane.querySelector('[data-page="1"]') as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('asks the panel to find what was typed, and shows the page it is on, marked', () => {
    const col = openRoot(header({ kind: 'seq', type: 'list', size: 250 }));
    sendRows(0, 'items', items(0, 100));
    const box = col.el.contentPane.querySelector('.goto-input') as HTMLInputElement;
    box.value = '-1';
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(sent('goTo')).toEqual([
      { command: 'goTo', columnId: 0, handle: 7, tab: 'items', text: '-1' },
    ]);
    posted.length = 0;
    view.handleHostMessage({ command: 'goToResult', columnId: 0, tab: 'items', index: -1 });
    expect(sent('fetchTab')).toEqual([
      { command: 'fetchTab', columnId: 0, handle: 7, tab: 'items', start: 200 },
    ]);
    sendRows(0, 'items', items(200, 50), 200);
    expect(col.el.contentPane.querySelector('tr.found')!.textContent).toContain('[249]');
  });

  it('says when nothing was found', () => {
    const col = openRoot(header({ kind: 'dict', type: 'dict', size: 3 }));
    sendRows(0, 'entries', [row({ name: "'a'" })]);
    view.handleHostMessage({
      command: 'goToResult',
      columnId: 0,
      tab: 'entries',
      error: 'No key reads as b.',
    });
    expect(col.el.contentPane.querySelector('.goto-error')!.textContent).toBe('No key reads as b.');
  });
});

describe('Back, Forward and Refresh', () => {
  it('dives in place with Enter and walks back', () => {
    const col = openRoot();
    sendRows(0, 'attributes', [row({ name: 'tags', handle: 51 })]);
    const tr = col.el.contentPane.querySelector('tr[data-row="0"]')!;
    tr.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    // Every test's init wires the document again, and jsdom keeps one document for the file, so
    // earlier views answer the Enter too; the newest one's message is the last.
    expect(sent('diveHere').at(-1)).toEqual({
      command: 'diveHere',
      columnId: 0,
      handle: 51,
      label: 'p.tags',
      remember: true,
    });
    view.handleHostMessage({
      command: 'replaceColumn',
      columnId: 0,
      handle: 52,
      label: 'p.tags',
      header: header({ handle: 52, type: 'dict', kind: 'dict', size: 1 }),
      editable: true,
      remember: true,
    });
    expect(col.history.map((h) => h.label)).toEqual(['p', 'p.tags']);
    posted.length = 0;
    click(col.el.root.querySelector('.nav-back'));
    expect(sent('diveHere')).toEqual([
      { command: 'diveHere', columnId: 0, handle: 7, label: 'p', remember: false },
    ]);
  });

  it('reads the same object again on Refresh, staying on its tab', () => {
    const col = openRoot();
    click(col.el.root.querySelector('[data-tab="repr"]'));
    posted.length = 0;
    click(col.el.root.querySelector('.nav-refresh'));
    expect(sent('diveHere')).toEqual([
      { command: 'diveHere', columnId: 0, handle: 7, label: 'p', remember: false, keepTab: true },
    ]);
    view.handleHostMessage({
      command: 'replaceColumn',
      columnId: 0,
      handle: 9,
      label: 'p',
      header: header({ handle: 9 }),
      editable: true,
      remember: false,
      keepTab: true,
    });
    expect(col.activeTab).toBe('repr');
    expect(col.history[col.historyIndex].handle).toBe(9);
  });

  it('says why a column could not be read', () => {
    const col = openRoot();
    view.handleHostMessage({
      command: 'columnError',
      columnId: 0,
      message: 'Its session is running.',
    });
    expect(col.el.error.textContent).toBe('Its session is running.');
    expect(col.el.error.style.display).toBe('');
  });
});

describe('the Repr and Class tabs', () => {
  it('shows str() under repr() only when it differs', () => {
    const col = openRoot();
    click(col.el.root.querySelector('[data-tab="repr"]'));
    view.handleHostMessage({
      command: 'tabData',
      columnId: 0,
      tab: 'repr',
      repr: { repr: "'a\\nb'", str: 'a\nb', cut: false },
    });
    expect(col.el.contentPane.querySelector('.repr-text')!.textContent).toBe("'a\\nb'");
    expect(col.el.contentPane.querySelector('.str-text')!.textContent).toBe('a\nb');
  });

  it('lists methods by the class that defines them, and asks for one source on click', () => {
    const col = openRoot();
    click(col.el.root.querySelector('[data-tab="class"]'));
    view.handleHostMessage({
      command: 'tabData',
      columnId: 0,
      tab: 'class',
      info: {
        name: 'Point',
        qualname: 'Point',
        module: '__main__',
        doc: '',
        isClass: false,
        mro: ['__main__.Point', 'object'],
        members: [
          { owner: 'Point', name: '__init__', kind: 'method' },
          { owner: 'Point', name: 'norm', kind: 'method' },
          { owner: 'Point', name: 'origin', kind: 'classmethod' },
          { owner: 'Point', name: 'scale', kind: 'attribute' },
        ],
      },
    });
    const names = Array.from(col.el.contentPane.querySelectorAll('.method-item')).map(
      (m) => (m as HTMLElement).dataset.member,
    );
    expect(names).toEqual(['norm', 'origin', '__init__']);
    click(col.el.contentPane.querySelector('[data-member="norm"]'));
    expect(sent('fetchSource')).toEqual([
      { command: 'fetchSource', columnId: 0, handle: 7, owner: 'Point', name: 'norm' },
    ]);
    view.handleHostMessage({
      command: 'source',
      columnId: 0,
      owner: 'Point',
      name: 'norm',
      source: 'norm\n\t^ 5',
      caption: 'Smalltalk · Point',
    });
    const box = col.el.contentPane.querySelector('.method-source-box')!;
    // The caption is drawn apart from the code, so it is not read or copied as part of it.
    expect(box.querySelector('.source-caption')!.textContent).toBe('Smalltalk · Point');
    expect(box.lastChild!.textContent).toBe('norm\n\t^ 5');
  });
});

describe('the Class tab headings', () => {
  const info = (members: { owner: string; name: string; kind: string }[]) => ({
    name: 'Order',
    qualname: 'Order',
    module: '__main__',
    doc: '',
    isClass: false,
    mro: ['Order', 'Base', 'object'],
    members,
  });
  const headings = (col: Column) =>
    Array.from(col.el.contentPane.querySelectorAll('.class-owner')).map((h) => h.textContent);

  it('heads each class only when more than one defines methods', () => {
    let col = openRoot();
    click(col.el.root.querySelector('[data-tab="class"]'));
    view.handleHostMessage({
      command: 'tabData',
      columnId: 0,
      tab: 'class',
      info: info([{ owner: 'Order', name: 'total', kind: 'method' }]),
    });
    expect(headings(col)).toEqual([]);
    col = openRoot();
    click(col.el.root.querySelector('[data-tab="class"]'));
    view.handleHostMessage({
      command: 'tabData',
      columnId: 0,
      tab: 'class',
      info: info([
        { owner: 'Order', name: 'total', kind: 'method' },
        { owner: 'Base', name: 'save', kind: 'method' },
      ]),
    });
    expect(headings(col)).toEqual(['defined in Order', 'defined in Base']);
  });
});

describe('the Evaluate tab', () => {
  it('runs the expression against the column object, and shows the answer', () => {
    const col = openRoot();
    click(col.el.root.querySelector('[data-tab="eval"]'));
    const box = col.el.contentPane.querySelector('.eval-input') as HTMLTextAreaElement;
    box.value = 'self.x * 2';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    click(col.el.contentPane.querySelector('[data-eval="display"]'));
    expect(sent('evaluate')).toEqual([
      { command: 'evaluate', columnId: 0, handle: 7, expression: 'self.x * 2', mode: 'display' },
    ]);
    view.handleHostMessage({ command: 'evalResult', columnId: 0, ok: true, text: '6' });
    expect(col.el.contentPane.querySelector('.eval-out')!.textContent).toBe('6');
  });

  it("offers self and the object's own attributes as names to type", () => {
    const col = openRoot();
    sendRows(0, 'attributes', [
      row({ name: 'special variables', handle: 0, ref: 60, type: '', value: '' }),
      row({ name: 'x' }),
    ]);
    click(col.el.root.querySelector('[data-tab="eval"]'));
    const names = Array.from(col.el.contentPane.querySelectorAll('.eval-var')).map(
      (v) => (v as HTMLElement).dataset.var,
    );
    expect(names).toEqual(['self', 'self.x']);
  });
});
