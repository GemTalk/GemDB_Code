import * as fs from 'fs';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { stageGrail } from '../grail';
import { PythonFrame, parsePythonStack, pythonStackQuery } from '../haltStack';
import {
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
  unquote,
} from '../pauseVariables';
import { isRunning, startNetldi, startStone, stopNetldi, stopStone } from '../processes';
import { runPython } from '../pythonQueries';
import {
  HaltAnswer,
  HaltRequest,
  SessionOwner,
  closeSessionFor,
  executeAsync,
  interruptSessionFor,
  logoutAll,
  sessionForIfOpen,
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
    expect(seen.p.map((v) => v.name).sort()).toEqual(['name', 'tags']);
    // A list reads by position from 0, not as Smalltalk's 1-based keys.
    expect(seen.local.map((v) => v.name)).toEqual(['[0]', '[1]']);
    expect(seen.local[1]).toMatchObject({ value: '(1, 2)', type: 'tuple', indexed: 2 });
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
