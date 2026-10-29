import * as vscode from 'vscode';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetSettings, __setSetting } from '../__mocks__/vscode';
import { eventsNamed, fakeExtensionContext } from './telemetryTestSupport';

// `databaseStarted` is reported from inside `ensureRunning`, the one path
// everything that needs a database goes through — including every notebook
// cell. These tests exercise the "already running" fast path directly, with
// everything ensureRunning touches mocked to already-done, so the two bounds
// on the event (silent on a no-op call, deduped on a repeated failure) can be
// asserted without a real engine, database, or Grail.
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

const nothingStarted = { startedStone: false, startedNetldi: false };
const ensureProcesses = vi.fn(async () => nothingStarted);
vi.mock('../processes', () => ({
  listProcesses: () => [],
  findStone: () => true,
  findNetldi: () => true,
  ensureProcesses: () => ensureProcesses(),
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

const { ensureRunning, reinstallGrail, resumeRunning } = await import('../lifecycle');
// Constants on the act side, literals on the assert side: the expectations pin
// the wire value, so renaming one must fail here rather than silently split a
// series in App Insights.
const { TRIGGER, initTelemetry } = await import('../telemetry');
const { initUnattendedSetupMarker } = await import('../unattendedSetupMarker');

describe('databaseStarted', () => {
  beforeEach(() => {
    __resetSettings();
    bundledGrailStamp.mockReturnValue('grail=0.1-1-gabc\n');
    grailNeedsUpdate.mockReturnValue(false);
    grailInstalled.mockReturnValue(true);
    isInstalled.mockReturnValue(true);
    ensureOsConfigured.mockReset().mockResolvedValue('alreadyConfigured');
    isSharedMemoryConfigured.mockReset().mockResolvedValue(true);
    fileInGrail.mockClear();
    ensureProcesses.mockReset().mockResolvedValue(nothingStarted);

    const context = fakeExtensionContext();
    initTelemetry(context, false);
    // `ensureRunning` reaches `runSetup` when isInstalled() is false (see the
    // isInstalled(false) case below), and a completed run looks at the marker.
    initUnattendedSetupMarker(context.globalStorageUri.fsPath);
  });

  // Also a window that pressed Start while another window, or the GemDB Shell,
  // was starting the database: once it has the lock it finds both up and has
  // started nothing, so the start is the other process's to report.
  it('sends nothing on a no-op call — everything already up, nothing prompted', async () => {
    const ok = await ensureRunning('/ext', TRIGGER.notebook);

    expect(ok).toBe(true);
    expect(eventsNamed('databaseStarted')).toHaveLength(0);
  });

  it('sends started when something was actually done, e.g. the os-config prompt fired', async () => {
    ensureOsConfigured.mockResolvedValue('configured');

    const ok = await ensureRunning('/ext', TRIGGER.startCommand);

    expect(ok).toBe(true);
    const events = eventsNamed('databaseStarted');
    expect(events).toHaveLength(1);
    expect(events[0].properties).toMatchObject({
      trigger: 'startCommand',
      outcome: 'started',
      filedGrail: 'no',
    });
  });

  it('sends started when the stone had to be started', async () => {
    ensureProcesses.mockResolvedValue({ startedStone: true, startedNetldi: false });

    const ok = await ensureRunning('/ext', TRIGGER.notebook);

    expect(ok).toBe(true);
    expect(eventsNamed('databaseStarted')).toHaveLength(1);
  });

  it('sends started when only the listener had to be started', async () => {
    ensureProcesses.mockResolvedValue({ startedStone: false, startedNetldi: true });

    await ensureRunning('/ext', TRIGGER.notebook);

    expect(eventsNamed('databaseStarted')).toHaveLength(1);
  });

  it('reports a script that did not take as osConfigFailed, not a decline', async () => {
    // The user said yes and the sudo script ran, but shared memory is still
    // short — a mistyped password, a cancelled script. Counting that as a
    // decline would make a yes read as a no.
    ensureOsConfigured.mockResolvedValue('stillUnconfigured');

    expect(await ensureRunning('/ext', TRIGGER.startCommand)).toBe(false);
    const events = eventsNamed('databaseStarted');
    expect(events).toHaveLength(1);
    expect(events[0].properties).toMatchObject({ outcome: 'osConfigFailed' });
  });

  it('dedupes a repeated failure per trigger, reports again on a new one, and again on recovery', async () => {
    // These phases share one `reportedFailures` set (module state in
    // telemetry.ts, exactly as it is in a real window), so they run as one
    // sequence rather than as separate tests that would each need it reset.
    ensureOsConfigured.mockResolvedValue('declined');
    const first = await ensureRunning('/ext', TRIGGER.notebook);
    const second = await ensureRunning('/ext', TRIGGER.notebook);
    const third = await ensureRunning('/ext', TRIGGER.notebook);
    expect([first, second, third]).toEqual([false, false, false]);
    expect(eventsNamed('databaseStarted')).toHaveLength(1);
    expect(eventsNamed('databaseStarted')[0].properties).toMatchObject({
      trigger: 'notebook',
      outcome: 'osConfigDeclined',
    });

    // The same failure from another trigger is its own report — `trigger` is
    // what tells a notebook batch from an explicit Start.
    await ensureRunning('/ext', TRIGGER.startCommand);
    expect(eventsNamed('databaseStarted')).toHaveLength(2);
    expect(eventsNamed('databaseStarted')[1].properties).toMatchObject({
      trigger: 'startCommand',
      outcome: 'osConfigDeclined',
    });

    // Alternating between them sends nothing more: the dedup remembers every
    // pair, not just the last, or two surfaces failing in turn would be unbounded.
    await ensureRunning('/ext', TRIGGER.notebook);
    await ensureRunning('/ext', TRIGGER.startCommand);
    expect(eventsNamed('databaseStarted')).toHaveLength(2);

    isInstalled.mockReturnValue(false);
    await ensureRunning('/ext', TRIGGER.notebook);
    expect(eventsNamed('databaseStarted')).toHaveLength(3);
    expect(eventsNamed('databaseStarted')[2].properties).toMatchObject({ outcome: 'setupFailed' });

    isInstalled.mockReturnValue(true);
    ensureOsConfigured.mockResolvedValue('configured');
    await ensureRunning('/ext', TRIGGER.notebook);
    expect(eventsNamed('databaseStarted')).toHaveLength(4);
    expect(eventsNamed('databaseStarted')[3].properties).toMatchObject({ outcome: 'started' });
  });
});

// `autoStart` hands a database it found running to `resumeRunning`. A stone the
// `gemdb` command or the GemDB Shell started has no Grail filed in, and only
// `ensureRunning` files it in, so without this a CLI-only user stayed without
// Python support for good (#91).
describe('resumeRunning', () => {
  beforeEach(() => {
    __resetSettings();
    grailNeedsUpdate.mockReturnValue(false);
    grailInstalled.mockReturnValue(true);
    isInstalled.mockReturnValue(true);
    ensureOsConfigured.mockReset().mockResolvedValue('alreadyConfigured');
    isSharedMemoryConfigured.mockReset().mockResolvedValue(true);
    fileInGrail.mockClear();
    ensureProcesses.mockReset().mockResolvedValue(nothingStarted);
    initTelemetry(fakeExtensionContext(), false);
  });

  it('files Grail in when the database is running without it', async () => {
    grailInstalled.mockReturnValue(false);
    grailNeedsUpdate.mockReturnValue(true);

    expect(await resumeRunning('/ext')).toBe(true);

    expect(fileInGrail).toHaveBeenCalledTimes(1);
    expect(eventsNamed('databaseStarted').map((e) => e.properties)).toEqual([
      expect.objectContaining({
        trigger: 'autoStart',
        outcome: 'started',
        filedGrail: 'firstTime',
      }),
    ]);
  });

  // An update waits for the database's next use (a cell, Start, an agent):
  // every window activates at once after an extension update, and two of them
  // installing into one database at the same moment is a race not worth
  // starting from an editor that only opened.
  it('leaves an update to the next use of the database: opening the editor installs nothing', async () => {
    grailNeedsUpdate.mockReturnValue(true);
    const ask = vi.spyOn(vscode.window, 'showWarningMessage');

    await resumeRunning('/ext');

    expect(ask).not.toHaveBeenCalled();
    expect(fileInGrail).not.toHaveBeenCalled();
    expect(eventsNamed('databaseStarted')).toHaveLength(0);
    ask.mockRestore();
  });

  it('leaves a database with current Python support to the MCP server alone', async () => {
    await resumeRunning('/ext');

    expect(fileInGrail).not.toHaveBeenCalled();
    expect(ensureOsConfigured).not.toHaveBeenCalled();
    expect(eventsNamed('databaseStarted')).toHaveLength(0);
  });

  it('never asks for shared memory: short, it leaves Grail for an explicit start', async () => {
    grailInstalled.mockReturnValue(false);
    grailNeedsUpdate.mockReturnValue(true);
    isSharedMemoryConfigured.mockResolvedValue(false);

    await resumeRunning('/ext');

    expect(ensureOsConfigured).not.toHaveBeenCalled();
    expect(fileInGrail).not.toHaveBeenCalled();
  });

  it('never files Grail into an external database', async () => {
    __setSetting('gemdb.externalDatabase.gemstone', '/opt/gemstone/product');
    grailInstalled.mockReturnValue(false);
    grailNeedsUpdate.mockReturnValue(true);

    await resumeRunning('/ext');

    expect(fileInGrail).not.toHaveBeenCalled();
  });
});

// Installing a newer Grail over the one a database has keeps what was stored
// under the old one working: Grail upgrades in place, rebuilding deployed
// modules into their committed classes (Grail #1791), and Grail's upgrade test
// measures it nightly from 1.9.0's pin. So an update is installed like the MCP
// server's, without a question, unless gemdb.reinstallPythonOnUpdate is off.
describe('an update to Python support', () => {
  let ask: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetSettings();
    bundledGrailStamp.mockReturnValue('grail=0.2-1-gdef\n');
    grailNeedsUpdate.mockReturnValue(true);
    grailInstalled.mockReturnValue(true);
    isInstalled.mockReturnValue(true);
    ensureOsConfigured.mockReset().mockResolvedValue('alreadyConfigured');
    isSharedMemoryConfigured.mockReset().mockResolvedValue(true);
    fileInGrail.mockClear();
    ensureProcesses.mockReset().mockResolvedValue(nothingStarted);
    initTelemetry(fakeExtensionContext(), false);
    ask?.mockRestore();
    ask = vi.spyOn(vscode.window, 'showWarningMessage');
  });

  it('installs it without asking, and reports it as an update', async () => {
    expect(await ensureRunning('/ext', TRIGGER.notebook)).toBe(true);

    expect(ask).not.toHaveBeenCalled();
    expect(fileInGrail).toHaveBeenCalledTimes(1);
    expect(eventsNamed('databaseStarted').map((e) => e.properties)).toEqual([
      expect.objectContaining({ trigger: 'notebook', outcome: 'started', filedGrail: 'update' }),
    ]);
  });

  it('installs it whoever started the database, auto-start and agents included', async () => {
    for (const trigger of [TRIGGER.startCommand, TRIGGER.shell, TRIGGER.autoStart, TRIGGER.mcp]) {
      expect(await ensureRunning('/ext', trigger)).toBe(true);
    }

    expect(ask).not.toHaveBeenCalled();
    expect(fileInGrail).toHaveBeenCalledTimes(4);
  });

  it('keeps the current Python support, and still starts, when gemdb.reinstallPythonOnUpdate is off', async () => {
    __setSetting('gemdb.reinstallPythonOnUpdate', false);

    expect(await ensureRunning('/ext', TRIGGER.notebook)).toBe(true);

    expect(ask).not.toHaveBeenCalled();
    expect(fileInGrail).not.toHaveBeenCalled();
  });

  it('installs Python support into a database that has none, whatever the setting says', async () => {
    __setSetting('gemdb.reinstallPythonOnUpdate', false);
    grailInstalled.mockReturnValue(false);

    await ensureRunning('/ext', TRIGGER.autoStart);

    expect(ask).not.toHaveBeenCalled();
    expect(fileInGrail).toHaveBeenCalledTimes(1);
  });

  it('reinstalls on request without asking, since the command is the request', async () => {
    grailNeedsUpdate.mockReturnValue(false);

    await reinstallGrail('/ext');

    expect(ask).not.toHaveBeenCalled();
    expect(fileInGrail).toHaveBeenCalledTimes(1);
  });

  it('reinstalls on request with the setting off: the setting is about updates, not requests', async () => {
    __setSetting('gemdb.reinstallPythonOnUpdate', false);

    await reinstallGrail('/ext');

    expect(fileInGrail).toHaveBeenCalledTimes(1);
  });
});
