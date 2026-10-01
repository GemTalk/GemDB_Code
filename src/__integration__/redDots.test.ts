import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fileOwner } from '../fileOwner';
import { stageGrail } from '../grail';
import { parsePythonStack, pythonStackQuery } from '../haltStack';
import { isRunning, startNetldi, startStone, stopNetldi, stopStone } from '../processes';
import { runPython, runPythonFile } from '../pythonQueries';
import { DotsByFile } from '../redDots';
import {
  HaltAnswer,
  HaltRequest,
  SessionOwner,
  closeSessionFor,
  logoutAll,
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

let fixture: Fixture | undefined;
let dir = '';

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdb-reddots-'));
  fs.writeFileSync(path.join(dir, 'helper.py'), HELPER);
  fs.writeFileSync(path.join(dir, 'main.py'), MAIN);
  if (!haveExtent) return;
  fixture = makeFixture();
  if (!fixture) return;
  createDatabaseWithPython(fixture);
  stageGrail(ext);
  await startStone();
  await startNetldi();
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
});
