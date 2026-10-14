import { promises as fsPromises } from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from '../__mocks__/vscode';
import { eventsNamed, fakeExtensionContext } from './telemetryTestSupport';

/**
 * The vscode-facing wrappers are one at a time in a window: the first-run
 * prompt, a cell's, and "GemDB: Configure Shared Memory" must not each open a
 * modal or a `sudo` terminal. They live apart from osConfig.test.ts because
 * they need the real wrappers, with the operating system faked underneath.
 */

// The limits `isSharedMemoryConfigured` reads — as macOS's sysctl prints them,
// or as Linux's /proc holds them — and what `busctl` says about RemoveIPC.
let enoughMemory = false;
let removeIpcOff = true;
const sharedMemoryBytes = (): number => Math.round((enoughMemory ? 1024 : 0.004) * 2 ** 30);
vi.mock('child_process', async (original) => ({
  ...(await original<typeof import('child_process')>()),
  execFile: (
    file: string,
    _args: string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string) => void,
  ) => {
    if (file === 'busctl') {
      callback(null, `b ${removeIpcOff ? 'false' : 'true'}\n`);
      return;
    }
    const bytes = sharedMemoryBytes();
    callback(null, `kern.sysv.shmmax: ${bytes}\nkern.sysv.shmall: ${Math.round(bytes / 4096)}\n`);
  },
}));

const { ensureOsConfigured, configureSharedMemory } = await import('../osConfig');
const { TRIGGER, initTelemetry } = await import('../telemetry');

const SHARED_MEMORY_TERMINAL = 'GemDB: Shared Memory Setup';
const REMOVE_IPC_TERMINAL = 'GemDB: RemoveIPC Setup';

const originalPlatform = process.platform;
const sent = (): Record<string, unknown>[] =>
  eventsNamed('osConfigPrompted').map((e) => e.properties as Record<string, unknown>);

let answer: ((choice: string | undefined) => void) | undefined;
let modal: ReturnType<typeof vi.spyOn>;
let information: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

/** Terminals opened so far with this name, in order. */
const terminalsNamed = (name: string): number =>
  vscode.__terminals.filter((t) => (t as unknown) === name).length;

/** Close the most recent terminal with this name, as the user finishing it. */
function closeTerminal(name: string): void {
  const index = (vscode.__terminals as unknown[]).lastIndexOf(name);
  vscode.__closeTerminal(vscode.__openTerminals[index]);
}

/** The user finishing the shared-memory terminal: the script has run, so memory is as given. */
function finishScript(options: { took: boolean }): void {
  enoughMemory = options.took;
  closeTerminal(SHARED_MEMORY_TERMINAL);
}

/** Let every pending promise chain run, so a test can assert that something is still waiting. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function onLinux(): void {
  Object.defineProperty(process, 'platform', { value: 'linux' });
  vi.spyOn(fsPromises, 'readFile').mockImplementation((async (file: unknown) => {
    if (String(file).startsWith('/proc/sys/kernel/shmmax')) return String(sharedMemoryBytes());
    if (String(file).startsWith('/proc/sys/kernel/shmall'))
      return String(Math.round(sharedMemoryBytes() / 4096));
    throw new Error(`unexpected read of ${String(file)}`);
  }) as typeof fsPromises.readFile);
}

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  enoughMemory = false;
  removeIpcOff = true;
  vscode.__resetSettings();
  vscode.__terminals.length = 0;
  vscode.__openTerminals.length = 0;
  initTelemetry(fakeExtensionContext(), false);
  answer = undefined;
  modal = vi.spyOn(vscode.window, 'showWarningMessage').mockImplementation(
    () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  );
  information = vi.spyOn(vscode.window, 'showInformationMessage');
  error = vi.spyOn(vscode.window, 'showErrorMessage');
});

// The prompt and the script are module-level single flights. A test that fails
// with one still open would hand it to every later test, which would join it
// and time out, so settle whatever is left — cancel the modal, close the
// terminals — before the spies are restored.
afterEach(async () => {
  for (let round = 0; round < 5; round++) {
    answer?.(undefined);
    vscode.__closeAllTerminals();
    await settle();
  }
  Object.defineProperty(process, 'platform', { value: originalPlatform });
  vi.restoreAllMocks();
});

describe('one OS prompt at a time', () => {
  it('shares one modal, one terminal and one event between callers with different triggers', async () => {
    const first = ensureOsConfigured('/ext', TRIGGER.firstRun);
    const second = ensureOsConfigured('/ext', TRIGGER.notebook);
    await vi.waitFor(() => expect(modal).toHaveBeenCalledTimes(1));

    answer?.('Configure');
    await vi.waitFor(() => expect(vscode.__openTerminals).toHaveLength(1));
    finishScript({ took: true });

    expect(await first).toBe('configured');
    expect(await second).toBe('configured');
    expect(modal).toHaveBeenCalledTimes(1);
    expect(vscode.__terminals).toHaveLength(1);
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toMatchObject({ trigger: 'firstRun', outcome: 'configured' });
  });

  it('starts afresh once the first prompt has settled', async () => {
    const first = ensureOsConfigured('/ext', TRIGGER.firstRun);
    await vi.waitFor(() => expect(modal).toHaveBeenCalledTimes(1));
    answer?.(undefined);
    expect(await first).toBe('declined');

    const second = ensureOsConfigured('/ext', TRIGGER.notebook);
    await vi.waitFor(() => expect(modal).toHaveBeenCalledTimes(2));
    answer?.(undefined);
    expect(await second).toBe('declined');
  });
});

describe('the command and the prompt share one script, and nothing else', () => {
  it('lets the command join the script a prompt started, without a second terminal', async () => {
    const prompt = ensureOsConfigured('/ext', TRIGGER.firstRun);
    await vi.waitFor(() => expect(modal).toHaveBeenCalledTimes(1));
    answer?.('Configure');
    await vi.waitFor(() => expect(vscode.__openTerminals).toHaveLength(1));

    const command = configureSharedMemory('/ext');
    await settle();
    finishScript({ took: true });
    await command;

    expect(await prompt).toBe('configured');
    expect(vscode.__terminals).toHaveLength(1);
    // One event each: the modal's answer, and the command run while memory was short.
    expect(sent()).toEqual([
      expect.objectContaining({ trigger: 'firstRun', outcome: 'configured' }),
      expect.objectContaining({ trigger: 'sharedMemoryCommand', outcome: 'configured' }),
    ]);
    expect(information).toHaveBeenCalledTimes(1);
    expect(information).toHaveBeenCalledWith('Shared memory configured.');
    expect(error).not.toHaveBeenCalled();
  });

  it('runs the script for the command even when the modal it overlapped is cancelled', async () => {
    const prompt = ensureOsConfigured('/ext', TRIGGER.notebook);
    await vi.waitFor(() => expect(modal).toHaveBeenCalledTimes(1));

    const command = configureSharedMemory('/ext');
    await vi.waitFor(() => expect(vscode.__openTerminals).toHaveLength(1));
    answer?.(undefined);
    expect(await prompt).toBe('declined');

    finishScript({ took: true });
    await command;
    expect(vscode.__terminals).toHaveLength(1);
    expect(information).toHaveBeenCalledWith('Shared memory configured.');
    expect(error).not.toHaveBeenCalled();
  });

  it('lets a modal answered "Configure" join the script the command already opened', async () => {
    const command = configureSharedMemory('/ext');
    await vi.waitFor(() => expect(vscode.__openTerminals).toHaveLength(1));

    // Raising shared memory always asks, even with the command's terminal open.
    const prompt = ensureOsConfigured('/ext', TRIGGER.notebook);
    await vi.waitFor(() => expect(modal).toHaveBeenCalledTimes(1));
    answer?.('Configure');
    await settle();
    expect(vscode.__terminals).toHaveLength(1);

    finishScript({ took: false });
    expect(await prompt).toBe('stillUnconfigured');
    await command;
    expect(vscode.__terminals).toHaveLength(1);
    expect(sent()).toEqual([
      expect.objectContaining({ trigger: 'sharedMemoryCommand', outcome: 'stillUnconfigured' }),
      expect.objectContaining({ trigger: 'notebook', outcome: 'stillUnconfigured' }),
    ]);
  });

  it("answers alreadyConfigured at once when memory is enough, even with the command's terminal open", async () => {
    enoughMemory = true;
    const command = configureSharedMemory('/ext');
    await vi.waitFor(() => expect(vscode.__openTerminals).toHaveLength(1));

    expect(await ensureOsConfigured('/ext', TRIGGER.notebook)).toBe('alreadyConfigured');
    expect(modal).not.toHaveBeenCalled();
    // Memory was never short, so neither the prompt nor the command reports.
    finishScript({ took: true });
    await command;
    expect(sent()).toHaveLength(0);
  });

  it('reports nothing for a cell whose modal was never shown', async () => {
    enoughMemory = true;
    const command = configureSharedMemory('/ext');
    await vi.waitFor(() => expect(vscode.__openTerminals).toHaveLength(1));

    // The cell overlaps the command's script but shows no modal, so it must
    // not answer `configured`: that would count as GemDB having prompted.
    const prompt = ensureOsConfigured('/ext', TRIGGER.notebook);
    finishScript({ took: true });
    await command;
    expect(await prompt).toBe('alreadyConfigured');
    expect(modal).not.toHaveBeenCalled();
    expect(sent()).toHaveLength(0);
  });
});

describe('on Linux, with RemoveIPC unset', () => {
  beforeEach(() => {
    onLinux();
    removeIpcOff = false;
  });

  it("still offers RemoveIPC to a prompt that joined the command's script", async () => {
    const command = configureSharedMemory('/ext');
    await vi.waitFor(() => expect(vscode.__openTerminals).toHaveLength(1));

    const prompt = ensureOsConfigured('/ext', TRIGGER.notebook);
    await vi.waitFor(() => expect(modal).toHaveBeenCalledTimes(1));
    answer?.('Configure');
    await settle();
    finishScript({ took: true });
    await command;

    await vi.waitFor(() => expect(terminalsNamed(REMOVE_IPC_TERMINAL)).toBe(1));
    closeTerminal(REMOVE_IPC_TERMINAL);
    expect(await prompt).toBe('removeIpcUnset');
    expect(terminalsNamed(SHARED_MEMORY_TERMINAL)).toBe(1);
  });

  it('lets the command finish without waiting on the RemoveIPC terminal that follows', async () => {
    const prompt = ensureOsConfigured('/ext', TRIGGER.firstRun);
    await vi.waitFor(() => expect(modal).toHaveBeenCalledTimes(1));
    answer?.('Configure');
    await vi.waitFor(() => expect(vscode.__openTerminals).toHaveLength(1));

    let commandDone = false;
    const command = configureSharedMemory('/ext').then(() => {
      commandDone = true;
    });
    await settle();
    finishScript({ took: true });
    await vi.waitFor(() => expect(terminalsNamed(REMOVE_IPC_TERMINAL)).toBe(1));
    await settle();

    expect(commandDone).toBe(true);
    await command;
    expect(information).toHaveBeenCalledWith('Shared memory configured.');
    closeTerminal(REMOVE_IPC_TERMINAL);
    expect(await prompt).toBe('removeIpcUnset');
  });
});
