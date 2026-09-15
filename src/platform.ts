import * as vscode from 'vscode';

/**
 * The platforms a release can honestly carry: Apple Silicon macOS, and Linux on
 * both x86-64 and arm64.
 *
 * This gate exists to agree with the payload, not to express an ambition. What
 * cannot be faked is Grail's CPython shim — a native library compiled against a
 * specific engine version on a specific platform, staged into
 * `grail/prebuilt/<platform>/` by a build that has to *run* on that platform. A
 * `.vsix` missing the right one installs perfectly and then fails at the first
 * `import`, which is a far worse first run than being told the platform is not
 * supported. So this predicate lists exactly the platforms CI builds a shim for
 * (see `.github/workflows/ci.yml`), and each target's `.vsix` carries its own.
 *
 * Widening it is therefore two coordinated steps, in this order: build the shim
 * on the new platform so `grail/prebuilt/` carries it, then widen this
 * predicate. Doing the second without the first is the bug this function exists
 * to prevent.
 *
 * Intel macOS is out, and is not coming back. It used to be one machine away:
 * the 3.7.x catalog published an `i386.Darwin` engine and only the shim was
 * missing. At 4.0 the engine itself is gone — dl.gemdb.com carries
 * `arm64.Darwin`, `arm64.Linux` and `x86_64.Linux`, and nothing for Intel
 * macOS — so there is no build to support even if someone produced a machine
 * to build the shim on. Treat it as unsupported rather than pending.
 *
 * Windows stays further out, and not only for the shim: its install runs a Unix
 * shell pipeline, and reaching it means routing every command through WSL as
 * Jasper does — a large amount of machinery for an extension whose whole point
 * is a short first run.
 *
 * Note on Rosetta: an Intel build of VS Code on an Apple Silicon Mac reports
 * `darwin`/`x64` here and is correctly refused. Its extension host is an x86_64
 * process, so it would load an x86_64 GCI library, which is exactly the shim we
 * do not ship. The arm64 build of VS Code is the supported one.
 */
export function isSupportedPlatform(): boolean {
  if (process.platform === 'darwin') return process.arch === 'arm64';
  if (process.platform === 'linux') return process.arch === 'arm64' || process.arch === 'x64';
  return false;
}

/**
 * The download/product-directory key for this machine, e.g. `arm64.Darwin`.
 *
 * Undefined on Intel macOS, which no longer has a key to spell: the engine is
 * not published for it (see `isSupportedPlatform`), so there is no product
 * directory it could name.
 */
export function platformKey(): string | undefined {
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'arm64.Darwin' : undefined;
  if (process.platform === 'linux') {
    return `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}.Linux`;
  }
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
