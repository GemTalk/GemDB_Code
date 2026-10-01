import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __debugFactories,
  __debugStartOptions,
  __debugStartResult,
  __debugStarts,
  DebugAdapterInlineImplementation,
  SourceBreakpoint,
  debug,
  window,
} from '../__mocks__/vscode';
import type { DotsByFile } from '../redDots';
import type { HaltAnswer, HaltHandler, HaltRequest, RedDotSource } from '../session';

/**
 * The breakpoint() debugger, without a database: the stack Grail answers is a
 * string, the adapter is a message pump, and the halt handler is a promise.
 * That the gem really halts, resumes and stops is `breakpoint.test.ts`'s job.
 */

let installed: HaltHandler | undefined;
let dotSource: RedDotSource | undefined;
vi.mock('../session', () => ({
  setHaltHandler: (handler: HaltHandler | undefined) => {
    installed = handler;
  },
  setRedDotSource: (source: RedDotSource | undefined) => {
    dotSource = source;
  },
}));

const { locateCell, parsePythonStack } = await import('../haltStack');
const { clearRegistryQuery, parseChildren, parsePausedStack } = await import('../pauseVariables');
const { armedLinesQuery } = await import('../redDots');
const {
  PauseDebugAdapter,
  pauseForDebugSession,
  pauseForOwner,
  redDotsOf,
  registerBreakpointDebugger,
  sameDots,
  scopesFor,
  toDapFrames,
  toDapVariable,
  verifiedDots,
  withFileDots,
} = await import('../debugger');

const F = '\u001f';
const R = '\u001e';
const row = (...fields: Array<string | number>): string => fields.join(F) + R;

/** Let the handler's queries and VS Code's promises run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('reading the paused stack', () => {
  it('reads one frame per record, innermost first', () => {
    const raw =
      row('K.find', 4, 12, 4, 24, '<grail>', '            breakpoint()') +
      row('<module>', 12, 0, 12, 7, '<grail>', 'outer()');

    const frames = parsePythonStack(raw);

    expect(frames).toEqual([
      {
        name: 'K.find',
        line: 4,
        column: 12,
        endLine: 4,
        endColumn: 24,
        file: '<grail>',
        lineText: '            breakpoint()',
      },
      {
        name: '<module>',
        line: 12,
        column: 0,
        endLine: 12,
        endColumn: 7,
        file: '<grail>',
        lineText: 'outer()',
      },
    ]);
  });

  it('drops the frame Grail’s own pdb.set_trace adds, so the stack starts in user code', () => {
    const raw =
      row(
        'pdb.set_trace',
        32,
        4,
        32,
        20,
        '/root/grail/src/python/stdlib/pdb.py',
        'sys.breakpoint()',
      ) + row('go', 5, 0, 5, 9, '<grail>', 'x()');

    const frames = parsePythonStack(raw);

    expect(frames.map((f) => f.name)).toEqual(['go']);
  });

  it('keeps a frame Grail could not place, with zeros rather than NaN', () => {
    const frames = parsePythonStack(row('helper', '', '', '', '', '/m.py', ''));

    expect(frames).toEqual([
      { name: 'helper', line: 0, column: 0, endLine: 0, endColumn: 0, file: '/m.py', lineText: '' },
    ]);
  });

  it('answers no frames for an empty stack', () => {
    expect(parsePythonStack('')).toEqual([]);
  });

  it('keeps each frame’s locals with that frame when the stub frame is dropped', () => {
    const raw =
      row('pdb.set_trace', 32, 0, 0, 0, '/g/stdlib/pdb.py', 'x', 1) +
      row('go', 5, 0, 0, 0, '<grail>', 'x()', 2) +
      row('<module>', 7, 0, 0, 0, '<grail>', 'go()', 0) +
      `9${R}`;

    const { frames, globals } = parsePausedStack(raw);

    expect(frames.map((f) => [f.name, f.locals])).toEqual([
      ['go', 2],
      ['<module>', 0],
    ]);
    expect(globals).toBe(9);
  });

  it('answers no frames and no globals for an empty walk', () => {
    expect(parsePausedStack(`0${R}`)).toEqual({ frames: [], globals: 0 });
  });
});

describe('finding the cell a frame came from', () => {
  const frame = (line: number, lineText: string, file = '<grail>') =>
    ({ name: 'f', line, column: 0, endLine: line, endColumn: 1, file, lineText }) as const;
  const one = { uri: 'cell:1', lines: ['def f():', '    breakpoint()'] };
  const two = { uri: 'cell:2', lines: ['x = 1', 'f()'] };

  it('finds the running cell when the line matches there', () => {
    expect(locateCell(frame(2, 'f()'), two, [one, two])).toBe('cell:2');
  });

  it('finds the cell that defined a function called from another cell', () => {
    expect(locateCell(frame(2, '    breakpoint()'), two, [one, two])).toBe('cell:1');
  });

  it('prefers the running cell when two cells hold the same line', () => {
    const copy = { uri: 'cell:3', lines: ['x = 1', 'f()'] };

    expect(locateCell(frame(2, 'f()'), copy, [two, copy])).toBe('cell:3');
  });

  it('guesses only the running cell when there is no line text to compare', () => {
    expect(locateCell(frame(1, ''), two, [one, two])).toBe('cell:2');
    expect(locateCell(frame(1, ''), undefined, [one, two])).toBeUndefined();
  });

  it('places no frame from a real file, or with no line', () => {
    expect(locateCell(frame(1, 'x = 1', '/m.py'), two, [two])).toBeUndefined();
    expect(locateCell(frame(0, 'x = 1'), two, [two])).toBeUndefined();
  });

  it('finds a statement that spans several lines by its first', () => {
    const wrapped = { uri: 'cell:w', lines: ['result = compute(', '    a,', '    b,', ')'] };

    const uri = locateCell(frame(1, 'result = compute(\n    a,\n    b,\n)'), undefined, [wrapped]);

    expect(uri).toBe('cell:w');
  });
});

describe('placing frames in the editor', () => {
  const cell = {
    uri: 'vscode-notebook-cell:/a.ipynb#c1',
    lines: ['def f():', '    breakpoint()'],
    label: 'Cell [3]',
  };
  const frame = (over: Partial<Parameters<typeof toDapFrames>[0][number]>) => ({
    name: 'f',
    line: 2,
    column: 0,
    endLine: 0,
    endColumn: 0,
    file: '<grail>',
    lineText: '',
    ...over,
  });

  it('shows a notebook frame in its cell, labelled as the cell is, with 1-based columns', () => {
    const [dap] = toDapFrames(
      [frame({ column: 4, endLine: 2, endColumn: 16, lineText: '    breakpoint()' })],
      cell,
      [cell],
    );

    expect(dap).toEqual({
      id: 1,
      name: 'f',
      line: 2,
      column: 5,
      endLine: 2,
      endColumn: 17,
      source: { name: 'Cell [3]', path: 'vscode-notebook-cell:/a.ipynb#c1' },
    });
  });

  it('highlights the statement inside a def, where Grail gives no span, from the frame’s text', () => {
    const [dap] = toDapFrames([frame({ lineText: 'breakpoint(' })], cell, [cell]);

    expect(dap).toMatchObject({ line: 2, column: 5, endLine: 2, endColumn: 16 });
  });

  it('falls back to the line from its first non-blank character', () => {
    const [dap] = toDapFrames([frame({ lineText: '' })], cell, [cell]);

    expect(dap).toMatchObject({ column: 5, endColumn: 17 });
  });

  it('counts columns in UTF-16 units, so an emoji before the breakpoint lands right', () => {
    const emoji = { uri: 'cell:e', lines: ['x = "😀"; breakpoint()'], label: 'Cell 1' };

    // Grail counts code points: breakpoint() starts at 9 and ends at 21; in UTF-16
    // the emoji is two units, so the offsets move by one.
    const [dap] = toDapFrames(
      [frame({ line: 1, column: 9, endLine: 1, endColumn: 21, lineText: 'breakpoint()' })],
      emoji,
      [emoji],
    );

    expect(emoji.lines[0].slice(dap.column - 1, (dap.endColumn ?? 0) - 1)).toBe('breakpoint()');
  });

  it('shows a frame from a file in that file, reading the line to place it', () => {
    const [dap] = toDapFrames(
      [
        frame({
          name: 'C.m',
          line: 5,
          column: 8,
          endLine: 5,
          endColumn: 20,
          file: '/w/probemod.py',
        }),
      ],
      undefined,
      [],
      () => ['', '', '', '', '        breakpoint()'],
    );

    expect(dap).toMatchObject({
      source: { name: 'probemod.py', path: '/w/probemod.py' },
      column: 9,
      endColumn: 21,
    });
  });

  it('hands back each frame’s whole cell or file, so a saved stack can keep its source', () => {
    const texts: Array<string[] | undefined> = [];
    const fileLines = ['def helper(f):', '    return f()'];

    toDapFrames(
      [
        frame({ lineText: 'breakpoint(' }),
        frame({ name: 'helper', line: 2, file: '/w/mod.py' }),
        frame({ name: 'nowhere', line: 3, lineText: 'not in any cell' }),
      ],
      cell,
      [cell],
      () => fileLines,
      texts,
    );

    expect(texts[0]).toEqual(cell.lines);
    expect(texts[1]).toEqual(fileLines);
    expect(texts[2]).toBeUndefined();
  });

  it('reads a file once however many frames are in it', () => {
    const readLines = vi.fn(() => ['def f(n):', '    return f(n - 1)']);
    const deep = Array.from({ length: 50 }, () => frame({ file: '/w/rec.py' }));

    toDapFrames(deep, undefined, [], readLines);

    expect(readLines).toHaveBeenCalledTimes(1);
  });

  it('keeps a frame with nowhere to show it, dimmed and without a range', () => {
    const [dap] = toDapFrames([frame({ name: 'g', line: 3, lineText: 'nowhere' })], cell, [cell]);

    expect(dap).toEqual({ id: 1, name: 'g', line: 3, column: 1, presentationHint: 'subtle' });
  });
});

describe('scopes and variable rows', () => {
  it('lets a cell’s top level, which has no Locals, open on its Globals', () => {
    // VS Code opens the first scope not marked expensive.
    const [first] = scopesFor(0, 4).filter((scope) => !scope.expensive);

    expect(first?.name).toBe('Globals');
  });

  it('opens a function’s frame on its Locals, not its Globals', () => {
    const [first] = scopesFor(3, 4).filter((scope) => !scope.expensive);

    expect(first?.name).toBe('Locals');
  });

  it('offers only the scopes a frame has', () => {
    expect(scopesFor(0, 0)).toEqual([]);
    expect(scopesFor(0, 4).map((s) => s.name)).toEqual(['Globals']);
  });

  it('tells VS Code how many items a list has, so it pages them', () => {
    const rows = toDapVariable({
      name: 'rows',
      value: '[...]',
      type: 'list',
      ref: 7,
      indexed: 10_000,
      named: 0,
      handle: 7,
    });
    const leaf = toDapVariable({
      name: 'n',
      value: '3',
      type: 'int',
      ref: 0,
      indexed: 0,
      named: 0,
      handle: 8,
    });

    expect(rows).toEqual({
      name: 'rows',
      value: '[...]',
      type: 'list',
      variablesReference: 7,
      indexedVariables: 10_000,
    });
    expect(leaf).toEqual({ name: 'n', value: '3', type: 'int', variablesReference: 0 });
  });
});

/** Drive an adapter and collect what it sends. */
function adapterFor(
  pause: ({ answer: (c: HaltAnswer) => void } & Record<string, unknown>) | undefined,
) {
  const sent: Array<Record<string, unknown>> = [];
  const adapter = new PauseDebugAdapter(() =>
    pause
      ? {
          label: 'a.ipynb',
          frames: [{ id: 1, name: 'f', line: 2, column: 1 }],
          scopes: (frameId: number) => (frameId === 1 ? scopesFor(3, 9) : []),
          variables: (ref: number, start: number, count: number) =>
            Promise.resolve(
              ref === 3
                ? [{ name: `from ${start}, ${count}`, value: '1', variablesReference: 0 }]
                : [],
            ),
          ...pause,
        }
      : undefined,
  );
  adapter.onDidSendMessage((m) => sent.push(m as Record<string, unknown>));
  let seq = 1;
  const request = (command: string, args?: Record<string, unknown>) =>
    adapter.handleMessage({ seq: seq++, type: 'request', command, arguments: args });
  const events = () => sent.filter((m) => m.type === 'event').map((m) => m.event);
  const response = (command: string) =>
    sent.filter((m) => m.type === 'response' && m.command === command).pop();
  return { adapter, sent, request, events, response };
}

describe('red dots from the gutter', () => {
  const dot = (file: string | undefined, line: number, more: Record<string, unknown> = {}) => ({
    file,
    line,
    enabled: true,
    ...more,
  });

  it('keeps enabled, plain dots in .py files, once per line, under every spelling of the path', () => {
    const dots = redDotsOf(
      [
        dot('/export/w/m.py', 3),
        dot('/export/w/m.py', 3),
        dot('/export/w/m.py', 7),
        dot('/export/w/m.py', 8, { enabled: false }),
        dot('/export/w/m.py', 9, { condition: 'x' }),
        dot('/export/w/m.py', 10, { logMessage: 'hi' }),
        dot('/export/w/m.py', 11, { hitCondition: '3' }),
        dot('/export/w/notes.txt', 1),
        dot(undefined, 2),
      ],
      (f) => [f, f.replace('/export', '')],
    );

    expect([...dots]).toEqual([
      ['/export/w/m.py', [3, 7]],
      ['/w/m.py', [3, 7]],
    ]);
  });

  it('takes a setBreakpoints request as the newest word on its file, and drops a file it empties', () => {
    const before: DotsByFile = new Map([
      ['/w/a.py', [1]],
      ['/w/m.py', [3]],
    ]);

    const changed = withFileDots(
      before,
      '/w/m.py',
      [{ line: 5 }, { line: 5 }, { line: 6, condition: 'x' }],
      (f) => [f],
    );
    const emptied = withFileDots(before, '/w/m.py', [], (f) => [f]);

    expect([...changed]).toEqual([
      ['/w/a.py', [1]],
      ['/w/m.py', [5]],
    ]);
    expect([...emptied]).toEqual([['/w/a.py', [1]]]);
    // A request under the resolved spelling replaces the lines under the link's spelling too.
    const linked = withFileDots(
      new Map([
        ['/link/m.py', [3]],
        ['/real/m.py', [3]],
      ]),
      '/real/m.py',
      [{ line: 4 }],
      (f) => (f === '/link/m.py' ? [f, '/real/m.py'] : [f]),
    );
    expect([...linked]).toEqual([
      ['/link/m.py', [4]],
      ['/real/m.py', [4]],
    ]);
    expect(
      sameDots(
        before,
        new Map([
          ['/w/m.py', [3]],
          ['/w/a.py', [1]],
        ]),
      ),
    ).toBe(true);
    expect(sameDots(before, changed)).toBe(false);
  });

  it('verifies only the dots that hold a break in a live run', () => {
    const wanted = [{ line: 2 }, { line: 4 }];

    expect(verifiedDots('/w/m.py', wanted, [2], true)).toEqual([
      { verified: true, line: 2 },
      { verified: false, line: 4, message: expect.stringMatching(/no code for this line yet/) },
    ]);
    expect(verifiedDots('/w/m.py', wanted, [2], false).every((d) => !d.verified)).toBe(true);
    expect(verifiedDots(undefined, wanted, undefined, true).every((d) => !d.verified)).toBe(true);
  });
});

describe('the debug adapter', () => {
  it('reports stopped once attach and configurationDone have both arrived', () => {
    const { request, events } = adapterFor({ answer: () => {} });

    request('initialize');
    const afterInitialize = events();
    request('attach', { gemdbPause: '1' });
    const afterAttach = events();
    request('configurationDone');

    expect(afterInitialize).toEqual(['initialized']);
    expect(afterAttach).toEqual(['initialized']);
    expect(events()).toEqual(['initialized', 'stopped']);
  });

  it('answers the call stack and one thread', () => {
    const { request, response } = adapterFor({ answer: () => {} });
    request('initialize');
    request('attach', { gemdbPause: '1' });

    request('threads');
    request('stackTrace', { threadId: 1 });

    expect(response('threads')?.body).toEqual({ threads: [{ id: 1, name: 'a.ipynb' }] });
    expect(response('stackTrace')?.body).toEqual({
      stackFrames: [{ id: 1, name: 'f', line: 2, column: 1 }],
      totalFrames: 1,
    });
  });

  it('answers a frame’s Locals and Globals, and pages a row’s children', async () => {
    const { request, response } = adapterFor({ answer: () => {} });
    request('initialize');
    request('launch', { gemdbPause: '1' });

    request('scopes', { frameId: 1 });
    request('variables', { variablesReference: 3, start: 200, count: 100 });
    await settle();

    expect(response('scopes')?.body).toEqual({
      scopes: [
        { name: 'Locals', variablesReference: 3, presentationHint: 'locals', expensive: false },
        { name: 'Globals', variablesReference: 9, presentationHint: 'globals', expensive: false },
      ],
    });
    expect(response('variables')?.body).toEqual({
      variables: [{ name: 'from 200, 100', value: '1', variablesReference: 0 }],
    });
  });

  it('reads one page when VS Code asks for all of a row’s children', async () => {
    const { request, response } = adapterFor({ answer: () => {} });
    request('initialize');
    request('launch', { gemdbPause: '1' });

    request('variables', { variablesReference: 3 });
    await settle();

    const { variables } = response('variables')?.body as { variables: Array<{ name: string }> };
    expect(variables[0].name).toBe('from 0, 500');
  });

  it('resumes the evaluation on Continue and ends the session', () => {
    const answer = vi.fn();
    const { request, events, adapter } = adapterFor({ answer });
    request('initialize');
    request('attach', { gemdbPause: '1' });

    request('continue', { threadId: 1 });
    adapter.dispose(); // VS Code disposes after terminated; that must not re-answer

    expect(answer).toHaveBeenCalledWith('continue');
    expect(answer).toHaveBeenCalledTimes(1);
    expect(events()).toContain('terminated');
  });

  it('stops the evaluation on Stop', () => {
    const answer = vi.fn();
    const { request } = adapterFor({ answer });
    request('initialize');
    request('attach', { gemdbPause: '1' });

    request('terminate');
    request('disconnect');

    expect(answer).toHaveBeenCalledWith('stop');
    expect(answer).toHaveBeenCalledTimes(1);
  });

  it('stops the evaluation when the session goes away without an answer', () => {
    const answer = vi.fn();
    const { request, adapter } = adapterFor({ answer });
    request('initialize');
    request('attach', { gemdbPause: '1' });

    adapter.dispose();

    expect(answer).toHaveBeenCalledWith('stop');
  });

  it('says stepping is not supported yet, to the user, and leaves the pause alone', () => {
    const answer = vi.fn();
    const { request, response } = adapterFor({ answer });
    request('initialize');
    request('attach', { gemdbPause: '1' });

    const replies = ['next', 'stepIn', 'stepOut'].map((step) => {
      request(step, { threadId: 1 });
      return response(step);
    });

    for (const reply of replies) {
      expect(reply?.success).toBe(false);
      expect((reply?.body as { error: { showUser: boolean } }).error.showUser).toBe(true);
      expect(reply?.message).toMatch(/Stepping isn't supported yet/);
    }
    expect(answer).not.toHaveBeenCalled();
  });

  it('says red dots belong in .py files when asked for some in a notebook cell', async () => {
    const { request, response } = adapterFor({ answer: () => {} });
    request('initialize');
    request('launch', { gemdbPause: '1' });

    request('setBreakpoints', {
      source: { path: 'vscode-notebook-cell:/w/a.ipynb#W0sZmlsZQ' },
      breakpoints: [{ line: 3 }],
    });
    await settle();

    expect(response('setBreakpoints')?.body).toEqual({
      breakpoints: [
        {
          verified: false,
          line: 3,
          message:
            'Red dots work in .py files. In a notebook cell, put breakpoint() on the line instead.',
        },
      ],
    });
  });

  it('re-arms a paused run when a .py file’s dots change, and verifies the dots that took', async () => {
    const rearm = vi.fn((dots: DotsByFile) =>
      Promise.resolve(
        new Map([['/w/m.py', [...(dots.get('/w/m.py') ?? [])].filter((l) => l !== 9)]]),
      ),
    );
    const { request, response } = adapterFor({ answer: () => {}, rearm });
    request('initialize');
    request('launch', { gemdbPause: '1' });

    request('setBreakpoints', {
      source: { path: '/w/m.py' },
      breakpoints: [{ line: 4 }, { line: 9 }, { line: 6, condition: 'x > 1' }],
    });
    await settle();

    expect(rearm).toHaveBeenCalledTimes(1);
    // A conditional dot is not set at all, rather than set as a plain one.
    expect([...rearm.mock.calls[0][0]]).toEqual([['/w/m.py', [4, 9]]]);
    expect(response('setBreakpoints')?.body).toEqual({
      breakpoints: [
        { verified: true, line: 4 },
        { verified: false, line: 9, message: expect.stringMatching(/no code for this line yet/) },
        { verified: false, line: 6, message: expect.stringMatching(/Conditions/) },
      ],
    });
  });

  it('leaves a paused run alone when VS Code re-sends the dots it was armed with', async () => {
    const rearm = vi.fn(() => Promise.resolve(new Map<string, number[]>()));
    const queries: string[] = [];
    const { request, response } = adapterFor({
      answer: () => {},
      rearm,
      armedDots: new Map([['/w/m.py', [4]]]),
      query: (code: string) => {
        queries.push(code);
        return Promise.resolve(`/w/m.py${F}4${R}`);
      },
    });
    request('launch', { gemdbPause: '1' });

    request('setBreakpoints', { source: { path: '/w/m.py' }, breakpoints: [{ line: 4 }] });
    await settle();

    // Re-arming converts the paused stack to slower code, so an unchanged set only asks.
    expect(rearm).not.toHaveBeenCalled();
    expect(queries).toEqual([armedLinesQuery(new Map([['/w/m.py', [4]]]))]);
    expect(response('setBreakpoints')?.body).toEqual({
      breakpoints: [{ verified: true, line: 4 }],
    });
  });

  it('re-arms a dot the gutter gained while the run was still running, before it paused', async () => {
    // The run was armed with no dots; the user added line 4 before breakpoint() paused it.
    debug.breakpoints = [
      new SourceBreakpoint({
        uri: { scheme: 'file', fsPath: '/w/m.py' },
        range: { start: { line: 3 } },
      }),
    ];
    const rearm = vi.fn(() => Promise.resolve(new Map([['/w/m.py', [4]]])));
    const { request } = adapterFor({
      answer: () => {},
      rearm,
      armedDots: new Map(),
      query: vi.fn(),
    });
    request('launch', { gemdbPause: '1' });

    request('setBreakpoints', { source: { path: '/w/m.py' }, breakpoints: [{ line: 4 }] });
    await settle();
    debug.breakpoints = [];

    expect(rearm).toHaveBeenCalledTimes(1);
  });

  it('holds a setBreakpoints that arrives before launch until the pause is known', async () => {
    const rearm = vi.fn(() => Promise.resolve(new Map([['/w/m.py', [4]]])));
    const { request, response } = adapterFor({ answer: () => {}, rearm });
    request('initialize');

    // VS Code sends breakpoints on `initialized`, in parallel with launch.
    request('setBreakpoints', { source: { path: '/w/m.py' }, breakpoints: [{ line: 4 }] });
    await settle();
    const beforeLaunch = response('setBreakpoints');
    request('launch', { gemdbPause: '1' });
    await settle();

    expect(beforeLaunch).toBeUndefined();
    expect(response('setBreakpoints')?.body).toEqual({
      breakpoints: [{ verified: true, line: 4 }],
    });
  });

  it('answers back-to-back setBreakpoints in order, each building on the last', async () => {
    const seen: Array<Array<[string, number[]]>> = [];
    const rearm = vi.fn(async (dots: DotsByFile) => {
      seen.push([...dots] as Array<[string, number[]]>);
      return new Map([...dots].map(([f, l]) => [f, [...l]]));
    });
    const { request, sent } = adapterFor({ answer: () => {}, rearm });
    request('initialize');
    request('launch', { gemdbPause: '1' });

    // VS Code sends one request per file as the session starts, without waiting.
    request('setBreakpoints', { source: { path: '/w/a.py' }, breakpoints: [{ line: 1 }] });
    request('setBreakpoints', { source: { path: '/w/b.py' }, breakpoints: [{ line: 2 }] });
    await settle();
    await settle();

    expect(seen).toEqual([
      [['/w/a.py', [1]]],
      [
        ['/w/a.py', [1]],
        ['/w/b.py', [2]],
      ],
    ]);
    const replies = sent.filter((m) => m.command === 'setBreakpoints').map((m) => m.body);
    expect(replies).toEqual([
      { breakpoints: [{ verified: true, line: 1 }] },
      { breakpoints: [{ verified: true, line: 2 }] },
    ]);
  });

  it('answers unverified, and goes on answering, when re-arming fails', async () => {
    const rearm = vi
      .fn()
      .mockRejectedValueOnce(new Error('session gone'))
      .mockResolvedValueOnce(new Map([['/w/m.py', [3]]]));
    const { request, sent } = adapterFor({ answer: () => {}, rearm });
    request('initialize');
    request('launch', { gemdbPause: '1' });

    // The same request twice: after a failure the run's breaks are unknown,
    // so the second must re-arm rather than take the dots as already set.
    request('setBreakpoints', { source: { path: '/w/m.py' }, breakpoints: [{ line: 3 }] });
    request('setBreakpoints', { source: { path: '/w/m.py' }, breakpoints: [{ line: 3 }] });
    await settle();
    await settle();

    expect(rearm).toHaveBeenCalledTimes(2);
    const replies = sent.filter((m) => m.command === 'setBreakpoints').map((m) => m.body);
    expect(replies).toEqual([
      {
        breakpoints: [
          { verified: false, line: 3, message: expect.stringMatching(/no code for this line yet/) },
        ],
      },
      { breakpoints: [{ verified: true, line: 3 }] },
    ]);
  });

  it('sets no red dot on a saved stack, which has no run to stop', async () => {
    const { request, response } = adapterFor({ answer: () => {}, saved: true });
    request('initialize');
    request('launch', { gemdbPause: '1' });

    request('setBreakpoints', { source: { path: '/w/m.py' }, breakpoints: [{ line: 2 }] });
    await settle();

    expect(response('setBreakpoints')?.body).toEqual({
      breakpoints: [{ verified: false, line: 2, message: expect.stringMatching(/saved stack/) }],
    });
  });

  it('accepts a launch request the way it accepts attach', () => {
    const { request, response, events } = adapterFor({ answer: () => {} });
    request('initialize');

    request('launch', { gemdbPause: '1' });
    request('configurationDone');

    expect(response('launch')?.success).toBe(true);
    expect(events()).toContain('stopped');
  });

  it('declines Restart with a message, leaving the pause alone', () => {
    const answer = vi.fn();
    const { request, response } = adapterFor({ answer });
    request('initialize');
    request('launch', { gemdbPause: '1' });

    request('restart');

    expect(
      (response('initialize')?.body as { supportsRestartRequest: boolean }).supportsRestartRequest,
    ).toBe(true);
    expect(response('restart')?.success).toBe(false);
    expect(response('restart')?.message).toMatch(/Restarting isn't supported yet/);
    expect(answer).not.toHaveBeenCalled();
  });

  it('serves a saved stack’s source text, and says the stop is a saved stack', () => {
    const sent: Array<Record<string, unknown>> = [];
    const adapter = new PauseDebugAdapter(() => ({
      label: 'Saved stack: a.ipynb',
      frames: [
        {
          id: 1,
          name: 'f',
          line: 2,
          column: 1,
          source: { name: 'Cell [1] (saved)', sourceReference: 1 },
        },
      ],
      scopes: () => [],
      variables: () => Promise.resolve([]),
      answer: () => {},
      sourceText: (ref: number) => (ref === 1 ? 'def f():\n    breakpoint()' : undefined),
      description: 'Saved stack from 2026-10-01 16:20 (read-only)',
      saved: true,
    }));
    adapter.onDidSendMessage((m) => sent.push(m as Record<string, unknown>));
    const ask = (seq: number, command: string, args?: Record<string, unknown>) =>
      adapter.handleMessage({ seq, type: 'request', command, arguments: args });

    ask(1, 'initialize');
    ask(2, 'launch', { gemdbPause: '1' });
    ask(3, 'configurationDone');
    ask(4, 'source', { source: { sourceReference: 1 }, sourceReference: 1 });
    ask(5, 'source', { sourceReference: 7 });

    const stopped = sent.find((m) => m.event === 'stopped')?.body as Record<string, unknown>;
    const sources = sent.filter((m) => m.command === 'source');
    expect(stopped).toMatchObject({
      reason: 'entry',
      description: 'Saved stack from 2026-10-01 16:20 (read-only)',
    });
    expect(sources[0]).toMatchObject({
      success: true,
      body: { content: 'def f():\n    breakpoint()' },
    });
    expect(sources[1]).toMatchObject({ success: false });
  });

  it('ends quietly when the pause it was started for has already ended', () => {
    const { request, response, events } = adapterFor(undefined);
    request('initialize');

    request('attach', { gemdbPause: 'gone' });

    // Nothing went wrong, so nothing is put in front of the user.
    expect(response('attach')?.success).toBe(true);
    expect(events()).toContain('terminated');
    expect(events()).not.toContain('stopped');
  });
});

describe('opening the debugger at a breakpoint()', () => {
  beforeEach(() => {
    __debugStarts.length = 0;
    __debugStartOptions.length = 0;
    __debugStartResult.value = true;
  });

  /** A paused `<grail>` frame with locals at 3 over a module frame with locals at 4; globals at 9. */
  const PAUSED =
    row('go', 5, 0, 5, 4, '<grail>', 'go()', 3) +
    row('helper', 2, 0, 0, 0, '/w/mod.py', 'return f()', 4) +
    `9${R}`;

  function haltRequest(): HaltRequest & { cancel: () => void; queries: string[] } {
    const cancels: Array<() => void> = [];
    const queries: string[] = [];
    return {
      session: {
        owner: { key: 'file:///a.ipynb', kind: 'notebook', label: 'a.ipynb' },
        connected: true,
      } as unknown as HaltRequest['session'],
      process: 42n,
      reason: 'breakpoint()',
      armedDots: new Map(),
      rearm: () => Promise.resolve(new Map()),
      query: (code) => {
        queries.push(code);
        return Promise.resolve(code.includes('Suspended') ? PAUSED : '');
      },
      onCancel: (callback) => cancels.push(callback),
      cancel: () => cancels.forEach((c) => c()),
      queries,
    };
  }

  /** The adapter VS Code would get for the session the handler just started. */
  function adapterForLastStart(): InstanceType<typeof PauseDebugAdapter> {
    const factory = __debugFactories.get('gemdb') as {
      createDebugAdapterDescriptor: (s: unknown) => DebugAdapterInlineImplementation;
    };
    const configuration = __debugStarts[__debugStarts.length - 1];
    return factory.createDebugAdapterDescriptor({ configuration }).implementation as InstanceType<
      typeof PauseDebugAdapter
    >;
  }

  /** Send one request to an adapter and answer what it sent back for that command. */
  function ask(
    adapter: InstanceType<typeof PauseDebugAdapter>,
    command: string,
    args: Record<string, unknown> = {},
  ): Array<Record<string, unknown>> {
    const sent: Array<Record<string, unknown>> = [];
    const listener = adapter.onDidSendMessage((m) => sent.push(m as Record<string, unknown>));
    adapter.handleMessage({ seq: 1, type: 'request', command, arguments: args });
    listener.dispose();
    return sent;
  }

  const pauseIdOf = (index: number): string =>
    (__debugStarts[index] as { gemdbPause: string }).gemdbPause;

  it('starts a debug session for a halt and settles it from the adapter', async () => {
    const registration = registerBreakpointDebugger();
    const answered = installed!(haltRequest());
    await settle();
    const adapter = adapterForLastStart();

    ask(adapter, 'initialize');
    ask(adapter, 'attach', { gemdbPause: pauseIdOf(0) });
    const [stack] = ask(adapter, 'stackTrace');
    ask(adapter, 'continue');

    // Launch, not attach: an attach session shows Disconnect where Stop belongs.
    expect(__debugStarts).toEqual([
      expect.objectContaining({ type: 'gemdb', request: 'launch', name: 'GemDB: a.ipynb' }),
    ]);
    // Reaching a breakpoint() must not save the notebook.
    expect(__debugStartOptions).toEqual([{ suppressSaveBeforeStart: true }]);
    const { stackFrames } = stack.body as { stackFrames: Array<{ name: string }> };
    expect(stackFrames.map((f) => f.name)).toEqual(['go', 'helper']);
    await expect(answered).resolves.toBe('continue');
    registration.dispose();
  });

  it('opens a red dot’s pause as a breakpoint, reading the stack at the step point', async () => {
    const registration = registerBreakpointDebugger();
    const request = { ...haltRequest(), reason: 'red dot' as const };
    const answered = installed!(request);
    await settle();
    const adapter = adapterForLastStart();

    ask(adapter, 'initialize');
    ask(adapter, 'launch', { gemdbPause: pauseIdOf(0) });
    const stopped = ask(adapter, 'configurationDone').find((m) => m.event === 'stopped');
    ask(adapter, 'continue');

    expect(stopped?.body).toMatchObject({
      reason: 'breakpoint',
      description: 'Paused on breakpoint',
    });
    // The innermost frame's line comes from its step point, not Grail's ip lookup.
    expect(request.queries[0]).toContain('dotLine := true ifTrue:');
    await expect(answered).resolves.toBe('continue');
    registration.dispose();
  });

  it('serves the gutter’s dots to the session while registered', () => {
    debug.breakpoints = [
      new SourceBreakpoint({
        uri: { scheme: 'file', fsPath: '/nowhere/m.py' },
        range: { start: { line: 4 } },
      }),
      new SourceBreakpoint({
        uri: { scheme: 'vscode-notebook-cell', fsPath: '/nowhere/a.ipynb' },
        range: { start: { line: 0 } },
      }),
    ];
    const registration = registerBreakpointDebugger();
    const served = dotSource?.();
    registration.dispose();
    debug.breakpoints = [];

    expect(served && [...served]).toEqual([['/nowhere/m.py', [5]]]);
    expect(dotSource).toBeUndefined();
  });

  it('offers the notebook’s globals under a cell’s frame, not under an imported module’s', async () => {
    const registration = registerBreakpointDebugger();
    const answered = installed!(haltRequest());
    await settle();
    const adapter = adapterForLastStart();
    ask(adapter, 'launch', { gemdbPause: pauseIdOf(0) });

    const [cellScopes] = ask(adapter, 'scopes', { frameId: 1 });
    const [moduleScopes] = ask(adapter, 'scopes', { frameId: 2 });

    const names = (reply: Record<string, unknown>) =>
      (reply.body as { scopes: Array<{ name: string; variablesReference: number }> }).scopes.map(
        (s) => [s.name, s.variablesReference],
      );
    expect(names(cellScopes)).toEqual([
      ['Locals', 3],
      ['Globals', 9],
    ]);
    expect(names(moduleScopes)).toEqual([['Locals', 4]]);
    registration.dispose();
    await expect(answered).resolves.toBe('stop');
  });

  it('drops the pause’s registry before the evaluation resumes', async () => {
    const registration = registerBreakpointDebugger();
    const request = haltRequest();
    const answered = installed!(request);
    await settle();
    const adapter = adapterForLastStart();
    ask(adapter, 'launch', { gemdbPause: pauseIdOf(0) });
    let queriesWhenAnswered: string[] = [];
    void answered.then(() => (queriesWhenAnswered = [...request.queries]));

    ask(adapter, 'continue');
    await answered;

    // The session runs queries in order and resumes only after the last, so
    // the clear being queued before the answer is what keeps the registry
    // from outliving the pause.
    expect(queriesWhenAnswered[queriesWhenAnswered.length - 1]).toBe(clearRegistryQuery());
    registration.dispose();
  });

  it('finds the pause behind a debug session or a notebook, until it is answered', async () => {
    const registration = registerBreakpointDebugger();
    const answered = installed!(haltRequest());
    await settle();
    const factory = __debugFactories.get('gemdb') as {
      createDebugAdapterDescriptor: (s: unknown) => DebugAdapterInlineImplementation;
    };
    const adapter = factory.createDebugAdapterDescriptor({
      id: 'debug-7',
      configuration: __debugStarts[0],
    }).implementation as InstanceType<typeof PauseDebugAdapter>;
    ask(adapter, 'launch', { gemdbPause: pauseIdOf(0) });

    const bySession = pauseForDebugSession('debug-7');
    const byOwner = pauseForOwner('file:///a.ipynb');
    ask(adapter, 'continue');
    await answered;

    expect(bySession?.label).toBe('a.ipynb');
    expect(byOwner).toBe(bySession);
    expect(pauseForDebugSession('debug-7')).toBeUndefined();
    expect(pauseForOwner('file:///a.ipynb')).toBeUndefined();
    registration.dispose();
  });

  it('remembers each listed row’s handle by its container and name, plain values included', async () => {
    const registration = registerBreakpointDebugger();
    const request = haltRequest();
    request.query = (code) => {
      request.queries.push(code);
      if (code.includes('Suspended')) return Promise.resolve(PAUSED);
      return Promise.resolve(
        row('depth', '3', 'int', 0, 0, 0, 12) + row('self', '<E>', 'E', 13, 0, 1, 13),
      );
    };
    void installed!(request);
    await settle();
    const adapter = adapterForLastStart();
    ask(adapter, 'launch', { gemdbPause: pauseIdOf(0) });

    ask(adapter, 'variables', { variablesReference: 3 });
    await settle();

    const pause = pauseForOwner('file:///a.ipynb')!;
    expect(pause.handleFor?.(3, 'depth')).toBe(12);
    expect(pause.handleFor?.(3, 'self')).toBe(13);
    expect(pause.handleFor?.(4, 'depth')).toBeUndefined();
    registration.dispose();
  });

  it('keeps two pauses in one run apart: a late disconnect from the first settles nothing', async () => {
    const registration = registerBreakpointDebugger();
    const first = installed!(haltRequest());
    await settle();
    const firstAdapter = adapterForLastStart();
    ask(firstAdapter, 'launch', { gemdbPause: pauseIdOf(0) });
    ask(firstAdapter, 'continue');
    await expect(first).resolves.toBe('continue');
    const second = installed!(haltRequest());
    await settle();

    // VS Code tears the first session down after it ended; that must not reach the second pause.
    ask(firstAdapter, 'disconnect');
    firstAdapter.dispose();
    const secondAdapter = adapterForLastStart();
    ask(secondAdapter, 'launch', { gemdbPause: pauseIdOf(1) });
    ask(secondAdapter, 'continue');

    expect(pauseIdOf(1)).not.toBe(pauseIdOf(0));
    await expect(second).resolves.toBe('continue');
    registration.dispose();
  });

  it('stops the run, saying why, when the debugger cannot start', async () => {
    __debugStartResult.value = false;
    const shown = vi.spyOn(window, 'showErrorMessage');
    const registration = registerBreakpointDebugger();

    const answered = installed!(haltRequest());

    await expect(answered).resolves.toBe('stop');
    expect(shown).toHaveBeenCalledWith(expect.stringMatching(/could not open the debugger/));
    shown.mockRestore();
    registration.dispose();
  });

  it('stops the run, saying why, when starting the debugger fails outright', async () => {
    __debugStartResult.value = new Error('no debug service');
    const shown = vi.spyOn(window, 'showErrorMessage');
    const registration = registerBreakpointDebugger();

    const answered = installed!(haltRequest());

    await expect(answered).resolves.toBe('stop');
    expect(shown).toHaveBeenCalledWith(expect.stringMatching(/could not open the debugger/));
    shown.mockRestore();
    registration.dispose();
  });

  it('stops the run when the evaluation is cancelled while paused', async () => {
    const registration = registerBreakpointDebugger();
    const request = haltRequest();
    const answered = installed!(request);

    request.cancel();

    await expect(answered).resolves.toBe('stop');
    registration.dispose();
  });

  it('opens no debugger for a pause cancelled while its stack was being read', async () => {
    const registration = registerBreakpointDebugger();
    const request = haltRequest();
    const answered = installed!(request);

    request.cancel();
    await settle();

    await expect(answered).resolves.toBe('stop');
    expect(__debugStarts).toEqual([]);
    registration.dispose();
  });

  it('uninstalls its handler and stops anything still paused when disposed', async () => {
    const registration = registerBreakpointDebugger();
    const answered = installed!(haltRequest());
    await settle();

    registration.dispose();

    await expect(answered).resolves.toBe('stop');
    expect(installed).toBeUndefined();
  });
});

describe('the variables queries’ answers', () => {
  it('reads one row per child, with its counts', () => {
    const raw = row('tags', "{'a', 'b'}", 'set', 8, 2, 0, 8) + row('n', '2', 'int', 0, 0, 0, 9);

    const rows = parseChildren(raw);

    // A leaf has no ref — it cannot be expanded — but it has a handle, so it can be saved.
    expect(rows).toEqual([
      { name: 'tags', value: "{'a', 'b'}", type: 'set', ref: 8, indexed: 2, named: 0, handle: 8 },
      { name: 'n', value: '2', type: 'int', ref: 0, indexed: 0, named: 0, handle: 9 },
    ]);
  });
});
