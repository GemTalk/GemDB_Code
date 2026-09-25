import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { rootPath } from './config';
import { errorMessage, log } from './log';

/**
 * Install the Brain Freeze demo — a Flask application that lives in the
 * database — and put its README in front of the user.
 *
 * The demo is its own public repository rather than a directory here, per its
 * own PRD, so "install" means a clone. That is also why this command exists at
 * all: the alternative is a README line the user has to copy a URL out of.
 *
 * It asks nothing. The clone lands under the root path, beside the engine and
 * the database, which puts it on the automated side of GemDB's line: inert,
 * and undone by deleting a directory GemDB already told the user it owns. It
 * used to ask where to clone, when the answer could be anywhere on disk; with
 * the location fixed there is no question left whose answer changes anything.
 *
 * Nothing here touches the database. Cloning is inert, the demo's own README
 * owns its setup, and a user who is only browsing the code should not have a
 * stone started on their behalf — so this deliberately does not call
 * `ensureRunning`. The first notebook cell or `gemdb` run inside the clone
 * goes through it in the usual way.
 */
export const BRAIN_FREEZE_URL = 'https://github.com/GemTalk/brain-freeze.git';

/** The directory `git clone` creates, and the only name this file will delete. */
export const BRAIN_FREEZE_DIR = 'brain-freeze';

/** Where the demo is installed: under the root path, so it moves with the setting. */
export function brainFreezePath(root = rootPath()): string {
  return path.join(root, BRAIN_FREEZE_DIR);
}

export interface CloneWorld {
  /** Where the clone goes. */
  target: string;
  exists: (target: string) => boolean;
  /**
   * Run the clone, resolving `'cancelled'` if the user cancelled it.
   *
   * A cancellation is not a failure and must not be reported as one, so it
   * travels as a value; a rejection here means git could not do it.
   */
  clone: (url: string, target: string) => Promise<'cloned' | 'cancelled'>;
  /** Remove a partial clone this operation created, and nothing else. */
  discard: (target: string) => void;
  reportError: (message: string) => void;
  /** The folders open in this window, empty for an empty window. */
  openFolders: () => string[];
  /** Show the demo's README here, in this window. */
  showReadme: (target: string) => Promise<void>;
  /** Leave word for the window about to open `target` to show its README. */
  promiseReadme: (target: string) => void;
  openFolder: (target: string, newWindow: boolean) => Promise<void>;
  log: (message: string) => void;
}

/**
 * The decision half of the command: what happens if the demo is already
 * there, what a failed or cancelled clone leaves behind, and which window it
 * opens in.
 */
export async function runCloneDemo(world: CloneWorld): Promise<void> {
  const { target } = world;

  // Never clobber what is there. A second run of this command is most likely
  // someone who wants the demo they already have, and the directory may hold
  // their own commits — so this opens it and stops. Repairing a broken clone
  // is `rm -rf` in a terminal, which is a thing a user can do deliberately and
  // GemDB should not do on a guess.
  if (world.exists(target)) {
    world.log(`Brain Freeze is already at ${target}.`);
    await openDemo(world);
    return;
  }

  world.log(`Cloning ${BRAIN_FREEZE_URL} into ${target}`);
  let outcome: 'cloned' | 'cancelled';
  try {
    outcome = await world.clone(BRAIN_FREEZE_URL, target);
  } catch (e) {
    // git removes its own half-finished clone when it fails on its own, but a
    // killed git does not — and the leftover would meet the branch above on
    // the next run, which opens it as though it were a working checkout. So
    // the partial goes, and only ever the directory this call just created:
    // the existence check above is what makes that safe.
    world.discard(target);
    world.reportError(`GemDB could not install Brain Freeze: ${errorMessage(e)}`);
    return;
  }

  if (outcome === 'cancelled') {
    world.discard(target);
    world.log('Installing Brain Freeze was cancelled.');
    return;
  }

  world.log(`Cloned Brain Freeze into ${target}`);
  await openDemo(world);
}

/**
 * Open the demo without asking which window.
 *
 * Opening a folder in this window replaces the workspace and restarts the
 * extension host, which is too much to do to someone mid-task — but an empty
 * window has no task to interrupt, and a new window takes nothing away that
 * closing it does not give back. So the window decides: an empty one is
 * reused, one with folders open is left alone and the demo gets a window of
 * its own. VS Code's own save prompt covers unsaved editors either way.
 */
async function openDemo(world: CloneWorld): Promise<void> {
  const { target } = world;
  const folders = world.openFolders().map((f) => path.resolve(f));
  // Already open here (on its own or in a multi-root workspace): opening it
  // again would do nothing visible, so the README is the whole answer.
  if (folders.includes(path.resolve(target))) {
    await world.showReadme(target);
    return;
  }
  // Code after `openFolder` never runs in the window that shows the folder —
  // that is a restarted extension host, or another one entirely — so the
  // README is left as a note for whichever activation finds it.
  world.promiseReadme(target);
  await world.openFolder(target, folders.length > 0);
}

/**
 * How long a promised README stays promised.
 *
 * The window that opens the demo activates GemDB within seconds, trusted or
 * not — GemDB runs in Restricted Mode, and a fresh clone opens in it by
 * default — so this only has to outlast a slow start. What it guards against
 * is a note left by a window that never got there (closed, crashed) opening a
 * README on some unrelated visit to the folder later.
 */
export const README_PROMISE_MS = 10 * 60 * 1000;

let pendingPath: string | undefined;

/**
 * Called once at activation, with the extension's global storage directory.
 *
 * A file there rather than `globalState`, for the reasons `autoStart.ts` gives
 * — it is per-machine, since the clone is — and one more: the note is written
 * by one window and read by another, and a file is visible to the other the
 * moment it is written.
 */
export function initPendingReadme(storageDir: string): void {
  pendingPath = path.join(storageDir, 'pending-demo-readme');
}

function promiseReadme(target: string): void {
  if (!pendingPath) return;
  try {
    fs.mkdirSync(path.dirname(pendingPath), { recursive: true });
    fs.writeFileSync(pendingPath, target);
  } catch {
    /* worst case the folder opens and the README does not */
  }
}

/**
 * The README a window with `folders` open was promised, if any, clearing the
 * promise when it is kept or has expired.
 *
 * A note for a folder this window does not have is left alone: it may be for
 * a window that is still starting, and this window taking it would leave that
 * one with nothing.
 */
export function takePromisedReadme(folders: string[], now = Date.now()): string | undefined {
  if (!pendingPath) return undefined;
  let target: string;
  let writtenAt: number;
  try {
    target = fs.readFileSync(pendingPath, 'utf8');
    writtenAt = fs.statSync(pendingPath).mtimeMs;
  } catch {
    return undefined;
  }
  if (now - writtenAt > README_PROMISE_MS) {
    fs.rmSync(pendingPath, { force: true });
    return undefined;
  }
  if (!folders.map((f) => path.resolve(f)).includes(path.resolve(target))) return undefined;
  fs.rmSync(pendingPath, { force: true });
  return target;
}

/**
 * Open the demo's README rendered, which is how a walkthrough reads.
 *
 * This works in Restricted Mode, which is where a fresh clone opens, so the
 * README is there before any question about trust is. That question comes
 * from VS Code itself, the first time the user runs a cell or opens a
 * terminal, which is the moment it is about something.
 */
async function showReadme(target: string): Promise<void> {
  const readme = path.join(target, 'README.md');
  if (!fs.existsSync(readme)) return;
  await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(readme));
}

function openFolderPaths(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
}

/** Keep a promise an earlier window made to this one, if it made one. */
export async function showPromisedReadme(): Promise<void> {
  const target = takePromisedReadme(openFolderPaths());
  if (target) await showReadme(target);
}

/** Run `git clone` under a cancellable progress notification. */
async function cloneWithGit(url: string, target: string): Promise<'cloned' | 'cancelled'> {
  // The root path exists once GemDB is set up, but this command does not need
  // GemDB set up — someone can read the demo before downloading an engine.
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // `withProgress` answers a Thenable, and the CloneWorld contract is a
  // Promise: awaiting here is what converts one to the other.
  return await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Installing the Brain Freeze demo…',
      cancellable: true,
    },
    (_progress, token) =>
      new Promise<'cloned' | 'cancelled'>((resolve, reject) => {
        // Full history, not `--depth 1`: this is a repository the user is going
        // to read and work in, unlike the payload clones in scripts/, where a
        // shallow fetch is of a build input nobody keeps.
        const git = spawn('git', ['clone', url, target], { stdio: ['ignore', 'pipe', 'pipe'] });
        let cancelled = false;
        // git reports progress on stderr, and it is the only account of a slow
        // clone anyone gets — the progress notification cannot show it.
        git.stderr.on('data', (chunk: Buffer) => log(chunk.toString().trimEnd()));
        git.stdout.on('data', (chunk: Buffer) => log(chunk.toString().trimEnd()));

        token.onCancellationRequested(() => {
          cancelled = true;
          git.kill();
        });

        // ENOENT for a missing git arrives here, not as a non-zero exit.
        git.on('error', (e) => reject(e));
        git.on('close', (code) => {
          if (cancelled) resolve('cancelled');
          else if (code === 0) resolve('cloned');
          else reject(new Error(`git clone exited ${String(code)}. See the GemDB log.`));
        });
      }),
  );
}

/** The command VS Code registers: `runCloneDemo` against the real editor. */
export function cloneBrainFreeze(): Promise<void> {
  return runCloneDemo({
    target: brainFreezePath(),
    exists: (target) => fs.existsSync(target),
    clone: cloneWithGit,
    discard: (target) => {
      // Belt and braces around a recursive delete: the caller only ever passes
      // a path it created, and this refuses anything not named for the demo.
      if (path.basename(target) !== BRAIN_FREEZE_DIR) return;
      fs.rmSync(target, { recursive: true, force: true });
    },
    reportError: (message) => void vscode.window.showErrorMessage(message),
    openFolders: openFolderPaths,
    showReadme,
    promiseReadme,
    openFolder: async (target, newWindow) => {
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target), {
        forceNewWindow: newWindow,
      });
    },
    log,
  });
}
