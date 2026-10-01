import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { __resetSettings, __setSetting } from '../__mocks__/vscode';
import { eventsNamed, fakeExtensionContext } from './telemetryTestSupport';

// `runSetup` is the shared body of `prepare()`, `install()` and
// `ensureRunning()` — see lifecycle.ts's own comment on the extraction. These
// tests exercise it directly, with everything that touches the machine or
// the network mocked out, so the three outcomes and both cancel routes are
// covered without a real download.

interface FakeToken {
  isCancellationRequested: boolean;
}

const installEngine = vi.fn<(progress: unknown, token: FakeToken) => Promise<string>>(
  async () => '/engine',
);
vi.mock('../engine', () => ({
  installEngine: (progress: unknown, token: FakeToken) => installEngine(progress, token),
}));

const createDatabase = vi.fn((_enginePath: string, _extensionPath?: string) => ({
  created: true,
  preloaded: true,
}));
const assertDatabaseIsLocal = vi.fn(() => {});
vi.mock('../database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../database')>();
  return {
    DatabaseOnNfsError: actual.DatabaseOnNfsError,
    DatabaseVersionError: actual.DatabaseVersionError,
    assertDatabaseIsLocal: () => assertDatabaseIsLocal(),
    assertDatabaseMatchesEngine: () => {},
    createDatabase: (enginePath: string, extensionPath?: string) =>
      createDatabase(enginePath, extensionPath),
  };
});

const stageGrail = vi.fn((_extensionPath: string) => {});
vi.mock('../grail', () => ({
  stageGrail: (extensionPath: string) => stageGrail(extensionPath),
}));

const { runSetup } = await import('../lifecycle');
const { engineDirName } = await import('../paths');
const { DatabaseOnNfsError } = await import('../database');
// Constants on the act side, literals on the assert side: the expectations pin
// the wire value, so renaming one must fail here rather than silently split a
// series in App Insights.
const { TRIGGER, initTelemetry } = await import('../telemetry');
const { initUnattendedSetupMarker, readUnattendedSetupMarker, writeUnattendedSetupMarker } =
  await import('../unattendedSetupMarker');

let root: string;

/** What another VS Code window's setup looks like from here: its claim on the lock. */
function holdLockForAnotherWindow(): void {
  // Our parent is alive, and is not us — the same stand-in lock.test.ts uses.
  fs.writeFileSync(path.join(root, '.gemdb-setup.lock'), String(process.ppid));
}

function releaseLockFromAnotherWindow(): void {
  fs.unlinkSync(path.join(root, '.gemdb-setup.lock'));
}

/** Leave on disk what a finished setup leaves, as another window would. */
function finishSetupInAnotherWindow(): void {
  fs.mkdirSync(path.join(root, engineDirName()));
  fs.mkdirSync(path.join(root, 'db', 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'db', 'data', 'extent0.dbf'), '');
  fs.mkdirSync(path.join(root, 'grail'));
  fs.writeFileSync(path.join(root, 'grail', 'GRAIL_VERSION'), 'test');
  releaseLockFromAnotherWindow();
}

describe('runSetup', () => {
  beforeEach(() => {
    __resetSettings();
    // Setup takes the machine-wide setup lock, which lives in the root path —
    // never the real one, where a running GemDB window could be holding it.
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdb-setup-'));
    __setSetting('gemdb.rootPath', root);
    installEngine.mockReset().mockResolvedValue('/engine');
    createDatabase.mockReset().mockReturnValue({ created: true, preloaded: true });
    stageGrail.mockReset();
    assertDatabaseIsLocal.mockReset();

    // `send()` in telemetry.ts is a no-op until `initTelemetry` has run —
    // exactly as in a real activation — so this test needs one too, with a
    // throwaway global storage directory.
    const context = fakeExtensionContext();
    initTelemetry(context, false);
    initUnattendedSetupMarker(context.globalStorageUri.fsPath);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('completes when every step succeeds', async () => {
    const outcome = await runSetup('/ext', TRIGGER.installCommand);

    expect(outcome).toBe('completed');
    expect(stageGrail).toHaveBeenCalledWith('/ext');
  });

  it('reports setupStarted and setupFinished around a completed attempt', async () => {
    await runSetup('/ext', TRIGGER.installCommand);

    const started = eventsNamed('setupStarted');
    const finished = eventsNamed('setupFinished');
    expect(started).toHaveLength(1);
    expect(started[0].properties).toMatchObject({ trigger: 'installCommand' });
    expect(finished).toHaveLength(1);
    expect(finished[0].properties).toMatchObject({
      trigger: 'installCommand',
      outcome: 'completed',
    });
    expect(finished[0].measurements?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('is cancelled when the token is already cancelled after the download step', async () => {
    // `installEngine` is the one step that actually checks the token
    // mid-flight; a mock that never throws still lets `prepareFiles` notice
    // cancellation was requested once it returns.
    installEngine.mockImplementation(async (_progress, token) => {
      Object.defineProperty(token, 'isCancellationRequested', { value: true });
      return '/engine';
    });

    const outcome = await runSetup('/ext', TRIGGER.firstRun);

    expect(outcome).toBe('cancelled');
    expect(createDatabase).not.toHaveBeenCalled();
    const finished = eventsNamed('setupFinished');
    expect(finished[0].properties.outcome).toBe('cancelled');
  });

  it('completes when the cancel is requested after the download step was checked', async () => {
    // What a Cancel pressed while the database is created or Grail staged
    // amounts to: those steps do not yield, so nothing looks at the token again.
    let token: FakeToken | undefined;
    installEngine.mockImplementation(async (_progress, t) => {
      token = t;
      return '/engine';
    });
    createDatabase.mockImplementation(() => {
      if (token) Object.defineProperty(token, 'isCancellationRequested', { value: true });
      return { created: true, preloaded: true };
    });
    writeUnattendedSetupMarker('cancelled');

    const outcome = await runSetup('/ext', TRIGGER.firstRun);

    expect(outcome).toBe('completed');
    expect(stageGrail).toHaveBeenCalledWith('/ext');
    expect(readUnattendedSetupMarker()).toBe('completed');
  });

  it('joins a setup already under way rather than starting a second download', async () => {
    // #68: the first-run setup was downloading when Set Up GemDB was pressed,
    // and two downloads into one `.part` file failed them both.
    let finishDownload: (enginePath: string) => void = () => {};
    installEngine.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          finishDownload = resolve;
        }),
    );

    const first = runSetup('/ext', TRIGGER.firstRun);
    const second = runSetup('/ext', TRIGGER.installCommand);
    finishDownload('/engine');

    expect(await Promise.all([first, second])).toEqual(['completed', 'completed']);
    expect(installEngine).toHaveBeenCalledTimes(1);
    expect(eventsNamed('setupStarted')).toHaveLength(1);
  });

  it('runs again once the setup under way has finished', async () => {
    installEngine.mockRejectedValueOnce(new Error('ECONNRESET'));

    const first = await runSetup('/ext', TRIGGER.firstRun);
    const second = await runSetup('/ext', TRIGGER.installCommand);

    expect([first, second]).toEqual(['failed', 'completed']);
    expect(installEngine).toHaveBeenCalledTimes(2);
  });

  it('tells the welcome view a setup is under way for as long as it runs', async () => {
    const settingUp: unknown[] = [];
    const registration = vscode.commands.registerCommand('setContext', (key, value) => {
      if (key === 'gemdb.settingUp') settingUp.push(value);
    });

    await runSetup('/ext', TRIGGER.installCommand);
    registration.dispose();

    expect(settingUp).toEqual([true, false]);
  });

  describe('while another window is setting up', () => {
    beforeEach(() => {
      holdLockForAnotherWindow();
      vi.useFakeTimers({ toFake: ['setTimeout'] });
    });

    it('waits for it, and downloads nothing once it has finished', async () => {
      const outcome = runSetup('/ext', TRIGGER.installCommand);
      await vi.advanceTimersByTimeAsync(3000);
      finishSetupInAnotherWindow();
      await vi.advanceTimersByTimeAsync(1000);

      expect(await outcome).toBe('completed');
      expect(installEngine).not.toHaveBeenCalled();
    });

    it('waits for it, and sets up here if it stopped short', async () => {
      const outcome = runSetup('/ext', TRIGGER.notebook);
      await vi.advanceTimersByTimeAsync(3000);
      const downloadsWhileWaiting = installEngine.mock.calls.length;
      releaseLockFromAnotherWindow();
      await vi.advanceTimersByTimeAsync(1000);

      expect(downloadsWhileWaiting).toBe(0);
      expect(await outcome).toBe('completed');
      expect(installEngine).toHaveBeenCalledTimes(1);
    });

    it('stops waiting when cancelled, and leaves that window to carry on', async () => {
      const token = {
        isCancellationRequested: false,
        onCancellationRequested: () => ({ dispose: () => {} }),
      };
      vi.spyOn(vscode.window, 'withProgress').mockImplementation(
        (_options, task) => task({ report: () => {} }, token as vscode.CancellationToken) as never,
      );

      const outcome = runSetup('/ext', TRIGGER.notebook);
      await vi.advanceTimersByTimeAsync(1000);
      token.isCancellationRequested = true;
      await vi.advanceTimersByTimeAsync(1000);

      expect(await outcome).toBe('cancelled');
      expect(installEngine).not.toHaveBeenCalled();
      expect(fs.readFileSync(path.join(root, '.gemdb-setup.lock'), 'utf8')).toBe(
        String(process.ppid),
      );
    });
  });

  it('refuses a root path on NFS before downloading, and offers a local folder', async () => {
    // #69: the stone will not open a database there, and used to say so only
    // at the first start, after the whole setup had run.
    assertDatabaseIsLocal.mockImplementation(() => {
      throw new DatabaseOnNfsError('on NFS');
    });
    const showErrorMessage = vi.spyOn(vscode.window, 'showErrorMessage');

    const outcome = await runSetup('/ext', TRIGGER.firstRun);

    expect(outcome).toBe('failed');
    expect(installEngine).not.toHaveBeenCalled();
    expect(showErrorMessage).toHaveBeenCalledWith('on NFS', 'Choose a Local Folder…', 'Show Log');
  });

  it('is cancelled when a step throws "Download cancelled"', async () => {
    installEngine.mockRejectedValue(new Error('Download cancelled'));

    const outcome = await runSetup('/ext', TRIGGER.firstRun);

    expect(outcome).toBe('cancelled');
  });

  it('fails on any other error, without leaking it into telemetry', async () => {
    installEngine.mockRejectedValue(new Error('ECONNRESET reading /some/local/path'));

    const outcome = await runSetup('/ext', TRIGGER.firstRun);

    expect(outcome).toBe('failed');
    const finished = eventsNamed('setupFinished');
    expect(finished[0].properties).toMatchObject({ trigger: 'firstRun', outcome: 'failed' });
    expect(Object.values(finished[0].properties).join(' ')).not.toContain('ECONNRESET');
    expect(Object.values(finished[0].properties).join(' ')).not.toContain('/some/local/path');
  });

  describe('the unattended setup marker', () => {
    it('is replaced by a completed run', async () => {
      writeUnattendedSetupMarker('cancelled');

      await runSetup('/ext', TRIGGER.installCommand);

      expect(readUnattendedSetupMarker()).toBe('completed');
    });

    it('is replaced by a completed run after an uninstall', async () => {
      writeUnattendedSetupMarker('uninstalled');

      await runSetup('/ext', TRIGGER.notebook);

      expect(readUnattendedSetupMarker()).toBe('completed');
    });

    it('is not created by a completed run, so unattended setup stays allowed', async () => {
      await runSetup('/ext', TRIGGER.installCommand);

      expect(readUnattendedSetupMarker()).toBe('none');
    });

    it('is left alone by a failed run', async () => {
      writeUnattendedSetupMarker('cancelled');
      installEngine.mockRejectedValue(new Error('ECONNRESET'));

      await runSetup('/ext', TRIGGER.notebook);

      expect(readUnattendedSetupMarker()).toBe('cancelled');
    });

    it('is left alone by a cancelled run', async () => {
      writeUnattendedSetupMarker('failed');
      installEngine.mockRejectedValue(new Error('Download cancelled'));

      await runSetup('/ext', TRIGGER.notebook);

      expect(readUnattendedSetupMarker()).toBe('failed');
    });

    it('is left alone by a run cancelled while the engine was being extracted', async () => {
      writeUnattendedSetupMarker('failed');
      installEngine.mockImplementation(async (_progress, token) => {
        Object.defineProperty(token, 'isCancellationRequested', { value: true });
        return '/engine';
      });

      const outcome = await runSetup('/ext', TRIGGER.notebook);

      expect(outcome).toBe('cancelled');
      expect(createDatabase).not.toHaveBeenCalled();
      expect(stageGrail).not.toHaveBeenCalled();
      expect(readUnattendedSetupMarker()).toBe('failed');
    });
  });
});
