import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { errorMessage, log } from './log';

/**
 * Clone the Brain Freeze demo — a Flask application that lives in the
 * database.
 *
 * The demo is its own public repository rather than a directory here, per its
 * own PRD, so the only thing GemDB can offer is the clone. That is also why
 * this command exists at all: the alternative is a README line the user has to
 * copy a URL out of.
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

const OPEN = 'Open';
const OPEN_NEW = 'Open in New Window';

export interface CloneWorld {
  /**
   * Ask which folder to clone into, answering undefined if the user dismissed
   * the dialog.
   *
   * The dialog is the consent: a clone is persistent and outside the root
   * path, which by GemDB's automation line is something to ask about rather
   * than do. Asking *where* is a better question than asking *whether* —
   * it cannot be answered wrong, and the user has already said whether by
   * running the command.
   */
  pickParent: () => Promise<string | undefined>;
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
  /** Ask a question with named buttons, answering undefined if dismissed. */
  ask: (message: string, ...choices: string[]) => Promise<string | undefined>;
  reportError: (message: string) => void;
  openFolder: (target: string, newWindow: boolean) => Promise<void>;
  log: (message: string) => void;
}

/**
 * The decision half of the command: where it goes, what happens if something
 * is already there, and what a failed or cancelled clone leaves behind.
 */
export async function runCloneDemo(world: CloneWorld): Promise<void> {
  const parent = await world.pickParent();
  if (!parent) return;

  const target = path.join(parent, BRAIN_FREEZE_DIR);

  // Never clobber what is there. A second run of this command is most likely
  // someone who wants the demo they already have, and the directory may hold
  // their own commits — so this offers to open it and stops. Repairing a
  // broken clone is `rm -rf` in a terminal, which is a thing a user can do
  // deliberately and GemDB should not do on a guess.
  if (world.exists(target)) {
    world.log(`Brain Freeze is already at ${target}.`);
    const answer = await world.ask(
      `${BRAIN_FREEZE_DIR} already exists in this folder.`,
      OPEN,
      OPEN_NEW,
    );
    if (answer) await world.openFolder(target, answer === OPEN_NEW);
    return;
  }

  world.log(`Cloning ${BRAIN_FREEZE_URL} into ${target}`);
  let outcome: 'cloned' | 'cancelled';
  try {
    outcome = await world.clone(BRAIN_FREEZE_URL, target);
  } catch (e) {
    // git removes its own half-finished clone when it fails on its own, but a
    // killed git does not — and the leftover would meet the branch above on
    // the next run, which offers to open it as though it were a working
    // checkout. So the partial goes, and only ever the directory this call
    // just created: the existence check above is what makes that safe.
    world.discard(target);
    world.reportError(`GemDB could not clone Brain Freeze: ${errorMessage(e)}`);
    return;
  }

  if (outcome === 'cancelled') {
    world.discard(target);
    world.log('Cloning Brain Freeze was cancelled.');
    return;
  }

  world.log(`Cloned Brain Freeze into ${target}`);
  // Opening in this window replaces the workspace and restarts the extension
  // host, which is too much to do to someone without asking — hence a
  // question rather than an `openFolder` the moment the clone lands.
  const answer = await world.ask(`Cloned Brain Freeze into ${target}.`, OPEN, OPEN_NEW);
  if (answer) await world.openFolder(target, answer === OPEN_NEW);
}

/** Run `git clone` under a cancellable progress notification. */
async function cloneWithGit(url: string, target: string): Promise<'cloned' | 'cancelled'> {
  // `withProgress` answers a Thenable, and the CloneWorld contract is a
  // Promise: awaiting here is what converts one to the other.
  return await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Cloning the Brain Freeze demo…',
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
    pickParent: async () => {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Clone Here',
        title: 'Choose a folder to clone the Brain Freeze demo into',
      });
      return picked?.[0]?.fsPath;
    },
    exists: (target) => fs.existsSync(target),
    clone: cloneWithGit,
    discard: (target) => {
      // Belt and braces around a recursive delete: the caller only ever passes
      // a path it created, and this refuses anything not named for the demo.
      if (path.basename(target) !== BRAIN_FREEZE_DIR) return;
      fs.rmSync(target, { recursive: true, force: true });
    },
    ask: (message, ...choices) =>
      Promise.resolve(vscode.window.showInformationMessage(message, ...choices)),
    reportError: (message) => void vscode.window.showErrorMessage(message),
    openFolder: async (target, newWindow) => {
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target), {
        forceNewWindow: newWindow,
      });
    },
    log,
  });
}
