import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeController, __controllers, __resetSettings } from '../__mocks__/vscode';

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

interface PyResult {
  output: string;
  value: string;
}

const py = (value: string, output = ''): PyResult => ({ output, value });

vi.mock('../lifecycle', () => ({ ensureRunning: (p: string) => ensureRunning(p) }));
vi.mock('../pythonQueries', () => ({
  runPython: (source: string, owner: SessionOwner, onOutput?: (text: string) => void) =>
    runPython(source, owner, onOutput),
  isErrorResult: (result: string) => isErrorResult(result),
  resetScope: () => {},
}));

const { GemDbNotebookController } = await import('../notebook');

/** A notebook cell, reduced to the two things the controller reads. */
function cell(source: string, notebook = 'file:///a.ipynb'): unknown {
  return {
    document: { getText: () => source },
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
});
