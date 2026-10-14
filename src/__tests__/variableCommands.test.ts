import { afterEach, describe, expect, it, vi } from 'vitest';
import { DebugStackFrame, __commands, commands, debug, window } from '../__mocks__/vscode';
import type { Pause } from '../debugger';

/**
 * Show in Debug Console and Evaluate with self… on a Variables row, without a
 * database: which row's object they name, what they ask the paused session,
 * and that they open the console. What the adapter does with the request is
 * `debugConsole.test.ts`; the whole path at a real pause is the row-menu test
 * in `__integration__/debugConsole.test.ts`.
 */

let pause: Partial<Pause> | undefined;
vi.mock('../debugger', () => ({
  DEBUG_TYPE: 'gemdb',
  pauseForDebugSession: (id: string | undefined) => (id === 's1' ? pause : undefined),
}));

const {
  EVALUATE_WITH_SELF,
  SHOW_IN_CONSOLE,
  evaluateWithSelf,
  registerVariableCommands,
  showInDebugConsole,
} = await import('../variableCommands');

type CustomRequest = (command: string, args?: unknown) => Promise<unknown>;

/** A paused GemDB session whose rows under container 5 have handles by name. */
function paused(customRequest: CustomRequest = () => Promise.resolve({})) {
  const session = { id: 's1', type: 'gemdb', name: 'GemDB: a.ipynb', customRequest };
  debug.activeDebugSession = session;
  pause = { handleFor: (container, name) => (container === 5 && name === 'n' ? 12 : undefined) };
  return session;
}

/** Record the commands run and the errors shown, in order. */
function watching() {
  const seen: string[] = [];
  vi.spyOn(commands, 'executeCommand').mockImplementation((id: string) => {
    seen.push(`command ${id}`);
    return undefined;
  });
  vi.spyOn(window, 'showErrorMessage').mockImplementation((message: string) => {
    seen.push(`error ${message}`);
    return Promise.resolve(undefined);
  });
  return seen;
}

const row = (name: string, variablesReference: number) => ({
  sessionId: 's1',
  container: { variablesReference: 5 },
  variable: { name, value: '…', variablesReference },
});

afterEach(() => {
  vi.restoreAllMocks();
  debug.activeDebugSession = undefined;
  debug.activeStackItem = undefined;
  pause = undefined;
});

describe('Show in Debug Console', () => {
  it('opens the console, then asks the session to show the row’s object there', async () => {
    const seen = watching();
    const customRequest = vi.fn<CustomRequest>(async (command, args) => {
      seen.push(`request ${command} ${JSON.stringify(args)}`);
      return {};
    });
    paused(customRequest);

    await showInDebugConsole(row('p', 7));

    expect(seen).toEqual([
      'command workbench.debug.action.focusRepl',
      'request gemdbShowRow {"handle":7,"name":"p"}',
    ]);
  });

  it('leaves what to type at the console’s prompt, as the adapter answers it', async () => {
    const seen = watching();
    vi.spyOn(commands, 'executeCommand').mockImplementation((id: string, ...args: unknown[]) => {
      seen.push(`command ${id}${args.length ? ' ' + JSON.stringify(args[0]) : ''}`);
      return undefined;
    });
    paused(() => Promise.resolve({ typed: 'entry' }));

    await showInDebugConsole(row('entry', 7));

    expect(seen).toEqual([
      'command workbench.debug.action.focusRepl',
      'command type {"text":"entry"}',
    ]);
  });

  it('types nothing when the adapter answers nothing to type', async () => {
    const seen = watching();
    paused(() => Promise.resolve({}));

    await showInDebugConsole(row('p', 7));

    expect(seen).toEqual(['command workbench.debug.action.focusRepl']);
  });

  it('finds a leaf row’s object by its handle, as Add to Persisted Objects does', async () => {
    watching();
    const customRequest = vi.fn<CustomRequest>().mockResolvedValue({});
    paused(customRequest);

    await showInDebugConsole(row('n', 0));

    expect(customRequest).toHaveBeenCalledWith('gemdbShowRow', { handle: 12, name: 'n' });
  });

  it('says so, and asks nothing, for a row with no object of its own', async () => {
    const seen = watching();
    const customRequest = vi.fn<CustomRequest>();
    paused(customRequest);

    await showInDebugConsole(row('...', 0));

    expect(customRequest).not.toHaveBeenCalled();
    expect(seen).toEqual(['error "..." is not an object of its own.']);
  });

  it('says it needs a paused GemDB run when there is none', async () => {
    const seen = watching();
    debug.activeDebugSession = { id: 'py', type: 'debugpy' };

    await showInDebugConsole(row('p', 7));

    expect(seen).toEqual([expect.stringMatching(/^error .*paused in the debugger/)]);
  });

  it('shows the error when the request fails', async () => {
    const seen = watching();
    paused(() => Promise.reject(new Error('the pause is over')));

    await showInDebugConsole(row('p', 7));

    expect(seen).toContain('error the pause is over');
  });
});

describe('Evaluate with self…', () => {
  it('runs the expression typed with self bound to the row, in the frame selected in Call Stack', async () => {
    watching();
    const customRequest = vi.fn<CustomRequest>().mockResolvedValue({});
    const session = paused(customRequest);
    debug.activeStackItem = new DebugStackFrame(session, 1, 3);
    vi.spyOn(window, 'showInputBox').mockResolvedValue('len(self.history)');

    await evaluateWithSelf(row('p', 7));

    expect(customRequest).toHaveBeenCalledWith('gemdbShowRow', {
      handle: 7,
      name: 'p',
      expression: 'len(self.history)',
      frameId: 3,
    });
  });

  it('leaves the frame to the adapter when none is selected in this session', async () => {
    watching();
    const customRequest = vi.fn<CustomRequest>().mockResolvedValue({});
    paused(customRequest);
    debug.activeStackItem = new DebugStackFrame(
      { id: 'other', type: 'gemdb', customRequest },
      1,
      3,
    );
    vi.spyOn(window, 'showInputBox').mockResolvedValue('self');

    await evaluateWithSelf(row('p', 7));

    expect(customRequest.mock.calls[0][1]).not.toHaveProperty('frameId');
  });

  it('does nothing when the input box is dismissed or left empty', async () => {
    const seen = watching();
    const customRequest = vi.fn<CustomRequest>();
    paused(customRequest);
    const input = vi.spyOn(window, 'showInputBox');

    input.mockResolvedValueOnce(undefined);
    await evaluateWithSelf(row('p', 7));
    input.mockResolvedValueOnce('   ');
    await evaluateWithSelf(row('p', 7));

    expect(customRequest).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });
});

describe('registering the commands', () => {
  it('registers both under the ids package.json puts on the Variables menu, and removes them on dispose', async () => {
    const registration = registerVariableCommands();
    const { default: manifest } = (await import('../../package.json')) as unknown as {
      default: {
        contributes: { menus: Record<string, Array<{ command: string; when?: string }>> };
      };
    };

    expect(__commands.has(SHOW_IN_CONSOLE)).toBe(true);
    expect(__commands.has(EVALUATE_WITH_SELF)).toBe(true);
    const onVariables = manifest.contributes.menus['debug/variables/context'];
    expect(onVariables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ command: SHOW_IN_CONSOLE, when: 'debugType == gemdb' }),
        expect.objectContaining({ command: EVALUATE_WITH_SELF, when: 'debugType == gemdb' }),
      ]),
    );
    registration.dispose();
    expect(__commands.has(SHOW_IN_CONSOLE)).toBe(false);
  });
});
