import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetSettings } from '../__mocks__/vscode';
import { eventsNamed, fakeExtensionContext } from './telemetryTestSupport';

// `databaseStarted` is reported from inside `ensureRunning`, the one path
// everything that needs a database goes through — including every notebook
// cell. These tests exercise the "already running" fast path directly, with
// everything ensureRunning touches mocked to already-done, so the two bounds
// on the event (silent on a no-op call, deduped on a repeated failure) can be
// asserted without a real engine, database, or Grail.
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

const ensureOsConfigured = vi.fn(
  async (_extensionPath: string, _trigger: string): Promise<string> => 'alreadyConfigured',
);
vi.mock('../osConfig', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../osConfig')>();
  return {
    OS_CONFIG_RESULT: actual.OS_CONFIG_RESULT,
    osConfigAllowsStart: actual.osConfigAllowsStart,
    ensureOsConfigured: (extensionPath: string, trigger: string) =>
      ensureOsConfigured(extensionPath, trigger),
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
// Constants on the act side, literals on the assert side: the expectations pin
// the wire value, so renaming one must fail here rather than silently split a
// series in App Insights.
const { TRIGGER, initTelemetry } = await import('../telemetry');

describe('databaseStarted', () => {
  beforeEach(() => {
    __resetSettings();
    bundledGrailStamp.mockReturnValue('grail=0.1-1-gabc\n');
    grailNeedsUpdate.mockReturnValue(false);
    grailInstalled.mockReturnValue(true);
    isInstalled.mockReturnValue(true);
    ensureOsConfigured.mockResolvedValue('alreadyConfigured');
    findStone.mockReturnValue(true);
    findNetldi.mockReturnValue(true);

    initTelemetry(fakeExtensionContext(), false);
  });

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
    findStone.mockReturnValue(false);

    const ok = await ensureRunning('/ext', TRIGGER.notebook);

    expect(ok).toBe(true);
    expect(startStone).toHaveBeenCalledTimes(1);
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
