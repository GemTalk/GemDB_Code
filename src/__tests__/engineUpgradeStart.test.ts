import * as vscode from 'vscode';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetSettings } from '../__mocks__/vscode';
import { eventsNamed, fakeExtensionContext } from './telemetryTestSupport';

// Where `ensureRunning` meets a database the previous engine wrote: whether it
// upgrades, asks, or only says so, and that nothing starts on a database that
// was not upgraded. The upgrade's own steps are `engineUpgrade.test.ts`'s;
// here it is a stub, with everything else `ensureRunning` touches mocked to
// already-done, as in `databaseStarted.test.ts`.
vi.mock('../cli', () => ({ writeCliScripts: () => {}, ensureCliCurrent: () => true }));
vi.mock('../account', () => ({ ensureDatabaseAccount: () => {} }));
vi.mock('../grail', () => ({
  grailLabel: () => 'grail 0.1',
  grailNeedsUpdate: () => false,
  stageGrail: () => {},
  fileInGrail: async () => {},
  bundledGrailStamp: () => 'grail=0.1-1-gabc\n',
  grailUpdateDeclined: () => undefined,
  recordGrailUpdateDeclined: () => {},
}));

/** Each test gets its own extent path: `ensureRunning` remembers an extent it has checked. */
let extent = '/db/data/extent0.dbf';
vi.mock('../paths', () => ({
  databaseExists: () => true,
  databaseLogPath: () => '/db/log',
  databasePath: () => '/db',
  enginePath: () => '/engine',
  extentPath: () => extent,
  grailInstalled: () => true,
  grailPath: () => '/grail',
  grailStagedOnDisk: () => true,
  grailStampPath: () => '/grail/.gemdb-grail-stamp',
  mcpPath: () => '/mcp',
  mcpStampPath: () => '/mcp/.gemdb-mcp-stamp',
}));

const pendingEngineUpgrade = vi.fn((): { from: string; to: string } | undefined => ({
  from: '4.0.0.a5',
  to: '4.0.0.a8',
}));
vi.mock('../database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../database')>();
  return { ...actual, pendingEngineUpgrade: () => pendingEngineUpgrade() };
});

const upgradeEngine = vi.fn(async (): Promise<'upgraded' | 'declined'> => 'upgraded');
vi.mock('../engineUpgrade', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../engineUpgrade')>();
  return { ...actual, upgradeEngine: () => upgradeEngine() };
});

vi.mock('../osConfig', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../osConfig')>();
  return {
    OS_CONFIG_RESULT: actual.OS_CONFIG_RESULT,
    osConfigAllowsStart: actual.osConfigAllowsStart,
    ensureOsConfigured: async () => 'alreadyConfigured',
    isSharedMemoryConfigured: async () => true,
  };
});

const ensureProcesses = vi.fn(async () => ({ startedStone: true, startedNetldi: false }));
vi.mock('../processes', () => ({
  listProcesses: () => [],
  findStone: () => true,
  findNetldi: () => true,
  engineEnvironment: () => ({}),
  ensureProcesses: () => ensureProcesses(),
  isListening: () => true,
  isRunning: () => true,
  stopNetldi: async () => {},
  stopStone: async () => {},
}));
vi.mock('../platform', () => ({
  isSupportedPlatform: () => true,
  libraryPathVariable: () => 'DYLD_LIBRARY_PATH',
  setContext: () => {},
}));
vi.mock('../autoStart', () => ({
  allowAutoStart: () => {},
  autoStartSuppressed: () => false,
  initAutoStart: () => {},
  suppressAutoStart: () => {},
}));

const { ensureRunning } = await import('../lifecycle');
const { TRIGGER, initTelemetry } = await import('../telemetry');
const { initUnattendedSetupMarker } = await import('../unattendedSetupMarker');
const { EngineUpgradeError } = await import('../engineUpgrade');

let n = 0;
beforeEach(() => {
  __resetSettings();
  extent = `/db${++n}/data/extent0.dbf`;
  pendingEngineUpgrade.mockReset().mockReturnValue({ from: '4.0.0.a5', to: '4.0.0.a8' });
  upgradeEngine.mockReset().mockResolvedValue('upgraded');
  ensureProcesses.mockClear();
  const context = fakeExtensionContext();
  initTelemetry(context, false);
  initUnattendedSetupMarker(context.globalStorageUri.fsPath);
});

function outcome(): unknown {
  return eventsNamed('databaseStarted').at(-1)?.properties.outcome;
}

describe('starting a database the previous engine wrote', () => {
  it('upgrades it, then starts it, when someone asked for the database', async () => {
    expect(await ensureRunning('/ext', TRIGGER.startCommand)).toBe(true);
    expect(upgradeEngine).toHaveBeenCalledTimes(1);
    expect(ensureProcesses).toHaveBeenCalledTimes(1);
    expect(outcome()).toBe('started');
  });

  it('checks once per window, not on every cell', async () => {
    await ensureRunning('/ext', TRIGGER.notebook);
    await ensureRunning('/ext', TRIGGER.notebook);
    expect(pendingEngineUpgrade).toHaveBeenCalledTimes(1);
    expect(upgradeEngine).toHaveBeenCalledTimes(1);
  });

  it('starts nothing when the user says no', async () => {
    upgradeEngine.mockResolvedValue('declined');
    expect(await ensureRunning('/ext', TRIGGER.notebook)).toBe(false);
    expect(ensureProcesses).not.toHaveBeenCalled();
    expect(outcome()).toBe('upgradeDeclined');
  });

  it('starts nothing when the upgrade fails, and shows why with the log', async () => {
    const shown = vi.spyOn(vscode.window, 'showErrorMessage');
    upgradeEngine.mockRejectedValue(new EngineUpgradeError('upgradeImage failed; restored'));
    expect(await ensureRunning('/ext', TRIGGER.startCommand)).toBe(false);
    expect(ensureProcesses).not.toHaveBeenCalled();
    expect(outcome()).toBe('upgradeFailed');
    expect(shown).toHaveBeenCalledWith(
      'Upgrading your database failed',
      expect.objectContaining({ modal: true, detail: 'upgradeImage failed; restored' }),
      'Show Log',
    );
    shown.mockRestore();
  });

  it('only says so, with a button that asks, when nobody asked for the database', async () => {
    const shown = vi.spyOn(vscode.window, 'showWarningMessage');
    for (const trigger of [TRIGGER.autoStart, TRIGGER.mcp]) {
      expect(await ensureRunning('/ext', trigger)).toBe(false);
      expect(outcome()).toBe('upgradeNeeded');
    }
    expect(upgradeEngine).not.toHaveBeenCalled();
    expect(ensureProcesses).not.toHaveBeenCalled();
    expect(shown).toHaveBeenCalledWith(expect.stringMatching(/4\.0\.0\.a5/), 'Upgrade Database…');
    shown.mockRestore();
  });

  it('leaves a database that needs no upgrade to the ordinary start', async () => {
    pendingEngineUpgrade.mockReturnValue(undefined);
    expect(await ensureRunning('/ext', TRIGGER.notebook)).toBe(true);
    expect(upgradeEngine).not.toHaveBeenCalled();
  });
});
