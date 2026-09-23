import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { __resetSettings, __setSetting, env } from '../__mocks__/vscode';
import { eventsNamed, fakeExtensionContext } from './telemetryTestSupport';

// `activate()` is synchronous, but everything after its two exits — the
// download, the sudo prompt, autoStart — is a detached tail that must never
// run in a unit test. These mocks keep that tail inert. `telemetry.ts` itself
// is NOT mocked: the vscode mock's fake `env.createTelemetryLogger`, plus the
// root-level `__mocks__/@vscode/extension-telemetry.ts`, let the real module
// run, so this exercises real `send`, real `baseProperties` merging, and
// real event names, recorded in `__telemetry`.
vi.mock('@vscode/extension-telemetry');
const isInstalled = vi.fn(() => true);
vi.mock('../lifecycle', () => ({
  isInstalled: () => isInstalled(),
  ensureMcpRunning: async () => false,
  ensureRunning: async () => false,
  install: async () => {},
  prepare: () => false,
  reinstallGrail: async () => {},
  start: async () => {},
  stop: async () => {},
  uninstall: async () => {},
}));
vi.mock('../autoStart', () => ({
  autoStartSuppressed: () => true,
  initAutoStart: () => {},
  suppressAutoStart: () => {},
}));
const isRunning = vi.fn(() => false);
vi.mock('../processes', () => ({
  isRunning: () => isRunning(),
  isRunningAsync: async () => isRunning(),
  isListening: () => true,
  listProcesses: () => [],
}));
vi.mock('../osConfig', () => ({
  configureSharedMemory: async () => {},
  ensureOsConfigured: async () => false,
  isSharedMemoryConfigured: async () => false,
  isRemoveIpcConfigured: () => false,
  sharedMemoryLabel: async () => '',
}));

const { activate } = await import('../extension');

describe('activate()', () => {
  let originalPlatform: PropertyDescriptor | undefined;
  let originalArch: PropertyDescriptor | undefined;
  let rootPathValue: string;

  beforeEach(() => {
    __resetSettings();
    rootPathValue = mkdtempSync(join(tmpdir(), 'gemdb-root-'));
    __setSetting('gemdb.rootPath', rootPathValue);
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    originalArch = Object.getOwnPropertyDescriptor(process, 'arch');
    isInstalled.mockReset().mockReturnValue(true);
    isRunning.mockReset().mockReturnValue(false);
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    Object.defineProperty(process, 'arch', { value: 'arm64' });
  });

  afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
    if (originalArch) Object.defineProperty(process, 'arch', originalArch);
    env.remoteName = undefined;
  });

  it('reports activation exactly once on a supported platform', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    Object.defineProperty(process, 'arch', { value: 'arm64' });

    activate(fakeExtensionContext());
    // `activated.state` is resolved off the synchronous activation path (it
    // spawns `gslist`), so the event lands a tick after `activate()` returns.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const activated = eventsNamed('activated');
    expect(activated).toHaveLength(1);
    const durationMs = activated[0].measurements?.activationMs;
    expect(durationMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(durationMs)).toBe(true);
  });

  it('still reports activation on an unsupported platform', () => {
    // This is the case that catches a regression to only emitting at the
    // normal end of activate(): the early return on an unsupported platform
    // must not silently drop that population.
    Object.defineProperty(process, 'platform', { value: 'win32' });

    activate(fakeExtensionContext());

    const activated = eventsNamed('activated');
    expect(activated).toHaveLength(1);
    expect(activated[0].properties.state).toBe('unsupportedPlatform');
  });

  describe('activated.state', () => {
    beforeEach(() => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      Object.defineProperty(process, 'arch', { value: 'arm64' });
    });

    it('is notInstalled when nothing is on disk yet', () => {
      isInstalled.mockReturnValue(false);

      activate(fakeExtensionContext());

      const [activated] = eventsNamed('activated');
      expect(activated.properties.state).toBe('notInstalled');
    });

    it('is stopped when installed but not running', async () => {
      isInstalled.mockReturnValue(true);
      isRunning.mockReturnValue(false);

      activate(fakeExtensionContext());
      await new Promise((resolve) => setTimeout(resolve, 0));

      const [activated] = eventsNamed('activated');
      expect(activated.properties.state).toBe('stopped');
    });

    it('is running when the database is up', async () => {
      isInstalled.mockReturnValue(true);
      isRunning.mockReturnValue(true);

      activate(fakeExtensionContext());
      await new Promise((resolve) => setTimeout(resolve, 0));

      const [activated] = eventsNamed('activated');
      expect(activated.properties.state).toBe('running');
    });
  });

  describe('unattendedSetupSkipped', () => {
    function skipped(): { skipReason: unknown }[] {
      return eventsNamed('unattendedSetupSkipped').map((e) => ({
        skipReason: e.properties.skipReason,
      }));
    }

    it('reports alreadyInstalled without ever emitting setupStarted', () => {
      isInstalled.mockReturnValue(true);

      activate(fakeExtensionContext());

      expect(skipped()).toEqual([{ skipReason: 'alreadyInstalled' }]);
    });

    it('reports remoteWindow for a remote or web window', () => {
      isInstalled.mockReturnValue(false);
      env.remoteName = 'wsl';

      activate(fakeExtensionContext());

      expect(skipped()).toEqual([{ skipReason: 'remoteWindow' }]);
    });

    it('reports markerPresent when an earlier cancel already recorded a marker', () => {
      isInstalled.mockReturnValue(false);
      const context = fakeExtensionContext();
      writeFileSync(
        join(context.globalStorageUri.fsPath, 'setup-attempted'),
        new Date().toISOString(),
      );

      activate(context);

      expect(skipped()).toEqual([{ skipReason: 'markerPresent' }]);
    });

    it('reports lockHeld when another window already owns the setup lock', async () => {
      isInstalled.mockReturnValue(false);
      mkdirSync(join(rootPathValue, '.gemdb-locks'), { recursive: true });
      // A pid this test process did not spawn, but that is alive on any Unix
      // host: process 1 is always running. Anything other than this test's
      // own pid takes the "another window" branch instead of the "stale
      // debris from an earlier call" one.
      writeFileSync(join(rootPathValue, '.gemdb-setup.lock'), '1');

      activate(fakeExtensionContext());
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(skipped()).toEqual([{ skipReason: 'lockHeld' }]);
    });

    it('reports installedByOtherWindow when the lock re-check finds it already done', async () => {
      // isInstalled() is called twice by activate() itself (initTelemetry,
      // then the activated.state calculation) before prepareOnFirstRun's own
      // outer check — both fine to answer true. The outer check must answer
      // false to reach the lock at all; the re-check inside it must then
      // answer true, the shape of another window finishing the whole thing
      // while this one was waiting to acquire the lock.
      isInstalled
        .mockReturnValueOnce(true) // initTelemetry
        .mockReturnValueOnce(true) // activated.state
        .mockReturnValueOnce(false) // prepareOnFirstRun's outer check
        .mockReturnValue(true); // the re-check inside the lock

      activate(fakeExtensionContext());
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(skipped()).toEqual([{ skipReason: 'installedByOtherWindow' }]);
    });
  });
});
