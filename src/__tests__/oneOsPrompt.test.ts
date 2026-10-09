import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from '../__mocks__/vscode';
import { eventsNamed, fakeExtensionContext } from './telemetryTestSupport';

/**
 * The vscode-facing wrappers are one at a time in a window: the first-run
 * prompt, a cell's, and "GemDB: Configure Shared Memory" must not each open a
 * modal or a `sudo` terminal. They live apart from osConfig.test.ts because
 * they need the real wrappers, with the operating system faked underneath.
 */

// The limits `isSharedMemoryConfigured` reads, as macOS's sysctl prints them.
let enoughMemory = false;
vi.mock('child_process', async (original) => ({
  ...(await original<typeof import('child_process')>()),
  execFile: (
    _file: string,
    _args: string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string) => void,
  ) => {
    const gb = enoughMemory ? 1024 : 0.004;
    const bytes = Math.round(gb * 2 ** 30);
    callback(null, `kern.sysv.shmmax: ${bytes}\nkern.sysv.shmall: ${Math.round(bytes / 4096)}\n`);
  },
}));

const { ensureOsConfigured, configureSharedMemory } = await import('../osConfig');
const { TRIGGER, initTelemetry } = await import('../telemetry');

const originalPlatform = process.platform;
const sent = (): Record<string, unknown>[] =>
  eventsNamed('osConfigPrompted').map((e) => e.properties as Record<string, unknown>);

let answer: (choice: string | undefined) => void;
let modal: ReturnType<typeof vi.spyOn>;
let information: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

/** The user finishing the terminal: the script has run, so memory is as given. */
function finishScript(options: { took: boolean }): void {
  enoughMemory = options.took;
  vscode.__closeTerminal(vscode.__openTerminals[0]);
}

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  enoughMemory = false;
  vscode.__resetSettings();
  vscode.__terminals.length = 0;
  vscode.__openTerminals.length = 0;
  initTelemetry(fakeExtensionContext(), false);
  modal = vi.spyOn(vscode.window, 'showWarningMessage').mockImplementation(
    () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  );
  information = vi.spyOn(vscode.window, 'showInformationMessage');
  error = vi.spyOn(vscode.window, 'showErrorMessage');
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform });
  vi.restoreAllMocks();
});

describe('one OS prompt at a time', () => {
  it('shares one modal, one terminal and one event between callers with different triggers', async () => {
    const first = ensureOsConfigured('/ext', TRIGGER.firstRun);
    const second = ensureOsConfigured('/ext', TRIGGER.notebook);
    await vi.waitFor(() => expect(modal).toHaveBeenCalledTimes(1));

    answer('Configure');
    await vi.waitFor(() => expect(vscode.__openTerminals).toHaveLength(1));
    finishScript({ took: true });

    expect(await first).toBe('configured');
    expect(await second).toBe('configured');
    expect(modal).toHaveBeenCalledTimes(1);
    expect(vscode.__terminals).toHaveLength(1);
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toMatchObject({ trigger: 'firstRun', outcome: 'configured' });
  });

  it('lets the command join a prompt whose script is running, without a second terminal or event', async () => {
    const prompt = ensureOsConfigured('/ext', TRIGGER.firstRun);
    await vi.waitFor(() => expect(modal).toHaveBeenCalledTimes(1));
    answer('Configure');
    await vi.waitFor(() => expect(vscode.__openTerminals).toHaveLength(1));

    const command = configureSharedMemory('/ext');
    // Let the command reach its wait before the terminal closes.
    await new Promise((resolve) => setTimeout(resolve, 0));
    finishScript({ took: true });
    await command;

    expect(await prompt).toBe('configured');
    expect(vscode.__terminals).toHaveLength(1);
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toMatchObject({ trigger: 'firstRun' });
    expect(information).toHaveBeenCalledWith('Shared memory configured.');
    expect(error).not.toHaveBeenCalled();
  });

  it('lets the command join a prompt still waiting on its modal', async () => {
    const prompt = ensureOsConfigured('/ext', TRIGGER.firstRun);
    await vi.waitFor(() => expect(modal).toHaveBeenCalledTimes(1));

    const command = configureSharedMemory('/ext');
    await new Promise((resolve) => setTimeout(resolve, 0));
    answer('Configure');
    await vi.waitFor(() => expect(vscode.__openTerminals).toHaveLength(1));
    finishScript({ took: false });
    await command;

    expect(await prompt).toBe('stillUnconfigured');
    expect(vscode.__terminals).toHaveLength(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('still below'));
    expect(sent()).toHaveLength(1);
  });

  it("waits for the command's script instead of asking, and reports nothing", async () => {
    const command = configureSharedMemory('/ext');
    await vi.waitFor(() => expect(vscode.__openTerminals).toHaveLength(1));

    const prompt = ensureOsConfigured('/ext', TRIGGER.notebook);
    await new Promise((resolve) => setTimeout(resolve, 0));
    finishScript({ took: true });

    expect(await prompt).toBe('configured');
    await command;
    expect(modal).not.toHaveBeenCalled();
    expect(vscode.__terminals).toHaveLength(1);
    // Only the command's own report: the waiting prompt sends none.
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toMatchObject({ trigger: 'sharedMemoryCommand', outcome: 'configured' });
  });

  it("answers stillUnconfigured when the command's script did not take", async () => {
    const command = configureSharedMemory('/ext');
    await vi.waitFor(() => expect(vscode.__openTerminals).toHaveLength(1));

    const prompt = ensureOsConfigured('/ext', TRIGGER.notebook);
    await new Promise((resolve) => setTimeout(resolve, 0));
    finishScript({ took: false });

    expect(await prompt).toBe('stillUnconfigured');
    await command;
    expect(modal).not.toHaveBeenCalled();
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toMatchObject({ trigger: 'sharedMemoryCommand' });
  });

  it('starts afresh once the first prompt has settled', async () => {
    const first = ensureOsConfigured('/ext', TRIGGER.firstRun);
    await vi.waitFor(() => expect(modal).toHaveBeenCalledTimes(1));
    answer(undefined);
    expect(await first).toBe('declined');

    const second = ensureOsConfigured('/ext', TRIGGER.notebook);
    await vi.waitFor(() => expect(modal).toHaveBeenCalledTimes(2));
    answer(undefined);
    expect(await second).toBe('declined');
  });
});
