import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { __resetSettings, __setSetting } from '../__mocks__/vscode';

// `activate()` is synchronous, but everything after its two exits — the
// download, the sudo prompt, autoStart — is a detached tail that must never
// run in a unit test. These mocks keep that tail inert; see telemetry.ts's own
// mock for why the event itself is faked rather than asserted through a real
// reporter.
const reportActivation = vi.fn<(durationMs: number) => void>();

vi.mock('../telemetry', () => ({
  initTelemetry: () => {},
  reportActivation: (ms: number) => reportActivation(ms),
}));
vi.mock('../lifecycle', () => ({
  isInstalled: () => true,
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
vi.mock('../processes', () => ({
  isRunning: () => false,
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
    reportActivation.mockClear();
    __setSetting('gemdb.rootPath', mkdtempSync(join(tmpdir(), 'gemdb-root-')));
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    originalArch = Object.getOwnPropertyDescriptor(process, 'arch');
  });

  afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
    if (originalArch) Object.defineProperty(process, 'arch', originalArch);
  });

  it('reports activation exactly once on a supported platform', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    Object.defineProperty(process, 'arch', { value: 'arm64' });

    activate(fakeContext());

    expect(reportActivation).toHaveBeenCalledTimes(1);
    const [durationMs] = reportActivation.mock.calls[0];
    expect(durationMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(durationMs)).toBe(true);
  });

  it('still reports activation on an unsupported platform', () => {
    // This is the case that catches a regression to only emitting at the
    // normal end of activate(): the early return on an unsupported platform
    // must not silently drop that population.
    Object.defineProperty(process, 'platform', { value: 'win32' });

    activate(fakeContext());

    expect(reportActivation).toHaveBeenCalledTimes(1);
  });
});
