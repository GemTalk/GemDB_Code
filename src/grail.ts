import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import * as vscode from 'vscode';
import { dbPassword, dbUser, rootPath, stoneName } from './config';
import { platformKey, sharedLibraryExtension } from './platform';
import { errorMessage, log, logStep } from './log';
import { engineEnvironment, shimLibraryPath } from './processes';
import {
  grailFailurePath,
  grailPath,
  grailStampPath,
  installedGrailStamp,
  grailStagedByPath,
  removeGrailStamps,
  stagedGrailStamp,
} from './paths';
import { STAMP_ORDER, StampOrder, compareStamps, parseStamp, stampFor } from './stamps';
import { logoutAll } from './session';
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

/**
 * How the Grail filed into the database compares with this extension's, or
 * undefined when this build ships none.
 */
export function installedGrailOrder(extensionPath: string): StampOrder | undefined {
  const bundled = bundledGrailStamp(extensionPath);
  if (!bundled) return undefined;
  return compareStamps(installedGrailStamp(), stampFor(extensionPath, bundled));
}

/**
 * True when the Grail in the database should be replaced by this extension's.
 *
 * Not merely "different": one filed in by a newer GemDB, from another editor
 * on the same root path, is left where it is (`stamps.ts`).
 */
export function grailNeedsUpdate(extensionPath: string): boolean {
  const order = installedGrailOrder(extensionPath); // undefined: nothing to stage; reported separately
  return order === STAMP_ORDER.older || order === STAMP_ORDER.sameVersionDifferent;
}

/** A Grail a newer GemDB put in place, which this one must leave alone. */
export interface NewerGrail {
  /** Filed into the database, or only staged on disk so far. */
  where: 'installed' | 'staged';
  /** The GemDB that did it, as its stamp records. */
  version: string | undefined;
}

/**
 * The Grail a newer GemDB filed in or staged, if there is one.
 *
 * Both count. Filed in, replacing it would downgrade the database; staged
 * only, a newer GemDB is about to file it in, and replacing the files under
 * it would hand its install an older payload.
 */
export function newerGrail(extensionPath: string): NewerGrail | undefined {
  const bundled = bundledGrailStamp(extensionPath);
  if (!bundled) return undefined;
  const ours = stampFor(extensionPath, bundled);
  const records: [NewerGrail['where'], string | undefined][] = [
    ['installed', installedGrailStamp()],
    ['staged', stagedGrailStamp()],
  ];
  for (const [where, record] of records) {
    if (record !== undefined && compareStamps(record, ours) === STAMP_ORDER.newer) {
      return { where, version: parseStamp(record).extension };
    }
  }
  return undefined;
}

/**
 * Copy the bundled Grail to the root path, together with the prebuilt CPython
 * shim for this platform. Replaces any previously staged copy wholesale — a
 * partial overlay of one Grail on another is not a state worth supporting.
 *
 * Unless a newer GemDB staged or filed in the one there (`newerGrail`): then
 * nothing is touched, and this returns false.
 */
export function stageGrail(extensionPath: string): boolean {
  const source = path.join(extensionPath, 'grail');
  const stamp = bundledGrailStamp(extensionPath);
  if (!stamp) {
    throw new Error(
      'This build of GemDB ships no Python payload, so Python cannot be installed. ' +
        'Run "npm run bundle:grail" before packaging the extension.',
    );
  }

  const newer = newerGrail(extensionPath);
  if (newer) {
    log(
      `Skipped staging Grail: GemDB ${newer.version ?? 'unknown'} ` +
        (newer.where === 'installed' ? 'filed a newer one in.' : 'staged a newer one.'),
    );
    return false;
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
  // What is recorded is who staged it, and last, once the copy is complete.
  fs.writeFileSync(grailStagedByPath(), `${stampFor(extensionPath, stamp)}\n`);
  log(`Grail staged at ${dest}`);
  return true;
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
  // The database directory exists for GemDB's own database, but not for an
  // external one, whose extent is elsewhere; the stamp still lives here.
  fs.mkdirSync(path.dirname(grailStampPath()), { recursive: true });
  fs.writeFileSync(grailStampPath(), `${stampFor(extensionPath, stamp)}\n`);
  fs.rmSync(grailFailurePath(), { force: true });
}

/** What the status view needs to say that filing Grail in failed. */
export interface GrailInstallFailure {
  /** The bundled build that failed, or null when the build shipped none. */
  stamp: string | null;
  /** When, as an ISO timestamp. */
  at: string;
  /** The error, as the notification showed it. */
  message: string;
}

const installAttempts = new vscode.EventEmitter<void>();

/**
 * Fires after every attempt to file Grail in, whichever way it went. The
 * status view listens, because most attempts are not a command the view
 * could refresh after: a notebook's first cell reaches `ensureRunning`
 * directly.
 */
export const onDidAttemptGrailInstall = installAttempts.event;

/**
 * Stage Grail, file it into the running database, and record the outcome —
 * the stamp on success, a failure record otherwise.
 *
 * The one path both callers take, so neither can forget the failure record:
 * without it the status view read a failed install as a fresh one ("installs
 * when you first run Python"), since the stamp is already gone by then.
 *
 * The stamps are removed just before the installer runs, so that one which
 * dies partway reads as "not filed in" rather than as whatever was there
 * before. Both of them: a legacy stamp left behind would be read in its place.
 *
 * Returns false, having changed nothing, when a newer GemDB staged or filed in
 * the Grail already there.
 */
export async function fileInGrail(
  extensionPath: string,
  progress: vscode.Progress<{ message?: string }>,
): Promise<boolean> {
  try {
    if (!stageGrail(extensionPath)) {
      log('Skipped filing Grail in: a newer GemDB manages it.');
      return false;
    }
    removeGrailStamps();
    await installGrail(extensionPath, progress);
    recordGrailInstalled(extensionPath);
    return true;
  } catch (e) {
    recordGrailFailed(extensionPath, e);
    throw e;
  } finally {
    installAttempts.fire();
  }
}

function recordGrailFailed(extensionPath: string, e: unknown): void {
  const failure: GrailInstallFailure = {
    stamp: bundledGrailStamp(extensionPath) ?? null,
    at: new Date().toISOString(),
    message: errorMessage(e),
  };
  try {
    // The database directory exists for GemDB's own database, but not for an
    // external one, whose extent is elsewhere; the record still lives here.
    fs.mkdirSync(path.dirname(grailFailurePath()), { recursive: true });
    fs.writeFileSync(grailFailurePath(), `${JSON.stringify(failure)}\n`);
  } catch (w) {
    // The failure itself is already on its way to a notification; losing the
    // record only costs the status view its warning.
    log(`Could not record the failed Python install: ${errorMessage(w)}`);
  }
}

/**
 * The failed install of the Grail this extension ships, if one is on record.
 *
 * A record for a different build is ignored: an update that ships a fixed
 * payload has not failed yet, and saying it had would be the stale warning
 * this record exists to replace.
 */
export function grailInstallFailure(extensionPath: string): GrailInstallFailure | undefined {
  let failure: GrailInstallFailure;
  try {
    failure = JSON.parse(fs.readFileSync(grailFailurePath(), 'utf8')) as GrailInstallFailure;
  } catch {
    return undefined;
  }
  return failure.stamp === (bundledGrailStamp(extensionPath) ?? null) ? failure : undefined;
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
    GEMDB_STONE: stoneName(),
    GEMDB_USER: dbUser(),
    GEMDB_PASSWORD: dbPassword(),
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
        // installed" against a database where it plainly is. Every session,
        // not just the extension's own: each open notebook holds one, and each
        // would carry the same stale view. Dropping them here rather than at
        // the call sites means no future caller can forget; the next use logs
        // in fresh and sees what the installer committed.
        logoutAll();
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
