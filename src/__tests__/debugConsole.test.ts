import { afterEach, describe, expect, it, vi } from 'vitest';
import { window } from '../__mocks__/vscode';
import type { ConsoleAnswer, Pause } from '../debugger';
import type { HaltHandler, RedDotSource } from '../session';

/**
 * The Debug Console and the Watch pane, without a database: what the adapter
 * does with an `evaluate` request — which frame it asks for, what it sends
 * back and in what order, how it is stopped — given a pause whose `evaluate`
 * is a stub. What the expression actually does in the gem is
 * `debugConsole.test.ts` in `__integration__`.
 */

vi.mock('../session', () => ({
  setHaltHandler: (_handler: HaltHandler | undefined) => {},
  setRedDotSource: (_source: RedDotSource | undefined) => {},
}));

const { PauseDebugAdapter } = await import('../debugger');

/** Let the adapter's promises run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

type Evaluate = NonNullable<Pause['evaluate']>;

/** A value answer: `value` reads as typed, nothing printed, not expandable. */
const value = (text: string, more: Partial<ConsoleAnswer> = {}): ConsoleAnswer =>
  ({ kind: 'value', output: '', value: text, variablesReference: 0, ...more }) as ConsoleAnswer;

/** An adapter on a paused two-frame stack whose `evaluate` is `evaluate`. */
function consoleOn(evaluate: Evaluate | undefined, more: Partial<Pause> = {}) {
  const sent: Array<Record<string, unknown>> = [];
  const pause: Pause = {
    label: 'a.ipynb',
    frames: [
      { id: 1, name: 'inner', line: 4, column: 1 },
      { id: 2, name: 'outer', line: 9, column: 1 },
    ],
    scopes: () => [],
    variables: () => Promise.resolve([]),
    answer: () => {},
    ...(evaluate ? { evaluate } : {}),
    ...more,
  };
  const adapter = new PauseDebugAdapter(() => pause);
  adapter.onDidSendMessage((m) => sent.push(m as Record<string, unknown>));
  let seq = 1;
  const request = (command: string, args?: Record<string, unknown>): number => {
    const mine = seq++;
    adapter.handleMessage({ seq: mine, type: 'request', command, arguments: args });
    return mine;
  };
  const responseTo = (requestSeq: number) =>
    sent.find((m) => m.type === 'response' && m.request_seq === requestSeq);
  const events = (name: string) => sent.filter((m) => m.type === 'event' && m.event === name);
  return { adapter, sent, request, responseTo, events };
}

/** Initialize (as VS Code does, claiming what it supports), launch and stop. */
function started(
  evaluate: Evaluate | undefined,
  client: Record<string, unknown> = { supportsInvalidatedEvent: true },
  more: Partial<Pause> = {},
) {
  const c = consoleOn(evaluate, more);
  c.request('initialize', { adapterID: 'gemdb', ...client });
  c.request('launch', { gemdbPause: '1' });
  c.request('configurationDone');
  return c;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('what the adapter claims', () => {
  it('claims cancelling, so a runaway console line can be stopped', () => {
    const { request, responseTo } = consoleOn(undefined);
    const seq = request('initialize', { adapterID: 'gemdb' });

    expect(responseTo(seq)?.body).toMatchObject({ supportsCancelRequest: true });
  });

  it('does not claim hover evaluation: a hover must never change anything', () => {
    const { request, responseTo } = consoleOn(undefined);
    const seq = request('initialize', { adapterID: 'gemdb' });

    const body = responseTo(seq)?.body as Record<string, unknown>;
    expect(body.supportsEvaluateForHovers).toBeFalsy();
  });

  it('refuses a hover evaluate without running anything', async () => {
    const evaluate = vi.fn<Evaluate>();
    const { request, responseTo } = started(evaluate);

    const seq = request('evaluate', { expression: 'p', frameId: 1, context: 'hover' });
    await settle();

    expect(responseTo(seq)?.success).toBe(false);
    expect(evaluate).not.toHaveBeenCalled();
  });
});

describe('the frame an expression runs in', () => {
  it('runs in the frame VS Code names: the one selected in Call Stack', async () => {
    const evaluate = vi.fn<Evaluate>().mockResolvedValue(value('1'));
    const { request } = started(evaluate);

    request('evaluate', { expression: 'n', frameId: 2, context: 'repl' });
    await settle();

    expect(evaluate).toHaveBeenCalledWith('n', 2, 'repl', expect.anything());
  });

  it('runs in the top frame when VS Code names none', async () => {
    const evaluate = vi.fn<Evaluate>().mockResolvedValue(value('1'));
    const { request } = started(evaluate);

    request('evaluate', { expression: 'n', context: 'repl' });
    await settle();

    expect(evaluate).toHaveBeenCalledWith('n', 1, 'repl', expect.anything());
  });

  it('tells a watch from a console line, so a watch keeps the short time budget', async () => {
    const evaluate = vi.fn<Evaluate>().mockResolvedValue(value('1'));
    const { request } = started(evaluate);

    request('evaluate', { expression: 'n', frameId: 1, context: 'watch' });
    await settle();

    expect(evaluate).toHaveBeenCalledWith('n', 1, 'watch', expect.anything());
  });

  it('answers with a message, not a hang, where the pause offers no evaluation', async () => {
    const { request, responseTo } = started(undefined);

    const seq = request('evaluate', { expression: 'p', frameId: 1, context: 'repl' });
    await settle();

    expect(responseTo(seq)).toMatchObject({ success: false });
    expect(responseTo(seq)?.message).toEqual(expect.any(String));
  });
});

describe('what the console shows', () => {
  it('answers the value as typed, with its type and a reference that opens it', async () => {
    const { request, responseTo } = started(() =>
      Promise.resolve(value("P('ann')", { type: 'P', variablesReference: 12, namedVariables: 2 })),
    );

    const seq = request('evaluate', { expression: 'p', frameId: 1, context: 'repl' });
    await settle();

    expect(responseTo(seq)).toMatchObject({
      success: true,
      body: { result: "P('ann')", type: 'P', variablesReference: 12, namedVariables: 2 },
    });
  });

  it('pages a big result the way the Variables pane does', async () => {
    const { request, responseTo } = started(() =>
      Promise.resolve(
        value('list with 1000 items', {
          type: 'list',
          variablesReference: 4,
          indexedVariables: 1000,
        }),
      ),
    );

    const seq = request('evaluate', { expression: 'big', frameId: 1, context: 'repl' });
    await settle();

    expect(responseTo(seq)?.body).toMatchObject({ variablesReference: 4, indexedVariables: 1000 });
  });

  it('shows nothing for None or a statement', async () => {
    const { request, responseTo } = started(() => Promise.resolve(value('')));

    const seq = request('evaluate', { expression: 'y = 5', frameId: 1, context: 'repl' });
    await settle();

    expect(responseTo(seq)).toMatchObject({
      success: true,
      body: { result: '', variablesReference: 0 },
    });
  });

  it('sends what the line printed as stdout output, before the answer', async () => {
    const { request, sent, responseTo } = started(() =>
      Promise.resolve(value('', { output: "P('ann')\n" })),
    );

    const seq = request('evaluate', { expression: 'print(p)', frameId: 1, context: 'repl' });
    await settle();

    const printed = sent.findIndex((m) => m.event === 'output');
    const answered = sent.indexOf(responseTo(seq)!);
    expect(sent[printed]?.body).toMatchObject({ category: 'stdout', output: "P('ann')\n" });
    expect(printed).toBeGreaterThanOrEqual(0);
    expect(printed).toBeLessThan(answered);
  });

  it('sends no output event when nothing was printed', async () => {
    const { request, events } = started(() => Promise.resolve(value('1')));

    request('evaluate', { expression: '1', frameId: 1, context: 'repl' });
    await settle();

    expect(events('output')).toEqual([]);
  });
});

describe('errors', () => {
  const TRACEBACK = [
    '---------------------------------------------------------------------------',
    'ZeroDivisionError                         Traceback (most recent call last)',
    'Debug Console, line 2',
    '      1 x = 1',
    '----> 2 1/0',
    '',
    'ZeroDivisionError: division by zero',
  ].join('\n');

  it('fails the request with the traceback as its message, not put to the user as a dialog', async () => {
    const { request, responseTo } = started(() =>
      Promise.resolve({ kind: 'error', output: '', traceback: TRACEBACK } as ConsoleAnswer),
    );

    const seq = request('evaluate', { expression: 'x = 1\n1/0', frameId: 1, context: 'repl' });
    await settle();

    const reply = responseTo(seq) as {
      success: boolean;
      message: string;
      body: { error: { format: string; showUser: boolean } };
    };
    expect(reply.success).toBe(false);
    expect(reply.message).toBe(TRACEBACK);
    expect(reply.body.error.showUser).toBe(false);
  });

  it('still sends what was printed before the error, ahead of it', async () => {
    const { request, sent, responseTo } = started(() =>
      Promise.resolve({ kind: 'error', output: 'first\n', traceback: TRACEBACK } as ConsoleAnswer),
    );

    const seq = request('evaluate', {
      expression: 'print("first")\n1/0',
      frameId: 1,
      context: 'repl',
    });
    await settle();

    const printed = sent.findIndex((m) => m.event === 'output');
    expect(sent[printed]?.body).toMatchObject({ output: 'first\n' });
    expect(printed).toBeLessThan(sent.indexOf(responseTo(seq)!));
  });

  it('shows a watch’s error in the watch, the same way', async () => {
    const { request, responseTo } = started(() =>
      Promise.resolve({ kind: 'error', output: '', traceback: TRACEBACK } as ConsoleAnswer),
    );

    const seq = request('evaluate', { expression: '1/0', frameId: 1, context: 'watch' });
    await settle();

    expect(responseTo(seq)).toMatchObject({ success: false, message: TRACEBACK });
  });

  it('reads an interrupted line as interrupted, not as an error in the user’s code', async () => {
    const { request, responseTo } = started(() =>
      Promise.resolve({ kind: 'interrupted', output: '' } as ConsoleAnswer),
    );

    const seq = request('evaluate', {
      expression: 'while True: pass',
      frameId: 1,
      context: 'repl',
    });
    await settle();

    const reply = responseTo(seq) as { success: boolean; message: string };
    expect(reply.success).toBe(false);
    expect(reply.message).toMatch(/interrupted/i);
    expect(reply.message).not.toMatch(/^Error/);
  });

  it('answers a failure of the evaluation itself with a message, and keeps the pause', async () => {
    const answer = vi.fn();
    const { request, responseTo } = started(
      () => Promise.reject(new Error('the session went away')),
      undefined,
      { answer },
    );

    const seq = request('evaluate', { expression: 'p', frameId: 1, context: 'repl' });
    await settle();

    expect(responseTo(seq)).toMatchObject({ success: false });
    expect(answer).not.toHaveBeenCalled();
  });
});

describe('the Variables pane after a console line', () => {
  it('tells VS Code to read the variables again after a console line', async () => {
    const { request, events } = started(() => Promise.resolve(value('')));

    request('evaluate', { expression: 'p.x = 10', frameId: 1, context: 'repl' });
    await settle();

    expect(events('invalidated').map((e) => e.body)).toEqual([
      expect.objectContaining({ areas: expect.arrayContaining(['variables']) }),
    ]);
  });

  it('says so after a console line that failed too: it may have changed something first', async () => {
    const { request, events } = started(() =>
      Promise.resolve({ kind: 'error', output: '', traceback: 'x' } as ConsoleAnswer),
    );

    request('evaluate', { expression: 'p.x = 10\n1/0', frameId: 1, context: 'repl' });
    await settle();

    expect(events('invalidated')).toHaveLength(1);
  });

  it('never invalidates after a watch, which VS Code re-runs when the variables are read again', async () => {
    const { request, events } = started(() => Promise.resolve(value('1')));

    request('evaluate', { expression: 'p.x', frameId: 1, context: 'watch' });
    await settle();

    expect(events('invalidated')).toEqual([]);
  });

  it('sends no invalidated event to a client that did not claim it', async () => {
    const { request, events } = started(() => Promise.resolve(value('')), {});

    request('evaluate', { expression: 'p.x = 10', frameId: 1, context: 'repl' });
    await settle();

    expect(events('invalidated')).toEqual([]);
  });
});

describe('stopping a runaway line', () => {
  /** An evaluate that runs until its signal aborts, then answers interrupted. */
  function runaway(): { evaluate: Evaluate; signals: AbortSignal[] } {
    const signals: AbortSignal[] = [];
    const evaluate: Evaluate = (_source, _frameId, _context, signal) => {
      signals.push(signal);
      return new Promise<ConsoleAnswer>((resolve) =>
        signal.addEventListener('abort', () =>
          resolve({ kind: 'interrupted', output: '' } as ConsoleAnswer),
        ),
      );
    };
    return { evaluate, signals };
  }

  it('stops the line on DAP cancel, and answers both requests', async () => {
    const { evaluate, signals } = runaway();
    const { request, responseTo } = started(evaluate);

    const running = request('evaluate', {
      expression: 'while True: pass',
      frameId: 1,
      context: 'repl',
    });
    await settle();
    const cancel = request('cancel', { requestId: running });
    await settle();

    expect(signals[0].aborted).toBe(true);
    expect(responseTo(cancel)?.success).toBe(true);
    expect(responseTo(running)).toMatchObject({ success: false });
    expect((responseTo(running) as { message: string }).message).toMatch(/interrupted|cancelled/i);
  });

  it('leaves alone a line that a cancel for some other request names', async () => {
    const { evaluate, signals } = runaway();
    const { request } = started(evaluate);

    const running = request('evaluate', { expression: 'spin()', frameId: 1, context: 'repl' });
    await settle();
    request('cancel', { requestId: running + 100 });
    await settle();

    expect(signals[0].aborted).toBe(false);
  });

  it('offers a cancellable notification once a console line has run a few seconds', async () => {
    vi.useFakeTimers();
    const { evaluate, signals } = runaway();
    let cancelRequested: (() => void) | undefined;
    const shown: Array<{ cancellable?: boolean; title?: string }> = [];
    vi.spyOn(window, 'withProgress').mockImplementation(((
      options: { cancellable?: boolean; title?: string },
      task: (
        progress: unknown,
        token: { isCancellationRequested: boolean; onCancellationRequested: unknown },
      ) => Thenable<unknown>,
    ) => {
      shown.push(options);
      return task(
        { report: () => {} },
        {
          isCancellationRequested: false,
          onCancellationRequested: (listener: () => void) => {
            cancelRequested = listener;
            return { dispose: () => {} };
          },
        },
      );
    }) as typeof window.withProgress);
    const { request, responseTo } = started(evaluate);

    const running = request('evaluate', {
      expression: 'while True: pass',
      frameId: 1,
      context: 'repl',
    });
    await vi.advanceTimersByTimeAsync(500);
    const earlyNotifications = shown.length;
    await vi.advanceTimersByTimeAsync(5_000);
    cancelRequested?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(earlyNotifications).toBe(0);
    expect(shown).toEqual([expect.objectContaining({ cancellable: true })]);
    expect(signals[0].aborted).toBe(true);
    expect(responseTo(running)).toMatchObject({ success: false });
  });

  it('shows no notification for a line that finishes quickly', async () => {
    vi.useFakeTimers();
    const progress = vi.spyOn(window, 'withProgress');
    const { request } = started(() => Promise.resolve(value('1')));

    request('evaluate', { expression: '1', frameId: 1, context: 'repl' });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(progress).not.toHaveBeenCalled();
  });

  it('shows no notification for a watch, which has a budget of its own', async () => {
    vi.useFakeTimers();
    const progress = vi.spyOn(window, 'withProgress');
    const { evaluate } = runaway();
    const { request } = started(evaluate);

    request('evaluate', { expression: 'spin()', frameId: 1, context: 'watch' });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(progress).not.toHaveBeenCalled();
  });
});

describe('a saved stack', () => {
  it.todo(
    'offers the console on a stack opened from the database read-only, or refuses it with a message — not decided yet',
  );
});

describe('putting a Variables row in the Debug Console', () => {
  const showRow = (answer: ConsoleAnswer) => vi.fn(() => Promise.resolve(answer));

  it('shows the row’s object as an entry that expands like the row', async () => {
    const shown = showRow(value("Account('ada', 10)", { variablesReference: 7 }));
    const { request, responseTo, events } = started(undefined, undefined, {
      showRow: shown,
      evaluate: vi.fn(),
    });

    const seq = request('gemdbShowRow', { handle: 7, name: 'p' });
    await settle();

    expect(shown).toHaveBeenCalledWith(7, 'p');
    expect(events('output').map((e) => e.body)).toEqual([
      { category: 'console', output: "p: Account('ada', 10)\n", variablesReference: 7 },
    ]);
    expect(responseTo(seq)?.success).toBe(true);
    // Showing changes nothing, so Variables is left alone.
    expect(events('invalidated')).toEqual([]);
  });

  it('runs an expression with self bound to the row, echoing it, and refreshes Variables', async () => {
    const evaluate = vi.fn<Evaluate>().mockResolvedValue(value('2', { output: 'hi\n' }));
    const { request, events } = started(evaluate, undefined, { showRow: vi.fn() });

    request('gemdbShowRow', { handle: 7, name: 'p', expression: 'len(self.history)', frameId: 2 });
    await settle();

    expect(evaluate).toHaveBeenCalledWith('len(self.history)', 2, 'repl', expect.anything(), 7);
    expect(events('output').map((e) => e.body)).toEqual([
      { category: 'console', output: '>>> len(self.history)  # self is p\n' },
      { category: 'stdout', output: 'hi\n' },
      { category: 'console', output: '2\n', variablesReference: 0 },
    ]);
    expect(events('invalidated')).toHaveLength(1);
  });

  it('shows an error’s traceback in the console', async () => {
    const evaluate = vi
      .fn<Evaluate>()
      .mockResolvedValue({ kind: 'error', output: '', traceback: 'TB' } as ConsoleAnswer);
    const { request, events, responseTo } = started(evaluate, undefined, { showRow: vi.fn() });

    const seq = request('gemdbShowRow', { handle: 7, name: 'p', expression: 'self.nope' });
    await settle();

    expect(events('output').pop()?.body).toEqual({ category: 'stderr', output: 'TB\n' });
    expect(responseTo(seq)?.success).toBe(true);
  });

  it('refuses where the pause has no rows to show, such as a saved stack', async () => {
    const { request, responseTo } = started(undefined);

    const seq = request('gemdbShowRow', { handle: 7, name: 'p' });
    await settle();

    expect(responseTo(seq)).toMatchObject({ success: false });
  });
});
