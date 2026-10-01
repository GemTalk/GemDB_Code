import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Debug Python File, without a database: which file it runs and as whom, what
 * its terminal shows, and when it refuses. That such a run really stops at
 * breakpoint() with the file's own frames is `breakpoint.test.ts`'s job.
 */

const ensureRunning = vi.fn(async () => true);
vi.mock('../lifecycle', () => ({ ensureRunning: () => ensureRunning() }));

interface Owner {
  key: string;
  kind: string;
  label: string;
}
type Result = { output: string; value: string; stopped?: boolean };
let finish: (result: Result) => void = () => {};
const runPythonFile = vi.fn(
  (_file: string, _owner: Owner, onOutput?: (text: string) => void) =>
    new Promise<Result>((resolve) => {
      onOutput?.('hello\n');
      finish = resolve;
    }),
);
vi.mock('../pythonQueries', async (original) => ({
  ...(await original<typeof import('../pythonQueries')>()),
  runPythonFile: (file: string, owner: Owner, onOutput?: (text: string) => void) =>
    runPythonFile(file, owner, onOutput),
}));
const interrupted: string[] = [];
const closed: string[] = [];
vi.mock('../session', () => ({
  interruptSessionFor: (key: string) => interrupted.push(key),
  closeSessionFor: (key: string) => closed.push(key),
}));

const vscode = await import('../__mocks__/vscode');
const { debugFile, endOfRun, terminalText } = await import('../debugFile');
const { fileOwner, runFileOf } = await import('../fileOwner');

const uri = (fsPath: string) => ({ fsPath, toString: () => `file://${fsPath}` }) as never;

/** The newest terminal, opened, with everything it writes collected. */
function lastTerminal() {
  const options = vscode.__terminals[vscode.__terminals.length - 1];
  const written: string[] = [];
  options.pty!.onDidWrite((text) => written.push(text));
  options.pty!.open();
  return { options, text: () => written.join('') };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vscode.__terminals.length = 0;
  interrupted.length = 0;
  closed.length = 0;
  runPythonFile.mockClear();
  vscode.workspace.isTrusted = true;
});

describe('who a file run belongs to', () => {
  it('is keyed by the file’s path, so the key alone says it is a file run', () => {
    expect(fileOwner('/w/job.py')).toEqual({ key: '/w/job.py', kind: 'file', label: 'job.py' });
    expect(runFileOf('/w/job.py')).toBe('/w/job.py');
    expect(runFileOf('file:///w/breakpoint.ipynb')).toBeUndefined();
    expect(runFileOf(undefined)).toBeUndefined();
  });
});

describe('what the terminal shows', () => {
  it('turns newlines into the carriage returns a terminal needs', () => {
    expect(terminalText('a\nb\r\nc')).toBe('a\r\nb\r\nc');
  });

  it('ends a run with how it ended', () => {
    expect(endOfRun({ output: '', value: '' })).toContain('Finished.');
    expect(
      endOfRun({ output: '', value: 'Error: ZeroDivisionError - division by zero' }),
    ).toContain('ZeroDivisionError');
    expect(endOfRun({ output: '', value: 'Error: x', stopped: true })).toContain('Stopped.');
    expect(endOfRun(new Error('GemDB is not running'))).toContain('GemDB is not running');
  });
});

describe('Debug Python File', () => {
  it('runs the file in its own session and streams what it prints to its terminal', async () => {
    const run = debugFile('/ext', uri('/w/job.py'));
    await settle();
    const terminal = lastTerminal();

    expect(terminal.options.name).toBe('GemDB Debug: job.py');
    expect(runPythonFile).toHaveBeenCalledWith(
      '/w/job.py',
      { key: '/w/job.py', kind: 'file', label: 'job.py' },
      expect.any(Function),
    );
    finish({ output: '', value: '' });
    await run;
    await settle();
    expect(terminal.text()).toContain('hello\r\n');
    expect(terminal.text()).toContain('Finished.');
    // The session outlives the run, for Persisted Objects' Commit and Abort.
    expect(closed).toEqual([]);
  });

  it('does not start a second run of a file still running, and reuses its terminal after', async () => {
    const first = debugFile('/ext', uri('/w/twice.py'));
    await settle();
    await debugFile('/ext', uri('/w/twice.py'));

    expect(runPythonFile).toHaveBeenCalledTimes(1);
    finish({ output: '', value: '' });
    await first;
    const again = debugFile('/ext', uri('/w/twice.py'));
    await settle();
    finish({ output: '', value: '' });
    await again;
    expect(runPythonFile).toHaveBeenCalledTimes(2);
    expect(vscode.__terminals).toHaveLength(1);
  });

  it('stops the run on Ctrl+C, and closing the terminal ends the run and then the session', async () => {
    const run = debugFile('/ext', uri('/w/stop.py'));
    await settle();
    const terminal = lastTerminal();

    terminal.options.pty!.handleInput!('\x03');
    expect(interrupted).toEqual(['/w/stop.py']);
    terminal.options.pty!.close();
    expect(interrupted).toEqual(['/w/stop.py', '/w/stop.py']);
    expect(closed).toEqual([]);
    finish({ output: '', value: 'Error: KeyboardInterrupt - ', stopped: true });
    await run;
    await settle();
    expect(closed).toEqual(['/w/stop.py']);
  });

  it('refuses a file that is not Python, and runs nothing in a folder VS Code does not trust', async () => {
    await debugFile('/ext', uri('/w/notes.txt'));
    vscode.workspace.isTrusted = false;
    await debugFile('/ext', uri('/w/job.py'));

    expect(runPythonFile).not.toHaveBeenCalled();
    expect(vscode.__terminals).toHaveLength(0);
  });
});
