import * as vscode from 'vscode';

/**
 * GemDB 1.x supports macOS on Apple Silicon, and nothing else yet.
 *
 * The narrowness is about what a release can honestly carry, not about what the
 * code can do: everything below this line already handles Linux and Intel Macs,
 * and `platformKey` still spells all four. What cannot be faked is Grail's
 * CPython shim — a native library compiled against a specific engine version on
 * a specific platform, staged into `grail/prebuilt/<platform>/` by a build that
 * has to *run* on that platform. A `.vsix` missing the right one installs
 * perfectly and then fails at the first `import`, which is a far worse first run
 * than being told the platform is not supported yet. So the release ships one
 * prebuilt shim and this gate agrees with it.
 *
 * Widening it is therefore two coordinated steps, in this order: run
 * `bundle:grail` on the new platform so `grail/prebuilt/` carries its shim, then
 * widen this predicate. Doing the second without the first is the bug this
 * function exists to prevent.
 *
 * Windows stays further out, and not only for the shim: its install runs a Unix
 * shell pipeline, and reaching it means routing every command through WSL as
 * Jasper does — a large amount of machinery for an extension whose whole point
 * is a short first run.
 *
 * Note on Rosetta: an Intel build of VS Code on an Apple Silicon Mac reports
 * `x64` here and is correctly refused. Its extension host is an x86_64 process,
 * so it would load an x86_64 GCI library, which is exactly the shim we do not
 * ship. The arm64 build of VS Code is the supported one.
 */
export function isSupportedPlatform(): boolean {
  return process.platform === 'darwin' && process.arch === 'arm64';
}

/**
 * The catalog/product-directory key for this machine, e.g. `arm64.Darwin`.
 *
 * The engine's Darwin x86_64 build is named `i386.Darwin` for historical
 * reasons — that is the vendor's spelling, not a mistake here.
 */
export function platformKey(): string | undefined {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
  if (process.platform === 'darwin') return arch === 'arm64' ? 'arm64.Darwin' : 'i386.Darwin';
  if (process.platform === 'linux') return `${arch}.Linux`;
  return undefined;
}

/** Product archive extension for this platform. */
export function archiveExtension(): 'dmg' | 'zip' {
  return process.platform === 'darwin' ? 'dmg' : 'zip';
}

/** Shared-library extension for this platform. */
export function sharedLibraryExtension(): 'dylib' | 'so' {
  return process.platform === 'darwin' ? 'dylib' : 'so';
}

/** The dynamic-loader search-path variable this platform uses. */
export function libraryPathVariable(): 'DYLD_LIBRARY_PATH' | 'LD_LIBRARY_PATH' {
  return process.platform === 'darwin' ? 'DYLD_LIBRARY_PATH' : 'LD_LIBRARY_PATH';
}

/** Publish `gemdb.*` context keys the `when` clauses in package.json read. */
export function setContext(key: string, value: unknown): void {
  void vscode.commands.executeCommand('setContext', key, value);
}
