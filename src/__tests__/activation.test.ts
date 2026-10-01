import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  __changeSetting,
  __commands,
  __resetSettings,
  __setSetting,
  env,
} from '../__mocks__/vscode';
import { engineDirName, extentPath } from '../paths';
import { eventsNamed, fakeExtensionContext } from './telemetryTestSupport';

// `activate()` is synchronous, but everything after its two exits — the
// download, the sudo prompt, autoStart — is a detached tail that must never
// run in a unit test. These mocks keep that tail inert. `telemetry.ts` itself
// is NOT mocked: the vscode mock's fake `env.createTelemetryLogger`, plus the
// root-level `__mocks__/@vscode/extension-telemetry.ts` (applied to every file
// by src/__mocks__/setup.ts), let the real module run, so this exercises real
// `send`, real `baseProperties` merging, and real event names, recorded in
// `__telemetry`.
const isInstalled = vi.fn(() => true);
const uninstall = vi.fn(async () => true);
const prepare = vi.fn(async (): Promise<string> => 'failed');
vi.mock('../lifecycle', () => ({
  isInstalled: () => isInstalled(),
  ensureMcpRunning: async () => false,
  ensureRunning: async () => false,
  resumeMcpServing: async () => false,
  install: async () => {},
  prepare: () => prepare(),
  reinstallGrail: async () => {},
  start: async () => {},
  stop: async () => {},
  uninstall: () => uninstall(),
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
const ensureOsConfigured = vi.fn(async (): Promise<string> => 'alreadyConfigured');
vi.mock('../osConfig', async (importOriginal) => ({
  osConfigAllowsStart: (await importOriginal<typeof import('../osConfig')>()).osConfigAllowsStart,
  configureSharedMemory: async () => {},
  configureRemoveIpc: async () => {},
  ensureOsConfigured: () => ensureOsConfigured(),
  isSharedMemoryConfigured: async () => false,
  isRemoveIpcConfigured: () => false,
  sharedMemoryLabel: async () => '',
}));

// Only what the real `runSetup` touches, for the first run marker tests that
// complete an explicit setup through it: no download, no database, no copy.
vi.mock('../engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../engine')>()),
  installEngine: async () => '/engine',
}));
vi.mock('../database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../database')>()),
  assertDatabaseMatchesEngine: () => {},
  createDatabase: () => true,
}));
vi.mock('../grail', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../grail')>()),
  stageGrail: () => {},
}));

// A change of database settings ends what was bound to the old database.
// These record that it happened; what each one does is tested where it lives.
const logoutAll = vi.fn();
vi.mock('../session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../session')>()),
  logoutAll: () => logoutAll(),
}));
const stopMcpServer = vi.fn(async (_options?: { bySession?: boolean }) => {});
vi.mock('../mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../mcp')>()),
  stopMcpServer: (options?: { bySession?: boolean }) => stopMcpServer(options),
}));
const ensureCliCurrent = vi.fn(() => true);
vi.mock('../cli', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../cli')>()),
  ensureCliCurrent: () => ensureCliCurrent(),
}));

const { activate } = await import('../extension');
// The real one, past the `lifecycle` mock above: it is what writes `completed`
// over the marker when an explicit setup completes.
const { runSetup } = await vi.importActual<typeof import('../lifecycle')>('../lifecycle');
const { TRIGGER } = await import('../telemetry');
const { writeUnattendedSetupMarker } = await import('../unattendedSetupMarker');

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
    uninstall.mockReset().mockResolvedValue(true);
    prepare.mockReset().mockResolvedValue('failed');
    ensureOsConfigured.mockReset().mockResolvedValue('alreadyConfigured');
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
    // spawns `gslist`), so the event lands after `activate()` returns. Poll
    // for it rather than sleeping a tick: `activate()` has no promise to
    // await (returning one would hold VS Code's activation on `gslist`), and
    // a fixed wait breaks as soon as that tail grows another `await`.
    await expect.poll(() => eventsNamed('activated')).toHaveLength(1);

    const activated = eventsNamed('activated');
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
      await expect.poll(() => eventsNamed('activated')).toHaveLength(1);

      const [activated] = eventsNamed('activated');
      expect(activated.properties.state).toBe('stopped');
    });

    it('is running when the database is up', async () => {
      isInstalled.mockReturnValue(true);
      isRunning.mockReturnValue(true);

      activate(fakeExtensionContext());
      await expect.poll(() => eventsNamed('activated')).toHaveLength(1);

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

    // What `diskSnapshot` adds to a marker-based skip, as sent: strings, so
    // the booleans arrive as 'true' and 'false'.
    const DISK_PROPERTIES = ['databaseOnDisk', 'engineOnDisk', 'grailOnDisk'];
    function diskSent(): Record<string, unknown>[] {
      return eventsNamed('unattendedSetupSkipped').map((e) =>
        Object.fromEntries(
          Object.entries(e.properties).filter(([key]) => DISK_PROPERTIES.includes(key)),
        ),
      );
    }

    it('stays silent on an installed machine, leaving that to activated', async () => {
      isInstalled.mockReturnValue(true);
      isRunning.mockReturnValue(false);

      activate(fakeExtensionContext());
      await expect.poll(() => eventsNamed('activated')).toHaveLength(1);

      expect(skipped()).toEqual([]);
      expect(eventsNamed('setupStarted')).toEqual([]);
    });

    it('reports remoteWindow for a remote or web window', () => {
      isInstalled.mockReturnValue(false);
      env.remoteName = 'wsl';

      activate(fakeExtensionContext());

      expect(skipped()).toEqual([{ skipReason: 'remoteWindow' }]);
      expect(diskSent()).toEqual([{}]);
    });

    it('reports a marker that records no outcome as attemptedBefore, and leaves it', async () => {
      isInstalled.mockReturnValue(false);
      const context = fakeExtensionContext();
      const marker = join(context.globalStorageUri.fsPath, 'setup-attempted');
      // What every release through 1.5.1 wrote, however setup ended.
      const legacy = new Date().toISOString();
      writeFileSync(marker, legacy);

      activate(context);

      await expect.poll(skipped).toEqual([{ skipReason: 'attemptedBefore' }]);
      expect(eventsNamed('setupStarted')).toEqual([]);
      expect(readFileSync(marker, 'utf8')).toBe(legacy);
    });

    it.each([
      ['cancelled', 'cancelledBefore'],
      ['failed', 'failedBefore'],
      ['completed', 'installedBefore'],
      ['uninstalled', 'uninstalled'],
      [new Date().toISOString(), 'attemptedBefore'],
    ])('reports %s recorded in the marker as %s, with what is on disk', (recorded, skipReason) => {
      isInstalled.mockReturnValue(false);
      const context = fakeExtensionContext();
      writeFileSync(join(context.globalStorageUri.fsPath, 'setup-attempted'), recorded);
      // A database and an engine this build does not pin, and no Grail: each
      // property reads differently from an empty root path's.
      mkdirSync(join(extentPath(), '..'), { recursive: true });
      writeFileSync(extentPath(), '');
      mkdirSync(join(rootPathValue, engineDirName('0.0.1')));

      activate(context);

      expect(skipped()).toEqual([{ skipReason }]);
      expect(diskSent()).toEqual([
        { databaseOnDisk: 'true', engineOnDisk: 'other', grailOnDisk: 'false' },
      ]);
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

      await expect.poll(skipped).toEqual([{ skipReason: 'lockHeld' }]);
      expect(diskSent()).toEqual([{}]);
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

      const context = fakeExtensionContext();

      activate(context);

      await expect.poll(skipped).toEqual([{ skipReason: 'installedByOtherWindow' }]);
      expect(diskSent()).toEqual([{}]);
      // Recorded like any other first run, from the outcome it saw.
      const marker = join(context.globalStorageUri.fsPath, 'setup-attempted');
      expect(readFileSync(marker, 'utf8')).toBe('completed');
    });
  });

  describe('the first run marker', () => {
    it.each(['cancelled', 'failed'])(
      'is not written over once the files step ends %s, so a setup completed while the OS step waits is kept',
      async (filesOutcome) => {
        isInstalled.mockReturnValue(false);
        // As the real `prepare` does, through `runSetup`: records the outcome
        // before returning it.
        prepare.mockImplementation(async () => {
          writeUnattendedSetupMarker(filesOutcome as 'cancelled' | 'failed');
          return filesOutcome;
        });
        // The OS step waiting on a sudo terminal the user has not finished with.
        let releaseOs: (result: string) => void = () => {};
        ensureOsConfigured.mockReturnValue(
          new Promise((resolve) => {
            releaseOs = resolve;
          }),
        );
        const context = fakeExtensionContext();
        const marker = join(context.globalStorageUri.fsPath, 'setup-attempted');
        const lock = join(rootPathValue, '.gemdb-setup.lock');

        activate(context);
        await expect.poll(() => prepare.mock.calls.length).toBe(1);
        await new Promise((resolve) => setImmediate(resolve));

        // Meanwhile the user presses Resume and that setup completes.
        expect(await runSetup('/ext', TRIGGER.installCommand)).toBe('completed');

        releaseOs('declined');
        await expect.poll(() => existsSync(lock)).toBe(false);
        await new Promise((resolve) => setImmediate(resolve));

        expect(readFileSync(marker, 'utf8')).toBe('completed');
      },
    );
  });

  // #70: the lock keeps two setups apart, and the shared-memory step is not
  // one. Held across it, another window's Install, Start or notebook cell
  // waited behind a sudo prompt nobody might be answering.
  it('releases the setup lock when the files step ends, without waiting for the shared-memory prompt', async () => {
    isInstalled.mockReturnValue(false);
    prepare.mockResolvedValue('completed');
    ensureOsConfigured.mockReturnValue(new Promise(() => {}));
    const lock = join(rootPathValue, '.gemdb-setup.lock');

    activate(fakeExtensionContext());
    await expect.poll(() => prepare.mock.calls.length).toBe(1);

    await expect.poll(() => existsSync(lock)).toBe(false);
    expect(ensureOsConfigured).toHaveBeenCalledTimes(1);
  });

  // Its machine is configured by whoever runs it. A sudo prompt for shared
  // memory on a machine GemDB does not run the database on is never right.
  it('never asks about shared memory on first run for an external database', async () => {
    __setSetting('gemdb.externalDatabase.gemstone', '/opt/gemstone/product');
    isInstalled.mockReturnValue(false);
    prepare.mockResolvedValue('completed');
    const lock = join(rootPathValue, '.gemdb-setup.lock');

    activate(fakeExtensionContext());
    await expect.poll(() => prepare.mock.calls.length).toBe(1);
    await expect.poll(() => existsSync(lock)).toBe(false);

    expect(ensureOsConfigured).not.toHaveBeenCalled();
  });

  // The walkthrough picks its setup and stopping steps on this key, and can
  // open before the sidebar — the other place it is set — has ever rendered.
  describe('telling the walkthrough whose database it is', () => {
    let published: unknown[];

    beforeEach(() => {
      published = [];
      __commands.set('setContext', (key, value) => {
        if (key === 'gemdb.externalDatabase') published.push(value);
      });
    });

    it('says an administrator runs it before the sidebar has rendered', () => {
      __setSetting('gemdb.externalDatabase.gemstone', '/opt/gemstone/product');

      activate(fakeExtensionContext());

      expect(published[0]).toBe(true);
    });

    it('says GemDB Code runs it when no external database is set', () => {
      activate(fakeExtensionContext());

      expect(published[0]).toBe(false);
    });

    it('follows the setting when it changes', () => {
      activate(fakeExtensionContext());

      __changeSetting('gemdb.externalDatabase.gemstone', '/opt/gemstone/product');
      const afterSetting = published.at(-1);
      __changeSetting('gemdb.externalDatabase.gemstone', '');
      const afterClearing = published.at(-1);

      expect([afterSetting, afterClearing]).toEqual([true, false]);
    });
  });

  describe('when the external database settings change', () => {
    beforeEach(() => {
      __setSetting('gemdb.externalDatabase.gemstone', '/opt/gemstone/product');
      logoutAll.mockReset();
      stopMcpServer.mockReset();
      ensureCliCurrent.mockReset().mockReturnValue(true);
    });

    it.each([
      ['engine', 'gemdb.externalDatabase.gemstone', '/opt/gemstone/other'],
      ['lock directory', 'gemdb.externalDatabase.globalDirectory', '/srv/gemstone'],
      ['stone', 'gemdb.externalDatabase.stone', 'other'],
      ['NetLDI', 'gemdb.externalDatabase.netldi', 'otherldi'],
      ['account', 'gemdb.externalDatabase.user', 'someoneElse'],
    ])('leaves the previous database when its %s changes', (_label, key, value) => {
      activate(fakeExtensionContext());

      __changeSetting(key, value);

      expect(logoutAll).toHaveBeenCalledOnce();
      expect(stopMcpServer).toHaveBeenCalledOnce();
      expect(ensureCliCurrent).toHaveBeenCalledOnce();
    });

    it('stops the MCP server without sending the new database its old session id', () => {
      activate(fakeExtensionContext());

      __changeSetting('gemdb.externalDatabase.stone', 'other');

      expect(stopMcpServer).toHaveBeenCalledWith({ bySession: false });
    });

    it('keeps sessions open when only the password file changes', () => {
      activate(fakeExtensionContext());

      __changeSetting('gemdb.externalDatabase.passwordFile', '/home/dev/.gemdb-password');

      expect(logoutAll).not.toHaveBeenCalled();
      expect(stopMcpServer).not.toHaveBeenCalled();
    });

    it('rewrites the gemdb command when only the password file changes', () => {
      activate(fakeExtensionContext());

      __changeSetting('gemdb.externalDatabase.passwordFile', '/home/dev/.gemdb-password');

      expect(ensureCliCurrent).toHaveBeenCalledOnce();
    });

    it('leaves sessions alone when an unrelated setting changes', () => {
      activate(fakeExtensionContext());

      __changeSetting('gemdb.mcp.enabled', true);

      expect(logoutAll).not.toHaveBeenCalled();
      expect(ensureCliCurrent).not.toHaveBeenCalled();
    });
  });

  describe('gemdb.uninstall', () => {
    it('overwrites the marker with uninstalled rather than deleting it', async () => {
      const context = fakeExtensionContext();
      const marker = join(context.globalStorageUri.fsPath, 'setup-attempted');
      writeFileSync(marker, 'completed');
      activate(context);

      await __commands.get('gemdb.uninstall')?.();

      expect(readFileSync(marker, 'utf8')).toBe('uninstalled');
    });

    it('leaves the marker alone when nothing was removed', async () => {
      uninstall.mockResolvedValue(false);
      const context = fakeExtensionContext();
      const marker = join(context.globalStorageUri.fsPath, 'setup-attempted');
      writeFileSync(marker, 'completed');
      activate(context);

      await __commands.get('gemdb.uninstall')?.();

      expect(readFileSync(marker, 'utf8')).toBe('completed');
    });
  });
});
