import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { __resetSettings, __setSetting, __telemetry } from '../__mocks__/vscode';

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

function fakeContext(): Parameters<typeof activate>[0] {
  return {
    extensionPath: '/ext',
    extension: { packageJSON: { version: '0.0.0-test' } },
    extensionMode: 1, // vscode.ExtensionMode.Production
    globalStorageUri: { fsPath: mkdtempSync(join(tmpdir(), 'gemdb-activation-')) },
    subscriptions: [],
    environmentVariableCollection: {
      description: '',
      clear: () => {},
      prepend: () => {},
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('activate()', () => {
  let originalPlatform: PropertyDescriptor | undefined;
  let originalArch: PropertyDescriptor | undefined;

  beforeEach(() => {
    __resetSettings();
    __setSetting('gemdb.rootPath', mkdtempSync(join(tmpdir(), 'gemdb-root-')));
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    originalArch = Object.getOwnPropertyDescriptor(process, 'arch');
    isInstalled.mockReset().mockReturnValue(true);
    isRunning.mockReset().mockReturnValue(false);
  });

  afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
    if (originalArch) Object.defineProperty(process, 'arch', originalArch);
  });

  it('reports activation exactly once on a supported platform', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    Object.defineProperty(process, 'arch', { value: 'arm64' });

    activate(fakeContext());

    const activated = __telemetry.filter((e) => e.name === 'activated');
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

    activate(fakeContext());

    const activated = __telemetry.filter((e) => e.name === 'activated');
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

      activate(fakeContext());

      const [activated] = __telemetry.filter((e) => e.name === 'activated');
      expect(activated.properties.state).toBe('notInstalled');
    });

    it('is stopped when installed but not running', () => {
      isInstalled.mockReturnValue(true);
      isRunning.mockReturnValue(false);

      activate(fakeContext());

      const [activated] = __telemetry.filter((e) => e.name === 'activated');
      expect(activated.properties.state).toBe('stopped');
    });

    it('is running when the database is up', () => {
      isInstalled.mockReturnValue(true);
      isRunning.mockReturnValue(true);

      activate(fakeContext());

      const [activated] = __telemetry.filter((e) => e.name === 'activated');
      expect(activated.properties.state).toBe('running');
    });
  });
});
