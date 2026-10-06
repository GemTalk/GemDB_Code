import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __log, __resetSettings, __setSetting } from '../__mocks__/vscode';
import { fakeExtensionContext } from './telemetryTestSupport';

// The lifecycle against an external database: `ensureRunning` checks rather
// than starts, never asks about shared memory, and Stop and Remove decline.
// Everything that touches the machine is mocked, as in databaseStarted.test.ts;
// the assertions are about which of those it does NOT call.
vi.mock('../cli', () => ({ writeCliScripts: () => {}, ensureCliCurrent: () => true }));

vi.mock('../grail', () => ({
  grailLabel: () => 'grail 0.1',
  grailNeedsUpdate: () => false,
  newerGrail: () => undefined,
  stageGrail: () => true,
  fileInGrail: async () => true,
  bundledGrailStamp: () => 'grail=0.1-1-gabc\n',
}));

vi.mock('../paths', () => ({
  databaseExists: () => false,
  databasePath: () => '/db',
  enginePath: () => '/opt/gemstone/product',
  grailInstalled: () => true,
  grailPath: () => '/grail',
  grailStagedOnDisk: () => true,
  mcpPath: () => '/mcp',
}));

const ensureOsConfigured = vi.fn(async (): Promise<string> => 'alreadyConfigured');
vi.mock('../osConfig', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../osConfig')>();
  return {
    OS_CONFIG_RESULT: actual.OS_CONFIG_RESULT,
    osConfigAllowsStart: actual.osConfigAllowsStart,
    ensureOsConfigured: () => ensureOsConfigured(),
  };
});

const findStone = vi.fn(() => true);
const findNetldi = vi.fn(() => true);
const startStone = vi.fn(async () => {});
const startNetldi = vi.fn(async () => {});
const stopStone = vi.fn(async () => {});
const stopNetldi = vi.fn(async () => {});
vi.mock('../processes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../processes')>();
  return {
    ExternalDatabaseError: actual.ExternalDatabaseError,
    listProcesses: () => [],
    findStone: () => findStone(),
    findNetldi: () => findNetldi(),
    startStone: () => startStone(),
    startNetldi: () => startNetldi(),
    isListening: () => findNetldi(),
    isRunning: () => findStone(),
    stopNetldi: () => stopNetldi(),
    stopStone: () => stopStone(),
  };
});

const isMcpRunning = vi.fn(async () => false);
const startMcpServer = vi.fn(async () => true);
vi.mock('../mcp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../mcp')>();
  return {
    ...actual,
    bundledMcpStamp: () => 'mcp=abc\n',
    ensureMcpInstalled: async () => {},
    isMcpRunning: () => isMcpRunning(),
    startMcpServer: () => startMcpServer(),
  };
});

vi.mock('../platform', () => ({ isSupportedPlatform: () => true, setContext: () => {} }));
vi.mock('../autoStart', () => ({
  allowAutoStart: () => {},
  autoStartSuppressed: () => false,
  initAutoStart: () => {},
  suppressAutoStart: () => {},
}));

const { ensureRunning, isInstalled, resumeMcpServing, stop, uninstall } =
  await import('../lifecycle');
const { TRIGGER, initTelemetry } = await import('../telemetry');

describe('an external database', () => {
  beforeEach(() => {
    __resetSettings();
    __setSetting('gemdb.externalDatabase.gemstone', '/opt/gemstone/product');
    for (const mock of [
      ensureOsConfigured,
      startStone,
      startNetldi,
      stopStone,
      stopNetldi,
      startMcpServer,
    ]) {
      mock.mockClear();
    }
    findStone.mockReturnValue(true);
    findNetldi.mockReturnValue(true);
    isMcpRunning.mockResolvedValue(false);
    initTelemetry(fakeExtensionContext(), false);
  });

  it('counts as installed without a database of its own', () => {
    expect(isInstalled()).toBe(true);
  });

  it('is used as it is when running: no shared-memory check, nothing started', async () => {
    expect(await ensureRunning('/ext', TRIGGER.notebook)).toBe(true);
    expect(ensureOsConfigured).not.toHaveBeenCalled();
    expect(startStone).not.toHaveBeenCalled();
    expect(startNetldi).not.toHaveBeenCalled();
  });

  it('is reported, not started, when it is down', async () => {
    findStone.mockReturnValue(false);

    expect(await ensureRunning('/ext', TRIGGER.notebook)).toBe(false);
    expect(startStone).not.toHaveBeenCalled();
    expect(startNetldi).not.toHaveBeenCalled();
    expect(__log.join('\n')).toMatch(/administrator runs\. Ask them to start it/);
  });

  it('counts a missing NetLDI as down, since no session can connect', async () => {
    findNetldi.mockReturnValue(false);

    expect(await ensureRunning('/ext', TRIGGER.notebook)).toBe(false);
    expect(startNetldi).not.toHaveBeenCalled();
  });

  it('is never stopped', async () => {
    await stop();
    expect(stopStone).not.toHaveBeenCalled();
    expect(stopNetldi).not.toHaveBeenCalled();
  });

  it('is never removed', async () => {
    expect(await uninstall()).toBe(false);
  });

  describe('on activation, with MCP on', () => {
    beforeEach(() => __setSetting('gemdb.mcp.enabled', true));

    // The database is always up already, so `autoStart` never reaches
    // `ensureRunning`; without this the router a reboot took stays away.
    it('starts the router for the running database, and nothing else', async () => {
      expect(await resumeMcpServing('/ext')).toBe(true);
      expect(startMcpServer).toHaveBeenCalledOnce();
      expect(startStone).not.toHaveBeenCalled();
      expect(startNetldi).not.toHaveBeenCalled();
    });

    it('leaves a router that is already listening alone', async () => {
      isMcpRunning.mockResolvedValue(true);
      expect(await resumeMcpServing('/ext')).toBe(true);
      expect(startMcpServer).not.toHaveBeenCalled();
    });

    it('does not start one for a database that is down', async () => {
      findStone.mockReturnValue(false);
      expect(await resumeMcpServing('/ext')).toBe(false);
      expect(startMcpServer).not.toHaveBeenCalled();
    });
  });

  it('starts no router on activation when MCP is off', async () => {
    expect(await resumeMcpServing('/ext')).toBe(false);
    expect(startMcpServer).not.toHaveBeenCalled();
  });
});
