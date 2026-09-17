import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetSettings, __telemetry } from '../__mocks__/vscode';

// `databaseStarted` is reported from inside `ensureRunning`, the one path
// everything that needs a database goes through — including every notebook
// cell. These tests exercise the "already running" fast path directly, with
// everything ensureRunning touches mocked to already-done, so the two bounds
// on the event (silent on a no-op call, deduped on a repeated failure) can be
// asserted without a real engine, database, or Grail.
vi.mock('@vscode/extension-telemetry');
vi.mock('../cli', () => ({ writeCliScripts: () => {}, ensureCliCurrent: () => true }));

const bundledGrailStamp = vi.fn(() => 'grail=0.1-1-gabc\n');
const grailNeedsUpdate = vi.fn(() => false);
vi.mock('../grail', () => ({
  grailLabel: () => 'grail 0.1',
  grailNeedsUpdate: () => grailNeedsUpdate(),
  recordGrailInstalled: () => {},
  stageGrail: () => {},
  installGrail: async () => {},
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

const ensureOsConfigured = vi.fn(async (_extensionPath: string, _trigger: string) => ({
  ok: true,
  prompted: false,
}));
vi.mock('../osConfig', () => ({
  ensureOsConfigured: (extensionPath: string, trigger: string) =>
    ensureOsConfigured(extensionPath, trigger),
}));

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
const { initTelemetry } = await import('../telemetry');

function databaseStartedEvents(): { properties: Record<string, unknown> }[] {
  return __telemetry.filter((e) => e.name === 'databaseStarted');
}

describe('databaseStarted', () => {
  beforeEach(() => {
    __resetSettings();
    bundledGrailStamp.mockReturnValue('grail=0.1-1-gabc\n');
    grailNeedsUpdate.mockReturnValue(false);
    grailInstalled.mockReturnValue(true);
    isInstalled.mockReturnValue(true);
    ensureOsConfigured.mockResolvedValue({ ok: true, prompted: false });
    findStone.mockReturnValue(true);
    findNetldi.mockReturnValue(true);

    initTelemetry(
      {
        extensionMode: 1, // vscode.ExtensionMode.Production
        globalStorageUri: { fsPath: mkdtempSync(join(tmpdir(), 'gemdb-dbstarted-')) },
        subscriptions: [],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      false,
    );
  });

  it('sends nothing on a no-op call — everything already up, nothing prompted', async () => {
    const ok = await ensureRunning('/ext', 'notebook');

    expect(ok).toBe(true);
    expect(databaseStartedEvents()).toHaveLength(0);
  });

  it('sends started when something was actually done, e.g. the os-config prompt fired', async () => {
    ensureOsConfigured.mockResolvedValue({ ok: true, prompted: true });

    const ok = await ensureRunning('/ext', 'startCommand');

    expect(ok).toBe(true);
    const events = databaseStartedEvents();
    expect(events).toHaveLength(1);
    expect(events[0].properties).toMatchObject({
      trigger: 'startCommand',
      outcome: 'started',
      filedGrail: 'no',
    });
  });

  it('sends started when the stone had to be started', async () => {
    findStone.mockReturnValue(false);

    const ok = await ensureRunning('/ext', 'notebook');

    expect(ok).toBe(true);
    expect(startStone).toHaveBeenCalledTimes(1);
    expect(databaseStartedEvents()).toHaveLength(1);
  });

  it('dedupes a repeated failure, reports again on a new one, and again on recovery', async () => {
    // These three phases share one `lastReportedFailure` (module state in
    // telemetry.ts, exactly as it is in a real window), so they run as one
    // sequence rather than as separate tests that would each need it reset.
    ensureOsConfigured.mockResolvedValue({ ok: false, prompted: true });
    const first = await ensureRunning('/ext', 'notebook');
    const second = await ensureRunning('/ext', 'notebook');
    const third = await ensureRunning('/ext', 'notebook');
    expect([first, second, third]).toEqual([false, false, false]);
    expect(databaseStartedEvents()).toHaveLength(1);
    expect(databaseStartedEvents()[0].properties).toMatchObject({
      outcome: 'osConfigDeclined',
    });

    isInstalled.mockReturnValue(false);
    await ensureRunning('/ext', 'notebook');
    expect(databaseStartedEvents()).toHaveLength(2);
    expect(databaseStartedEvents()[1].properties).toMatchObject({ outcome: 'setupFailed' });

    isInstalled.mockReturnValue(true);
    ensureOsConfigured.mockResolvedValue({ ok: true, prompted: true });
    await ensureRunning('/ext', 'notebook');
    expect(databaseStartedEvents()).toHaveLength(3);
    expect(databaseStartedEvents()[2].properties).toMatchObject({ outcome: 'started' });
  });
});
