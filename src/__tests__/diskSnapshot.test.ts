import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { __resetSettings, __setSetting } from '../__mocks__/vscode';
import { ENGINE_ON_DISK, diskSnapshot, engineDirName, extentPath, grailPath } from '../paths';

// The snapshot is what telemetry attaches to a marker-based skip, so what
// matters is that it reads only existence, tells this platform's engines
// apart, and never throws.

describe('diskSnapshot', () => {
  let root: string;
  let originalPlatform: PropertyDescriptor | undefined;
  let originalArch: PropertyDescriptor | undefined;

  beforeEach(() => {
    __resetSettings();
    root = mkdtempSync(join(tmpdir(), 'gemdb-snap-'));
    __setSetting('gemdb.rootPath', root);
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    originalArch = Object.getOwnPropertyDescriptor(process, 'arch');
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    Object.defineProperty(process, 'arch', { value: 'arm64' });
  });

  afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
    if (originalArch) Object.defineProperty(process, 'arch', originalArch);
    rmSync(root, { recursive: true, force: true });
  });

  it('reports nothing on an empty root path', () => {
    expect(diskSnapshot()).toEqual({
      databaseOnDisk: false,
      engineOnDisk: ENGINE_ON_DISK.none,
      grailOnDisk: false,
    });
  });

  it('reports the database and Grail when they are there', () => {
    mkdirSync(join(extentPath(), '..'), { recursive: true });
    writeFileSync(extentPath(), '');
    mkdirSync(grailPath(), { recursive: true });
    writeFileSync(join(grailPath(), 'GRAIL_VERSION'), '1');

    expect(diskSnapshot()).toMatchObject({ databaseOnDisk: true, grailOnDisk: true });
  });

  it('reports the pinned engine as current, even beside another', () => {
    mkdirSync(join(root, engineDirName()));
    mkdirSync(join(root, engineDirName('0.0.1')));

    expect(diskSnapshot().engineOnDisk).toBe(ENGINE_ON_DISK.current);
  });

  it('reports an engine that is not the pinned one as other', () => {
    mkdirSync(join(root, engineDirName('0.0.1')));

    expect(diskSnapshot().engineOnDisk).toBe(ENGINE_ON_DISK.other);
  });

  it('does not count an engine for another platform', () => {
    mkdirSync(join(root, 'GemStone64Bit0.0.1-x86_64.Linux'));
    mkdirSync(join(root, 'GemStone64Bit-arm64.Darwin')); // no version at all
    mkdirSync(join(root, 'grail'));

    expect(diskSnapshot().engineOnDisk).toBe(ENGINE_ON_DISK.none);
  });

  it('counts no engine on a platform with no key, rather than matching "unknown"', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    mkdirSync(join(root, 'GemStone64Bit0.0.1-unknown'));

    expect(diskSnapshot().engineOnDisk).toBe(ENGINE_ON_DISK.none);
  });

  it('reads a missing root path as none', () => {
    rmSync(root, { recursive: true, force: true });

    expect(diskSnapshot().engineOnDisk).toBe(ENGINE_ON_DISK.none);
  });

  it('reads a failing directory listing as none instead of throwing', () => {
    // A root path that is a file: listing it raises ENOTDIR, with no mock.
    const file = join(root, 'not-a-directory');
    writeFileSync(file, '');
    __setSetting('gemdb.rootPath', file);

    expect(diskSnapshot().engineOnDisk).toBe(ENGINE_ON_DISK.none);
  });
});
