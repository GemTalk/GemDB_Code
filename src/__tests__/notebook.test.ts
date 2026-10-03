import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { FakeController, __controllers, __resetSettings } from '../__mocks__/vscode';

// Runs the kernel through the same entry point VS Code calls (the
// executeHandler the controller publishes), against a fake controller rather
// than @vscode/test-electron. Once the logic around that entry point is
// covered, what's left is whether VS Code itself offers the controller in
// the kernel picker — VS Code's behaviour, not worth a downloaded editor per
// run to assert.

// The database and the Python are both somebody else's tests: what the
// controller decides is when to call them, with what, and what to do with the
// answer. Grail's own behaviour is covered against a real database in
// src/__integration__/grail.test.ts.
const ensureRunning = vi.fn<(extensionPath: string) => Promise<boolean>>();
interface SessionOwner {
  key: string;
  kind: string;
  label: string;
}

const runPython =
  vi.fn<
    (source: string, owner: SessionOwner, onOutput?: (text: string) => void) => Promise<PyResult>
  >();
const isErrorResult = vi.fn<(result: string) => boolean>();
const runPythonInSession =
  vi.fn<(session: unknown, source: string, scope: string) => Promise<PyResult>>();
const sessionForIfOpen = vi.fn<(key: string) => unknown>();

interface PyResult {
  output: string;
  value: string;
  stopped?: boolean;
}

const py = (value: string, output = ''): PyResult => ({ output, value });

vi.mock('../lifecycle', () => ({ ensureRunning: (p: string) => ensureRunning(p) }));
vi.mock('../pythonQueries', () => ({
  runPython: (source: string, owner: SessionOwner, onOutput?: (text: string) => void) =>
    runPython(source, owner, onOutput),
  isErrorResult: (result: string) => isErrorResult(result),
  resetScope: () => {},
  runPythonInSession: (session: unknown, source: string, scope: string) =>
    runPythonInSession(session, source, scope),
}));
vi.mock('../session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../session')>()),
  sessionForIfOpen: (key: string) => sessionForIfOpen(key),
}));

const { GemDbNotebookController, refreshActiveNotebookView } = await import('../notebook');

/** A notebook cell, reduced to what the controller reads. */
function cell(source: string, notebook = 'file:///a.ipynb'): unknown {
  return {
    document: { getText: () => source, uri: { toString: () => `${notebook}#cell` } },
    notebook: { uri: { toString: () => notebook } },
  };
}

function newController(): FakeController {
  new GemDbNotebookController('/ext');
  return __controllers[__controllers.length - 1];
}

/** Run cells the way VS Code does — through the handler the controller published. */
async function run(controller: FakeController, cells: unknown[]): Promise<void> {
  await controller.executeHandler?.(cells);
}

beforeEach(() => {
  __resetSettings();
  vi.clearAllMocks();
  ensureRunning.mockResolvedValue(true);
  isErrorResult.mockReturnValue(false);
  runPython.mockResolvedValue(py('ok'));
});

describe('the notebook kernel', () => {
  it('registers against the built-in notebook type, so no Jupyter extension is needed', () => {
    const controller = newController();
    expect(controller.notebookType).toBe('jupyter-notebook');
    expect(controller.supportedLanguages).toEqual(['python']);
  });

  it('starts the database once for the batch, not once per cell', async () => {
    const controller = newController();
    await run(controller, [cell('1'), cell('2'), cell('3')]);

    expect(ensureRunning).toHaveBeenCalledTimes(1);
    expect(runPython).toHaveBeenCalledTimes(3);
    expect(controller.executions.every((e) => e.success)).toBe(true);
  });

  it('numbers executions in order', async () => {
    const controller = newController();
    await run(controller, [cell('1'), cell('2')]);
    expect(controller.executions.map((e) => e.executionOrder)).toEqual([1, 2]);
  });

  it('fails every cell without running any Python when the database will not start', async () => {
    ensureRunning.mockResolvedValue(false);
    const controller = newController();
    await run(controller, [cell('1'), cell('2')]);

    // The point of doing this before the loop: no cell reports a failure of its
    // own for what is really one environment problem.
    expect(runPython).not.toHaveBeenCalled();
    expect(controller.executions).toHaveLength(2);
    expect(controller.executions.every((e) => e.started && e.success === false)).toBe(true);
  });

  it('keys the owner on the notebook, so two notebooks keep their own globals', async () => {
    const controller = newController();
    await run(controller, [cell('x', 'file:///one.ipynb'), cell('x', 'file:///two.ipynb')]);

    // The key is what selects both the session and the namespace inside it, so
    // two notebooks getting different keys is what keeps their variables — and
    // their transactions — apart.
    expect(runPython.mock.calls.map(([, owner]) => owner.key)).toEqual([
      'file:///one.ipynb',
      'file:///two.ipynb',
    ]);
    expect(runPython.mock.calls.map(([, owner]) => owner.kind)).toEqual(['notebook', 'notebook']);
  });

  it('labels a notebook session by file name, for messages about scarce sessions', async () => {
    const controller = newController();
    await run(controller, [cell('x', 'file:///work/analysis.ipynb')]);

    expect(runPython.mock.calls[0][1].label).toBe('analysis.ipynb');
  });

  it('runs every cell of one notebook under the same owner', async () => {
    const controller = newController();
    await run(controller, [cell('a'), cell('b'), cell('c')]);

    const keys = new Set(runPython.mock.calls.map(([, owner]) => owner.key));
    expect([...keys]).toEqual(['file:///a.ipynb']);
  });

  it('does not touch the database for an empty cell', async () => {
    const controller = newController();
    await run(controller, [cell('   \n  ')]);

    expect(runPython).not.toHaveBeenCalled();
    expect(controller.executions[0].success).toBe(true);
    expect(controller.executions[0].output).toEqual([]);
  });

  it('renders a result as text output', async () => {
    runPython.mockResolvedValue(py('42'));
    const controller = newController();
    await run(controller, [cell('6 * 7')]);

    const [output] = controller.executions[0].output;
    expect(output.items[0].mime).toBe('text/plain');
    expect(output.items[0].data).toBe('42');
    expect(controller.executions[0].success).toBe(true);
  });

  it('renders Python’s own error as a failed cell rather than a result', async () => {
    runPython.mockResolvedValue(py('Error: ZeroDivisionError - division by zero'));
    isErrorResult.mockReturnValue(true);
    const controller = newController();
    await run(controller, [cell('1 / 0')]);

    const [output] = controller.executions[0].output;
    expect(output.items[0].mime).toBe('application/vnd.code.notebook.error');
    expect(controller.executions[0].success).toBe(false);
  });

  it('reports a dropped session as a failed cell instead of throwing', async () => {
    // A thrown error is the environment failing — the database stopped, the
    // session died — not the cell's code. It still has to land in the cell,
    // because that is where the user is looking.
    runPython.mockRejectedValue(new Error('GemDB is not running'));
    const controller = newController();
    await expect(run(controller, [cell('1')])).resolves.toBeUndefined();

    const [output] = controller.executions[0].output;
    expect(output.items[0].data).toContain('GemDB is not running');
    expect(controller.executions[0].success).toBe(false);
  });

  it('streams print() chunks into the cell while it runs, then appends the value', async () => {
    // The kernel passes an output sink; each chunk repaints the cell's text
    // output. A streamed result comes back with `output` empty — the chunks
    // are everything — and must not be shown twice.
    runPython.mockImplementation((_source, _scope, onOutput) => {
      onOutput?.('tick 1\n');
      onOutput?.('tick 2\n');
      return Promise.resolve(py('42'));
    });
    const controller = newController();
    await run(controller, [cell('loop()')]);

    const outputs = controller.executions[0].output;
    expect(outputs).toHaveLength(2);
    expect(outputs[0].items[0].data).toBe('tick 1\ntick 2\n');
    expect(outputs[1].items[0].data).toBe('42');
    expect(controller.executions[0].success).toBe(true);
  });

  it('shows printed output before the result, as the code produced them', async () => {
    runPython.mockResolvedValue(py('42', 'working...\n'));
    const controller = newController();
    await run(controller, [cell('print("working..."); 6 * 7')]);

    const outputs = controller.executions[0].output;
    expect(outputs).toHaveLength(2);
    expect(outputs[0].items[0].data).toBe('working...\n');
    expect(outputs[1].items[0].data).toBe('42');
  });

  it('keeps what a cell printed even when it then raised', async () => {
    runPython.mockResolvedValue(py('Error: ZeroDivisionError - division by zero', 'partial\n'));
    isErrorResult.mockReturnValue(true);
    const controller = newController();
    await run(controller, [cell('print("partial"); 1 / 0')]);

    const outputs = controller.executions[0].output;
    expect(outputs[0].items[0].data).toBe('partial\n');
    expect(outputs[1].items[0].mime).toBe('application/vnd.code.notebook.error');
    expect(controller.executions[0].success).toBe(false);
  });

  it('suppresses a None result rather than printing it', async () => {
    runPython.mockResolvedValue(py('', ''));
    const controller = newController();
    await run(controller, [cell('x = 1')]);

    expect(controller.executions[0].output).toEqual([]);
    expect(controller.executions[0].success).toBe(true);
  });

  it('keeps going after a failed cell', async () => {
    isErrorResult.mockImplementation((result) => result === 'bad');
    runPython.mockResolvedValueOnce(py('bad')).mockResolvedValueOnce(py('good'));
    const controller = newController();
    await run(controller, [cell('1'), cell('2')]);

    expect(controller.executions.map((e) => e.success)).toEqual([false, true]);
  });

  it('stops the queued cells when the user stopped the run at a breakpoint()', async () => {
    isErrorResult.mockImplementation((result) => result.startsWith('Error: '));
    runPython.mockResolvedValueOnce({
      output: '',
      value: 'Error: Stopped in the debugger.',
      stopped: true,
    });
    const controller = newController();
    await run(controller, [cell('breakpoint()'), cell('2'), cell('3')]);

    // Only the stopped cell ran; the two behind it never started.
    expect(controller.executions.map((e) => e.success)).toEqual([false]);
    expect(runPython).toHaveBeenCalledTimes(1);
  });

  it('stops the queued cells when the user interrupts, and runs the next batch normally', async () => {
    isErrorResult.mockImplementation((result) => result.startsWith('Error: '));
    const controller = newController();
    // The interrupt arrives while the first cell is running.
    runPython.mockImplementationOnce(async () => {
      await controller.interruptHandler?.({ uri: { toString: () => 'file:///a.ipynb' } });
      return py('Error: Break - a Break occurred');
    });
    await run(controller, [cell('while True: pass'), cell('2')]);
    expect(controller.executions).toHaveLength(1);

    runPython.mockResolvedValueOnce(py('3'));
    await run(controller, [cell('3')]);
    expect(controller.executions.map((e) => e.success)).toEqual([false, true]);
  });

  it('stops the queued cells when a cell could not run at all', async () => {
    runPython.mockRejectedValueOnce(
      new Error('The session was closed while paused in the debugger.'),
    );
    const controller = newController();

    await run(controller, [cell('breakpoint()'), cell('2'), cell('3')]);

    // The next cell would log in afresh, without the state the first one had.
    expect(runPython).toHaveBeenCalledTimes(1);
    expect(controller.executions.map((e) => e.success)).toEqual([false]);
  });

  it('runs a second request for the same notebook only after the first has finished', async () => {
    let finishFirst: (result: PyResult) => void = () => {};
    runPython.mockImplementationOnce(
      () => new Promise<PyResult>((resolve) => (finishFirst = resolve)),
    );
    const controller = newController();
    const first = run(controller, [cell('breakpoint()')]);
    await vi.waitFor(() => expect(runPython).toHaveBeenCalledTimes(1));

    const second = run(controller, [cell('2')]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const callsWhileFirstRan = runPython.mock.calls.length;
    finishFirst(py('1'));
    await Promise.all([first, second]);

    expect(callsWhileFirstRan).toBe(1);
    expect(runPython.mock.calls.map(([source]) => source)).toEqual(['breakpoint()', '2']);
  });

  it('ends a run waiting behind another when the user interrupts', async () => {
    isErrorResult.mockImplementation((result) => result.startsWith('Error: '));
    let finishFirst: (result: PyResult) => void = () => {};
    runPython.mockImplementationOnce(
      () => new Promise<PyResult>((resolve) => (finishFirst = resolve)),
    );
    const controller = newController();
    const first = run(controller, [cell('breakpoint()')]);
    await vi.waitFor(() => expect(runPython).toHaveBeenCalledTimes(1));
    const second = run(controller, [cell('2')]);

    await controller.interruptHandler?.({ uri: { toString: () => 'file:///a.ipynb' } });
    finishFirst(py('Error: KeyboardInterrupt - '));
    await Promise.all([first, second]);

    expect(runPython).toHaveBeenCalledTimes(1);
  });

  it('runs no cell when the user interrupts while the database is still starting', async () => {
    let started: (running: boolean) => void = () => {};
    ensureRunning.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => (started = resolve)),
    );
    const controller = newController();
    const running = run(controller, [cell('1'), cell('2')]);
    await vi.waitFor(() => expect(ensureRunning).toHaveBeenCalled());

    await controller.interruptHandler?.({ uri: { toString: () => 'file:///a.ipynb' } });
    started(true);
    await running;

    expect(runPython).not.toHaveBeenCalled();
  });

  it('does not hold one notebook’s run behind another’s', async () => {
    runPython.mockImplementationOnce(() => new Promise<PyResult>(() => {}));
    const controller = newController();
    void run(controller, [cell('breakpoint()', 'file:///a.ipynb')]);
    await vi.waitFor(() => expect(runPython).toHaveBeenCalledTimes(1));

    await run(controller, [cell('2', 'file:///b.ipynb')]);

    expect(runPython).toHaveBeenCalledTimes(2);
  });

  it('tells its listener after every cell, so views that show commits can re-read', async () => {
    const finished = vi.fn();
    new GemDbNotebookController('/ext', finished);
    const controller = __controllers[__controllers.length - 1];
    runPython.mockRejectedValueOnce(new Error('dropped'));

    await run(controller, [cell('1')]);
    await run(controller, [cell('2'), cell('3')]);

    // Once per cell that ran, whether it succeeded or not.
    expect(finished).toHaveBeenCalledTimes(3);
  });

  it('clears the previous run’s output as soon as a cell starts', async () => {
    const controller = newController();
    let atStart: unknown;
    runPython.mockImplementationOnce(async () => {
      atStart = controller.executions[0].output;
      return py('1');
    });
    await run(controller, [cell('1')]);
    expect(atStart).toEqual([]);
  });
});

describe('Refresh Notebook View', () => {
  const notebook = 'file:///analysis.ipynb';
  const openNotebook = () => {
    (vscode.window as { activeNotebookEditor: unknown }).activeNotebookEditor = {
      notebook: { uri: { toString: () => notebook } },
    };
  };

  beforeEach(() => {
    runPythonInSession.mockReset();
    sessionForIfOpen.mockReset();
    isErrorResult.mockImplementation((value) => value.startsWith('Error: '));
  });

  it('asks for a notebook when none is open', async () => {
    (vscode.window as { activeNotebookEditor: unknown }).activeNotebookEditor = undefined;
    const error = vi.spyOn(vscode.window, 'showErrorMessage');

    await refreshActiveNotebookView();

    expect(error).toHaveBeenCalledWith('Open a notebook to refresh its view.');
    expect(runPythonInSession).not.toHaveBeenCalled();
  });

  it('spends no session on a notebook that has not run a cell', async () => {
    openNotebook();
    sessionForIfOpen.mockReturnValue(undefined);
    const info = vi.spyOn(vscode.window, 'showInformationMessage');

    await refreshActiveNotebookView();

    expect(runPythonInSession).not.toHaveBeenCalled();
    expect(info.mock.calls.at(-1)?.[0]).toContain('first cell will see every commit');
  });

  it('runs gemdb.refresh() in the notebook’s own session, binding no name', async () => {
    openNotebook();
    const session = { id: 'the notebook’s' };
    sessionForIfOpen.mockReturnValue(session);
    runPythonInSession.mockResolvedValue(py(''));
    const info = vi.spyOn(vscode.window, 'showInformationMessage');

    await refreshActiveNotebookView();

    const [usedSession, source, scope] = runPythonInSession.mock.calls[0];
    expect(usedSession).toBe(session);
    expect(source).toBe("__import__('gemdb').refresh()");
    expect(scope).toBe(sessionForIfOpen.mock.calls[0][0]);
    expect(info.mock.calls.at(-1)?.[0]).toContain('now sees every commit');
  });

  it('shows gemdb.refresh()’s own refusal when there are uncommitted changes', async () => {
    openNotebook();
    sessionForIfOpen.mockReturnValue({});
    runPythonInSession.mockResolvedValue(
      py('Error: PendingChangesError: commit or abort your changes first'),
    );
    const error = vi.spyOn(vscode.window, 'showErrorMessage');

    await refreshActiveNotebookView();

    expect(error.mock.calls.at(-1)?.[0]).toBe(
      'PendingChangesError: commit or abort your changes first',
    );
  });
});
