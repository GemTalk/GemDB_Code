import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import * as vscode from 'vscode';
import { DB_PASSWORD, DB_USER, STONE_NAME, rootPath } from './config';
import { platformKey, sharedLibraryExtension } from './platform';
import { log, logStep } from './log';
import { engineEnvironment, shimLibraryPath } from './processes';
import { grailPath, grailStampPath, installedGrailStamp } from './paths';
import { logout } from './session';
import { writeCliScripts } from './cli';

/**
 * Grail — the Python implementation that runs inside the database — is shipped
 * inside the extension and staged out of it on install.
 *
 * Staging rather than running in place is not incidental. Grail records its own
 * directory inside the database at install time, and every session resolves
 * modules relative to it. An extension directory is versioned
 * (`~/.vscode/extensions/gemdb.gemdb-0.1.0/`), so it moves on every update and
 * would leave the database pointing at a Grail that no longer exists. The
 * staged copy under the GemDB root path is stable.
 */

/** The Grail build shipped with this extension, or undefined if none is. */
export function bundledGrailStamp(extensionPath: string): string | undefined {
  try {
    return fs.readFileSync(path.join(extensionPath, 'grail', 'GRAIL_VERSION'), 'utf8').trim();
  } catch {
    return undefined;
  }
}

/** A short label for the status view, e.g. "0.1-42-gdfb171d". */
export function grailLabel(stamp: string | undefined): string {
  if (!stamp) return 'unknown';
  const match = stamp.match(/^grail=(.+)$/m);
  return match ? match[1] : 'unknown';
}

/** True when the staged Grail is not the one this extension ships. */
export function grailNeedsUpdate(extensionPath: string): boolean {
  const bundled = bundledGrailStamp(extensionPath);
  if (!bundled) return false; // nothing to stage; reported separately
  return installedGrailStamp() !== bundled;
}

/**
 * Copy the bundled Grail to the root path, together with the prebuilt CPython
 * shim for this platform. Replaces any previously staged copy wholesale — a
 * partial overlay of one Grail on another is not a state worth supporting.
 */
export function stageGrail(extensionPath: string): void {
  const source = path.join(extensionPath, 'grail');
  const stamp = bundledGrailStamp(extensionPath);
  if (!stamp) {
    throw new Error(
      'This build of GemDB ships no Python payload, so Python cannot be installed. ' +
        'Run "npm run bundle:grail" before packaging the extension.',
    );
  }

  logStep(`Staging Grail ${grailLabel(stamp)}`);
  const dest = grailPath();
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(rootPath(), { recursive: true });
  fs.cpSync(source, dest, { recursive: true });

  // Install the shim for this platform where Grail expects to find it. The
  // library is specific to the platform AND the engine version it was compiled
  // against; the bundle carries one per platform for the pinned engine.
  const key = platformKey();
  const prebuilt = path.join(
    dest,
    'prebuilt',
    key ?? '',
    `libcpython_ua.${sharedLibraryExtension()}`,
  );
  const shimDir = path.join(dest, 'src', 'c', 'shim');
  if (fs.existsSync(prebuilt)) {
    fs.mkdirSync(shimDir, { recursive: true });
    fs.copyFileSync(prebuilt, shimLibraryPath());
    fs.chmodSync(shimLibraryPath(), 0o755);
    log(`Installed the CPython shim for ${key}`);
  } else {
    log(
      `No prebuilt CPython shim for ${key} in this build. Python support will still install, ` +
        'but C extension modules will not be available.',
    );
  }

  // A .vsix is a zip; depending on how it was produced the executable bit on
  // shell scripts may not survive. Restore it rather than debug a "permission
  // denied" during someone's first install.
  for (const script of listShellScripts(dest)) {
    try {
      fs.chmodSync(script, 0o755);
    } catch {
      /* best effort */
    }
  }

  // The shell command is regenerated with every staging, so its baked-in
  // paths always match the engine and Grail that are actually on disk.
  writeCliScripts(extensionPath);

  // Deliberately NOT stamped here. The stamp means "this Grail is installed in
  // the database", and copying files is only half of that — see recordGrailInstalled.
  log(`Grail staged at ${dest}`);
}

/**
 * Record that the staged Grail is now filed into the database.
 *
 * Kept separate from staging, and written only after the install succeeds,
 * because the two can come apart: an install that dies partway leaves a
 * complete copy on disk and nothing usable in the database. Stamping at copy
 * time made that failure look like success — `isInstalled()` returned true and
 * the extension offered a REPL against a database with no Python in it.
 */
export function recordGrailInstalled(extensionPath: string): void {
  const stamp = bundledGrailStamp(extensionPath);
  if (!stamp) return;
  fs.writeFileSync(grailStampPath(), `${stamp}\n`);
}

function listShellScripts(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.sh')) found.push(full);
    }
  };
  walk(dir);
  return found;
}

/**
 * File Grail into the running database.
 *
 * The database must already be running: every step logs in. Output is streamed
 * to the GemDB log because this takes a few minutes and silence for that long
 * reads as a hang.
 */
export function installGrail(
  extensionPath: string,
  progress: vscode.Progress<{ message?: string }>,
): Promise<void> {
  logStep('Installing Grail into the database');
  const installer = path.join(extensionPath, 'resources', 'install-grail.sh');
  const env = {
    ...process.env,
    ...engineEnvironment(),
    GEMDB_STONE: STONE_NAME,
    GEMDB_USER: DB_USER,
    GEMDB_PASSWORD: DB_PASSWORD,
  };

  return new Promise((resolve, reject) => {
    // Invoked through bash explicitly, so a lost executable bit on the
    // extension's own resources cannot break the install either.
    const child = spawn('bash', [installer], { env, cwd: grailPath() });
    let tail = '';

    const collect = (data: Buffer): void => {
      const text = data.toString();
      tail = (tail + text).slice(-4000);
      log(text.trimEnd());
      // Grail's install prints a running commentary of what it is filing in;
      // the most recent line is a better progress message than a spinner.
      const lastLine = text.trim().split('\n').filter(Boolean).pop();
      if (lastLine) progress.report({ message: truncate(lastLine, 80) });
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);

    child.on('close', (code) => {
      if (code === 0) {
        log('Grail installed');
        // Any session open right now logged in before Grail existed, and a
        // GemStone session sees the repository as of its last transaction
        // boundary — so it would go on reporting "Python support is not
        // installed" against a database where it plainly is. Dropping it here
        // rather than at the call sites means no future caller can forget:
        // the next use logs in fresh and sees what the installer committed.
        logout();
        resolve();
        return;
      }
      reject(
        new Error(
          `Installing Python support failed (exit code ${code}). See the GemDB output for the full log.\n` +
            tail.trim().split('\n').slice(-8).join('\n'),
        ),
      );
    });
    child.on('error', (err) =>
      reject(new Error(`Installing Python support failed: ${err.message}`)),
    );
  });
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
