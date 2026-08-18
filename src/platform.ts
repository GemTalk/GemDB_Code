import * as vscode from 'vscode';

/**
 * GemDB supports macOS and Linux.
 *
 * Windows is not supported yet, and the reason is not just the engine: Grail's
 * CPython shim is a native library built against the engine's headers, and its
 * install runs a Unix shell pipeline. Jasper reaches Windows by routing every
 * command through WSL, which is a large amount of machinery for an extension
 * whose whole point is a short first-run path. Adding it is a deliberate
 * future step, not an oversight.
 */
export function isSupportedPlatform(): boolean {
  return process.platform === 'darwin' || process.platform === 'linux';
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
