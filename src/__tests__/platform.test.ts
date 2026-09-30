import { describe, expect, it } from 'vitest';
import { explainLibraryLoadFailure, isSnapRuntime } from '../platform';

// Captured verbatim from koffi on 2026-09-30, loading the pinned engine's
// client libraries (4.0.0.a4) inside the Snap Store build of VS Code 1.140.0
// (`code` snap revision 267, base core20) on Ubuntu 24.04. The first is what a
// notebook cell showed; the second is the same load one library later.
const SNAP_EXEC = '/snap/code/267/usr/share/code/code';
const GLIBCXX_FAILURE =
  "Failed to load shared library: /snap/core20/current/lib/x86_64-linux-gnu/libstdc++.so.6: version `GLIBCXX_3.4.29' not found (required by /home/dev/GemDB/GemStone64Bit4.0.0.a4-x86_64.Linux/lib/libnetldi-4.0.0.a4-64.so)";
const GLIBC_FAILURE =
  "Failed to load shared library: /snap/core20/current/lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.33' not found (required by /home/dev/GemDB/GemStone64Bit4.0.0.a4-x86_64.Linux/lib/libgcits-4.0.0.a4-64.so)";

describe('isSnapRuntime', () => {
  it('recognises a snap by where its executable lives', () => {
    expect(isSnapRuntime(SNAP_EXEC)).toBe(true);
    // Distributions without /snap mount snaps here.
    expect(isSnapRuntime('/var/lib/snapd/snap/code/267/usr/share/code/code')).toBe(true);
  });

  it('does not mistake a packaged or tarball install for one', () => {
    expect(isSnapRuntime('/usr/share/code/code')).toBe(false);
    expect(isSnapRuntime('/home/dev/VSCode-linux-x64/code')).toBe(false);
    // A directory named snap somewhere below the root is not a snap.
    expect(isSnapRuntime('/home/dev/snap/code/267/code')).toBe(false);
  });
});

describe('explainLibraryLoadFailure', () => {
  it('names the Snap and the build to install instead', () => {
    for (const failure of [GLIBCXX_FAILURE, GLIBC_FAILURE]) {
      const sentence = explainLibraryLoadFailure(failure, SNAP_EXEC);
      expect(sentence).toMatch(/installed as a Snap cannot run GemDB/);
      expect(sentence).toMatch(/code\.visualstudio\.com/);
    }
  });

  it('blames the system, not a Snap, when the editor is not one', () => {
    const sentence = explainLibraryLoadFailure(GLIBC_FAILURE, '/usr/share/code/code');

    expect(sentence).not.toMatch(/Snap/);
    expect(sentence).toMatch(/older than GemDB's database engine needs/);
    // The linker's detail is kept: without a Snap to name, it is the evidence.
    expect(sentence).toContain("`GLIBC_2.33' not found");
  });

  it('passes any other failure through unchanged', () => {
    const other =
      'Failed to load shared library: /home/dev/GemDB/x/lib/libgcits-4.0.0.a4-64.so: cannot open shared object file: No such file or directory';

    expect(explainLibraryLoadFailure(other, SNAP_EXEC)).toBe(other);
  });
});
