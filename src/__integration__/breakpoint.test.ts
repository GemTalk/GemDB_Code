import * as fs from 'fs';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { stageGrail } from '../grail';
import { PythonFrame, parsePythonStack, pythonStackQuery } from '../haltStack';
import {
  MAIN_MODULE,
  PauseVariable,
  abortQuery,
  childrenQuery,
  commitQuery,
  freeKeyQuery,
  inspectQuery,
  keyTakenQuery,
  needsCommitQuery,
  parseChildren,
  parsePausedStack,
  parseSaveSuggestion,
  pausedStackQuery,
  removeCommittedQuery,
  removeSavedQuery,
  rootListingQuery,
  saveSuggestionQuery,
  saveToRootQuery,
  setVariableQuery,
  unquote,
} from '../pauseVariables';
import { isRunning, startNetldi, startStone, stopNetldi, stopStone } from '../processes';
import { fileOwner } from '../fileOwner';
import { runPython, runPythonFile } from '../pythonQueries';
import {
  HaltAnswer,
  HaltRequest,
  SessionOwner,
  closeSessionFor,
  executeAsync,
  interruptSessionFor,
  logoutAll,
  sessionForIfOpen,
  sessionRegistry,
  setHaltHandler,
} from '../session';
import {
  SavedFrame,
  openStackQuery,
  parseOpenedStack,
  saveStackQuery,
  savedStackKeysQuery,
} from '../savedStacks';
import { createDatabaseWithPython, Fixture, haveTestExtent, makeFixture } from './fixture';

/**
 * breakpoint() against a real database: the gem halts, the stack Grail
 * reports is the Python one, and the evaluation resumes or ends as the user
 * chooses — with print() still streaming either side of the pause.
 *
 * The halt handler here stands in for the debugger (`debugger.ts`, tested
 * without a database): it reads the stack the same way and answers.
 */

const ext = process.cwd();
const haveExtent = haveTestExtent();

const NB: SessionOwner = { key: 'file:///bp.ipynb', kind: 'notebook', label: 'bp.ipynb' };

/** A notebook of its own, for a test whose globals must not meet another test's. */
const notebook = (name: string): SessionOwner => ({
  key: `file:///${name}.ipynb`,
  kind: 'notebook',
  label: `${name}.ipynb`,
});

/** A cell whose breakpoint() sits three calls deep in a method. */
const CELL = [
  'class K:',
  '    def find(self, n):',
  '        if n == 0:',
  '            breakpoint()',
  '            return "found"',
  '        return self.find(n - 1)',
  'def outer():',
  '    print("before")',
  '    r = K().find(2)',
  '    print("after", r)',
  '    return r',
  'outer()',
].join('\n');

let fixture: Fixture | undefined;

beforeAll(async () => {
  if (!haveExtent) return;
  fixture = makeFixture();
  if (!fixture) return;
  createDatabaseWithPython(fixture);
  stageGrail(ext);
  await startStone();
  await startNetldi();
});

afterEach(() => setHaltHandler(undefined));

afterAll(async () => {
  if (!fixture) return;
  logoutAll();
  try {
    await stopNetldi();
  } finally {
    if (isRunning()) await stopStone(true);
    fixture.remove();
  }
});

/** See database.test.ts — skipIf is evaluated during collection. */
function canMakeFixture(): boolean {
  const probe = makeFixture();
  if (!probe) return false;
  probe.remove();
  return true;
}

/** Install a handler that records the stack and what had printed, then answers. */
function answering(choice: HaltAnswer, printed: string[]) {
  const seen: { frames: PythonFrame[]; printedAtHalt: string } = { frames: [], printedAtHalt: '' };
  setHaltHandler(async (request: HaltRequest) => {
    seen.frames = parsePythonStack(await request.query(pythonStackQuery(request.process)));
    seen.printedAtHalt = printed.join('');
    return choice;
  });
  return seen;
}

describe.skipIf(!haveExtent || !canMakeFixture())('breakpoint()', () => {
  it('pauses with the Python stack, then Continue finishes the cell', async () => {
    const printed: string[] = [];
    const seen = answering('continue', printed);

    const result = await runPython(CELL, NB, (chunk) => printed.push(chunk));

    expect(seen.frames.map((f) => f.name)).toEqual([
      'K.find',
      'K.find',
      'K.find',
      'outer',
      '<module>',
    ]);
    expect(seen.frames.map((f) => f.line)).toEqual([4, 6, 6, 9, 12]);
    // The span is what the highlight and the cell match are made of.
    expect(seen.frames[0].lineText).toContain('breakpoint()');
    expect(seen.frames[0].file).toBe('<grail>');
    expect(seen.frames[0].endColumn).toBeGreaterThan(seen.frames[0].column);
    // A def in the cell is a block, whose span Grail misplaces; its text comes
    // from the recorded positions instead, so it can still find its cell.
    expect(seen.frames[3].lineText).toContain('r = K().find(2)');
    // Output streams up to the pause, and the rest after it.
    expect(seen.printedAtHalt).toBe('before\n');
    expect(printed.join('')).toBe('before\nafter found\n');
    expect(result.value).toBe("'found'");
  });

  it('gives a function from an earlier cell the text that finds that cell', async () => {
    const seen = answering('continue', []);
    await runPython('def early():\n    breakpoint()\n    return 1', NB);
    const result = await runPython('x = 5\nearly()', NB);

    expect(seen.frames.map((f) => f.name)).toEqual(['early', '<module>']);
    expect(seen.frames.map((f) => f.line)).toEqual([2, 2]);
    // The text is a slice of the frame's line, and that line is in the cell
    // that holds the code — which is what locateCell matches on.
    expect('    breakpoint()').toContain(seen.frames[0].lineText.trim());
    expect('early()').toContain(seen.frames[1].lineText.trim());
    expect(seen.frames[1].lineText.trim()).not.toBe('');
    expect(result.value).toBe('1');
  });

  it('shows each frame’s locals and the notebook’s globals, expandable, without disturbing the cell', async () => {
    const seen: Record<string, ReturnType<typeof parseChildren>> = {};
    let frameNames: string[] = [];
    setHaltHandler(async (request) => {
      const children = async (ref: number, start = 0, count = 500) =>
        parseChildren(await request.query(childrenQuery(ref, start, count)));
      const { frames, globals } = parsePausedStack(
        await request.query(pausedStackQuery(request.process, NB.key)),
      );
      frameNames = frames.map((f) => f.name);
      seen.go = await children(frames.find((f) => f.name === 'go')!.locals!);
      const byName = (name: string) => seen.go.find((v) => v.name === name)!;
      seen.p = await children(byName('p').ref);
      seen.local = await children(byName('local').ref);
      seen.tags = await children(seen.p.find((v) => v.name === 'tags')!.ref);
      seen.globals = await children(globals);
      const big = seen.globals.find((v) => v.name === 'big')!;
      seen.bigPage = await children(big.ref, 998, 50);
      seen.data = await children(seen.globals.find((v) => v.name === 'data')!.ref);
      const group = (name: string) => children(seen.globals.find((v) => v.name === name)!.ref);
      seen.classes = await group('class variables');
      seen.functions = await group('function variables');
      return 'continue';
    });
    const printed: string[] = [];

    const result = await runPython(
      [
        'class P:',
        '    def __init__(self, name):',
        '        self.name = name',
        '        self.tags = {"a", "b"}',
        '    def __repr__(self):',
        '        print("repr ran")',
        '        return f"P({self.name!r})"',
        'data = {"k": [1, 2.5, "s"], 3: None, "f": len}',
        'big = list(range(1000))',
        'def go(p, n=2):',
        '    local = [p, (1, 2)]',
        '    breakpoint()',
        '    print("after")',
        '    return n',
        'go(P("ann"))',
      ].join('\n'),
      NB,
      (chunk) => printed.push(chunk),
    );

    // One walk gives the frames and their locals: Grail's stub is gone, go is first.
    expect(frameNames).toEqual(['go', '<module>']);
    expect(seen.go.map((v) => [v.name, v.value, v.type])).toEqual(
      expect.arrayContaining([
        ['n', '2', 'int'],
        ['p', "P('ann')", 'P'],
        ['local', "[P('ann'), (1, 2)]", 'list'],
      ]),
    );
    // An object opens on its dunders, folded, then its data.
    expect(seen.p.map((v) => v.name)).toEqual(['special variables', 'name', 'tags']);
    // A list reads by position from 0, not as Smalltalk's 1-based keys.
    expect(seen.local.map((v) => v.name)).toEqual(['[0]', '[1]']);
    expect(seen.local[1]).toMatchObject({ value: '(1, 2)', type: 'tuple', indexed: 2, size: 2 });
    // A container carries its size for the row's badge; anything else carries none.
    expect(seen.go.find((v) => v.name === 'local')).toMatchObject({ size: 2 });
    expect(seen.go.find((v) => v.name === 'p')).toMatchObject({ size: -1 });
    expect(seen.tags.map((v) => v.value).sort()).toEqual(["'a'", "'b'"]);
    // Globals are the notebook's names — this cell's and earlier cells' — without the dunder
    // noise, with classes and functions folded into groups at the top and the data sorted below.
    const globalNames = seen.globals.map((v) => v.name);
    expect(globalNames.slice(0, 2)).toEqual(['class variables', 'function variables']);
    expect(globalNames).toEqual(expect.arrayContaining(['big', 'data']));
    expect(globalNames).not.toContain('P');
    expect(globalNames).not.toContain('go');
    expect(globalNames.filter((n) => /^__.*__$/.test(n))).toEqual([]);
    const dataNames = globalNames.slice(2);
    expect(dataNames).toEqual([...dataNames].sort());
    expect(seen.classes.map((v) => v.name)).toContain('P');
    expect(seen.functions.map((v) => v.name)).toContain('go');
    // A big list says how big it is, in place of a repr of every item, and
    // hands over a page on request.
    expect(seen.globals.find((v) => v.name === 'big')).toMatchObject({
      value: 'list with 1000 items',
      indexed: 1000,
      named: 0,
    });
    expect(seen.bigPage.map((v) => [v.name, v.value])).toEqual([
      ['[998]', '998'],
      ['[999]', '999'],
    ]);
    // A dict entry is named by its key's repr, so a str key reads as one.
    expect(seen.data.map((v) => [v.name, v.value])).toEqual(
      expect.arrayContaining([
        ["'k'", "[1, 2.5, 's']"],
        ['3', 'None'],
      ]),
    );
    // An ordinary dict is not a scope: a function in it stays an ordinary entry.
    expect(seen.data.map((v) => v.name)).toContain("'f'");
    // __repr__ printed while the Variables were read, and none of it reached the cell.
    expect(printed.join('')).toBe('after\n');
    expect(result.value).toBe('2');
  });

  it('shows an object whole: dunders and methods folded, class attributes, properties and slots', async () => {
    const seen: Record<string, PauseVariable[]> = {};
    const nb = notebook('bp-shape');
    setHaltHandler(async (request) => {
      const children = async (ref: number) =>
        parseChildren(await request.query(childrenQuery(ref, 0, 500)));
      const { globals } = parsePausedStack(
        await request.query(pausedStackQuery(request.process, nb.key)),
      );
      seen.globals = await children(globals);
      const ref = (rows: PauseVariable[], name: string) => rows.find((v) => v.name === name)!.ref;
      seen.p = await children(ref(seen.globals, 'p'));
      seen.special = await children(ref(seen.p, 'special variables'));
      seen.functions = await children(ref(seen.p, 'function variables'));
      seen.v = await children(ref(seen.globals, 'v'));
      seen.classes = await children(ref(seen.globals, 'class variables'));
      seen.Point = await children(ref(seen.classes, 'Point'));
      seen.modules = await children(ref(seen.globals, 'module variables'));
      seen.globalFunctions = await children(ref(seen.globals, 'function variables'));
      seen.t = await children(ref(seen.globals, 't'));
      return 'continue';
    });

    await runPython(
      [
        'class Point:',
        '    kind = "pt"',
        '    def __init__(self, x, y):',
        '        self.x, self.y = x, y',
        '    def distance(self):',
        '        return 0',
        '    @property',
        '    def norm(self):',
        '        return 5',
        'class Vec:',
        '    __slots__ = ("x", "y")',
        '    def __init__(self, x, y):',
        '        self.x, self.y = x, y',
        'class Empty:',
        '    pass',
        'class Temp:',
        '    unit = "C"',
        '    @property',
        '    def kelvin(self):',
        '        return 273',
        'def helper():',
        '    return 1',
        'import os',
        'p = Point(3, 4)',
        'v = Vec(1, 2)',
        'e = Empty()',
        't = Temp()',
        'breakpoint()',
      ].join('\n'),
      nb,
    );
    // The database allows ten sessions, and this file opens one per notebook.
    closeSessionFor(nb.key);

    // Groups first, then the data — its own attributes, the class's, and a
    // property's value, read through its getter — sorted by name.
    expect(seen.p.map((v) => v.name)).toEqual([
      'special variables',
      'function variables',
      'kind',
      'norm',
      'x',
      'y',
    ]);
    expect(seen.p.find((v) => v.name === 'norm')).toMatchObject({ value: '5', type: 'int' });
    expect(seen.special.map((v) => v.name)).toEqual(
      expect.arrayContaining(['__class__', '__dict__', '__init__', '__module__']),
    );
    expect(seen.functions.map((v) => v.name)).toEqual(['distance']);
    // Something with nothing of its own to show stays a leaf: a method, an empty object.
    expect(seen.functions[0].ref).toBe(0);
    expect(seen.globals.find((v) => v.name === 'e')).toMatchObject({ ref: 0, type: 'Empty' });
    // An object with nothing of its own still opens when its class gives it data.
    expect(seen.t.map((v) => [v.name, v.value])).toEqual(
      expect.arrayContaining([
        ['kelvin', '273'],
        ['unit', "'C'"],
      ]),
    );
    expect(seen.globalFunctions.find((v) => v.name === 'helper')).toMatchObject({
      ref: 0,
      type: 'function',
    });
    // Only a container trades its repr for a size: a module with hundreds of names keeps its own.
    expect(seen.modules.find((v) => v.name === 'os')?.value).toMatch(/^<module 'os'/);
    // Group headings cannot be changed; the attributes can.
    expect(seen.p.find((v) => v.name === 'special variables')).toMatchObject({ readOnly: true });
    expect(seen.p.find((v) => v.name === 'x')).toMatchObject({ readOnly: false });
    // A __slots__ object has no __dict__ and no instance variables, and still opens.
    expect(
      seen.v.filter((v) => !v.name.endsWith('variables')).map((v) => [v.name, v.value]),
    ).toEqual([
      ['x', '1'],
      ['y', '2'],
    ]);
    // A class shows its own methods apart from the dunders it is full of.
    const pointNames = seen.Point.map((v) => v.name);
    expect(pointNames.slice(0, 2)).toEqual(['special variables', 'function variables']);
    expect(pointNames.filter((n) => /^__.*__$/.test(n))).toEqual([]);
    expect(pointNames).toEqual(expect.arrayContaining(['kind', 'norm']));
  });

  it('sets a local, a global, an attribute, a list item and a dict entry, and the run sees them', async () => {
    const seen: Record<string, string> = {};
    const nb = notebook('bp-set');
    setHaltHandler(async (request) => {
      const children = async (ref: number) =>
        parseChildren(await request.query(childrenQuery(ref, 0, 500)));
      const set = (ref: number, name: string, value: string) =>
        request.query(setVariableQuery(request.process, ref, name, value));
      const { frames, globals } = parsePausedStack(
        await request.query(pausedStackQuery(request.process, nb.key)),
      );
      const tour = frames.find((f) => f.name === 'tour')!.locals!;
      const method = frames.find((f) => f.name === 'P.look')!.locals!;
      const globalRows = await children(globals);
      const ref = (rows: PauseVariable[], name: string) => rows.find((v) => v.name === name)!.ref;
      const locals = await children(tour);
      seen.selfReadOnly = String((await children(method)).find((v) => v.name === 'self')?.readOnly);
      seen.n = await set(tour, 'n', 'n + 92');
      seen.label = await set(tour, 'label', '"changed"');
      seen.g = await set(globals, 'g', '5');
      seen.x = await set(ref(locals, 'p'), 'x', '10');
      seen.item = await set(ref(globalRows, 'items'), '[1]', '"two"');
      seen.entry = await set(ref(globalRows, 'd'), "'k'", '[1, 2]');
      seen.tuple = await set(ref(globalRows, 't'), '[0]', '9');
      seen.norm = await set(ref(locals, 'p'), 'norm', '1');
      seen.self = await set(method, 'self', '1');
      seen.syntax = await set(tour, 'n', '1 +');
      // An assignment is a statement, not a value: refused, where it would have stored None.
      seen.statement = await set(tour, 'n', 'n = 5');
      seen.commented = await set(globals, 'g', '5  # a comment');
      seen.afterRows = JSON.stringify(
        (await children(tour)).filter((v) => v.name === 'n').map((v) => v.value),
      );
      return 'continue';
    });

    const result = await runPython(
      [
        'class P:',
        '    def __init__(self):',
        '        self.x = 1',
        '    @property',
        '    def norm(self):',
        '        return 5',
        '    def look(self):',
        '        return tour(self)',
        'g = 1',
        'items = [1, 2, 3]',
        'd = {"k": 0}',
        't = (1, 2)',
        'def tour(p):',
        '    n = 7',
        '    label = "in"',
        '    breakpoint()',
        '    return n, label, p.x',
        '(P().look(), g, items, d, t)',
      ].join('\n'),
      nb,
    );
    closeSessionFor(nb.key);

    const row = (raw: string) => parseChildren(raw)[0];
    expect(row(seen.n)).toMatchObject({ name: 'n', value: '99', type: 'int' });
    expect(row(seen.label)).toMatchObject({ value: "'changed'", type: 'str' });
    expect(row(seen.g)).toMatchObject({ value: '5' });
    expect(row(seen.x)).toMatchObject({ value: '10' });
    expect(row(seen.item)).toMatchObject({ value: "'two'" });
    expect(row(seen.entry)).toMatchObject({ value: '[1, 2]', size: 2 });
    // What Python refuses is refused, with Python's reason.
    expect(seen.tuple).toMatch(/^Error: TypeError/);
    expect(seen.norm).toMatch(/^Error: AttributeError/);
    expect(seen.syntax).toMatch(/^Error: SyntaxError/);
    expect(seen.statement).toMatch(/^Error: SyntaxError/);
    expect(row(seen.commented)).toMatchObject({ value: '5' });
    // A method's self is its receiver, which no frame write can replace.
    expect(seen.selfReadOnly).toBe('true');
    expect(seen.self).toBe('Error: self cannot be changed here');
    // The row reads the new value, and the run went on with every change.
    expect(seen.afterRows).toBe('["99"]');
    expect(result.value).toBe("((99, 'changed', 10), 5, [1, 'two', 3], {'k': [1, 2]}, (1, 2))");
  });

  it('writes a local in an outer frame, a closed-over local, and one set inside try:', async () => {
    const nb = notebook('bp-set-frames');
    const answers: string[] = [];
    setHaltHandler(async (request) => {
      const set = (ref: number, name: string, value: string) =>
        request.query(setVariableQuery(request.process, ref, name, value));
      const { frames } = parsePausedStack(
        await request.query(pausedStackQuery(request.process, nb.key)),
      );
      const outer = frames.find((f) => f.name === 'outer');
      if (outer) {
        // Not the innermost frame: the paused one is inner(), called from inside try:.
        answers.push(await set(outer.locals!, 'a', '10'), await set(outer.locals!, 'b', '20'));
      } else {
        answers.push(await set(frames.find((f) => f.name === 'tryer')!.locals!, 'c', '30'));
      }
      return 'continue';
    });

    const result = await runPython(
      [
        'def inner():',
        '    breakpoint()',
        '    return 0',
        'def outer():',
        '    a = 1',
        '    seen = lambda: a',
        '    try:',
        '        b = 2',
        '        inner()',
        '    finally:',
        '        pass',
        '    return a, seen(), b',
        'def tryer():',
        '    c = 1',
        '    try:',
        '        breakpoint()',
        '    finally:',
        '        pass',
        '    return c',
        '(outer(), tryer())',
      ].join('\n'),
      nb,
    );
    closeSessionFor(nb.key);

    expect(answers.map((a) => parseChildren(a)[0]?.value ?? a)).toEqual(['10', '20', '30']);
    // The run read every new value, the closure included.
    expect(result.value).toBe('((10, 10, 20), 30)');
  });

  it('offers Set Value on real locals only: not on a receiver, whatever the def calls it', async () => {
    const nb = notebook('bp-receivers');
    const seen: Array<Record<string, string>> = [];
    setHaltHandler(async (request) => {
      const { frames } = parsePausedStack(
        await request.query(pausedStackQuery(request.process, nb.key)),
      );
      const locals = frames[0].locals!;
      const rows = parseChildren(await request.query(childrenQuery(locals, 0, 500)));
      const set = (name: string, value: string) =>
        request.query(setVariableQuery(request.process, locals, name, value));
      const readOnly = (name: string) => String(rows.find((v) => v.name === name)?.readOnly);
      if (frames[0].name.endsWith('mk')) {
        // A value with a side effect must not run when its row cannot be changed.
        seen.push({
          cls: readOnly('cls'),
          k: readOnly('k'),
          write: await set('cls', 'log.append(9)'),
        });
      } else {
        seen.push({ this: readOnly('this'), j: readOnly('j') });
      }
      return 'continue';
    });

    const result = await runPython(
      [
        'class A:',
        '    @classmethod',
        '    def mk(cls):',
        '        k = 1',
        '        log = []',
        '        breakpoint()',
        '        return log',
        '    def see(this):',
        '        j = 2',
        '        breakpoint()',
        '        return j',
        '(A.mk(), A().see())',
      ].join('\n'),
      nb,
    );
    closeSessionFor(nb.key);

    // Grail may leave a classmethod's cls out of Locals altogether; it is never offered as writable.
    expect(seen[0].cls).not.toBe('false');
    expect(seen[0].write).toMatch(/^Error: cls cannot be changed here/);
    // A method's receiver is read-only whatever the def calls it; its real locals are not.
    expect(seen[1]).toEqual({ this: 'true', j: 'false' });
    // A real local beside the receiver stays writable.
    expect(seen[0].k).toBe('false');
    // Refused before the value ran: log, which the value could see, is unchanged.
    expect(result.value).toBe('([], 2)');
  });

  it('reads a tuple’s and a tuple subclass’s items as read-only, and a list subclass’s as writable', async () => {
    const nb = notebook('bp-tuples');
    const seen: Record<string, PauseVariable[]> = {};
    setHaltHandler(async (request) => {
      const children = async (ref: number) =>
        parseChildren(await request.query(childrenQuery(ref, 0, 500)));
      const { globals } = parsePausedStack(
        await request.query(pausedStackQuery(request.process, nb.key)),
      );
      const rows = await children(globals);
      seen.pt = await children(rows.find((v) => v.name === 'pt')!.ref);
      seen.ll = await children(rows.find((v) => v.name === 'll')!.ref);
      seen.tt = await children(rows.find((v) => v.name === 'tt')!.ref);
      return 'continue';
    });

    await runPython(
      [
        'from collections import namedtuple',
        'Pt = namedtuple("Pt", "x y")',
        'class L(list):',
        '    pass',
        'pt = Pt(1, 2)',
        'll = L([1, 2])',
        'tt = (1, 2)',
        'breakpoint()',
      ].join('\n'),
      nb,
    );
    closeSessionFor(nb.key);

    expect(seen.pt.filter((v) => v.name.startsWith('[')).map((v) => v.readOnly)).toEqual([
      true,
      true,
    ]);
    expect(seen.ll.map((v) => v.readOnly)).toEqual([false, false]);
    // And the common case, a plain tuple.
    expect(seen.tt.map((v) => v.readOnly)).toEqual([true, true]);
  });

  it('lets every Set Value use the globals, with a frame’s locals over them', async () => {
    const nb = notebook('bp-set-globals');
    const seen: Record<string, string> = {};
    setHaltHandler(async (request) => {
      const children = async (ref: number) =>
        parseChildren(await request.query(childrenQuery(ref, 0, 500)));
      const { frames, globals } = parsePausedStack(
        await request.query(pausedStackQuery(request.process, nb.key)),
      );
      const locals = frames[0].locals!;
      const set = (ref: number, name: string, value: string) =>
        request.query(setVariableQuery(request.process, ref, name, value, globals));
      const rows = await children(globals);
      const ref = (name: string) => rows.find((v) => v.name === name)!.ref;
      // A notebook class on an attribute row, a global on a list item and a dict entry.
      seen.attribute = await set(ref('holder'), 'x', 'Point(1, 2)');
      seen.item = await set(ref('items'), '[0]', 'g + 1');
      seen.entry = await set(ref('d'), "'k'", 'g + 1');
      // On a Locals row, a local and a global together.
      seen.sum = await set(locals, 'n', 'n + g');
      // A local shadows the global of the same name.
      seen.shadowed = await set(locals, 'y', 'x');
      // Still refused: a name that is neither.
      seen.unknown = await set(locals, 'z', 'nope');
      return 'continue';
    });

    const result = await runPython(
      [
        'class Point:',
        '    def __init__(self, x, y):',
        '        self.x, self.y = x, y',
        '    def __repr__(self):',
        '        return f"Point({self.x}, {self.y})"',
        'g = 5',
        'x = 100',
        'holder = Point(0, 0)',
        'items = [1, 2]',
        'd = {"k": 0}',
        'def f():',
        '    n = 1',
        '    x = 7',
        '    y = 0',
        '    z = 0',
        '    breakpoint()',
        '    return n, x, y, z',
        '(f(), holder.x, items, d)',
      ].join('\n'),
      nb,
    );
    closeSessionFor(nb.key);

    const value = (raw: string) => (raw.startsWith('Error: ') ? raw : parseChildren(raw)[0]?.value);
    expect(value(seen.attribute)).toBe('Point(1, 2)');
    expect(value(seen.item)).toBe('6');
    expect(value(seen.entry)).toBe('6');
    expect(value(seen.sum)).toBe('6');
    expect(value(seen.shadowed)).toBe('7');
    expect(seen.unknown).toMatch(/^Error: NameError/);
    // The run saw every change, and z was left alone.
    expect(result.value).toBe("((6, 7, 7, 0), Point(1, 2), [6, 2], {'k': 6})");
  });

  it('reads dicts whole: every entry, a page at a time when big, keys told apart', async () => {
    const seen: Record<string, PauseVariable[]> = {};
    const nb = notebook('bp-dicts');
    setHaltHandler(async (request) => {
      const children = async (ref: number, start = 0, count = 500) =>
        parseChildren(await request.query(childrenQuery(ref, start, count)));
      const { globals } = parsePausedStack(
        await request.query(pausedStackQuery(request.process, nb.key)),
      );
      seen.globals = await children(globals);
      const ref = (name: string) => seen.globals.find((v) => v.name === name)!.ref;
      seen.huge = await children(ref('huge'), 1500, 100);
      seen.meta = await children(ref('meta'));
      seen.keys = await children(ref('keys'));
      return 'continue';
    });

    await runPython(
      [
        'huge = {i: i * 2 for i in range(2000)}',
        'meta = {"__version__": "1.0", "name": "x"}',
        'keys = {1: "int", "1": "str", "a\x1fb": "odd"}',
        'breakpoint()',
      ].join('\n'),
      nb,
    );

    // More entries than one page: reported as indexed, so VS Code pages them.
    const huge = seen.globals.find((v) => v.name === 'huge')!;
    expect(huge).toMatchObject({ indexed: 2000, named: 0 });
    expect(seen.huge).toHaveLength(100);
    expect(seen.huge[0]).toMatchObject({ name: '1500', value: '3000' });
    // Dunder keys are hidden only in a namespace; in a dict they are data.
    expect(seen.globals.find((v) => v.name === 'meta')).toMatchObject({ named: 2 });
    expect(seen.meta.map((v) => v.name).sort()).toEqual(["'__version__'", "'name'"]);
    // 1 and '1' differ, and a separator character in a key shifts nothing.
    expect(seen.keys.map((v) => [v.name, v.value])).toEqual(
      expect.arrayContaining([
        ['1', "'int'"],
        ["'1'", "'str'"],
        ["'a\\x1fb'", "'odd'"],
      ]),
    );
  });

  it('stops running getters once one runs past the budget, and says which', async () => {
    const nb = notebook('bp-getters');
    const seen: Record<string, PauseVariable[]> = {};
    let took = 0;
    setHaltHandler(async (request) => {
      const children = async (ref: number) =>
        parseChildren(await request.query(childrenQuery(ref, 0, 500)));
      const { globals } = parsePausedStack(
        await request.query(pausedStackQuery(request.process, nb.key)),
      );
      const rows = await children(globals);
      const started = Date.now();
      seen.s = await children(rows.find((v) => v.name === 's')!.ref);
      took = Date.now() - started;
      seen.d = await children(rows.find((v) => v.name === 'd')!.ref);
      return 'continue';
    });

    const result = await runPython(
      [
        'class Slow:',
        '    def __init__(self):',
        '        self.own = 2',
        '    @property',
        '    def a(self):',
        '        while True:',
        '            pass',
        '    @property',
        '    def b(self):',
        '        while True:',
        '            pass',
        '    @property',
        '    def fast(self):',
        '        return 1',
        'class SpinDir:',
        '    def __init__(self):',
        '        self.x = 1',
        '    def __dir__(self):',
        '        while True:',
        '            pass',
        's = Slow()',
        'd = SpinDir()',
        'breakpoint()',
        '"went on"',
      ].join('\n'),
      nb,
    );
    closeSessionFor(nb.key);

    const value = (rows: PauseVariable[], name: string) => rows.find((v) => v.name === name)?.value;
    // The getter the break stopped, and the one after it, say so; neither is left out.
    expect(value(seen.s, 'a')).toBe('<getter took too long>');
    expect(value(seen.s, 'b')).toBe('<getter took too long>');
    expect(seen.s.map((v) => v.name)).toContain('fast');
    // What the object holds itself needs no getter, so it still reads.
    expect(value(seen.s, 'own')).toBe('2');
    // One budget, not one per slow getter.
    expect(took).toBeLessThan(3500);
    // A __dir__ that never returns leaves the object's own attributes, not nothing.
    expect(value(seen.d, 'x')).toBe('1');
    expect(result.value).toBe("'went on'");
  });

  it('gives up on a __repr__ that never returns, keeping the other rows and the pause', async () => {
    let rows: PauseVariable[] = [];
    let took = 0;
    const nb = notebook('bp-spin');
    setHaltHandler(async (request) => {
      const { globals } = parsePausedStack(
        await request.query(pausedStackQuery(request.process, nb.key)),
      );
      const started = Date.now();
      rows = parseChildren(await request.query(childrenQuery(globals, 0, 500)));
      took = Date.now() - started;
      return 'continue';
    });

    const result = await runPython(
      [
        'class Spin:',
        '    def __repr__(self):',
        '        while True:',
        '            pass',
        'a_spin = Spin()',
        'b_after = 7',
        'breakpoint()',
        '"went on"',
      ].join('\n'),
      nb,
    );

    expect(rows.find((v) => v.name === 'a_spin')?.value).toBe('<__repr__ took too long>');
    expect(rows.find((v) => v.name === 'b_after')?.value).toBe('7');
    expect(took).toBeLessThan(10_000);
    expect(result.value).toBe("'went on'");
  });

  it('keeps the cell’s print() when a __repr__ read from the debugger reaches breakpoint()', async () => {
    let failed = false;
    const nb = notebook('bp-nested');
    setHaltHandler(async (request) => {
      const { globals } = parsePausedStack(
        await request.query(pausedStackQuery(request.process, nb.key)),
      );
      await request.query(childrenQuery(globals, 0, 500)).catch(() => (failed = true));
      return 'continue';
    });
    const printed: string[] = [];

    const result = await runPython(
      [
        'class Nested:',
        '    def __repr__(self):',
        '        breakpoint()',
        '        return "n"',
        'n = Nested()',
        'breakpoint()',
        'print("still printing")',
        '"done"',
      ].join('\n'),
      nb,
      (chunk) => printed.push(chunk),
    );

    expect(failed).toBe(true);
    expect(printed.join('')).toBe('still printing\n');
    expect(result.value).toBe("'done'");
  });

  it('saves a paused object under gemdb.root, for other sessions once the notebook commits', async () => {
    const nb = notebook('bp-save');
    const other = notebook('bp-save-other');
    const seen: Record<string, string> = {};
    setHaltHandler(async (request) => {
      const { globals } = parsePausedStack(
        await request.query(pausedStackQuery(request.process, nb.key)),
      );
      const rows = parseChildren(await request.query(childrenQuery(globals, 0, 500)));
      const row = (name: string) => rows.find((v) => v.name === name)!;
      const suggestion = parseSaveSuggestion(
        await request.query(saveSuggestionQuery(row('e').handle)),
      );
      seen.type = suggestion.type;
      seen.label = suggestion.label ?? '';
      seen.free = unquote(await request.query(freeKeyQuery('employee_barbara')));
      seen.saved = unquote(await request.query(saveToRootQuery(row('e').handle, seen.free)));
      // A plain value has no children, and is saved all the same.
      seen.leaf = unquote(await request.query(saveToRootQuery(row('count').handle, 'bp_count')));
      seen.taken = await request.query(keyTakenQuery(seen.free));
      // Not committed, so only the paused notebook's own session can inspect it.
      seen.inspected = await request.query(inspectQuery(seen.free, false));
      // Taking back a save not yet committed leaves nothing behind.
      await request.query(saveToRootQuery(row('count').handle, 'bp_taken_back'));
      seen.takenBack = unquote(await request.query(removeSavedQuery(['bp_taken_back'])));
      seen.stillThere = await request.query(keyTakenQuery('bp_taken_back'));
      return 'continue';
    });

    await runPython(
      [
        'import gemdb',
        'class E:',
        '    def __init__(self, name):',
        '        self.name = name',
        'e = E("Barbara")',
        'count = 42',
        'gemdb.root["employee_barbara"] = "taken already"',
        'breakpoint()',
      ].join('\n'),
      nb,
    );
    const sameNotebook = await runPython('gemdb.root[' + JSON.stringify(seen.free) + '].name', nb);
    const beforeCommit = await runPython(
      `import gemdb\n${JSON.stringify(seen.free)} in gemdb.root`,
      other,
    );
    const dirtyBeforeCommit = await sessionForIfOpen(nb.key)!.executeAsync(needsCommitQuery());
    const committed = await sessionForIfOpen(nb.key)!.executeAsync(commitQuery());
    const dirtyAfterCommit = await sessionForIfOpen(nb.key)!.executeAsync(needsCommitQuery());
    const afterCommit = await runPython(
      `gemdb.abort()\nx = gemdb.root[${JSON.stringify(seen.free)}]\n(x.name, type(x).__name__, gemdb.root["bp_count"])`,
      other,
    );
    const listing = parseChildren(await executeAsync(rootListingQuery()));
    const [committedSelf, ...committedChildren] = parseChildren(
      await executeAsync(inspectQuery(seen.free, true)),
    );
    const missing = await executeAsync(inspectQuery('no_such_key', true));
    const removed = unquote(await executeAsync(removeCommittedQuery(['bp_count', seen.free])));
    const afterRemove = await runPython(
      `gemdb.abort()\n("bp_count" in gemdb.root, ${JSON.stringify(seen.free)} in gemdb.root)`,
      other,
    );

    expect(seen).toMatchObject({ type: 'E', label: 'Barbara', saved: 'saved', leaf: 'saved' });
    // The suggested key steps past one already in use.
    expect(seen.free).toBe('employee_barbara_2');
    expect(seen.taken).toBe('true');
    expect(seen.takenBack).toBe('removed');
    expect(seen.stillThere).toBe('false');
    expect(sameNotebook.value).toBe("'Barbara'");
    expect(beforeCommit.value).toBe('False');
    expect(dirtyBeforeCommit).toBe('true');
    expect(unquote(committed)).toBe('committed');
    expect(dirtyAfterCommit).toBe('false');
    expect(afterCommit.value).toBe("('Barbara', 'E', 42)");
    expect(listing.find((v) => v.name === 'employee_barbara_2')).toMatchObject({ type: 'E' });
    expect(listing.find((v) => v.name === 'bp_count')).toMatchObject({ value: '42', type: 'int' });
    const [pendingSelf, ...pendingChildren] = parseChildren(seen.inspected);
    expect(pendingSelf).toMatchObject({ name: 'value', type: 'E', named: 1 });
    expect(pendingChildren.map((c) => [c.name, c.value])).toEqual([['name', "'Barbara'"]]);
    expect(committedSelf).toMatchObject({ type: 'E' });
    expect(committedChildren.map((c) => c.name)).toEqual(['name']);
    expect(missing).toMatch(/^Error: KeyError/);
    // Removing committed entries commits that removal alone, all of them at once, for every session.
    expect(removed).toBe('removed');
    expect(afterRemove.value).toBe('(False, False)');
  });

  it('aborts an addition from the paused notebook, so no session ever sees it', async () => {
    const nb = notebook('bp-abort');
    const other = notebook('bp-abort-other');
    const seen: Record<string, string> = {};
    setHaltHandler(async (request) => {
      const { globals } = parsePausedStack(
        await request.query(pausedStackQuery(request.process, nb.key)),
      );
      const rows = parseChildren(await request.query(childrenQuery(globals, 0, 500)));
      await request.query(
        saveToRootQuery(rows.find((v) => v.name === 'draft')!.handle, 'bp_draft'),
      );
      seen.dirty = await request.query(needsCommitQuery());
      seen.aborted = unquote(await request.query(abortQuery()));
      seen.clean = await request.query(needsCommitQuery());
      seen.there = await request.query(keyTakenQuery('bp_draft'));
      return 'continue';
    });

    await runPython('draft = [1, 2, 3]\nbreakpoint()', nb);
    const elsewhere = await runPython('import gemdb\n"bp_draft" in gemdb.root', other);

    expect(seen).toEqual({ dirty: 'true', aborted: 'aborted', clean: 'false', there: 'false' });
    expect(elsewhere.value).toBe('False');
  });

  it('saves a paused stack under gemdb.root and opens it again from another session after a commit', async () => {
    const nb = notebook('bp-stack');
    const other = notebook('bp-stack-other');
    const cellText = [
      'class Employee:',
      '    def __init__(self, name, reports=()):',
      '        self.name = name',
      '        self.reports = list(reports)',
      '    def find(self, name, depth=0):',
      '        if self.name == name:',
      '            breakpoint()',
      '            return self',
      '        for r in self.reports:',
      '            found = r.find(name, depth + 1)',
      '            if found:',
      '                return found',
      '        return None',
      'ceo = Employee("Ada", [Employee("Grace", [Employee("Barbara")])])',
      'ceo.find("Barbara")',
    ].join('\n');
    let saved = '';
    let frameNames: string[] = [];
    setHaltHandler(async (request) => {
      const { frames } = parsePausedStack(
        await request.query(pausedStackQuery(request.process, nb.key)),
      );
      frameNames = frames.map((f) => f.name);
      const savedFrames: SavedFrame[] = frames.map((f) => ({
        name: f.name,
        line: f.line,
        column: f.column + 1,
        end_column: null,
        source_name: 'Cell [1]',
        path: 'vscode-notebook-cell:/gone/bp-stack.ipynb#W0',
        text: cellText,
      }));
      saved = unquote(
        await request.query(
          saveStackQuery(
            'stack_bp',
            {
              label: 'bp-stack.ipynb',
              notebook: nb.key,
              saved_at: '2026-10-01 16:20',
              description: 'Saved at breakpoint()',
            },
            savedFrames,
            frames.map((f) => f.locals ?? 0),
            nb.key,
          ),
        ),
      );
      return 'continue';
    });

    await runPython(cellText, nb);
    setHaltHandler(undefined);
    // The save is in the notebook's transaction; nothing is visible elsewhere until it commits.
    const beforeCommit = await runPython('import gemdb\n"stack_bp" in gemdb.root', other);
    await sessionForIfOpen(nb.key)!.executeAsync(commitQuery());
    const notebookGlobals = await runPython(
      '[k for k in globals() if k.startswith("___gemdb")]',
      nb,
    );
    const opened = parseOpenedStack(await executeAsync(openStackQuery('stack_bp')));
    const findLocals = parseChildren(await executeAsync(childrenQuery(opened.locals[0], 0, 500)));
    const globalsRows = parseChildren(await executeAsync(childrenQuery(opened.globals, 0, 500)));
    const stacks = JSON.parse(await executeAsync(savedStackKeysQuery())) as Array<{
      key: string;
      label: string;
      saved_at: string;
      frames: number;
    }>;
    // A stack is told apart by what it holds, never by its key: rename one, and fake one.
    await runPython(
      'import gemdb\ngemdb.abort()\ngemdb.root["my notes"] = gemdb.root["stack_bp"]\ngemdb.root["stack_not_really"] = {"frames": [1]}\ngemdb.commit()\n1',
      other,
    );
    const afterRename = (
      JSON.parse(await executeAsync(savedStackKeysQuery())) as Array<{ key: string }>
    ).map((stack) => stack.key);
    const renamed = parseOpenedStack(await executeAsync(openStackQuery('my notes')));
    const fromPython = await runPython(
      'import gemdb\ngemdb.abort()\ns = gemdb.root["stack_bp"]\n(s["kind"], len(s["frames"]), s["frames"][0]["name"], sorted(s["frames"][0]["locals"].keys()), s["frames"][0]["locals"]["self"].name)',
      other,
    );

    expect(saved).toBe('saved');
    expect(beforeCommit.value).toBe('False');
    // The temporary bindings the save used are gone from the notebook.
    expect(notebookGlobals.value).toBe('[]');
    expect(opened.meta.frames.map((f) => f.name)).toEqual(frameNames);
    expect(opened.meta.frames[0]).toMatchObject({ name: 'Employee.find', line: 7, text: cellText });
    expect(opened.meta.saved_at).toBe('2026-10-01 16:20');
    expect(findLocals.map((v) => [v.name, v.value])).toEqual(
      expect.arrayContaining([
        ['name', "'Barbara'"],
        ['depth', '2'],
      ]),
    );
    expect(findLocals.find((v) => v.name === 'self')).toMatchObject({ type: 'Employee' });
    expect(globalsRows.map((v) => v.name)).toEqual(expect.arrayContaining(['ceo']));
    expect(globalsRows.map((v) => v.name).filter((n) => n.startsWith('___gemdb'))).toEqual([]);
    expect(stacks).toContainEqual({
      key: 'stack_bp',
      label: 'bp-stack.ipynb',
      saved_at: '2026-10-01 16:20',
      frames: 4,
    });
    expect(afterRename).toEqual(expect.arrayContaining(['stack_bp', 'my notes']));
    expect(afterRename).not.toContain('stack_not_really');
    expect(renamed.meta.frames.map((f) => f.name)).toEqual(frameNames);
    expect(fromPython.value).toBe(
      "('gemdb.stack', 4, 'Employee.find', ['depth', 'name', 'self'], 'Barbara')",
    );
  });

  it('runs a .py file as __main__, pausing in its own frames with its globals, and saves that stack', async () => {
    // The tests before this one leave their notebooks' sessions open, and the database has ten.
    for (const info of sessionRegistry()) {
      if (info.owner.kind === 'notebook' && info.owner.key !== NB.key)
        closeSessionFor(info.owner.key);
    }
    const file = path.join(fixture!.root, 'bpjob.py');
    const lines = [
      'import gemdb',
      'total = 10',
      'bonus = 0',
      'def step(n):',
      '    x = n * 2',
      '    breakpoint()',
      '    return x',
      'print("as", __name__)',
      'total = total + step(3)',
      'print("total", total)',
      'print("bonus", bonus)',
    ];
    fs.writeFileSync(file, lines.join('\n'));
    const owner = fileOwner(file);
    let frames: Array<[string, string, number]> = [];
    let locals: string[] = [];
    let globalNames: string[] = [];
    let saved = '';
    let setGlobal = '';
    setHaltHandler(async (request) => {
      const stack = parsePausedStack(
        await request.query(pausedStackQuery(request.process, MAIN_MODULE)),
      );
      frames = stack.frames.map((f) => [f.name, f.file, f.line]);
      locals = parseChildren(
        await request.query(childrenQuery(stack.frames[0].locals!, 0, 50)),
      ).map((v) => `${v.name}=${v.value}`);
      const globalRows = parseChildren(await request.query(childrenQuery(stack.globals, 0, 50)));
      globalNames = globalRows.map((v) => v.name);
      saved = unquote(
        await request.query(
          saveStackQuery(
            'stack_bpjob',
            { label: 'bpjob.py', notebook: owner.key, saved_at: 'now', description: null },
            stack.frames.map((f) => ({
              name: f.name,
              line: f.line,
              column: f.column + 1,
              end_column: null,
              source_name: 'bpjob.py',
              path: f.file,
              text: lines.join('\n'),
            })),
            stack.frames.map((f) => f.locals ?? 0),
            MAIN_MODULE,
          ),
        ),
      );
      // A file run's globals are its __main__ module's: Set Value writes the module, and the run reads it.
      setGlobal = await request.query(
        setVariableQuery(request.process, stack.globals, 'bonus', '7'),
      );
      return 'continue';
    });
    const printed: string[] = [];

    const result = await runPythonFile(file, owner, (chunk) => printed.push(chunk));
    setHaltHandler(undefined);
    await sessionForIfOpen(owner.key)!.executeAsync(commitQuery());
    const opened = parseOpenedStack(await executeAsync(openStackQuery('stack_bpjob')));
    const savedGlobals = parseChildren(await executeAsync(childrenQuery(opened.globals, 0, 50)));
    const failed = await runPythonFile(
      (fs.writeFileSync(file, 'print("a")\n1/0\n'), file),
      owner,
      () => {},
    );
    closeSessionFor(owner.key);

    expect(frames).toEqual([
      ['step', file, 6],
      ['<module>', file, 9],
    ]);
    expect(locals).toEqual(['n=3', 'x=6']);
    // The script's globals, data first; dunders such as __name__ are left out.
    expect(globalNames).toEqual(expect.arrayContaining(['total']));
    expect(globalNames.filter((n) => n.startsWith('__') && n.endsWith('__'))).toEqual([]);
    expect(parseChildren(setGlobal)[0]).toMatchObject({ name: 'bonus', value: '7' });
    expect(printed.join('')).toBe('as __main__\ntotal 16\nbonus 7\n');
    expect(result.value).toBe('');
    expect(saved).toBe('saved');
    expect(opened.meta.frames.map((f) => f.name)).toEqual(['step', '<module>']);
    expect(savedGlobals.find((v) => v.name === 'total')?.value).toBe('10');
    expect(failed.value).toBe('Error: ZeroDivisionError - division by zero');
  });

  it('ends the cell on Stop, and the session is still usable', async () => {
    const printed: string[] = [];
    answering('stop', printed);

    const result = await runPython(CELL, NB, (chunk) => printed.push(chunk));

    expect(result.value).toBe('Error: Stopped in the debugger.');
    expect(printed.join('')).toBe('before\n');
    setHaltHandler(undefined);
    expect((await runPython('6 * 7', NB)).value).toBe('42');
  });

  it('names frames from an imported file by path, and qualifies methods by class', async () => {
    const dir = fixture!.root;
    fs.writeFileSync(
      path.join(dir, 'bpmod.py'),
      [
        'def helper(f):',
        '    return f()',
        'class C:',
        '    def m(self):',
        '        breakpoint()',
        '        return 7',
      ].join('\n'),
    );
    const seen = answering('continue', []);

    const result = await runPython(
      [
        'import sys',
        `sys.path.insert(0, ${JSON.stringify(dir)})`,
        'import bpmod',
        'def go():',
        '    return bpmod.helper(lambda: bpmod.C().m())',
        'go()',
      ].join('\n'),
      NB,
    );

    expect(seen.frames.map((f) => f.name)).toEqual(['C.m', '<lambda>', 'helper', 'go', '<module>']);
    expect(seen.frames[0].file).toBe(path.join(dir, 'bpmod.py'));
    expect(seen.frames[0].line).toBe(5);
    expect(seen.frames[2].file).toBe(path.join(dir, 'bpmod.py'));
    expect(seen.frames[1].file).toBe('<grail>');
    expect(result.value).toBe('7');
  });

  it('turns an interrupt while paused into KeyboardInterrupt and tells the handler', async () => {
    let cancelled = false;
    setHaltHandler(
      (request) =>
        new Promise<HaltAnswer>(() => {
          request.onCancel(() => {
            cancelled = true;
          });
          setTimeout(() => interruptSessionFor(NB.key), 50);
        }),
    );

    const result = await runPython('breakpoint()\n"not reached"', NB);

    expect(result.value).toBe('Error: KeyboardInterrupt - ');
    expect(cancelled).toBe(true);
    setHaltHandler(undefined);
    expect((await runPython('1 + 1', NB)).value).toBe('2');
  });

  it('fails the run cleanly when the session is closed while paused', async () => {
    let cancelled = false;
    setHaltHandler(
      (request) =>
        new Promise<HaltAnswer>(() => {
          request.onCancel(() => {
            cancelled = true;
          });
          setTimeout(() => closeSessionFor(NB.key), 50);
        }),
    );

    await expect(runPython('breakpoint()', NB)).rejects.toThrow(/closed while paused/);
    expect(cancelled).toBe(true);
  });

  it('says where it was and carries on where no debugger is installed, as in the GemDB Shell', async () => {
    const printed: string[] = [];
    const result = await runPython(
      'def f():\n    breakpoint()\n    return "went on"\nf()',
      NB,
      (chunk) => printed.push(chunk),
    );
    expect(printed.join('')).toBe(
      'breakpoint() at line 2: the debugger opens in notebooks and Debug Python File in GemDB; continuing.\n',
    );
    expect(result.value).toBe("'went on'");
  });
});
