import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __debugFactories,
  __debugStartOptions,
  __debugStartResult,
  __debugStarts,
  DebugAdapterInlineImplementation,
} from '../__mocks__/vscode';
import type { HaltAnswer, HaltHandler, HaltRequest } from '../session';

/**
 * The breakpoint() debugger, without a database: the stack Grail answers is a
 * string, the adapter is a message pump, and the halt handler is a promise.
 * That the gem really halts, resumes and stops is `breakpoint.test.ts`'s job.
 */

let installed: HaltHandler | undefined;
vi.mock('../session', () => ({
  setHaltHandler: (handler: HaltHandler | undefined) => {
    installed = handler;
  },
}));

const { locateCell, parsePythonStack } = await import('../haltStack');
const { parseChildren, parseFrameRefs } = await import('../pauseVariables');
const { PauseDebugAdapter, registerBreakpointDebugger, scopesFor, toDapFrames, toDapVariable } =
  await import('../debugger');

const F = '\u001f';
const R = '\u001e';
const row = (...fields: Array<string | number>): string => fields.join(F) + R;

describe('parsePythonStack', () => {
  it('reads one frame per record, innermost first', () => {
    const raw =
      row('K.find', 4, 12, 4, 24, '<grail>', '            breakpoint()') +
      row('<module>', 12, 0, 12, 7, '<grail>', 'outer()');
    expect(parsePythonStack(raw)).toEqual([
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
    expect(parsePythonStack(raw).map((f) => f.name)).toEqual(['go']);
  });

  it('keeps a frame Grail could not place, with zeros rather than NaN', () => {
    expect(parsePythonStack(row('helper', '', '', '', '', '/m.py', ''))).toEqual([
      { name: 'helper', line: 0, column: 0, endLine: 0, endColumn: 0, file: '/m.py', lineText: '' },
    ]);
  });

  it('answers no frames for an empty stack', () => {
    expect(parsePythonStack('')).toEqual([]);
  });
});

describe('locateCell', () => {
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
});

describe('toDapFrames', () => {
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

  it('keeps a frame with nowhere to show it, dimmed and without a range', () => {
    const [dap] = toDapFrames([frame({ name: 'g', line: 3, lineText: 'nowhere' })], cell, [cell]);
    expect(dap).toEqual({ id: 1, name: 'g', line: 3, column: 1, presentationHint: 'subtle' });
  });
});

describe('scopesFor and toDapVariable', () => {
  it('offers only the scopes a frame has', () => {
    expect(scopesFor(0, 0)).toEqual([]);
    expect(scopesFor(0, 4).map((s) => s.name)).toEqual(['Globals']);
  });

  it('tells VS Code how many items a list has, so it pages them', () => {
    expect(
      toDapVariable({
        name: 'rows',
        value: '[...]',
        type: 'list',
        ref: 7,
        indexed: 10_000,
        named: 0,
      }),
    ).toEqual({
      name: 'rows',
      value: '[...]',
      type: 'list',
      variablesReference: 7,
      indexedVariables: 10_000,
    });
    expect(
      toDapVariable({ name: 'n', value: '3', type: 'int', ref: 0, indexed: 0, named: 0 }),
    ).toEqual({
      name: 'n',
      value: '3',
      type: 'int',
      variablesReference: 0,
    });
  });
});

/** Drive an adapter and collect what it sends. */
function adapterFor(pause: { answer: (c: HaltAnswer) => void } | undefined) {
  const sent: Array<Record<string, unknown>> = [];
  const adapter = new PauseDebugAdapter(() =>
    pause
      ? {
          label: 'a.ipynb',
          frames: [{ id: 1, name: 'f', line: 2, column: 1 }],
          scopes: (frameId: number) => (frameId === 1 ? scopesFor(3, 9) : []),
          variables: (ref: number, start: number, count: number) =>
            ref === 3
              ? [{ name: `from ${start}, ${count}`, value: '1', variablesReference: 0 }]
              : [],
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

describe('PauseDebugAdapter', () => {
  it('reports stopped once attach and configurationDone have both arrived', () => {
    const { request, events } = adapterFor({ answer: () => {} });
    request('initialize');
    expect(events()).toEqual(['initialized']);
    request('attach', { gemdbPause: '1' });
    expect(events()).toEqual(['initialized']);
    request('configurationDone');
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

  it('answers a frame’s Locals and Globals, and pages a row’s children', () => {
    const { request, response } = adapterFor({ answer: () => {} });
    request('initialize');
    request('launch', { gemdbPause: '1' });
    request('scopes', { frameId: 1 });
    expect(response('scopes')?.body).toEqual({
      scopes: [
        { name: 'Locals', variablesReference: 3, presentationHint: 'locals', expensive: false },
        { name: 'Globals', variablesReference: 9, presentationHint: 'globals', expensive: true },
      ],
    });
    request('variables', { variablesReference: 3, start: 200, count: 100 });
    expect(response('variables')?.body).toEqual({
      variables: [{ name: 'from 200, 100', value: '1', variablesReference: 0 }],
    });
    // No count means "all", which is capped at one page.
    request('variables', { variablesReference: 3 });
    expect(
      (response('variables')?.body as { variables: Array<{ name: string }> }).variables[0].name,
    ).toBe('from 0, 500');
  });

  it('resumes the evaluation on Continue and ends the session', () => {
    const answer = vi.fn();
    const { request, events, adapter } = adapterFor({ answer });
    request('initialize');
    request('attach', { gemdbPause: '1' });
    request('continue', { threadId: 1 });
    expect(answer).toHaveBeenCalledWith('continue');
    expect(events()).toContain('terminated');
    adapter.dispose(); // VS Code disposes after terminated; that must not re-answer
    expect(answer).toHaveBeenCalledTimes(1);
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
    for (const step of ['next', 'stepIn', 'stepOut']) {
      request(step, { threadId: 1 });
      const reply = response(step);
      expect(reply?.success).toBe(false);
      expect((reply?.body as { error: { showUser: boolean } }).error.showUser).toBe(true);
      expect(reply?.message).toMatch(/Stepping isn't supported yet/);
    }
    expect(answer).not.toHaveBeenCalled();
  });

  it('reports red-dot breakpoints as unverified rather than pretending', () => {
    const { request, response } = adapterFor({ answer: () => {} });
    request('initialize');
    request('setBreakpoints', { breakpoints: [{ line: 3 }] });
    expect(response('setBreakpoints')?.body).toEqual({
      breakpoints: [
        { verified: false, line: 3, message: 'GemDB stops only at breakpoint() for now.' },
      ],
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
    expect(
      (response('initialize')?.body as { supportsRestartRequest: boolean }).supportsRestartRequest,
    ).toBe(true);
    request('launch', { gemdbPause: '1' });
    request('restart');
    expect(response('restart')?.success).toBe(false);
    expect(response('restart')?.message).toMatch(/Restarting isn't supported yet/);
    expect(answer).not.toHaveBeenCalled();
  });

  it('refuses to attach to a pause that is not there, and ends', () => {
    const { request, response, events } = adapterFor(undefined);
    request('initialize');
    request('attach', { gemdbPause: 'gone' });
    expect(response('attach')?.success).toBe(false);
    expect(events()).toContain('terminated');
  });
});

describe('registerBreakpointDebugger', () => {
  beforeEach(() => {
    __debugStarts.length = 0;
    __debugStartOptions.length = 0;
    __debugStartResult.value = true;
  });

  function haltRequest(): HaltRequest & { cancel: () => void } {
    const cancels: Array<() => void> = [];
    return {
      session: {
        owner: { key: 'file:///a.ipynb', kind: 'notebook', label: 'a.ipynb' },
        execute: () => row('go', 5, 0, 5, 4, '<grail>', 'go()'),
      } as unknown as HaltRequest['session'],
      process: 42n,
      onCancel: (callback) => cancels.push(callback),
      cancel: () => cancels.forEach((c) => c()),
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

  it('starts a debug session for a halt and settles it from the adapter', async () => {
    const registration = registerBreakpointDebugger();
    const answered = installed!(haltRequest());
    await Promise.resolve();
    // Launch, not attach: an attach session shows Disconnect where Stop belongs.
    expect(__debugStarts).toEqual([
      expect.objectContaining({ type: 'gemdb', request: 'launch', name: 'GemDB: a.ipynb' }),
    ]);
    // Reaching a breakpoint() must not save the notebook.
    expect(__debugStartOptions).toEqual([{ suppressSaveBeforeStart: true }]);
    const adapter = adapterForLastStart();
    let seq = 1;
    const sent: Array<Record<string, unknown>> = [];
    adapter.onDidSendMessage((m) => sent.push(m as Record<string, unknown>));
    const id = (__debugStarts[0] as { gemdbPause: string }).gemdbPause;
    adapter.handleMessage({ seq: seq++, type: 'request', command: 'initialize' });
    adapter.handleMessage({
      seq: seq++,
      type: 'request',
      command: 'attach',
      arguments: { gemdbPause: id },
    });
    adapter.handleMessage({ seq: seq++, type: 'request', command: 'stackTrace', arguments: {} });
    const stack = sent.find((m) => m.command === 'stackTrace')?.body as {
      stackFrames: Array<{ name: string }>;
    };
    expect(stack.stackFrames.map((f) => f.name)).toEqual(['go']);
    adapter.handleMessage({ seq: seq++, type: 'request', command: 'continue', arguments: {} });
    await expect(answered).resolves.toBe('continue');
    registration.dispose();
  });

  it('keeps two pauses in one run apart: a late disconnect from the first settles nothing', async () => {
    const registration = registerBreakpointDebugger();
    const first = installed!(haltRequest());
    await Promise.resolve();
    const firstAdapter = adapterForLastStart();
    const firstId = (__debugStarts[0] as { gemdbPause: string }).gemdbPause;
    firstAdapter.handleMessage({
      seq: 1,
      type: 'request',
      command: 'launch',
      arguments: { gemdbPause: firstId },
    });
    firstAdapter.handleMessage({ seq: 2, type: 'request', command: 'continue', arguments: {} });
    await expect(first).resolves.toBe('continue');

    const second = installed!(haltRequest());
    await Promise.resolve();
    const secondId = (__debugStarts[1] as { gemdbPause: string }).gemdbPause;
    expect(secondId).not.toBe(firstId);
    // VS Code tears the first session down after it ended; that must not reach the second pause.
    firstAdapter.handleMessage({ seq: 3, type: 'request', command: 'disconnect', arguments: {} });
    firstAdapter.dispose();
    const secondAdapter = adapterForLastStart();
    secondAdapter.handleMessage({
      seq: 1,
      type: 'request',
      command: 'launch',
      arguments: { gemdbPause: secondId },
    });
    secondAdapter.handleMessage({ seq: 2, type: 'request', command: 'continue', arguments: {} });
    await expect(second).resolves.toBe('continue');
    registration.dispose();
  });

  it('stops the run when the debugger cannot start', async () => {
    __debugStartResult.value = false;
    const registration = registerBreakpointDebugger();
    await expect(installed!(haltRequest())).resolves.toBe('stop');
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

  it('uninstalls its handler and stops anything still paused when disposed', async () => {
    const registration = registerBreakpointDebugger();
    const answered = installed!(haltRequest());
    registration.dispose();
    await expect(answered).resolves.toBe('stop');
    expect(installed).toBeUndefined();
  });
});

describe('the variables queries’ answers', () => {
  it('reads each frame’s locals ref and, last, the globals ref', () => {
    expect(parseFrameRefs(`1${R}2${R}0${R}3${R}`)).toEqual({ locals: [1, 2, 0], globals: 3 });
    expect(parseFrameRefs(`0${R}`)).toEqual({ locals: [], globals: 0 });
  });

  it('reads one row per child, with its counts', () => {
    expect(
      parseChildren(row('tags', "{'a', 'b'}", 'set', 8, 2, 0) + row('n', '2', 'int', 0, 0, 0)),
    ).toEqual([
      { name: 'tags', value: "{'a', 'b'}", type: 'set', ref: 8, indexed: 2, named: 0 },
      { name: 'n', value: '2', type: 'int', ref: 0, indexed: 0, named: 0 },
    ]);
  });
});
