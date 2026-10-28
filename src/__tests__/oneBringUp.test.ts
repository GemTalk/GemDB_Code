import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { __resetSettings, __setSetting } from '../__mocks__/vscode';
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
  extentPath: () => '/db/data/extent0.dbf',
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
// The stone start inside `ensureProcesses`, which starts only what is down.
const startStone = vi.fn(async () => {});
const stopStone = vi.fn(async (_force: boolean) => {
  findStone.mockReturnValue(false);
});
vi.mock('../processes', () => ({
  listProcesses: () => [],
  findStone: () => findStone(),
  findNetldi: () => findNetldi(),
  ensureProcesses: async () => {
    const startedStone = !findStone();
    if (startedStone) await startStone();
    return { startedStone, startedNetldi: false };
  },
  isListening: () => true,
  isRunning: () => findStone(),
  stopNetldi: async () => {},
  stopStone: (force: boolean) => stopStone(force),
}));

// The MCP server is off unless a test turns `gemdb.mcp.enabled` on.
const mcpNeedsUpdate = vi.fn(() => false);
const installMcp = vi.fn(async () => {});
const isMcpRunning = vi.fn(async () => false);
const startMcpServer = vi.fn(async () => true);
vi.mock('../mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../mcp')>()),
  bundledMcpStamp: () => 'mcp=abc\n',
  mcpNeedsUpdate: () => mcpNeedsUpdate(),
  stageMcp: () => {},
  installMcp: () => installMcp(),
  recordMcpInstalled: () => {},
  isMcpRunning: () => isMcpRunning(),
  startMcpServer: () => startMcpServer(),
  stopMcpServer: async () => {},
}));

vi.mock('../platform', () => ({ isSupportedPlatform: () => true, setContext: () => {} }));
const allowAutoStart = vi.fn();
vi.mock('../autoStart', () => ({
  allowAutoStart: () => allowAutoStart(),
  autoStartSuppressed: () => false,
  initAutoStart: () => {},
  suppressAutoStart: () => {},
}));

const { ensureRunning, resumeMcpServing, stop } = await import('../lifecycle');
const { TRIGGER, initTelemetry } = await import('../telemetry');
const { initUnattendedSetupMarker } = await import('../unattendedSetupMarker');

/** Every deferred a test made, so `afterEach` can release whatever a failed test left waiting. */
const deferreds: Array<{ resolve: () => void }> = [];

/** A promise the test settles by hand, so a bring-up stays in progress until it chooses. */
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  deferreds.push({ resolve });
  return { promise, resolve, reject };
}

// The bring-up and the MCP step are module-level single flights. A test that
// fails with one still held open would hand it to every later test, which
// would join it and time out — so release every deferred and let it drain.
afterEach(async () => {
  for (const d of deferreds.splice(0)) d.resolve();
  for (let round = 0; round < 5; round++) await new Promise((resolve) => setTimeout(resolve, 0));
});

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

// Activation's `resumeMcpServing` and a cell's `ensureRunning` both reach
// `ensureMcpServing`; on a running stone they would otherwise install the
// classes twice and fork two routers at one port.
describe('ensureMcpServing', () => {
  beforeEach(() => {
    __resetSettings();
    __setSetting('gemdb.mcp.enabled', true);
    grailNeedsUpdate.mockReturnValue(false);
    grailInstalled.mockReturnValue(true);
    isInstalled.mockReturnValue(true);
    ensureOsConfigured.mockReset().mockResolvedValue('alreadyConfigured');
    findStone.mockReturnValue(true);
    findNetldi.mockReturnValue(true);
    mcpNeedsUpdate.mockReturnValue(true);
    installMcp.mockReset();
    isMcpRunning.mockReset().mockResolvedValue(false);
    startMcpServer.mockReset().mockResolvedValue(true);

    const context = fakeExtensionContext();
    initTelemetry(context, false);
    initUnattendedSetupMarker(context.globalStorageUri.fsPath);
  });

  it('installs and starts the MCP server once when resume and a start overlap', async () => {
    const install = deferred();
    installMcp.mockImplementation(() => install.promise);

    const resumed = resumeMcpServing('/ext');
    const started = ensureRunning('/ext', TRIGGER.notebook);
    // Let both callers reach the MCP step before the install finishes.
    await new Promise((resolve) => setTimeout(resolve, 20));
    install.resolve();

    expect(await Promise.all([resumed, started])).toEqual([true, true]);
    expect(installMcp).toHaveBeenCalledTimes(1);
    expect(startMcpServer).toHaveBeenCalledTimes(1);
  });
});

// Stop takes no lock, so it can land on a bring-up under way. A caller who
// arrives after that Stop is asking for the database back: it must not be
// handed a result that described a database Stop has since taken down.
describe('ensureRunning after a Stop', () => {
  beforeEach(() => {
    __resetSettings();
    __setSetting('gemdb.mcp.enabled', true);
    grailNeedsUpdate.mockReturnValue(false);
    grailInstalled.mockReturnValue(true);
    isInstalled.mockReturnValue(true);
    ensureOsConfigured.mockReset().mockResolvedValue('alreadyConfigured');
    fileInGrail.mockReset();
    findStone.mockReturnValue(false);
    findNetldi.mockReturnValue(true);
    startStone.mockReset().mockImplementation(async () => {
      findStone.mockReturnValue(true);
    });
    stopStone.mockClear();
    mcpNeedsUpdate.mockReturnValue(true);
    installMcp.mockReset();
    isMcpRunning.mockReset().mockResolvedValue(false);
    startMcpServer.mockReset().mockResolvedValue(true);
    allowAutoStart.mockClear();

    const context = fakeExtensionContext();
    initTelemetry(context, false);
    initUnattendedSetupMarker(context.globalStorageUri.fsPath);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts the database again for a cell run after Stop, while auto-start is in the MCP step', async () => {
    const install = deferred();
    installMcp.mockImplementationOnce(() => install.promise);

    const auto = ensureRunning('/ext', TRIGGER.autoStart);
    await vi.waitFor(() => expect(installMcp).toHaveBeenCalledTimes(1));
    await stop();
    expect(findStone()).toBeFalsy();

    const cell = ensureRunning('/ext', TRIGGER.notebook);
    install.resolve();

    expect(await auto).toBe(true);
    expect(await cell).toBe(true);
    expect(findStone()).toBe(true);
    expect(startStone).toHaveBeenCalledTimes(2);
    // The cell retracted the Stop, once per pass; auto-start, GemDB's own doing, did not.
    expect(allowAutoStart).toHaveBeenCalledTimes(2);
  });

  it('starts again for a cell run after Stop even when the bring-up it joined failed', async () => {
    // Stop lands during the Grail file-in, which then fails for want of a stone.
    grailNeedsUpdate.mockReturnValue(true);
    grailInstalled.mockReturnValue(false);
    const fileIn = deferred();
    fileInGrail.mockImplementationOnce(() => fileIn.promise);

    const auto = ensureRunning('/ext', TRIGGER.autoStart);
    await vi.waitFor(() => expect(fileInGrail).toHaveBeenCalledTimes(1));
    await stop();
    const cell = ensureRunning('/ext', TRIGGER.notebook);
    fileIn.reject(new Error('no stone'));

    expect(await auto).toBe(false);
    expect(await cell).toBe(true);
    expect(findStone()).toBe(true);
    expect(fileInGrail).toHaveBeenCalledTimes(2);
  });

  it('joins without starting again when no Stop came between', async () => {
    const install = deferred();
    installMcp.mockImplementationOnce(() => install.promise);

    const first = ensureRunning('/ext', TRIGGER.notebook);
    await vi.waitFor(() => expect(installMcp).toHaveBeenCalledTimes(1));
    const second = ensureRunning('/ext', TRIGGER.startCommand);
    install.resolve();

    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(startStone).toHaveBeenCalledTimes(1);
    expect(allowAutoStart).toHaveBeenCalledTimes(2);
  });

  it('lets a Stop pressed after the cell joined win', async () => {
    const install = deferred();
    installMcp.mockImplementationOnce(() => install.promise);

    const auto = ensureRunning('/ext', TRIGGER.autoStart);
    await vi.waitFor(() => expect(installMcp).toHaveBeenCalledTimes(1));
    const cell = ensureRunning('/ext', TRIGGER.notebook);
    await stop();
    install.resolve();

    await auto;
    await cell;
    expect(startStone).toHaveBeenCalledTimes(1);
    expect(findStone()).toBeFalsy();
  });

  it('lets a Stop stand for an auto-start that joins after it', async () => {
    const install = deferred();
    installMcp.mockImplementationOnce(() => install.promise);

    const cell = ensureRunning('/ext', TRIGGER.notebook);
    await vi.waitFor(() => expect(installMcp).toHaveBeenCalledTimes(1));
    await stop();
    const auto = ensureRunning('/ext', TRIGGER.autoStart);
    install.resolve();

    await cell;
    await auto;
    expect(startStone).toHaveBeenCalledTimes(1);
    expect(findStone()).toBeFalsy();
  });

  it('leaves the database up when the Stop the cell came after is cancelled at its modal', async () => {
    const install = deferred();
    installMcp.mockImplementationOnce(() => install.promise);
    // A session holds the stone up, so Stop asks before forcing it; the user
    // dismisses the modal, which is the same answer as Cancel.
    stopStone.mockImplementationOnce(async () => {
      throw new Error('sessions are still logged in');
    });
    const modal = deferred();
    const warning = vi
      .spyOn(vscode.window, 'showWarningMessage')
      .mockImplementationOnce(() => modal.promise.then(() => undefined));

    const auto = ensureRunning('/ext', TRIGGER.autoStart);
    await vi.waitFor(() => expect(installMcp).toHaveBeenCalledTimes(1));
    const stopping = stop();
    await vi.waitFor(() => expect(warning).toHaveBeenCalledTimes(1));

    let cellDone = false;
    const cell = ensureRunning('/ext', TRIGGER.notebook).then((running) => {
      cellDone = true;
      return running;
    });
    install.resolve();
    expect(await auto).toBe(true);
    // The cell goes after the Stop it followed, so it waits on that modal.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cellDone).toBe(false);

    modal.resolve();
    await stopping;
    expect(await cell).toBe(true);
    // Nothing was stopped, so nothing was started again: the second pass
    // found the stone up and only brought back the MCP server Stop had taken down.
    expect(stopStone).toHaveBeenCalledTimes(1);
    expect(startStone).toHaveBeenCalledTimes(1);
    expect(startMcpServer).toHaveBeenCalledTimes(2);
    expect(findStone()).toBe(true);
  });
});
