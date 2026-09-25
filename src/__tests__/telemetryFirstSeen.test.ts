import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetSettings } from '../__mocks__/vscode';
import { eventsNamed, fakeExtensionContext } from './telemetryTestSupport';

const ensureRunning = vi.fn(async (_extensionPath: string, _trigger: string) => true);
vi.mock('../lifecycle', () => ({
  ensureRunning: (extensionPath: string, trigger: string) => ensureRunning(extensionPath, trigger),
}));

vi.mock('../cli', () => ({ cliPath: () => '/bin/gemdb', ensureCliCurrent: () => true }));
vi.mock('../processes', () => ({ findStone: () => true, findNetldi: () => true }));

const { openRepl } = await import('../repl');
const { initTelemetry } = await import('../telemetry');

beforeEach(() => {
  __resetSettings();
  vi.clearAllMocks();
  ensureRunning.mockResolvedValue(true);
});

describe('pythonUsed with a corrupt first-seen file', () => {
  // The write in resolveInstallDay is not atomic, so a crash or a full disk
  // during first activation can leave a zero-byte or truncated first-seen
  // file behind. `new Date(contents).getTime()` on that is NaN, and NaN would
  // slip past a plain `!== undefined` guard — this pins that reportPythonUsed
  // sends the event without a bogus `minutesSinceFirstSeen: NaN` measure.
  it('sends pythonUsed with no minutesSinceFirstSeen measure', async () => {
    const storageDir = mkdtempSync(join(tmpdir(), 'gemdb-first-seen-corrupt-'));
    writeFileSync(join(storageDir, 'first-seen'), '');

    initTelemetry(fakeExtensionContext({ globalStoragePath: storageDir }), false);

    await openRepl('/ext');

    expect(eventsNamed('pythonUsed')).toHaveLength(1);
    expect(eventsNamed('pythonUsed')[0].properties).toMatchObject({
      surface: 'shell',
      evidence: 'launched',
    });
    expect(eventsNamed('pythonUsed')[0].measurements).toBeUndefined();
  });
});

describe('pythonUsed minutesSinceFirstSeen', () => {
  const NOW = new Date('2026-09-23T12:00:00.000Z');

  // `seenSurfaces` lets each surface report once per module instance, so every
  // case gets a fresh telemetry.ts — and a fresh vscode mock with it, which is
  // why the event filter is re-imported alongside rather than taken from the
  // top of the file.
  async function minutesSinceFirstSeenFor(firstSeenAt: Date): Promise<number | undefined> {
    vi.resetModules();
    const { initTelemetry, reportPythonUsed, SURFACE, EVIDENCE } = await import('../telemetry');
    const support = await import('./telemetryTestSupport');
    const storageDir = mkdtempSync(join(tmpdir(), 'gemdb-first-seen-'));
    writeFileSync(join(storageDir, 'first-seen'), firstSeenAt.toISOString());

    initTelemetry(support.fakeExtensionContext({ globalStoragePath: storageDir }), false);
    reportPythonUsed(SURFACE.notebook, EVIDENCE.executed);

    const [event] = support.eventsNamed('pythonUsed');
    return event.measurements?.minutesSinceFirstSeen;
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends 0 rather than a negative age when first-seen is in the future', async () => {
    // A clock set back since first-seen was recorded, or set ahead when it was.
    const tomorrow = new Date(NOW.getTime() + 24 * 60 * 60_000);
    expect(await minutesSinceFirstSeenFor(tomorrow)).toBe(0);
  });

  it('sends 0, not no measure at all, when first-seen is now', async () => {
    expect(await minutesSinceFirstSeenFor(NOW)).toBe(0);
  });

  it('rounds to whole minutes rather than flooring', async () => {
    const ninetySecondsAgo = new Date(NOW.getTime() - 90_000);
    expect(await minutesSinceFirstSeenFor(ninetySecondsAgo)).toBe(2);
  });
});
