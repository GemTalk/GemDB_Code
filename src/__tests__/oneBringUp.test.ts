import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetSettings } from '../__mocks__/vscode';
import { eventsNamed, fakeExtensionContext } from './telemetryTestSupport';

// `ensureRunning` is single-flight within a window: two notebooks and Start
// pressed together would otherwise each run the whole bring-up, with two stone
// starts, two Grail file-ins and two events. These tests hold the stone start
// open on a promise so the calls genuinely overlap, then check that one run
// served them all and that only the caller that started it reported.
vi.mock('../cli', () => ({ writeCliScripts: () => {}, ensureCliCurrent: () => true }));
// Creating the database account logs in over GCI; that is integration's.
vi.mock('../account', () => ({ ensureDatabaseAccount: () => {} }));

const bundledGrailStamp = vi.fn(() => 'grail=0.1-1-gabc\n');
const grailNeedsUpdate = vi.fn(() => false);
const fileInGrail = vi.fn(async () => {});
vi.mock('../grail', () => ({
  grailLabel: () => 'grail 0.1',
  grailNeedsUpdate: () => grailNeedsUpdate(),
  stageGrail: () => {},
  fileInGrail: () => fileInGrail(),
  bundledGrailStamp: () => bundledGrailStamp(),
}));

const grailInstalled = vi.fn(() => true);
const isInstalled = vi.fn(() => true);
vi.mock('../paths', () => ({
  databaseExists: () => isInstalled(),
  databasePath: () => '/db',
  enginePath: () => (isInstalled() ? '/engine' : undefined),
  grailInstalled: () => grailInstalled(),
  grailPath: () => '/grail',
  grailStagedOnDisk: () => isInstalled(),
  mcpPath: () => '/mcp',
}));

const ensureOsConfigured = vi.fn(
  async (_extensionPath: string, _trigger: string): Promise<string> => 'alreadyConfigured',
);
const isSharedMemoryConfigured = vi.fn(async () => true);
vi.mock('../osConfig', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../osConfig')>();
  return {
    OS_CONFIG_RESULT: actual.OS_CONFIG_RESULT,
    osConfigAllowsStart: actual.osConfigAllowsStart,
    ensureOsConfigured: (extensionPath: string, trigger: string) =>
      ensureOsConfigured(extensionPath, trigger),
    isSharedMemoryConfigured: () => isSharedMemoryConfigured(),
  };
});

const findStone = vi.fn(() => true);
const findNetldi = vi.fn(() => true);
const startStone = vi.fn(async () => {});
const startNetldi = vi.fn(async () => {});
vi.mock('../processes', () => ({
  listProcesses: () => [],
  findStone: () => findStone(),
  findNetldi: () => findNetldi(),
  startStone: () => startStone(),
  startNetldi: () => startNetldi(),
  isListening: () => true,
  isRunning: () => true,
  stopNetldi: async () => {},
  stopStone: async () => {},
}));

vi.mock('../platform', () => ({ isSupportedPlatform: () => true, setContext: () => {} }));
vi.mock('../autoStart', () => ({
  allowAutoStart: () => {},
  autoStartSuppressed: () => false,
  initAutoStart: () => {},
  suppressAutoStart: () => {},
}));

const { ensureRunning } = await import('../lifecycle');
const { TRIGGER, initTelemetry } = await import('../telemetry');
const { initUnattendedSetupMarker } = await import('../unattendedSetupMarker');

/** A promise the test settles by hand, so a bring-up stays in progress until it chooses. */
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('ensureRunning', () => {
  beforeEach(() => {
    __resetSettings();
    bundledGrailStamp.mockReturnValue('grail=0.1-1-gabc\n');
    grailNeedsUpdate.mockReturnValue(true);
    grailInstalled.mockReturnValue(false);
    isInstalled.mockReturnValue(true);
    ensureOsConfigured.mockReset().mockResolvedValue('alreadyConfigured');
    isSharedMemoryConfigured.mockReset().mockResolvedValue(true);
    fileInGrail.mockClear();
    findStone.mockReturnValue(false);
    findNetldi.mockReturnValue(true);
    startStone.mockReset();

    const context = fakeExtensionContext();
    initTelemetry(context, false);
    initUnattendedSetupMarker(context.globalStorageUri.fsPath);
  });

  describe('when called while a bring-up is in progress', () => {
    it('serves every caller with one run, reported once under the first caller', async () => {
      const stoneStart = deferred();
      startStone.mockImplementation(async () => {
        await stoneStart.promise;
        findStone.mockReturnValue(true);
      });

      const calls = [
        ensureRunning('/ext', TRIGGER.autoStart),
        ensureRunning('/ext', TRIGGER.notebook),
        ensureRunning('/ext', TRIGGER.startCommand),
      ];
      stoneStart.resolve();

      expect(await Promise.all(calls)).toEqual([true, true, true]);
      expect(startStone).toHaveBeenCalledTimes(1);
      expect(fileInGrail).toHaveBeenCalledTimes(1);
      const events = eventsNamed('databaseStarted');
      expect(events).toHaveLength(1);
      expect(events[0].properties).toMatchObject({
        trigger: 'autoStart',
        outcome: 'started',
        filedGrail: 'firstTime',
      });
    });

    it('fails every caller together when the run fails, reporting the failure once', async () => {
      const stoneStart = deferred();
      startStone.mockImplementation(() => stoneStart.promise);

      const calls = [
        ensureRunning('/ext', TRIGGER.notebook),
        ensureRunning('/ext', TRIGGER.notebook),
        ensureRunning('/ext', TRIGGER.startCommand),
      ];
      stoneStart.reject(new Error('stone would not start'));

      expect(await Promise.all(calls)).toEqual([false, false, false]);
      expect(startStone).toHaveBeenCalledTimes(1);
      const events = eventsNamed('databaseStarted');
      expect(events).toHaveLength(1);
      expect(events[0].properties).toMatchObject({ trigger: 'notebook', outcome: 'startFailed' });
    });
  });

  it('starts a new run for a call made after the previous one has settled', async () => {
    startStone.mockImplementation(async () => {});
    ensureOsConfigured.mockResolvedValue('configured');

    await ensureRunning('/ext', TRIGGER.notebook);
    await ensureRunning('/ext', TRIGGER.startCommand);

    expect(ensureOsConfigured).toHaveBeenCalledTimes(2);
    expect(startStone).toHaveBeenCalledTimes(2);
  });
});
