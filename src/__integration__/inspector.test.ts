import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stageGrail } from '../grail';
import {
  classQuery,
  dropInspectorRegistryQuery,
  inspectorEvaluateQuery,
  inspectorRegistry,
  openQuery,
  parseClassInfo,
  parseHeader,
  parseRepr,
  parseSource,
  reprQuery,
  sourceAt,
  sourceQuery,
} from '../inspectorQueries';
import {
  childrenQuery,
  keyPositionQuery,
  parseChildren,
  parseConsoleReply,
  parseSaveSuggestion,
  saveSuggestionQuery,
  saveToRootQuery,
  setVariableQuery,
} from '../pauseVariables';
import { ensureProcesses, isRunning, stopNetldi, stopStone } from '../processes';
import { runPython } from '../pythonQueries';
import { SessionOwner, logoutAll, sessionFor } from '../session';
import { escapeString } from '../smalltalkText';
import { createDatabaseWithPython, Fixture, haveTestExtent, makeFixture } from './fixture';

/**
 * The Inspector's queries against a real database, in a notebook's session,
 * as the panel runs them (src/inspector.ts): an object is put in a registry,
 * opened into the Inspector's own, and read tab by tab — its rows, its repr,
 * its class, a method's source — then evaluated against, edited, and put back.
 */

const ext = process.cwd();
const haveExtent = haveTestExtent();

const nb: SessionOwner = {
  key: 'file:///inspector.ipynb',
  kind: 'notebook',
  label: 'inspector.ipynb',
};

/** The panel registry the tests read through, as one Inspector panel would. */
const REG = inspectorRegistry();

/** The registry the test hands objects over in, standing in for the pause's or Persisted Objects'. */
const SOURCE = 'GemDbInspectorTestRefs';

const CELL = [
  'class Point:',
  '    """A point in the plane."""',
  '    scale = 1',
  '    def __init__(self, x, y):',
  '        self.x, self.y = x, y',
  '        self.tags = {"origin": x == 0 and y == 0}',
  '    def norm(self):',
  '        return (self.x ** 2 + self.y ** 2) ** 0.5',
  '    @classmethod',
  '    def origin(cls):',
  '        return cls(0, 0)',
  '    @property',
  '    def doubled(self):',
  '        return Point(self.x * 2, self.y * 2)',
  '',
  'p = Point(3, 4)',
  'big = list(range(250))',
  'table = {"SKU%04d" % i: i for i in range(300)}',
  'text = "two\\nlines"',
  'class Status:',
  '    def __repr__(self):',
  '        return "Error: 404"',
  'status = Status()',
  'class Base:',
  '    def hello(self):',
  '        return "base"',
  'class Config(Base):',
  '    pass',
  'BaseConfig = Config',
  'class Config(BaseConfig):',
  '    class Options:',
  '        pass',
  '    def hello(self):',
  '        return "config"',
  'config = Config()',
  'limit = 10',
].join('\n');

let fixture: Fixture | undefined;

beforeAll(async () => {
  if (!haveExtent) return;
  fixture = makeFixture();
  if (!fixture) return;
  createDatabaseWithPython(fixture);
  stageGrail(ext);
  await ensureProcesses();
  await runPython(CELL, nb);
});

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

const run = (code: string): Promise<string> => sessionFor(nb).executeAsync(code);

/** Put the notebook's global `name` in the test's registry, and answer its position there. */
async function handOver(name: string): Promise<number> {
  return Number(
    await run(`| reg scope |
scope := (SessionTemps current at: #'__gemdbScopes') at: '${escapeString(nb.key)}'.
reg := SessionTemps current at: #'${SOURCE}' otherwise: nil.
reg isNil ifTrue: [reg := OrderedCollection new. SessionTemps current at: #'${SOURCE}' put: reg].
reg add: (scope at: #'${name}').
reg size printString encodeAsUTF8`),
  );
}

/** Open the notebook's global `name` in the Inspector, as the panel does on `ready`. */
async function open(name: string) {
  return parseHeader(await run(openQuery(SOURCE, await handOver(name), REG)));
}

const rows = async (handle: number, start = 0, count = 100) =>
  parseChildren(await run(childrenQuery(handle, start, count, REG)));

describe.skipIf(!haveExtent || !canMakeFixture())('the Inspector against a real database', () => {
  it("opens an object: its type, kind, module, OOP, and that it isn't committed", async () => {
    const header = await open('p');
    expect(header.row.type).toBe('Point');
    expect(header.row.kind).toBe('obj');
    expect(header.row.handle).toBeGreaterThan(0);
    expect(header.module).not.toBe('');
    expect(Number(header.oop)).toBeGreaterThan(0);
    expect(header.committed).toBe(false);
    expect(header.isClass).toBe(false);
  });

  it('refuses a handle that is not there', async () => {
    await expect(run(openQuery(SOURCE, 9999, REG)).then(parseHeader)).rejects.toThrow(
      'no longer available',
    );
  });

  it("lists an object's attributes as the Variables view does, with its groups", async () => {
    const header = await open('p');
    const listed = await rows(header.row.handle, 0, 500);
    const names = listed.map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining(['x', 'y', 'tags', 'doubled', 'special variables']),
    );
    expect(listed.find((r) => r.name === 'x')?.value).toBe('3');
    const functions = listed.find((r) => r.name === 'function variables');
    expect(functions && functions.ref).toBeGreaterThan(0);
    const inside = await rows(functions!.ref, 0, 500);
    expect(inside.map((r) => r.name)).toEqual(expect.arrayContaining(['norm', 'origin']));
  });

  it('reads a page of a list from where it is asked', async () => {
    const header = await open('big');
    expect(header.row.kind).toBe('seq');
    expect(header.row.size).toBe(250);
    const page = await rows(header.row.handle, 200, 100);
    expect(page.map((r) => r.name)).toEqual(Array.from({ length: 50 }, (_, i) => `[${200 + i}]`));
  });

  it('finds a dict entry by its key, as Go to does', async () => {
    const header = await open('table');
    expect(header.row.kind).toBe('dict');
    const pos = Number(await run(keyPositionQuery(header.row.handle, ["'SKU0042'"], REG)));
    expect(pos).toBeGreaterThanOrEqual(0);
    const [found] = await rows(header.row.handle, pos, 1);
    expect(found?.name).toBe("'SKU0042'");
    expect(found?.value).toBe('42');
  });

  it("shows a str's repr, and its str() beside it when they differ", async () => {
    const header = await open('text');
    const text = parseRepr(await run(reprQuery(header.row.handle, REG)));
    expect(text.repr).toBe("'two\\nlines'");
    expect(text.str).toBe('two\nlines');
    expect(text.cut).toBe(false);
    const point = parseRepr(await run(reprQuery((await open('p')).row.handle, REG)));
    expect(point.repr).toMatch(/^<(__main__\.)?Point object at /);
  });

  // CPython says __main__ for a class a notebook cell defines; Grail says builtins (measured
  // 2026-10-19, Grail a78e8c0), so the Class tab's Module reads builtins. Flips when Grail is fixed.
  it.fails("reports a notebook class's module as __main__", async () => {
    const header = await open('p');
    expect(header.module).toBe('__main__');
  });

  // What Grail says today, so the day it changes this goes red and names what it changed to.
  it("reports a notebook class's module as builtins, on today's Grail", async () => {
    expect((await open('p')).module).toBe('builtins');
  });

  it('opens a class as a class, and describes it rather than its metaclass', async () => {
    const header = await open('Point');
    expect(header.isClass).toBe(true);
    const info = parseClassInfo(await run(classQuery(header.row.handle, REG)));
    expect(info.isClass).toBe(true);
    expect(info.name).toBe('Point');
  });

  it('describes the class: its MRO, its docstring, and what each class defines', async () => {
    const info = parseClassInfo(await run(classQuery((await open('p')).row.handle, REG)));
    expect(info.name).toBe('Point');
    expect(info.module).toBe((await open('p')).module);
    expect(info.doc).toBe('A point in the plane.');
    expect(info.isClass).toBe(false);
    expect(info.mro[info.mro.length - 1]).toBe('object');
    expect(info.mro[0]).toMatch(/(^|\.)Point$/);
    const kinds = Object.fromEntries(info.members.map((m) => [m.name, m.kind]));
    expect(kinds).toMatchObject({
      norm: 'method',
      origin: 'classmethod',
      doubled: 'property',
      scale: 'attribute',
    });
  });

  it('says where a notebook method was defined, since Python can read no source for it', async () => {
    const answer = parseSource(
      await run(sourceQuery((await open('p')).row.handle, 0, 'Point', 'norm', REG)),
    );
    expect(answer).toMatchObject({ kind: 'where', file: '<grail>', line: 7 });
    const lines = CELL.split('\n');
    expect(answer.kind === 'where' && sourceAt(lines, answer.line, 'norm')).toBe(
      ['    def norm(self):', '        return (self.x ** 2 + self.y ** 2) ** 0.5'].join('\n'),
    );
    const origin = parseSource(
      await run(sourceQuery((await open('p')).row.handle, 0, 'Point', 'origin', REG)),
    );
    expect(origin.kind === 'where' && sourceAt(lines, origin.line, 'origin')).toBe(
      ['    @classmethod', '    def origin(cls):', '        return cls(0, 0)'].join('\n'),
    );
  });

  it("answers Grail's Smalltalk for a built-in method, every arity of it", async () => {
    const table = (await open('table')).row.handle;
    const get = parseSource(await run(sourceQuery(table, 0, 'dict', 'get', REG)));
    expect(get.kind).toBe('smalltalk');
    if (get.kind === 'smalltalk') {
      expect(get.className).toBe('KeyValueDictionary');
      expect(get.sources.map((t) => t.split('\n')[0])).toEqual(['get: key', 'get: key _: default']);
    }
    const add = parseSource(
      await run(sourceQuery((await open('big')).row.handle, 0, 'list', '__add__', REG)),
    );
    expect(add.kind === 'smalltalk' && add.sources[0]).toMatch(/^__add__: other/);
  });

  it("evaluates with self bound, among the notebook's names", async () => {
    const handle = (await open('p')).row.handle;
    const value = parseConsoleReply(
      await run(inspectorEvaluateQuery(handle, 'self.norm()', nb.key, REG)),
    );
    expect(value.kind).toBe('value');
    expect(value.kind === 'value' && value.row.value).toBe('5.0');
    const made = parseConsoleReply(
      await run(inspectorEvaluateQuery(handle, 'Point(self.y, self.x).x', nb.key, REG)),
    );
    expect(made.kind === 'value' && made.row.value).toBe('4');
    // The result is registered in the Inspector's own registry, so Inspect It can open it.
    const opened = parseConsoleReply(
      await run(inspectorEvaluateQuery(handle, 'self.tags', nb.key, REG)),
    );
    expect(opened.kind).toBe('value');
    if (opened.kind === 'value') {
      const header = parseHeader(await run(openQuery(REG, opened.row.handle, REG)));
      expect(header.row.type).toBe('dict');
    }
  });

  it('answers what was printed, and an error as a traceback', async () => {
    const handle = (await open('p')).row.handle;
    const printed = parseConsoleReply(
      await run(inspectorEvaluateQuery(handle, 'print("hi")', nb.key, REG)),
    );
    expect(printed.kind).toBe('none');
    expect(printed.output).toBe('hi\n');
    const failed = parseConsoleReply(
      await run(inspectorEvaluateQuery(handle, 'self.x / 0', nb.key, REG)),
    );
    expect(failed.kind).toBe('error');
    expect(failed.kind === 'error' && failed.error.type).toBe('ZeroDivisionError');
  });

  it("does not leave a name it binds in the notebook's globals", async () => {
    const handle = (await open('p')).row.handle;
    const reply = parseConsoleReply(
      await run(inspectorEvaluateQuery(handle, '_inspector_only = 1', nb.key, REG)),
    );
    // It ran: a statement answers none. A broken line would answer an error and prove nothing.
    expect(reply.kind).toBe('none');
    const result = await runPython('"_inspector_only" in globals()', nb);
    expect(result.value).toBe('False');
  });

  it('changes an attribute from an expression, and puts the first value back', async () => {
    const handle = (await open('p')).row.handle;
    const before = (await rows(handle, 0, 500)).find((r) => r.name === 'x')!;
    const changed = await run(setVariableQuery(0n, handle, 'x', 'self_x = 10', 0, REG));
    expect(changed).toMatch(/^Error: /);
    const written = await run(setVariableQuery(0n, handle, 'x', '7 + 3', 0, REG));
    expect(parseChildren(written)[0]?.value).toBe('10');
    expect((await runPython('p.x', nb)).value).toBe('10');
    const back = await run(setVariableQuery(0n, handle, 'x', '', 0, REG, before.handle));
    expect(parseChildren(back)[0]?.value).toBe('3');
    expect((await runPython('p.x', nb)).value).toBe('3');
  });

  it("adds an Inspector's object under gemdb.root, as Add to Persisted Objects… does", async () => {
    const handle = (await open('p')).row.handle;
    expect(parseSaveSuggestion(await run(saveSuggestionQuery(handle, REG))).type).toBe('Point');
    expect(await run(saveToRootQuery(handle, 'inspected_p', REG))).toBe("'saved'");
    expect((await runPython('import gemdb\ngemdb.root["inspected_p"] is p', nb)).value).toBe(
      'True',
    );
    await runPython('import gemdb\ndel gemdb.root["inspected_p"]', nb);
  });

  it('reads a repr that itself starts "Error: " as the repr it is', async () => {
    const text = parseRepr(await run(reprQuery((await open('status')).row.handle, REG)));
    expect(text.repr).toBe('Error: 404');
  });

  it('reports __bases__, and tells two classes of one name in the MRO apart', async () => {
    const handle = (await open('config')).row.handle;
    const info = parseClassInfo(await run(classQuery(handle, REG)));
    expect(info.bases).toEqual(['Config']);
    expect(info.mro.map((m) => m.split('.').pop())).toEqual(['Config', 'Config', 'Base', 'object']);
    const hello = info.members.filter((m) => m.name === 'hello');
    expect(hello.map((m) => m.ownerIndex)).toEqual([0, 2]);
    // The nearer Config's own source, and Base's, by MRO position.
    const near = parseSource(await run(sourceQuery(handle, 0, 'Config', 'hello', REG)));
    expect(near.kind).toBe('where');
    const base = parseSource(await run(sourceQuery(handle, 2, 'Base', 'hello', REG)));
    expect(base.kind === 'where' && base.line).not.toBe(near.kind === 'where' && near.line);
  });

  it('says a class attribute has no source of its own, and finds where a nested class is', async () => {
    const handle = (await open('p')).row.handle;
    const scale = parseSource(await run(sourceQuery(handle, 0, 'Point', 'scale', REG)));
    expect(scale).toMatchObject({ kind: 'text' });
    expect(scale.kind === 'text' && scale.text).toMatch(/class attribute.*\nscale = 1$/s);
    const nested = parseSource(
      await run(sourceQuery((await open('config')).row.handle, 0, 'Config', 'Options', REG)),
    );
    // Grail records where a class begins (__firstlineno__) — or says it does not.
    expect(
      (nested.kind === 'where' && nested.isClass === true) ||
        (nested.kind === 'text' && /not recorded/.test(nested.text)),
    ).toBe(true);
  });

  it("runs an edit's expression with self and the notebook's names, then stores it by handle", async () => {
    const handle = (await open('p')).row.handle;
    const reply = parseConsoleReply(
      await run(inspectorEvaluateQuery(handle, '(\nself.y + limit\n)', nb.key, REG)),
    );
    expect(reply.kind === 'value' && reply.row.value).toBe('14');
    if (reply.kind !== 'value') return;
    const written = await run(setVariableQuery(0n, handle, 'x', '', 0, REG, reply.row.handle));
    expect(parseChildren(written)[0]?.value).toBe('14');
    expect((await runPython('p.x', nb)).value).toBe('14');
    await runPython('p.x = 3', nb);
  });

  it('stores None as an edit, which answers none rather than a row', async () => {
    const handle = (await open('p')).row.handle;
    const reply = parseConsoleReply(
      await run(inspectorEvaluateQuery(handle, '(\nNone\n)', nb.key, REG)),
    );
    expect(reply.kind).toBe('none');
    await run(setVariableQuery(0n, handle, 'x', 'None', 0, REG));
    expect((await runPython('p.x is None', nb)).value).toBe('True');
    await runPython('p.x = 3', nb);
  });

  it('throws away what an Evaluate changed when asked to, as in GemDB’s own session', async () => {
    await runPython('import gemdb\ngemdb.root["probe_point"] = p\ngemdb.commit()', nb);
    const handle = (await open('p')).row.handle;
    await run(inspectorEvaluateQuery(handle, 'self.x = 99', nb.key, REG, true));
    expect((await runPython('p.x', nb)).value).toBe('3');
    await runPython('import gemdb\ndel gemdb.root["probe_point"]\ngemdb.commit()', nb);
  });

  it('keeps the object readable after the registry it came from is dropped', async () => {
    const handle = (await open('p')).row.handle;
    await run(`SessionTemps current removeKey: #'${SOURCE}' ifAbsent: []. 'ok' encodeAsUTF8`);
    expect((await rows(handle, 0, 500)).some((r) => r.name === 'x')).toBe(true);
  });

  it('drops its registry when asked', async () => {
    const handle = (await open('p')).row.handle;
    await run(dropInspectorRegistryQuery(REG));
    expect(await rows(handle)).toEqual([]);
  });
});
