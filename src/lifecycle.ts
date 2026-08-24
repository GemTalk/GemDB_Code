import * as fs from 'fs';
import * as vscode from 'vscode';
import { engineVersion, reinstallPythonOnUpdate, rootPath } from './config';
import { cliPath, writeCliScripts } from './cli';
import { createDatabase, removeDatabase } from './database';
import { Progress, installEngine, removeEngine } from './engine';
import {
  grailLabel,
  grailNeedsUpdate,
  recordGrailInstalled,
  stageAndRecordGrail,
  installGrail,
  stageGrail,
  bundledGrailStamp,
} from './grail';
import { errorMessage, log, logStep, showLog } from './log';
import { ensureOsConfigured } from './osConfig';
import {
  databaseExists,
  databasePath,
  enginePath,
  grailInstalled,
  grailPath,
  grailStagedOnDisk,
} from './paths';
import {
  findNetldi,
  findStone,
  isListening,
  isRunning,
  listProcesses,
  startNetldi,
  startStone,
  stopNetldi,
  stopStone,
} from './processes';
import { isSupportedPlatform } from './platform';
import { logoutAll } from './session';
import { allowAutoStart } from './autoStart';

/** Guard every entry point with one clear message rather than a stack trace. */
function requireSupportedPlatform(): boolean {
  if (isSupportedPlatform()) return true;
  void vscode.window.showErrorMessage(
    'GemDB runs on macOS with Apple Silicon. Intel Macs, Linux, and Windows are planned ' +
      'but not available yet.',
  );
  return false;
}

/**
 * True once everything GemDB needs is on disk.
 *
 * Deliberately does NOT require Grail to be filed into the database. Filing it
 * in needs a running database, and starting one is the step GemDB will not take
 * without the user asking — so "the files are ready" and "Python works" are
 * genuinely different states. The gap is closed on first use, by `ensureRunning`.
 */
export function isInstalled(): boolean {
  return enginePath() !== undefined && databaseExists() && grailStagedOnDisk();
}

/**
 * Everything that can be done without touching the machine or the user.
 *
 * Downloads the engine, unpacks it, creates the database, and stages Grail —
 * all of it confined to the root path and undone by deleting that directory.
 * Nothing here prompts, and nothing here starts a process, which is what makes
 * it safe to run unattended when the extension first activates.
 *
 * Every step is skipped if already done, so a cancelled run resumes rather than
 * starting over.
 */
async function prepareFiles(
  extensionPath: string,
  progress: Progress,
  token: vscode.CancellationToken,
): Promise<void> {
  const engine = await installEngine(progress, token);
  if (token.isCancellationRequested) return;

  progress.report({ message: 'Creating your database…' });
  const database = createDatabase(engine, extensionPath);

  // Stage Grail, then — only if this run made the database from the shipped
  // extent — record that it is already filed in, saving the several minutes
  // `ensureRunning` would otherwise spend filing it in on first use. The order
  // matters and the reasons are in stageAndRecordGrail; so does the condition,
  // which asks what this call did rather than what the extension ships, since
  // an upgrade finds a database carrying whatever Grail it was built with.
  progress.report({ message: 'Preparing Python support…' });
  stageAndRecordGrail(extensionPath, database.created && database.preloaded);
}

/** Guard against a build that forgot to run `npm run bundle:grail`. */
function requireGrailPayload(extensionPath: string): boolean {
  if (bundledGrailStamp(extensionPath)) return true;
  void vscode.window.showErrorMessage(
    'This build of GemDB ships no Python payload, so it cannot install Python support. ' +
      'This is a packaging fault — please report it.',
  );
  return false;
}

/**
 * The explicit "Install GemDB" command.
 *
 * Takes the whole thing to a working state, including starting the database and
 * filing Grail into it, because the user asked for exactly that and is sitting
 * there waiting. The unattended path (`prepare`) stops short of the parts that
 * need consent.
 */
export async function install(extensionPath: string): Promise<void> {
  if (!requireSupportedPlatform()) return;
  if (!requireGrailPayload(extensionPath)) return;

  if (isInstalled() && grailInstalled()) {
    const choice = await vscode.window.showInformationMessage(
      `GemDB is already installed at ${rootPath()}.`,
      'Start GemDB',
      'Show Log',
    );
    if (choice === 'Start GemDB') await start(extensionPath);
    else if (choice === 'Show Log') showLog();
    return;
  }

  const prepared = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Installing GemDB',
      cancellable: true,
    },
    async (progress, token) => {
      try {
        await prepareFiles(extensionPath, progress, token);
        return !token.isCancellationRequested;
      } catch (e) {
        reportFailure('Installing GemDB', e);
        return false;
      }
    },
  );
  if (!prepared) return;

  // Starting is a separate act, and it is where consent is asked for: raising
  // shared memory needs sudo, and the processes it starts outlive the editor.
  if (!(await ensureRunning(extensionPath))) return;

  void vscode.window
    .showInformationMessage(
      'GemDB is ready. Python now runs inside your database.',
      'Open GemDB Shell',
      'New Notebook',
    )
    .then((choice) => {
      if (choice === 'Open GemDB Shell') void vscode.commands.executeCommand('gemdb.openRepl');
      else if (choice === 'New Notebook') void vscode.commands.executeCommand('gemdb.newNotebook');
    });
}

/**
 * The unattended preparation run when the extension first activates.
 *
 * Does the inert work and stops. Returns false when the user cancelled, which
 * the caller records so it is never retried unasked — a cancel here is a
 * decision, not a hiccup, and the partly-downloaded archive is kept so that
 * choosing to continue later costs only the remaining bytes.
 */
export async function prepare(extensionPath: string): Promise<boolean> {
  if (!isSupportedPlatform() || !bundledGrailStamp(extensionPath)) return false;

  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Setting up GemDB',
      cancellable: true,
    },
    async (progress, token) => {
      // Cancelling reaches here two ways: the download throws, or a step
      // between downloads notices the token and returns. Both are the same
      // decision and get the same acknowledgement.
      //
      // It has to be a notification rather than a log line. Pressing Cancel
      // dismisses the progress notification, and without something in its place
      // GemDB simply goes quiet — from the outside, indistinguishable from
      // having given up. Shown once, at the moment of the decision, which keeps
      // it consistent with the setup-attempted marker: a cancel is answered,
      // not re-asked on every activation.
      const paused = (): false => {
        log('Setup paused. It will resume where it stopped when you next start GemDB.');
        void vscode.window
          .showInformationMessage(
            'Setup paused. Nothing is lost — GemDB picks up where it stopped whenever you are ready.',
            'Resume',
          )
          .then((choice) => {
            if (choice === 'Resume') void vscode.commands.executeCommand('gemdb.install');
          });
        return false;
      };

      try {
        progress.report({ message: 'Downloading the database engine…' });
        await prepareFiles(extensionPath, progress, token);
        if (token.isCancellationRequested) return paused();
        log('GemDB is ready to start.');
        return true;
      } catch (e) {
        if (errorMessage(e) === 'Download cancelled') return paused();
        reportFailure('Setting up GemDB', e);
        return false;
      }
    },
  );
}

/** Log a failure and offer the log, in the one shape every step uses. */
function reportFailure(what: string, e: unknown): void {
  log(`\n${what} failed: ${errorMessage(e)}`);
  void vscode.window
    .showErrorMessage(`${what} failed: ${errorMessage(e)}`, 'Show Log')
    .then((choice) => {
      if (choice === 'Show Log') showLog();
    });
}

/** The explicit "Start GemDB" command. */
export async function start(extensionPath: string): Promise<void> {
  if (!requireSupportedPlatform()) return;
  await ensureRunning(extensionPath);
}

/**
 * Bring the database up, doing whatever is still outstanding to get there.
 *
 * This is the single path to a running database, whether the user pressed Start
 * or simply ran a line of Python.
 *
 * It may prompt for shared memory, but in the ordinary case it will not have
 * to: first-run setup already asked, back when the user was watching GemDB
 * install itself. This is the backstop for the cases where that did not stick —
 * setup was declined, the machine was reconfigured since, or the extension was
 * pointed at a new root path — and here the prompt is justified because the
 * user has asked for something that cannot happen without it.
 *
 * Returns true when the database is up and Python will run.
 */
export async function ensureRunning(extensionPath: string): Promise<boolean> {
  // Asking for a running database is the clearest possible retraction of an
  // earlier "stop it". Running a cell counts: `ensureRunning` is the one path
  // to a running database, so it is the one place this belongs.
  allowAutoStart();
  if (!requireSupportedPlatform()) return false;
  if (!requireGrailPayload(extensionPath)) return false;

  // Files may still be missing if the automatic preparation was cancelled, or
  // never ran. Finishing it here is what lets a cancel be a pause: the download
  // picks up from the bytes already on disk.
  if (!isInstalled()) {
    const prepared = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Setting up GemDB',
        cancellable: true,
      },
      async (progress, token) => {
        try {
          await prepareFiles(extensionPath, progress, token);
          return !token.isCancellationRequested;
        } catch (e) {
          if (errorMessage(e) === 'Download cancelled') return false;
          reportFailure('Setting up GemDB', e);
          return false;
        }
      },
    );
    if (!prepared || !isInstalled()) return false;
  }

  // The shell command is normally written when Grail is staged, but an
  // install that predates it never runs that staging again — the payload on
  // disk already matches. Backstop it here, on the single path everything
  // that needs a database goes through.
  if (!fs.existsSync(cliPath())) {
    try {
      writeCliScripts(extensionPath);
    } catch (e) {
      log(`Could not write the gemdb command: ${errorMessage(e)}`);
    }
  }

  if (!(await ensureOsConfigured(extensionPath))) return false;

  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Starting GemDB' },
    async (progress) => {
      try {
        await startProcesses(progress);

        // Grail is filed in here rather than during preparation because it
        // needs a running database. The same branch covers the first install
        // and an extension update that ships a newer Grail — in both cases the
        // build on disk differs from the one recorded in the database.
        const firstTime = !grailInstalled();
        if (grailNeedsUpdate(extensionPath) && (firstTime || reinstallPythonOnUpdate())) {
          const stamp = bundledGrailStamp(extensionPath);
          log(
            firstTime
              ? `Installing Python support ${grailLabel(stamp)} into the database.`
              : `This GemDB update ships Python support ${grailLabel(stamp)}; refreshing the database copy.`,
          );
          progress.report({
            message: firstTime ? 'Installing Python support…' : 'Updating Python support…',
          });
          stageGrail(extensionPath);
          await installGrail(extensionPath, progress);
          recordGrailInstalled(extensionPath);
        }
        return true;
      } catch (e) {
        reportFailure('Starting GemDB', e);
        return false;
      }
    },
  );
}

/** Start whichever of the two processes is not already up. */
async function startProcesses(progress?: vscode.Progress<{ message?: string }>): Promise<void> {
  const running = listProcesses();
  if (!findStone(running)) {
    progress?.report({ message: 'Starting the database…' });
    await startStone();
  } else {
    log('The database is already running.');
  }
  if (!findNetldi(running)) {
    progress?.report({ message: 'Starting the session listener…' });
    await startNetldi();
  } else {
    log('The session listener is already running.');
  }
}

/**
 * Everything `stop` decides, with the world passed in.
 *
 * Stopping is the one operation here with a branch worth testing: a stone that
 * refuses to stop, a question, and a second attempt that overrides it. Taking
 * its collaborators as arguments is what lets that branch be exercised without
 * a database, an editor, or a `gslist` on the path.
 */
export interface StopWorld {
  /** Drop GemDB's own GCI session. It is a login like any other, and stopstone counts it. */
  logout: () => void;
  stoneUp: () => boolean;
  listenerUp: () => boolean;
  stopStone: (force: boolean) => Promise<void>;
  stopNetldi: () => Promise<void>;
  startNetldi: () => Promise<void>;
  /** Ask whether to disconnect the sessions that are in the way. */
  confirmForce: (reason: string) => Promise<boolean>;
  log: (message: string) => void;
}

export async function runStop(world: StopWorld): Promise<void> {
  // Ours goes first. A notebook that has run a cell leaves a session open, and
  // stopstone will refuse on account of it — GemDB blocking its own shutdown.
  world.logout();

  // Then the listener, so nothing new can connect to a database on its way
  // down. This is also why a refusal below has to be repaired: at that point
  // the listener is already gone.
  if (world.listenerUp()) await world.stopNetldi();

  if (!world.stoneUp()) {
    world.log('GemDB stopped.');
    return;
  }

  try {
    await world.stopStone(false);
    world.log('GemDB stopped.');
    return;
  } catch (e) {
    const reason = errorMessage(e);
    world.log(`\nStop failed: ${reason}`);

    // A timeout is stopstone giving up on waiting, not the stone refusing to
    // go — the shutdown was already asked for and may have landed a moment
    // later. Look before accusing it, or we offer to force-stop a database
    // that is already down.
    if (!world.stoneUp()) {
      world.log('GemDB stopped.');
      return;
    }

    if (!(await world.confirmForce(reason))) {
      // Declining means "leave it running", and a running database with no
      // listener accepts no new sessions — so put back what we stopped on the
      // way in rather than leaving a half-stopped machine behind.
      if (!world.listenerUp()) await world.startNetldi();
      world.log('GemDB is still running.');
      return;
    }
  }

  await world.stopStone(true);
  world.log('GemDB stopped, disconnecting the sessions that were still logged in.');
}

/** Stop the database, overriding logged-in sessions only if the user says so. */
export async function stop(): Promise<void> {
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Stopping GemDB' },
    async () => {
      try {
        await runStop({
          // Every session this window holds: the notebooks' and each REPL's.
          // All of them are logins stopstone would refuse over.
          logout: logoutAll,
          stoneUp: () => isRunning(),
          listenerUp: () => isListening(),
          stopStone,
          stopNetldi,
          startNetldi,
          confirmForce,
          log,
        });
      } catch (e) {
        log(`\nStop failed: ${errorMessage(e)}`);
        void vscode.window
          .showErrorMessage(`Stopping GemDB failed: ${errorMessage(e)}`, 'Show Log')
          .then((choice) => {
            if (choice === 'Show Log') showLog();
          });
      }
    },
  );
}

/**
 * Ask before disconnecting sessions that did not ask to be disconnected.
 *
 * Modal, because the alternative is a notification behind the progress toast
 * that expires unanswered and leaves the database running when the user
 * believes they stopped it.
 */
async function confirmForce(reason: string): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    `GemDB did not stop:\n\n${reason}\n\n` +
      'This is usually a session that is still logged in — an open GemDB Shell terminal ' +
      'counts as one, and so does a notebook in another window.\n\n' +
      'Stopping anyway disconnects every session. Work that has not been committed is lost.',
    { modal: true },
    'Stop Anyway',
  );
  return choice === 'Stop Anyway';
}

/** Reinstall Grail into the running database, on request. */
export async function reinstallGrail(extensionPath: string): Promise<void> {
  if (!isInstalled()) {
    void vscode.window.showErrorMessage('GemDB is not installed yet.');
    return;
  }
  if (!findStone()) {
    void vscode.window.showErrorMessage(
      'Start GemDB first — installing Python support needs a running database.',
    );
    return;
  }
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Reinstalling Python support' },
    async (progress) => {
      try {
        stageGrail(extensionPath);
        await installGrail(extensionPath, progress);
        recordGrailInstalled(extensionPath);
        void vscode.window.showInformationMessage('Python support reinstalled.');
      } catch (e) {
        void vscode.window
          .showErrorMessage(`Reinstalling Python support failed: ${errorMessage(e)}`, 'Show Log')
          .then((choice) => {
            if (choice === 'Show Log') showLog();
          });
      }
    },
  );
}

/**
 * Remove everything GemDB created.
 *
 * The database is the only irreplaceable part — the engine can be downloaded
 * again and Grail is inside the extension — so it is called out by name, and
 * removed only if the user says so explicitly.
 */
export async function uninstall(): Promise<void> {
  const choice = await vscode.window.showWarningMessage(
    'Remove GemDB?',
    {
      modal: true,
      detail:
        `This deletes the database engine and Python support from ${rootPath()}.\n\n` +
        `Your database — everything you have stored in it — is at ${databasePath()}. ` +
        'Choose what to do with it.',
    },
    'Remove everything, including my data',
    'Keep my database',
  );
  if (choice === undefined) return;

  if (findStone()) {
    void vscode.window.showErrorMessage('Stop GemDB before removing it.');
    return;
  }

  logStep('Removing GemDB');
  try {
    removeEngine(engineVersion());
    fs.rmSync(grailPath(), { recursive: true, force: true });
    log(`Removed Grail at ${grailPath()}`);
    if (choice === 'Remove everything, including my data') removeDatabase();
    else log(`Kept the database at ${databasePath()}`);
    void vscode.window.showInformationMessage('GemDB removed.');
  } catch (e) {
    void vscode.window.showErrorMessage(`Removing GemDB failed: ${errorMessage(e)}`);
  }
}
