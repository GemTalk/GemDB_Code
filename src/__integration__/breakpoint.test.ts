import * as fs from 'fs';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { stageGrail } from '../grail';
import { PythonFrame, parsePythonStack, pythonStackQuery } from '../haltStack';
import { isRunning, startNetldi, startStone, stopNetldi, stopStone } from '../processes';
import { runPython } from '../pythonQueries';
import {
  HaltAnswer,
  HaltRequest,
  SessionOwner,
  closeSessionFor,
  interruptSessionFor,
  logoutAll,
  setHaltHandler,
} from '../session';
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
    seen.frames = parsePythonStack(request.session.execute(pythonStackQuery(request.process)));
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

  it('ends the cell on Stop, and the session is still usable', async () => {
    const printed: string[] = [];
    answering('stop', printed);

    const result = await runPython(CELL, NB, (chunk) => printed.push(chunk));

    expect(result.value).toBe('Error: Stopped at breakpoint() in the debugger.');
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
      'breakpoint() at line 2: the debugger opens in notebooks for now; continuing.\n',
    );
    expect(result.value).toBe("'went on'");
  });
});
