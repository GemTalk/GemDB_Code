import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeController, __controllers, __resetSettings } from '../__mocks__/vscode';
import { eventsNamed, fakeExtensionContext } from './telemetryTestSupport';

// `pythonUsed` is bounded once per surface per window by a module-level Set
// in telemetry.ts, which is never reset — matching a real window's lifetime.
// That state persists for as long as this file's module instance does, so
// each surface's bounding is asserted as one sequential story per `it()`
// rather than across separate tests that would each assume a fresh Set.
vi.mock('@vscode/extension-telemetry');

interface SessionOwner {
  key: string;
  kind: string;
  label: string;
}
interface PyResult {
  output: string;
  value: string;
}
const py = (value: string, output = ''): PyResult => ({ output, value });

const ensureRunning = vi.fn(async (_extensionPath: string, _trigger: string) => true);
vi.mock('../lifecycle', () => ({
  ensureRunning: (extensionPath: string, trigger: string) => ensureRunning(extensionPath, trigger),
}));
const runPython = vi.fn(
  async (_source: string, _owner: SessionOwner, _onOutput?: (text: string) => void) => py('ok'),
);
vi.mock('../pythonQueries', () => ({
  runPython: (source: string, owner: SessionOwner, onOutput?: (text: string) => void) =>
    runPython(source, owner, onOutput),
  isErrorResult: () => false,
  resetScope: () => {},
}));

vi.mock('../cli', () => ({ cliPath: () => '/bin/gemdb', ensureCliCurrent: () => true }));
vi.mock('../processes', () => ({ findStone: () => true, findNetldi: () => true }));

const { GemDbNotebookController } = await import('../notebook');
const { openRepl, runFile } = await import('../repl');
const { initTelemetry } = await import('../telemetry');

function cell(source: string): unknown {
  return {
    document: { getText: () => source },
    notebook: { uri: { toString: () => 'file:///a.ipynb' } },
  };
}

function newController(): FakeController {
  new GemDbNotebookController('/ext');
  return __controllers[__controllers.length - 1];
}

async function runCells(controller: FakeController, cells: unknown[]): Promise<void> {
  await controller.executeHandler?.(cells);
}

beforeEach(() => {
  __resetSettings();
  vi.clearAllMocks();
  ensureRunning.mockResolvedValue(true);
  runPython.mockResolvedValue(py('ok'));
  initTelemetry(fakeExtensionContext(), false);
});

describe('pythonUsed', () => {
  // One test, one long sequence: `seenSurfaces` in telemetry.ts is a single
  // module-level Set for this file's whole run, exactly as it is for one
  // real window's whole lifetime, so bounding across "several opens" can only
  // be asserted within one story rather than split across `it()`s that would
  // each wrongly assume a fresh Set.
  it('bounds each surface to one event per window, kept separate from the others', async () => {
    const controller = newController();

    // An empty cell never reaches runPython, so it must not count as evidence.
    await runCells(controller, [cell('   \n  ')]);
    expect(eventsNamed('pythonUsed')).toHaveLength(0);

    // runPython rejecting is the database stopped, the session dropped, Grail
    // missing — not the Python code's own fault, and no source ever reached
    // the database, so this is not `executed` evidence.
    runPython.mockRejectedValueOnce(new Error('boom'));
    await runCells(controller, [cell('1/0')]);
    expect(eventsNamed('pythonUsed')).toHaveLength(0);

    // A cell whose result actually comes back is the first genuine run.
    await runCells(controller, [cell('1')]);
    expect(eventsNamed('pythonUsed')).toHaveLength(1);
    expect(eventsNamed('pythonUsed')[0].properties).toMatchObject({
      surface: 'notebook',
      evidence: 'executed',
    });
    expect(eventsNamed('pythonUsed')[0]).toHaveProperty('measurements');

    // Neither more cells nor another batch add a second notebook event.
    await runCells(controller, [cell('2'), cell('3')]);
    await runCells(controller, [cell('4')]);
    expect(eventsNamed('pythonUsed')).toHaveLength(1);

    // runFile is a different surface, so it gets its own first event —
    // and a second file run adds nothing more.
    const fileA = { fsPath: '/a.py', toString: () => 'file:///a.py' } as never;
    const fileB = { fsPath: '/b.py', toString: () => 'file:///b.py' } as never;
    await runFile('/ext', fileA);
    expect(eventsNamed('pythonUsed')).toHaveLength(2);
    expect(eventsNamed('pythonUsed')[1].properties).toMatchObject({
      surface: 'runFile',
      evidence: 'launched',
    });
    await runFile('/ext', fileB);
    expect(eventsNamed('pythonUsed')).toHaveLength(2);

    // The shell is a third surface — one more event, then bounded the same way.
    await openRepl('/ext');
    await openRepl('/ext');
    expect(eventsNamed('pythonUsed').map((e) => e.properties.surface)).toEqual([
      'notebook',
      'runFile',
      'shell',
    ]);
  });
});
