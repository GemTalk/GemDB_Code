import { describe, expect, it } from 'vitest';
import { PyRepl, ReplSession, ReplWorld } from '../pyRepl';
import { PyResult } from '../pythonQueries';
import { SessionError } from '../session';

/**
 * The REPL loop, driven the way a terminal drives it: bytes into
 * `handleInput`, text out through the world. The line editor's keystrokes
 * have their own suite (lineEditor.test.ts); this one is about the decisions
 * the loop makes around it — the continuation rule, exit(), type-ahead,
 * interruption, and a session that dies under the prompt.
 */

const OK: PyResult = { output: '', value: '' };

interface HarnessOptions {
  /** What running a statement answers; defaults to a silent success. May
   * stream chunks through the second argument first, the way a session does. */
  respond?: (source: string, onOutput: (text: string) => void) => Promise<PyResult>;
  /** Whether the session reports itself connected; defaults to true. */
  connected?: boolean;
  /** What the world answers when asked to bring the database up. */
  ensure?: boolean;
  /** When set, every login throws a SessionError with this message. */
  loginFails?: string;
}

function makeHarness(opts: HarnessOptions = {}) {
  const out: string[] = [];
  const runs: string[] = [];
  const counters = { interrupts: 0, logouts: 0, ensured: 0 };
  const state = { closed: false };

  const session: ReplSession = {
    connected: opts.connected ?? true,
    run(source: string, onOutput: (text: string) => void): Promise<PyResult> {
      runs.push(source);
      return opts.respond ? opts.respond(source, onOutput) : Promise.resolve(OK);
    },
    interrupt: () => {
      counters.interrupts += 1;
    },
    logout: () => {
      counters.logouts += 1;
    },
  };

  const world: ReplWorld = {
    write: (text) => out.push(text),
    close: () => {
      state.closed = true;
    },
    ensureRunning: () => {
      counters.ensured += 1;
      return Promise.resolve(opts.ensure ?? true);
    },
    login: () => {
      if (opts.loginFails) throw new SessionError(opts.loginFails);
      return session;
    },
  };

  return { repl: new PyRepl(world), runs, counters, state, text: () => out.join('') };
}

/** Let the promise chain behind a submitted line run to completion. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('PyRepl', () => {
  it('greets, logs in, and prompts', () => {
    const h = makeHarness();
    h.repl.open();
    expect(h.text()).toContain('GemDB Shell');
    expect(h.text()).toContain('>>> ');
  });

  it('evaluates a submitted line and shows its value', async () => {
    const h = makeHarness({ respond: () => Promise.resolve({ output: '', value: '4' }) });
    h.repl.open();
    h.repl.handleInput('2+2\r');
    await flush();
    expect(h.runs).toEqual(['2+2']);
    expect(h.text()).toContain('4\r\n');
    expect(h.text().endsWith('>>> ')).toBe(true);
  });

  it('renders printed output with terminal line endings, before the value', async () => {
    const h = makeHarness({ respond: () => Promise.resolve({ output: 'hi\nthere\n', value: '' }) });
    h.repl.open();
    h.repl.handleInput('print("hi")\r');
    await flush();
    expect(h.text()).toContain('hi\r\nthere\r\n');
  });

  it('writes streamed print() chunks as they arrive, before the value', async () => {
    // A session that streams delivers output through the callback and returns
    // it empty in the result — the loop must show the chunks (with terminal
    // line endings) and not wait for, or duplicate them from, the result.
    const h = makeHarness({
      respond: (_source, onOutput) => {
        onOutput('tick 1\n');
        onOutput('tick 2\n');
        return Promise.resolve({ output: '', value: "'done'" });
      },
    });
    h.repl.open();
    h.repl.handleInput('loop()\r');
    await flush();
    const text = h.text();
    expect(text).toContain('tick 1\r\ntick 2\r\n');
    expect(text.indexOf('tick 2')).toBeLessThan(text.indexOf("'done'"));
  });

  it('grows a block after a colon and runs it when an empty line closes it', async () => {
    const h = makeHarness();
    h.repl.open();
    h.repl.handleInput('def f():\r');
    await flush();
    expect(h.runs).toEqual([]); // still collecting
    expect(h.text()).toContain('... ');
    h.repl.handleInput('    return 1\r');
    await flush();
    h.repl.handleInput('\r');
    await flush();
    expect(h.runs).toEqual(['def f():\n    return 1\n']);
    expect(h.text().endsWith('>>> ')).toBe(true);
  });

  it('abandons a half-built block on Ctrl+C at the prompt, as CPython does', async () => {
    const h = makeHarness();
    h.repl.open();
    h.repl.handleInput('def f():\r');
    await flush();
    h.repl.handleInput('\u0003');
    h.repl.handleInput('1\r');
    await flush();
    expect(h.runs).toEqual(['1']); // nothing of the abandoned def survives
    expect(h.text()).toContain('^C');
  });

  it('leaves on exit() without evaluating it', async () => {
    const h = makeHarness();
    h.repl.open();
    h.repl.handleInput('exit()\r');
    await flush();
    expect(h.state.closed).toBe(true);
    expect(h.runs).toEqual([]);
  });

  it('leaves on Ctrl+D at an empty prompt', () => {
    const h = makeHarness();
    h.repl.open();
    h.repl.handleInput('\u0004');
    expect(h.state.closed).toBe(true);
  });

  it('interrupts running Python on Ctrl+C and reports it as KeyboardInterrupt', async () => {
    let release!: (result: PyResult) => void;
    const h = makeHarness({
      respond: () => new Promise<PyResult>((resolve) => (release = resolve)),
    });
    h.repl.open();
    h.repl.handleInput('while True: pass\r');
    await flush();
    expect(h.runs.length).toBe(1);

    h.repl.handleInput('\u0003');
    expect(h.counters.interrupts).toBe(1);

    // The break surfaces gem-side as an error result; the user who sent it is
    // told the Python way, not the Smalltalk way.
    release({ output: '', value: 'Error: UserInterrupt - a soft break was received' });
    await flush();
    expect(h.text()).toContain('KeyboardInterrupt');
    expect(h.text()).not.toContain('soft break');
  });

  it('reports a cancelled input() as KeyboardInterrupt, not as an error line', async () => {
    const h = makeHarness({
      respond: () => Promise.resolve({ output: '', value: 'Error: KeyboardInterrupt - ' }),
    });
    h.repl.open();
    h.repl.handleInput('input()\r');
    await flush();
    expect(h.text()).toContain('KeyboardInterrupt\r\n');
    expect(h.text()).not.toContain('Error:');
  });

  it('replays what was typed while Python ran', async () => {
    let release!: (result: PyResult) => void;
    const h = makeHarness({
      respond: (source) =>
        source === 'slow'
          ? new Promise<PyResult>((resolve) => (release = resolve))
          : Promise.resolve(OK),
    });
    h.repl.open();
    h.repl.handleInput('slow\r');
    await flush();
    h.repl.handleInput('fast\r'); // typed before the prompt is back
    expect(h.runs).toEqual(['slow']);

    release(OK);
    await flush();
    expect(h.runs).toEqual(['slow', 'fast']);
  });

  it('asks the world for a database when the session has died, and reports a refusal', async () => {
    const h = makeHarness({ connected: false, ensure: false });
    h.repl.open();
    h.repl.handleInput('1\r');
    await flush();
    expect(h.counters.ensured).toBe(1);
    expect(h.text()).toContain('GemDB is not running');
    expect(h.runs).toEqual([]);
  });

  it('shows a failed login and still offers the prompt', () => {
    const h = makeHarness({ loginFails: 'GemDB is not running. Start it before running Python.' });
    h.repl.open();
    expect(h.text()).toContain('GemDB is not running');
    expect(h.text().endsWith('>>> ')).toBe(true);
  });

  it('logs out when disposed', () => {
    const h = makeHarness();
    h.repl.open();
    h.repl.dispose();
    h.repl.dispose(); // second call is a no-op, not a second logout
    expect(h.counters.logouts).toBe(1);
  });

  // input(): the running Python asks for a line through readLine, and the
  // keys detour to a nested editor until the read settles.

  it('reads a line for input(), prompt first, through its own editor', async () => {
    const h = makeHarness();
    h.repl.open();
    const read = h.repl.readLine('NAME? ');
    h.repl.handleInput('Fred\r');
    expect(await read).toEqual({ line: 'Fred' });
    expect(h.text()).toContain('NAME? ');
    expect(h.text()).toContain('Fred');
  });

  it('answers Ctrl+C during input() as an interrupt', async () => {
    const h = makeHarness();
    h.repl.open();
    const read = h.repl.readLine('? ');
    h.repl.handleInput('\u0003');
    expect(await read).toEqual({ interrupt: true });
    expect(h.text()).toContain('^C');
  });

  it('answers Ctrl+D during input() as end of input', async () => {
    const h = makeHarness();
    h.repl.open();
    const read = h.repl.readLine('? ');
    h.repl.handleInput('\u0004');
    expect(await read).toEqual({ eof: true });
  });

  it('replays type-ahead into the read — the user answered early', async () => {
    let release!: (result: PyResult) => void;
    const h = makeHarness({
      respond: () => new Promise<PyResult>((resolve) => (release = resolve)),
    });
    h.repl.open();
    h.repl.handleInput('slow\r');
    await flush();
    h.repl.handleInput('Fred\r'); // typed before input() even asked
    expect(await h.repl.readLine('NAME? ')).toEqual({ line: 'Fred' });
    release(OK);
    await flush();
  });

  it('settles a pending read as end of input when disposed', async () => {
    const h = makeHarness();
    h.repl.open();
    const read = h.repl.readLine('? ');
    h.repl.dispose();
    expect(await read).toEqual({ eof: true });
  });
});
