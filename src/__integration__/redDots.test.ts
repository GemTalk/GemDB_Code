import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fileOwner } from '../fileOwner';
import { stageGrail } from '../grail';
import { parsePythonStack, pythonStackQuery } from '../haltStack';
import {
  childrenQuery,
  parseChildren,
  parsePausedStack,
  pausedStackQuery,
} from '../pauseVariables';
import { ensureProcesses, isRunning, stopNetldi, stopStone } from '../processes';
import { runPython, runPythonFile } from '../pythonQueries';
import { DotsByFile } from '../redDots';
import {
  HaltAnswer,
  HaltRequest,
  SessionOwner,
  closeSessionFor,
  logoutAll,
  sessionFor,
  setHaltHandler,
  setRedDotSource,
} from '../session';
import { createDatabaseWithPython, Fixture, haveTestExtent, makeFixture } from './fixture';

/**
 * Red dots in `.py` files against a real database: the session arms them
 * before a run and as imports compile code, the run stops at each one with
 * the Python stack, and nothing stops where no dot is.
 *
 * The halt handler and the dot source stand in for the debugger and the
 * gutter (`debugger.ts`, tested without a database).
 */

const ext = process.cwd();
const haveExtent = haveTestExtent();

/** A module with a function, a class, and a line of its own body. */
const HELPER = [
  'def double(x):', //        1
  '    y = x * 2', //         2
  '    return y', //          3
  '', //                      4
  'class Box:', //            5
  '    def size(self, n):', // 6
  '        s = n + 1', //     7
  '        return s', //      8
  '', //                      9
  'loaded = double(1)', //   10
].join('\n');

/** A script that imports the module and calls into it. */
const MAIN = [
  'import helper', //                    1
  'def step(n):', //                     2
  '    k = n - 1', //                    3
  '    return k', //                     4
  'a = helper.double(5)', //             5
  'b = helper.Box().size(2)', //         6
  'c = step(4)', //                      7
  'print("done", a, b, c)', //           8
].join('\n');

/** Loops, a nested def, and a comment that looks like the header Grail ends a method with. */
const LOOPS = [
  'def total(xs):', //                   1
  '    # line 99 file elsewhere.py', //  2
  '    t = 0', //                        3
  '    for x in xs:', //                 4
  '        t += x', //                   5
  '    def inner(y):', //                6
  '        return y + 1', //             7
  '    return inner(t)', //              8
].join('\n');

/** A script that pauses at breakpoint() before importing a module. */
const PAUSE_FIRST = ['breakpoint()', 'import later', 'later.go()'].join('\n');
const LATER = ['def go():', '    n = 1', '    return n'].join('\n');

/** A class whose __repr__ the Variables view runs while paused. */
const SHOWN = [
  'class Shown:',
  '    def __repr__(self):',
  '        text = "Shown()"',
  '        return text',
].join('\n');

/** A recursive call on a dotted line, and two files whose dotted lines share a number. */
const RECURSIVE = [
  'def depth(n):',
  '    if n == 0:',
  '        return 0',
  '    return depth(n - 1) + 1',
].join('\n');
const CALLER = ['import callee', 'def f():', '    return callee.g()'].join('\n');
// Line 3 does work: a bare `return x` has no step point to break on.
const CALLEE = ['def g():', '    x = 1', '    return x + 0'].join('\n');

/** A module committed in one session and warm-bound, its body not re-run, in another. */
const WARM = ['def twice(x):', '    y = x * 2', '    return y'].join('\n');

let fixture: Fixture | undefined;
let dir = '';

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdb-reddots-'));
  fs.writeFileSync(path.join(dir, 'helper.py'), HELPER);
  fs.writeFileSync(path.join(dir, 'main.py'), MAIN);
  fs.writeFileSync(path.join(dir, 'loops.py'), LOOPS);
  fs.writeFileSync(path.join(dir, 'pause_first.py'), PAUSE_FIRST);
  fs.writeFileSync(path.join(dir, 'later.py'), LATER);
  fs.writeFileSync(path.join(dir, 'shown.py'), SHOWN);
  fs.writeFileSync(path.join(dir, 'warm.py'), WARM);
  fs.writeFileSync(path.join(dir, 'recursive.py'), RECURSIVE);
  fs.writeFileSync(path.join(dir, 'caller.py'), CALLER);
  fs.writeFileSync(path.join(dir, 'callee.py'), CALLEE);
  if (!haveExtent) return;
  fixture = makeFixture();
  if (!fixture) return;
  createDatabaseWithPython(fixture);
  stageGrail(ext);
  await ensureProcesses();
});

afterEach(() => {
  setHaltHandler(undefined);
  setRedDotSource(undefined);
});

afterAll(async () => {
  fs.rmSync(dir, { recursive: true, force: true });
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

const file = (name: string): string => path.join(dir, name);

/** Serve these dots, the way the gutter would. */
function dotting(dots: Record<string, number[]>): void {
  const map: DotsByFile = new Map(Object.entries(dots).map(([name, lines]) => [file(name), lines]));
  setRedDotSource(() => map);
}

/** Record each stop as `name@line file`, innermost frame first, and answer. */
function recording(
  answer: (request: HaltRequest, index: number) => Promise<HaltAnswer> | HaltAnswer = () =>
    'continue',
) {
  const stops: Array<{ reason: string; top: string; stack: string[] }> = [];
  setHaltHandler(async (request) => {
    const frames = parsePythonStack(
      await request.query(
        pythonStackQuery(request.process, undefined, request.reason === 'red dot'),
      ),
    );
    const stack = frames.map((f) => `${f.name}@${f.line} ${path.basename(f.file)}`);
    stops.push({ reason: request.reason, top: stack[0], stack });
    return answer(request, stops.length - 1);
  });
  return stops;
}

describe.skipIf(!haveExtent || !canMakeFixture())('red dots', () => {
  it('stops a file run at dots in the script, in an imported function and method, and in a module body', async () => {
    const owner: SessionOwner = fileOwner(file('main.py'));
    dotting({ 'main.py': [3, 8], 'helper.py': [2, 7, 10] });
    const stops = recording();
    const printed: string[] = [];

    const result = await runPythonFile(file('main.py'), owner, (chunk) => printed.push(chunk));
    closeSessionFor(owner.key);

    // In the order the code runs. helper.py's body runs at the import, and
    // its function and class are compiled mid-run — the import hooks set
    // those breaks — and every stop reads as Python, at the dotted line.
    expect(stops.map((s) => s.top)).toEqual([
      '<module>@10 helper.py',
      'double@2 helper.py',
      'double@2 helper.py',
      'Box.size@7 helper.py',
      'step@3 main.py',
      '<module>@8 main.py',
    ]);
    expect(stops.every((s) => s.reason === 'red dot')).toBe(true);
    // The callers are Grail's to place; the one red dots place is the innermost.
    expect(stops[1].stack.slice(0, 2)).toEqual(['double@2 helper.py', '<module>@10 helper.py']);
    expect(stops[2].stack[1]).toMatch(/^<module>@\d+ main\.py$/);
    // Continue resumes past the dot, and the run finishes as it would have.
    expect(printed.join('')).toBe('done 10 3 3\n');
    expect(result.value).toBe('');
  });

  it('runs straight through when no line has a dot, with no stop at the import hooks', async () => {
    const owner: SessionOwner = fileOwner(file('main.py'));
    // A dot in a file this run never loads still arms the import hooks.
    dotting({ 'elsewhere.py': [1] });
    const stops = recording();

    const result = await runPythonFile(file('main.py'), owner, () => {});
    closeSessionFor(owner.key);

    expect(stops).toEqual([]);
    expect(result.value).toBe('');
  });

  it('arms a module imported by an earlier cell, and forgets a dot once it is removed', async () => {
    const owner: SessionOwner = {
      key: 'file:///dots.ipynb',
      kind: 'notebook',
      label: 'dots.ipynb',
    };
    const stops = recording();
    await runPython(`import sys\nsys.path.insert(0, ${JSON.stringify(dir)})\nimport helper`, owner);

    dotting({ 'helper.py': [7] });
    const first = await runPython('helper.Box().size(10)', owner);
    dotting({});
    const second = await runPython('helper.Box().size(20)', owner);
    closeSessionFor(owner.key);

    expect(stops.map((s) => s.top)).toEqual(['Box.size@7 helper.py']);
    expect([first.value, second.value]).toEqual(['11', '21']);
  });

  it('stops at a dot added while paused, later in the same run', async () => {
    const owner: SessionOwner = fileOwner(file('main.py'));
    // Paused in double(); add a dot in step(), which runs later.
    dotting({ 'helper.py': [2] });
    const armedAtPause: Array<Map<string, number[]>> = [];
    const stops = recording(async (request, index): Promise<HaltAnswer> => {
      if (index === 0) {
        armedAtPause.push(
          await request.rearm(
            new Map([
              [file('helper.py'), [2]],
              [file('main.py'), [3]],
            ]),
          ),
        );
      }
      return 'continue';
    });

    const result = await runPythonFile(file('main.py'), owner, () => {});
    closeSessionFor(owner.key);

    expect(stops.map((s) => s.top)).toEqual([
      'double@2 helper.py',
      'double@2 helper.py',
      'step@3 main.py',
    ]);
    expect(armedAtPause[0].get(file('main.py'))).toEqual([3]);
    expect(result.value).toBe('');
  });

  it('still stops at breakpoint() in a run with red dots, each stop saying which it was', async () => {
    fs.writeFileSync(
      file('both.py'),
      [
        'import helper',
        'def go():',
        '    breakpoint()',
        '    return helper.double(2)',
        'r = go()',
        'print(r)',
      ].join('\n'),
    );
    const owner: SessionOwner = fileOwner(file('both.py'));
    dotting({ 'helper.py': [2] });
    const stops = recording();
    const printed: string[] = [];

    await runPythonFile(file('both.py'), owner, (chunk) => printed.push(chunk));
    closeSessionFor(owner.key);

    expect(stops.map((s) => `${s.reason} ${s.top}`)).toEqual([
      'red dot double@2 helper.py',
      'breakpoint() go@3 both.py',
      'red dot double@2 helper.py',
    ]);
    expect(printed.join('')).toBe('4\n');
  });

  it('ends the run at a dot when the user stops there', async () => {
    const owner: SessionOwner = fileOwner(file('main.py'));
    dotting({ 'main.py': [3] });
    const stops = recording(() => 'stop');
    const printed: string[] = [];

    const result = await runPythonFile(file('main.py'), owner, (chunk) => printed.push(chunk));
    closeSessionFor(owner.key);

    expect(stops.map((s) => s.top)).toEqual(['step@3 main.py']);
    expect(result.stopped).toBe(true);
    expect(printed.join('')).toBe('');
  });

  it('stops on each pass of a loop (and once before it) and inside a nested def, past a comment like Grail’s header', async () => {
    const owner: SessionOwner = {
      key: 'file:///loops.ipynb',
      kind: 'notebook',
      label: 'loops.ipynb',
    };
    await runPython(`import sys\nsys.path.insert(0, ${JSON.stringify(dir)})\nimport loops`, owner);
    dotting({ 'loops.py': [3, 5, 7] });
    const stops = recording();

    const result = await runPython('loops.total([1, 2, 3])', owner);
    closeSessionFor(owner.key);

    // The comment's "# line 99" must not be taken for the header Grail
    // appends, or every line would read 98 off. The body stops once per pass
    // and once more just before the first: the loop's setup runs a copy of
    // the body's first step point, and nothing in the method tells that copy
    // from the one each pass runs (measured; see armMethod in redDots.ts).
    expect(stops.map((s) => s.top)).toEqual([
      'total@3 loops.py',
      'total@5 loops.py',
      'total@5 loops.py',
      'total@5 loops.py',
      'total@5 loops.py',
      'inner@7 loops.py',
    ]);
    expect(result.value).toBe('7');
  });

  it('stops no more at a dot removed while paused', async () => {
    const owner: SessionOwner = fileOwner(file('main.py'));
    dotting({ 'helper.py': [2] });
    const stops = recording(async (request): Promise<HaltAnswer> => {
      await request.rearm(new Map());
      return 'continue';
    });

    const result = await runPythonFile(file('main.py'), owner, () => {});
    closeSessionFor(owner.key);

    // double() runs at the import and again from line 5; only the first stops.
    expect(stops.map((s) => s.top)).toEqual(['double@2 helper.py']);
    expect(result.value).toBe('');
  });

  it('stops at a dot added while paused in a module the run imports afterwards', async () => {
    const owner: SessionOwner = fileOwner(file('pause_first.py'));
    // The run starts with no dots, so it is unarmed and the pause comes from
    // breakpoint(); the hooks that catch later.py come from the re-arm.
    dotting({});
    const stops = recording(async (request, index): Promise<HaltAnswer> => {
      if (index === 0) await request.rearm(new Map([[file('later.py'), [2]]]));
      return 'continue';
    });

    const result = await runPythonFile(file('pause_first.py'), owner, () => {});
    closeSessionFor(owner.key);

    // later.py is compiled after the pause, so only the import hooks the
    // re-arm set — with the new dots — can put this break in.
    // The script's own <module> frame is Grail's to place (it reads 0 here).
    expect(stops.map((s) => `${s.reason} ${s.top.replace(/@\d+ /, ' ')}`)).toEqual([
      'breakpoint() <module> pause_first.py',
      'red dot go later.py',
    ]);
    expect(stops[1].top).toBe('go@2 later.py');
    expect(result.value).toBe('');
  });

  it('runs a __repr__ the Variables view asks for while paused straight past a dot in it', async () => {
    const owner: SessionOwner = {
      key: 'file:///shown.ipynb',
      kind: 'notebook',
      label: 'shown.ipynb',
    };
    await runPython(`import sys\nsys.path.insert(0, ${JSON.stringify(dir)})\nimport shown`, owner);
    dotting({ 'shown.py': [3] });
    const reasons: string[] = [];
    let rows: string[] = [];
    setHaltHandler(async (request) => {
      reasons.push(request.reason);
      const { globals } = parsePausedStack(
        await request.query(pausedStackQuery(request.process, owner.key)),
      );
      rows = parseChildren(await request.query(childrenQuery(globals, 0, 50))).map(
        (v) => `${v.name}=${v.value}`,
      );
      return 'continue';
    });

    const result = await runPython('s = shown.Shown()\nbreakpoint()\n42', owner);
    closeSessionFor(owner.key);

    // Queries run with flags 0, so the dot inside __repr__ does not fire there.
    expect(reasons).toEqual(['breakpoint()']);
    expect(rows).toContain('s=Shown()');
    expect(result.value).toBe('42');
  });

  it('stops at each level of a recursive call on a dotted line', async () => {
    const owner: SessionOwner = { key: 'file:///rec.ipynb', kind: 'notebook', label: 'rec.ipynb' };
    await runPython(
      `import sys\nsys.path.insert(0, ${JSON.stringify(dir)})\nimport recursive`,
      owner,
    );
    dotting({ 'recursive.py': [4] });
    const stops = recording();

    const result = await runPython('recursive.depth(3)', owner);
    closeSessionFor(owner.key);

    // Like breakpoint() on that line: every call that reaches it stops.
    expect(stops.map((s) => s.top)).toEqual([
      'depth@4 recursive.py',
      'depth@4 recursive.py',
      'depth@4 recursive.py',
    ]);
    expect(stops.map((s) => s.stack.length)).toEqual(
      [...stops.map((s) => s.stack.length)].sort((a, b) => a - b),
    );
    expect(result.value).toBe('3');
  });

  it('stops at a dotted line called from the same line number of another file', async () => {
    const owner: SessionOwner = {
      key: 'file:///cross.ipynb',
      kind: 'notebook',
      label: 'cross.ipynb',
    };
    await runPython(`import sys\nsys.path.insert(0, ${JSON.stringify(dir)})\nimport caller`, owner);
    dotting({ 'caller.py': [3], 'callee.py': [3] });
    const stops = recording();

    const result = await runPython('caller.f()', owner);
    closeSessionFor(owner.key);

    expect(stops.map((s) => s.top)).toEqual(['f@3 caller.py', 'g@3 callee.py']);
    expect(result.value).toBe('1');
  });

  it('never stops a view’s own read at a dot in the __repr__ it runs', async () => {
    const owner: SessionOwner = {
      key: 'file:///view.ipynb',
      kind: 'notebook',
      label: 'view.ipynb',
    };
    await runPython(`import sys\nsys.path.insert(0, ${JSON.stringify(dir)})\nimport shown`, owner);
    dotting({ 'shown.py': [3] });
    const stops = recording();

    // What Persisted Objects does: Smalltalk through executeAsync, not a Python run.
    const shownRepr = await sessionFor(owner).executeAsync(`| d |
d := System myUserProfile symbolList objectNamed: #'ModuleAst'.
(d evaluateSource: 'import shown
repr(shown.Shown())' usingModuleScope: SymbolDictionary new) asString encodeAsUTF8`);
    // A run in the same session still stops there.
    await runPython('repr(shown.Shown())', owner);
    closeSessionFor(owner.key);

    expect(shownRepr).toBe('Shown()');
    expect(stops.map((s) => s.top)).toEqual(['Shown.__repr__@3 shown.py']);
  });

  it('arms a module another session committed, which an import binds without running its body', async () => {
    const importWarm = `import sys\nsys.path.insert(0, ${JSON.stringify(dir)})\nimport warm`;
    const writer: SessionOwner = {
      key: 'file:///writer.ipynb',
      kind: 'notebook',
      label: 'writer.ipynb',
    };
    await runPython(`${importWarm}\nimport gemdb\ngemdb.commit()`, writer);
    closeSessionFor(writer.key);

    const reader: SessionOwner = {
      key: 'file:///reader.ipynb',
      kind: 'notebook',
      label: 'reader.ipynb',
    };
    dotting({ 'warm.py': [2] });
    const stops = recording();
    const result = await runPython(`${importWarm}\nwarm.twice(4)`, reader);
    closeSessionFor(reader.key);

    expect(stops.map((s) => s.top)).toEqual(['twice@2 warm.py']);
    expect(result.value).toBe('8');
  });
});
