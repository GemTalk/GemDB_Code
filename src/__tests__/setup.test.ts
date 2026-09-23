import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetSettings } from '../__mocks__/vscode';
import { eventsNamed, fakeExtensionContext } from './telemetryTestSupport';

// `runSetup` is the shared body of `prepare()`, `install()` and
// `ensureRunning()` — see lifecycle.ts's own comment on the extraction. These
// tests exercise it directly, with everything that touches the machine or
// the network mocked out, so the three outcomes and both cancel routes are
// covered without a real download.
vi.mock('@vscode/extension-telemetry');

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
vi.mock('../database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../database')>();
  return {
    DatabaseVersionError: actual.DatabaseVersionError,
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
// Constants on the act side, literals on the assert side: the expectations pin
// the wire value, so renaming one must fail here rather than silently split a
// series in App Insights.
const { TRIGGER, initTelemetry } = await import('../telemetry');

describe('runSetup', () => {
  beforeEach(() => {
    __resetSettings();
    installEngine.mockReset().mockResolvedValue('/engine');
    createDatabase.mockReset().mockReturnValue({ created: true, preloaded: true });
    stageGrail.mockReset();

    // `send()` in telemetry.ts is a no-op until `initTelemetry` has run —
    // exactly as in a real activation — so this test needs one too, with a
    // throwaway global storage directory.
    initTelemetry(fakeExtensionContext(), false);
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
});
