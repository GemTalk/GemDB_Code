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

/**
 * What setup costs on this platform, as told to the user before it starts.
 *
 * Measured for 4.0.0.a4: the macOS disk image is 143 MB and its engine 378 MB
 * once copied out; the Linux zips are 424 MB (arm64) and 449 MB (x86-64) and
 * unpack to about 1.07 GB. The database with Python filed in and the staged
 * Python payload add about 330 MB either way. The figures move with the engine
 * pin, and the welcome view in package.json and the walkthrough repeat them.
 */
export function setupFootprint(): { download: string; disk: string } {
  return process.platform === 'darwin'
    ? { download: '145 MB', disk: '700 MB' }
    : { download: '450 MB', disk: '1.4 GB' };
}

/** Shared-library extension for this platform. */
export function sharedLibraryExtension(): 'dylib' | 'so' {
  return process.platform === 'darwin' ? 'dylib' : 'so';
}

/** The dynamic-loader search-path variable this platform uses. */
export function libraryPathVariable(): 'DYLD_LIBRARY_PATH' | 'LD_LIBRARY_PATH' {
  return process.platform === 'darwin' ? 'DYLD_LIBRARY_PATH' : 'LD_LIBRARY_PATH';
}

/**
 * Is this process running from a Snap — the Snap Store build of VS Code, or
 * the Shell wrapper running that build's Electron as Node?
 *
 * Read from the executable path rather than `$SNAP`, because the path is what
 * decides the outcome and a terminal's environment need not carry the
 * variable. `/var/lib/snapd/snap` is where distributions without `/snap`
 * (Fedora) mount snaps.
 */
export function isSnapRuntime(execPath: string = process.execPath): boolean {
  return /^\/(var\/lib\/snapd\/)?snap\//.test(execPath);
}

/**
 * Turn a failure to load the database client library into a sentence, when it
 * is the failure GemDB can name.
 *
 * The one it can name is a C runtime too old for the engine — the dynamic
 * linker's ``version `GLIBC_2.33' not found`` or ``version `GLIBCXX_3.4.29'
 * not found``. The case that meets users is the Snap Store build of VS Code:
 * its Electron is patched to run on the Snap's `core20` base, so the extension
 * host has Ubuntu 20.04's glibc 2.31 whatever the host has, and GemStone
 * 4.0's `libgcits` needs 2.34 (and `libnetldi` GLIBCXX_3.4.29). Measured on
 * 2026-09-30 with the `code` snap at revision 267 on Ubuntu 24.04: the
 * database installs and starts, since those are host binaries in processes of
 * their own, and then the first notebook cell fails at the load. Microsoft's
 * .deb of the same commit runs the cell. Nothing in the extension host can
 * bridge that — a process cannot load a library linked against a newer glibc
 * than the one it is running on — so the useful thing is to say which editor
 * to install instead.
 *
 * Anything else is passed through unchanged: a sentence that names the wrong
 * cause is worse than the linker's own.
 */
export function explainLibraryLoadFailure(
  message: string,
  execPath: string = process.execPath,
): string {
  if (!/version [`'"]GLIBC(XX)?_[\d.]+['`"] not found/.test(message)) return message;
  if (isSnapRuntime(execPath)) {
    return (
      'VS Code installed as a Snap cannot run GemDB: a Snap runs on its own, older copy of ' +
      "the system libraries, and GemDB's database engine needs newer ones. Install VS Code " +
      'from code.visualstudio.com (the .deb or .rpm package) instead; the database GemDB ' +
      'has already set up carries over.'
    );
  }
  return (
    "This system's C runtime libraries are older than GemDB's database engine needs, so the " +
    `database client library could not be loaded. (${message})`
  );
}

/** Publish `gemdb.*` context keys the `when` clauses in package.json read. */
export function setContext(key: string, value: unknown): void {
  void vscode.commands.executeCommand('setContext', key, value);
}
