import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  engineVersion,
  externalDatabase,
  isExternalDatabase,
  mcpEnabled,
  reinstallPythonOnUpdate,
  rootPath,
} from './config';
import { ensureDatabaseAccount } from './account';
import { writeCliScripts } from './cli';
import {
  assertDatabaseIsLocal,
  assertDatabaseMatchesEngine,
  createDatabase,
  DatabaseOnNfsError,
  DatabaseVersionError,
  DiskSpaceError,
  assertRoomForExtent,
  assertRoomForSetup,
  ensureSpaceLimits,
  removeDatabase,
} from './database';
import { Progress, installEngine, removeEngine } from './engine';
import {
  bundledGrailStamp,
  fileInGrail,
  grailLabel,
  grailNeedsUpdate,
  newerGrail,
  stageGrail,
} from './grail';
import { errorMessage, log, logStep, showLog } from './log';
import {
  bundledMcpStamp,
  ensureMcpInstalled,
  isMcpRunning,
  startMcpServer,
  stopMcpServer,
} from './mcp';
import { OS_CONFIG_RESULT, ensureOsConfigured, osConfigAllowsStart } from './osConfig';
import {
  databaseExists,
  databasePath,
  enginePath,
  grailInstalled,
  grailPath,
  grailStagedOnDisk,
  mcpPath,
} from './paths';
import {
  ExternalDatabaseError,
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
import { isSupportedPlatform, setContext } from './platform';
import { withSetupLockWhenFree } from './lock';
import { isOnNfs } from './networkFileSystem';
import { logoutAll } from './session';
import { allowAutoStart } from './autoStart';
import { readUnattendedSetupMarker, writeUnattendedSetupMarker } from './unattendedSetupMarker';
import {
  DATABASE_OUTCOME,
  DatabaseOutcome,
  FILED_GRAIL,
  FiledGrail,
  SETUP_OUTCOME,
  SetupOutcome,
  TRIGGER,
  Trigger,
  reportDatabaseStarted,
  reportSetupFinished,
  reportSetupStarted,
  Stopwatch,
} from './telemetry';

/** Guard every entry point with one clear message rather than a stack trace. */
function requireSupportedPlatform(): boolean {
  if (isSupportedPlatform()) return true;
  void vscode.window.showErrorMessage(
    'GemDB runs on macOS with Apple Silicon, and on Linux (x64 or arm64). ' +
      'Intel Macs and Windows are not supported.',
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
 *
 * An external database is not on disk for GemDB to find — its extent is the
 * administrator's, wherever they keep it — so for one, the engine and staged
 * Grail are the whole of it.
 */
export function isInstalled(): boolean {
  if (enginePath() === undefined || !grailStagedOnDisk()) return false;
  return isExternalDatabase() || databaseExists();
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
 *
 * Returns false when a cancel was noticed once the engine step returned,
 * whether or not the steps after it had anything left to do. That is the only
 * point a cancel can be seen: nothing after it yields, so a Cancel pressed while
 * the database is created or Grail staged is not delivered until the setup has
 * already finished, and the setup ends completed.
 */
async function prepareFiles(
  extensionPath: string,
  progress: Progress,
  token: vscode.CancellationToken,
): Promise<boolean> {
  // An external database's engine and extent already exist and are not
  // GemDB's to download, check or create; staging Grail is all that is left.
  // Nothing on this path yields, so there is no cancel to notice.
  const external = externalDatabase();
  if (external) {
    if (!enginePath()) {
      throw new Error(
        `No database engine at ${external.gemstone}. Check gemdb.externalDatabase.gemstone.`,
      );
    }
    progress.report({ message: 'Preparing Python support…' });
    stageGrail(extensionPath);
    return true;
  }

  // Before the download: the stone will not open a database on NFS, and
  // finding that out at the first start costs the whole setup. Nor will it
  // start on a disk too small for its reserved extent.
  assertDatabaseIsLocal();
  if (!databaseExists()) assertRoomForSetup();

  const engine = await installEngine(progress, token);
  if (token.isCancellationRequested) return false;

  // Before anything is created or copied: a database an older engine wrote
  // cannot be used by this one, and the engine will not say so until a login
  // fails. See assertDatabaseMatchesEngine.
  assertDatabaseMatchesEngine(engine, engineVersion());

  progress.report({ message: 'Creating your database…' });
  createDatabase(engine);

  progress.report({ message: 'Preparing Python support…' });
  stageGrail(extensionPath);
  return true;
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
 * Cancelling reaches here two ways: the download throws, or a step between
 * downloads notices the token and returns. Both are the same decision and get
 * the same acknowledgement.
 *
 * It has to be a notification rather than a log line. Pressing Cancel
 * dismisses the progress notification, and without something in its place
 * GemDB simply goes quiet — from the outside, indistinguishable from having
 * given up. Shown once, at the moment of the decision, which keeps it
 * consistent with the unattended setup marker: a cancel is answered, not
 * re-asked on every activation.
 */
function paused(): void {
  log('Setup paused. It will resume where it stopped when you next start GemDB.');
  void vscode.window
    .showInformationMessage(
      'Setup paused. Nothing is lost — GemDB picks up where it stopped whenever you are ready.',
      'Resume',
    )
    .then((choice) => {
      if (choice === 'Resume') void vscode.commands.executeCommand('gemdb.install');
    });
}

/**
 * Everything that can be done without touching the machine or the user, run
 * under a progress notification and classified into one outcome.
 *
 * This is the setup body shared by `prepare()`, `install()` and
 * `ensureRunning()` — previously three copies of the same try/cancel/catch.
 *
 * At most one runs at a time on this machine. Two at once download into the
 * same `.part` file — one writing from the start, the other appending to a
 * resume — and both fail at the size check, the first on a file larger than
 * the archive and the second on one the first has already discarded (#68).
 * In this window, a second caller waits for the first and gets its outcome:
 * pressing Set Up GemDB or running a cell while the first-run setup is
 * downloading is the ordinary way to get here twice. In another window, the
 * setup lock keeps it waiting until this one is done, and then it finds
 * nothing left to do.
 *
 * `gemdb.settingUp` is true for as long as one runs, so the welcome view can
 * say so instead of offering a Set Up GemDB button that would only join it.
 */
export function runSetup(extensionPath: string, trigger: Trigger): Promise<SetupOutcome> {
  if (setupInFlight) {
    log('Setup is already under way; waiting for it to finish.');
    return setupInFlight;
  }
  setContext('gemdb.settingUp', true);
  const run = runSetupOnce(extensionPath, trigger).finally(() => {
    setupInFlight = undefined;
    setContext('gemdb.settingUp', false);
  });
  setupInFlight = run;
  return run;
}

let setupInFlight: Promise<SetupOutcome> | undefined;

async function runSetupOnce(extensionPath: string, trigger: Trigger): Promise<SetupOutcome> {
  reportSetupStarted(trigger);
  const stopwatch = Stopwatch.start();
  const outcome = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: trigger === TRIGGER.installCommand ? 'Installing GemDB' : 'Setting up GemDB',
      cancellable: true,
    },
    async (progress, token): Promise<SetupOutcome> => {
      let waited = false;
      try {
        const prepared = await withSetupLockWhenFree(
          async () => {
            if (waited && isInstalled()) {
              log('Another window finished setting GemDB up.');
              return true;
            }
            return prepareFiles(extensionPath, progress, token);
          },
          {
            onWaiting: () => {
              waited = true;
              progress.report({
                message: 'Waiting for another VS Code window to finish setting GemDB up…',
              });
            },
            stopWaiting: () => token.isCancellationRequested,
          },
        );
        // Nothing to pause: the other window's setup carries on, and its own
        // notification is the one that says how it is going.
        if (prepared === undefined) {
          log('Stopped waiting for the other window, which carries on setting GemDB up.');
          return SETUP_OUTCOME.cancelled;
        }
        if (!prepared) {
          paused();
          return SETUP_OUTCOME.cancelled;
        }
        return SETUP_OUTCOME.completed;
      } catch (e) {
        if (errorMessage(e) === 'Download cancelled') {
          paused();
          return SETUP_OUTCOME.cancelled;
        }
        reportFailure(
          trigger === TRIGGER.installCommand ? 'Installing GemDB' : 'Setting up GemDB',
          e,
        );
        return SETUP_OUTCOME.failed;
      }
    },
  );
  reportSetupFinished(trigger, outcome, stopwatch.elapsedMs());

  // A completed setup replaces whatever the unattended setup marker says
  // (`cancelled`, `failed`, `uninstalled`), so it stops describing a state
  // that is no longer true (#53). Only when a marker exists: no marker means
  // the unattended setup has not had its turn, and completing an explicit
  // setup must not change that. Failed and cancelled runs write nothing;
  // `setupFinished` records them. The write comes after `setupFinished`
  // because it throws when the marker was never initialised, and that must not
  // drop the event.
  if (outcome === SETUP_OUTCOME.completed && readUnattendedSetupMarker() !== 'none') {
    writeUnattendedSetupMarker(SETUP_OUTCOME.completed);
  }
  return outcome;
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

  const outcome = await runSetup(extensionPath, TRIGGER.installCommand);
  if (outcome !== SETUP_OUTCOME.completed) return;

  // Starting is a separate act, and it is where consent is asked for: raising
  // shared memory needs sudo, and the processes it starts outlive the editor.
  if (!(await ensureRunning(extensionPath, TRIGGER.installCommand))) return;

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
 * Does the inert work and stops. Returns how it ended, which the caller
 * records so it is never retried unasked — a cancel here is a decision, not a
 * hiccup, and the partly-downloaded archive is kept so that choosing to
 * continue later costs only the remaining bytes.
 */
export async function prepare(extensionPath: string): Promise<SetupOutcome> {
  if (!isSupportedPlatform() || !bundledGrailStamp(extensionPath)) return SETUP_OUTCOME.failed;

  const outcome = await runSetup(extensionPath, TRIGGER.firstRun);
  if (outcome === SETUP_OUTCOME.completed) log('GemDB is ready to start.');
  return outcome;
}

/** Log a failure and offer the log, in the one shape every step uses. */
function reportFailure(what: string, e: unknown): void {
  log(`\n${what} failed: ${errorMessage(e)}`);

  // A database the engine cannot read is not a step that failed — it is a
  // decision waiting on the user, and it needs the whole message rather than
  // one prefixed by whatever GemDB happened to be doing. Modal, because it
  // asks for something (deleting a directory) and a toast that expires
  // unanswered leaves GemDB apparently broken for no stated reason.
  if (e instanceof DatabaseVersionError) {
    void vscode.window.showErrorMessage('GemDB cannot use this database', {
      modal: true,
      detail: e.message,
    });
    return;
  }

  // Not a step that failed either: nothing will work until the root path
  // moves, so the message offers the move rather than the log.
  if (e instanceof DatabaseOnNfsError) {
    void vscode.window
      .showErrorMessage(e.message, CHOOSE_LOCAL_FOLDER, 'Show Log')
      .then((choice) => {
        if (choice === CHOOSE_LOCAL_FOLDER) void chooseLocalRootPath();
        else if (choice === 'Show Log') showLog();
      });
    return;
  }

  // The same: nothing starts until there is disk for the reserved extent, so
  // the message says how much and offers somewhere else.
  if (e instanceof DiskSpaceError) {
    const elsewhere = 'Choose Another Folder…';
    void vscode.window.showErrorMessage(e.message, elsewhere, 'Show Log').then((choice) => {
      if (choice === elsewhere) void chooseLocalRootPath();
      else if (choice === 'Show Log') showLog();
    });
    return;
  }

  void vscode.window
    .showErrorMessage(`${what} failed: ${errorMessage(e)}`, 'Show Log')
    .then((choice) => {
      if (choice === 'Show Log') showLog();
    });
}

const CHOOSE_LOCAL_FOLDER = 'Choose a Local Folder…';

/**
 * Ask for a folder on a local disk, make it the root path, and set GemDB up
 * there (#69).
 *
 * Asked rather than chosen: the root path is a persistent, user-level setting,
 * and the only directory GemDB could pick unasked is one it cannot know is
 * local, backed up, or large enough. Setting up afterwards is not a second
 * question — getting a working GemDB is why the folder was asked for.
 *
 * GemDB goes in a `GemDB` folder inside the one picked, unless the pick is
 * already called that, so choosing `/scratch/me` does not scatter the engine,
 * the database and Python support across a directory that holds other things.
 */
export async function chooseLocalRootPath(world: RootPathWorld = realRootPathWorld): Promise<void> {
  const picked = await world.pickFolder();
  if (!picked) return;
  const root = path.basename(picked) === 'GemDB' ? picked : path.join(picked, 'GemDB');

  if (world.isOnNfs(root)) {
    void vscode.window
      .showErrorMessage(`${root} is on an NFS mount too.`, CHOOSE_LOCAL_FOLDER)
      .then((choice) => {
        if (choice === CHOOSE_LOCAL_FOLDER) void chooseLocalRootPath(world);
      });
    return;
  }

  const previous = rootPath();
  await world.setRootPath(root);
  log(
    `GemDB now keeps its files in ${root}. Nothing was moved from ${previous}; ` +
      'delete it once you no longer need it.',
  );
  await world.setUp();
}

/** What `chooseLocalRootPath` does to the editor, so a test can stand in. */
export interface RootPathWorld {
  pickFolder(): Promise<string | undefined>;
  isOnNfs(dir: string): boolean;
  setRootPath(root: string): Promise<void>;
  setUp(): Promise<void>;
}

const realRootPathWorld: RootPathWorld = {
  pickFolder: async () =>
    (
      await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Keep GemDB Here',
        title: 'Choose a folder on a local disk for GemDB',
      })
    )?.[0]?.fsPath,
  isOnNfs: (dir) => isOnNfs(dir),
  // Global, because the setting is machine-scoped: a workspace cannot hold it.
  setRootPath: async (root) =>
    vscode.workspace
      .getConfiguration('gemdb')
      .update('rootPath', root, vscode.ConfigurationTarget.Global),
  setUp: async () => {
    await vscode.commands.executeCommand('gemdb.install');
  },
};

/** The explicit "Start GemDB" command. */
export async function start(extensionPath: string): Promise<void> {
  if (!requireSupportedPlatform()) return;
  await ensureRunning(extensionPath, TRIGGER.startCommand);
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
export async function ensureRunning(extensionPath: string, trigger: Trigger): Promise<boolean> {
  const stopwatch = Stopwatch.start();
  const failed = (outcome: Exclude<DatabaseOutcome, typeof DATABASE_OUTCOME.started>): false => {
    reportDatabaseStarted(trigger, outcome, FILED_GRAIL.no, stopwatch.elapsedMs(), false);
    return false;
  };

  // Asking for a running database is the clearest possible retraction of an
  // earlier "stop it". Running a cell counts: `ensureRunning` is the one path
  // to a running database, so it is the one place this belongs.
  allowAutoStart();
  if (!requireSupportedPlatform()) return failed(DATABASE_OUTCOME.unsupportedPlatform);
  if (!requireGrailPayload(extensionPath)) return failed(DATABASE_OUTCOME.missingPayload);

  // Files may still be missing if the automatic preparation was cancelled, or
  // never ran. Finishing it here is what lets a cancel be a pause: the download
  // picks up from the bytes already on disk.
  if (!isInstalled()) {
    const outcome = await runSetup(extensionPath, trigger);
    if (outcome !== SETUP_OUTCOME.completed) {
      return failed(
        outcome === SETUP_OUTCOME.cancelled
          ? DATABASE_OUTCOME.setupCancelled
          : DATABASE_OUTCOME.setupFailed,
      );
    }
    if (!isInstalled()) return failed(DATABASE_OUTCOME.setupFailed);
  }

  // Staging Grail writes the shell command too, but only when the payload
  // changed — so an update that changed only code would leave the previous
  // `bin/gemdb` and shell bundle in place, and a fix to the shell would reach
  // the editor while the terminal it opens kept running the old one. Called
  // unconditionally here, on the single path everything that needs a database
  // goes through; `writeCliScripts` compares a fingerprint and returns without
  // touching the disk when it would write the same bytes.
  try {
    writeCliScripts(extensionPath);
  } catch (e) {
    log(`Could not write the gemdb command: ${errorMessage(e)}`);
  }

  // Declining and saying yes to a script that did not take are different
  // answers, and `databaseStarted` has to keep them apart. An external
  // database's machine is configured by whoever runs it, so GemDB neither
  // checks nor asks.
  const osResult = isExternalDatabase()
    ? OS_CONFIG_RESULT.alreadyConfigured
    : await ensureOsConfigured(extensionPath, trigger);
  if (!osConfigAllowsStart(osResult)) {
    return failed(
      osResult === OS_CONFIG_RESULT.declined
        ? DATABASE_OUTCOME.osConfigDeclined
        : DATABASE_OUTCOME.osConfigFailed,
    );
  }
  const osPrompted = osResult !== OS_CONFIG_RESULT.alreadyConfigured;

  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Starting GemDB' },
    async (progress) => {
      try {
        const { startedStone, startedNetldi } = await startProcesses(progress);

        // Before Python is installed, because it is installed into this
        // account. An external database's account is its administrator's.
        if (!isExternalDatabase()) ensureDatabaseAccount();

        // Grail is filed in here rather than during preparation because it
        // needs a running database. The same branch covers the first install
        // and an extension update that ships a newer Grail — in both cases the
        // build on disk differs from the one recorded in the database.
        const firstTime = !grailInstalled();
        let filedGrail: FiledGrail = FILED_GRAIL.no;
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
          if (await fileInGrail(extensionPath, progress)) {
            filedGrail = firstTime ? FILED_GRAIL.firstTime : FILED_GRAIL.update;
          }
        }

        await ensureMcpServing(extensionPath, progress);
        const didWork =
          osPrompted || startedStone || startedNetldi || filedGrail !== FILED_GRAIL.no;
        reportDatabaseStarted(
          trigger,
          DATABASE_OUTCOME.started,
          filedGrail,
          stopwatch.elapsedMs(),
          didWork,
        );
        return true;
      } catch (e) {
        reportFailure('Starting GemDB', e);
        return failed(DATABASE_OUTCOME.startFailed);
      }
    },
  );
}

/**
 * Bring the MCP server up alongside the database.
 *
 * Called from inside `ensureRunning`, after Grail, so that "the database is
 * running" and "an agent can reach it" are the same state. That is the whole
 * design: a user who has connected a client once should never have to think
 * about a second thing to start, and an agent's first tool call should bring
 * the database up the way a notebook's first cell does.
 *
 * A failure here does NOT fail `ensureRunning`, and that asymmetry is
 * deliberate. Every other step on this path is something the user's own work
 * needs — no database, no notebook. The MCP server is a door for something
 * else, and a router that cannot start (a port taken by another program, a
 * file-in that failed) must not be the reason a notebook cell will not run.
 * So it reports itself to the log and the status view and gets out of the way.
 *
 * Installing is separate from running, as with Grail: the classes are filed
 * into the database once per payload build, and the router is forked whenever
 * one is not already listening.
 */
async function ensureMcpServing(
  extensionPath: string,
  progress?: vscode.Progress<{ message?: string }>,
): Promise<boolean> {
  if (!mcpEnabled()) return false;
  if (!bundledMcpStamp(extensionPath)) {
    // A build without the payload is a packaging fault, but not one worth a
    // dialog: the rest of GemDB works, and the MCP row says what is missing.
    log('This build of GemDB ships no MCP server payload, so there is none to run.');
    return false;
  }

  try {
    await ensureMcpInstalled(extensionPath, progress);
    progress?.report({ message: 'Starting the MCP server…' });
    return await startMcpServer();
  } catch (e) {
    log(`The MCP server did not start: ${errorMessage(e)}`);
    return false;
  }
}

/**
 * Everything an MCP client needs, on demand.
 *
 * This is what VS Code calls through `resolveMcpServerDefinition` when it is
 * about to start the server, and what the "Register" command calls before it
 * hands out a URL. It goes through `ensureRunning` rather than starting the
 * router directly, because an MCP server with no database behind it is a URL
 * that answers every tool call with a login failure.
 */
export async function ensureMcpRunning(extensionPath: string): Promise<boolean> {
  if (!(await ensureRunning(extensionPath, TRIGGER.mcp))) return false;
  // `ensureRunning` starts it when it is enabled, so this is the report rather
  // than a second attempt — except where the database was already up and the
  // router had been stopped by hand, which `ensureMcpServing` handles above.
  return isMcpRunning();
}

/**
 * Bring the MCP server back for a database that is already running.
 *
 * `ensureRunning` starts the router with the database, but activation calls it
 * only for a database that is down — and an external database is never down
 * from here, any more than one another window started. The router does not
 * survive the stone, so after a reboot it would stay away until the first line
 * of Python, and a client configured with the bare URL (Claude Code, through
 * `claude mcp add`) would find nothing listening. VS Code's own clients go
 * through `ensureMcpRunning` and never see the difference.
 *
 * Starts only the router: the database is running, so nothing on the
 * `ensureRunning` path is outstanding but this.
 */
export async function resumeMcpServing(extensionPath: string): Promise<boolean> {
  if (!mcpEnabled() || !isInstalled() || !isRunning()) return false;
  if (await isMcpRunning()) return true;
  return ensureMcpServing(extensionPath);
}

/** Start whichever of the two processes is not already up. */
async function startProcesses(
  progress?: vscode.Progress<{ message?: string }>,
): Promise<{ startedStone: boolean; startedNetldi: boolean }> {
  const running = listProcesses();
  let startedStone = false;
  let startedNetldi = false;

  // Nothing to start for an external database — only whether it is up, said
  // in terms of what to do about it.
  const external = externalDatabase();
  if (external) {
    if (!findStone(running) || !findNetldi(running)) {
      throw new ExternalDatabaseError(
        `The database is not running: GemDB expects stone ${external.stone} and NetLDI ` +
          `${external.netldi}, which this machine's administrator runs. Ask them to start it.`,
      );
    }
    log('The database is running.');
    return { startedStone, startedNetldi };
  }

  if (!findStone(running)) {
    // Checked here as well as in `prepareFiles`, because an extension update
    // reaches this line without going through preparation at all: the engine
    // is downloaded, the database exists, Grail is staged, so `isInstalled()`
    // is true and the first thing that happens is a stone starting on a
    // repository the new engine cannot read.
    // NFS likewise: a database set up there before setup checked for it.
    assertDatabaseIsLocal();
    const engine = enginePath();
    if (engine) assertDatabaseMatchesEngine(engine, engineVersion());
    // A database an earlier GemDB created has no space limits yet, and the
    // stone reserves the extent's full size as it starts.
    ensureSpaceLimits();
    assertRoomForExtent();
    progress?.report({ message: 'Starting the database…' });
    await startStone();
    startedStone = true;
  } else {
    log('The database is already running.');
  }
  if (!findNetldi(running)) {
    progress?.report({ message: 'Starting the session listener…' });
    await startNetldi();
    startedNetldi = true;
  } else {
    log('The session listener is already running.');
  }
  return { startedStone, startedNetldi };
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
  /**
   * Stop the MCP server's router gem, if GemDB started one.
   *
   * A step of its own rather than part of `logout` because it is a different
   * kind of thing: not a session this process holds, but a detached gem this
   * machine is running, which may have been started by another window or
   * before the editor was last closed.
   */
  stopMcpServer: () => Promise<void>;
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

  // Then the MCP server, for exactly the same reason and more so: its router
  // gem holds a session for as long as it runs, and each connected client
  // holds another. Left up, every ordinary "Stop GemDB" would be refused and
  // land on the modal meant for a notebook someone forgot about — GemDB
  // blocking its own shutdown again, less visibly. Before the listener,
  // because the router forks its worker gems through the NetLDI.
  await world.stopMcpServer();

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
  if (isExternalDatabase()) {
    void vscode.window.showInformationMessage(
      "This database is run by this machine's administrator, so GemDB does not stop it.",
    );
    return;
  }
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Stopping GemDB' },
    async () => {
      try {
        await runStop({
          // Every session this window holds: the notebooks' and each REPL's.
          // All of them are logins stopstone would refuse over.
          logout: logoutAll,
          stopMcpServer,
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
  // Another editor on this root path runs a newer GemDB, and reinstalling
  // from here would downgrade what it put in place.
  const newer = newerGrail(extensionPath);
  if (newer) {
    const version = newer.version ?? 'unknown';
    void vscode.window.showErrorMessage(
      newer.where === 'installed'
        ? `Python support was installed by GemDB ${version}, newer than this editor's GemDB. ` +
            'Update GemDB here to reinstall.'
        : `A newer GemDB (${version}) has prepared Python support for this database. ` +
            'Update GemDB here to reinstall.',
    );
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
        if (await fileInGrail(extensionPath, progress)) {
          void vscode.window.showInformationMessage('Python support reinstalled.');
        }
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
 *
 * Resolves true once removal has begun, whether or not every step succeeded.
 */
export async function uninstall(): Promise<boolean> {
  // The engine and the database belong to the administrator. Removing only
  // GemDB's staged copies would leave a database GemDB then reinstalls into on
  // next use, so there is nothing useful to offer here.
  if (isExternalDatabase()) {
    void vscode.window.showInformationMessage(
      "This database is run by this machine's administrator, so GemDB does not remove it. " +
        'Clear gemdb.externalDatabase.gemstone to go back to a database GemDB manages.',
    );
    return false;
  }
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
  if (choice === undefined) return false;

  if (findStone()) {
    void vscode.window.showErrorMessage('Stop GemDB before removing it.');
    return false;
  }

  logStep('Removing GemDB');
  try {
    removeEngine(engineVersion());
    fs.rmSync(grailPath(), { recursive: true, force: true });
    log(`Removed Grail at ${grailPath()}`);
    fs.rmSync(mcpPath(), { recursive: true, force: true });
    log(`Removed the MCP server at ${mcpPath()}`);
    if (choice === 'Remove everything, including my data') removeDatabase();
    else log(`Kept the database at ${databasePath()}`);
    void vscode.window.showInformationMessage('GemDB removed.');
  } catch (e) {
    void vscode.window.showErrorMessage(`Removing GemDB failed: ${errorMessage(e)}`);
  }
  return true;
}
