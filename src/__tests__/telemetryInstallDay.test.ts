import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// telemetry.ts imports the real @vscode/extension-telemetry package, which
// itself requires 'vscode' at module load — unloadable outside an extension
// host. resolveInstallDay never touches it, so it is stubbed out rather than
// exercised here.
vi.mock('@vscode/extension-telemetry', () => ({ TelemetryReporter: class {} }));

const { resolveInstallDay } = await import('../telemetry');

// resolveInstallDay takes a plain path and a boolean, so all three branches
// are exercised directly against a temp directory — no VS Code needed.
describe('resolveInstallDay()', () => {
  let storageDir: string;

  beforeEach(() => {
    storageDir = mkdtempSync(join(tmpdir(), 'gemdb-install-day-'));
  });

  afterEach(() => {
    rmSync(storageDir, { recursive: true, force: true });
  });

  function todayUtcDate(): string {
    return new Date().toISOString().slice(0, 10);
  }

  it('reports firstSeen from an existing first-seen file, unmodified', () => {
    const firstSeen = join(storageDir, 'first-seen');
    fs.writeFileSync(firstSeen, '2026-08-01T00:00:00.000Z');

    const installDay = resolveInstallDay(storageDir, true);

    expect(installDay).toEqual({ installDay: '2026-08-01', installDaySource: 'firstSeen' });
    expect(fs.readFileSync(firstSeen, 'utf8')).toBe('2026-08-01T00:00:00.000Z');
  });

  it('reports reinstall when first-seen is absent but a database exists', () => {
    const installDay = resolveInstallDay(storageDir, true);

    expect(installDay).toEqual({ installDay: todayUtcDate(), installDaySource: 'reinstall' });
    expect(fs.existsSync(join(storageDir, 'first-seen'))).toBe(true);
  });

  it('reports firstSeen when first-seen is absent and there is no database', () => {
    const installDay = resolveInstallDay(storageDir, false);

    expect(installDay).toEqual({ installDay: todayUtcDate(), installDaySource: 'firstSeen' });
    expect(fs.existsSync(join(storageDir, 'first-seen'))).toBe(true);
  });

  it('never throws when the storage directory cannot be written', () => {
    // A path under a file, rather than a directory, can never be mkdir'd into.
    const blocked = join(storageDir, 'not-a-directory', 'nested');
    fs.writeFileSync(join(storageDir, 'not-a-directory'), '');

    expect(() => resolveInstallDay(blocked, false)).not.toThrow();
  });
});
