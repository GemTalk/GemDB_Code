import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetSettings } from '../__mocks__/vscode';
import { eventsNamed, fakeExtensionContext } from './telemetryTestSupport';

vi.mock('@vscode/extension-telemetry');

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
