import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  ensureRunning,
  install,
  isInstalled,
  prepare,
  reinstallGrail,
  start,
  stop,
  uninstall,
} from './lifecycle';
import { autoStartSuppressed, initAutoStart, suppressAutoStart } from './autoStart';
import { withSetupLock } from './lock';
import { disposeLog, log, showLog } from './log';
import { GemDbNotebookController, newNotebook, resetActiveNotebook } from './notebook';
import { configureSharedMemory, ensureOsConfigured, isSharedMemoryConfigured } from './osConfig';
import { isSupportedPlatform, setContext } from './platform';
import { isRunning } from './processes';
import { openRepl, runFile } from './repl';
import { logout, logoutAll } from './session';
import { GemDbStatusBar } from './statusBar';
import { StatusViewProvider } from './statusView';

export function activate(context: vscode.ExtensionContext): void {
  const extensionPath = context.extensionPath;
  log(`GemDB ${context.extension.packageJSON.version as string} activated`);

  initAutoStart(context.globalStorageUri.fsPath);

  const statusBar = new GemDbStatusBar();
  const status = new StatusViewProvider(extensionPath, () => statusBar.refresh());
  context.subscriptions.push(
    statusBar,
    vscode.window.registerTreeDataProvider('gemdbStatus', status),
    new vscode.Disposable(() => disposeLog()),
  );

  // The notebook kernel is registered even on an unsupported platform so the
  // kernel picker explains itself, rather than silently offering nothing.
  const notebooks = new GemDbNotebookController(extensionPath);
  context.subscriptions.push(notebooks);

  // Every command that changes state refreshes the view afterwards, so the
  // status readout can never disagree with what just happened.
  const refreshing = (run: () => Promise<void> | void) => async (): Promise<void> => {
    await run();
    status.refresh();
  };

  // The database can be started and stopped from outside this window — by
  // another window, or by hand in a terminal — so re-read the truth whenever
  // this window is brought back to the front.
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) status.refresh();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'gemdb.install',
      refreshing(() => install(extensionPath)),
    ),
    vscode.commands.registerCommand(
      'gemdb.start',
      refreshing(() => start(extensionPath)),
    ),
    vscode.commands.registerCommand(
      'gemdb.stop',
      // Pressing Stop, or clicking the status bar, is the one signal that the
      // user wants the database left alone. `stop` itself stays free of this:
      // it is also the programmatic path, and a shutdown GemDB performs on its
      // own behalf is not an instruction from anybody.
      refreshing(async () => {
        suppressAutoStart();
        await stop();
      }),
    ),
    vscode.commands.registerCommand('gemdb.refresh', () => status.refresh()),
    vscode.commands.registerCommand(
      'gemdb.reinstallPython',
      refreshing(() => reinstallGrail(extensionPath)),
    ),
    vscode.commands.registerCommand(
      'gemdb.uninstall',
      refreshing(async () => {
        logout();
        await uninstall();
      }),
    ),
    vscode.commands.registerCommand('gemdb.openRepl', () => openRepl(extensionPath)),
    vscode.commands.registerCommand('gemdb.runFile', (uri?: vscode.Uri) =>
      runFile(extensionPath, uri),
    ),
    vscode.commands.registerCommand('gemdb.newNotebook', () => newNotebook()),
    vscode.commands.registerCommand('gemdb.resetNotebook', () => resetActiveNotebook()),
    vscode.commands.registerCommand('gemdb.showLog', () => showLog()),
    vscode.commands.registerCommand(
      'gemdb.configureSharedMemory',
      refreshing(() => configureSharedMemory(extensionPath)),
    ),
  );

  // A change of root path or engine version invalidates everything the view
  // shows, and the session is bound to the old database.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration('gemdb.rootPath') ||
        event.affectsConfiguration('gemdb.engineVersion')
      ) {
        logout();
        status.refresh();
      }
    }),
  );

  if (!isSupportedPlatform()) {
    setContext('gemdb.state', 'unsupportedPlatform');
    log(`GemDB does not support ${process.platform} yet — macOS and Linux only.`);
    return;
  }

  status.refresh();

  void prepareOnFirstRun(context, extensionPath, () => status.refresh()).then(() =>
    autoStart(extensionPath, () => status.refresh()),
  );
}

/**
 * Get the machine ready the first time the extension activates, without asking.
 *
 * An installed GemDB with no database is inert — unlike a linter, which
 * sensibly waits for a file to open, there is nothing this extension can do
 * until the engine is on disk. So the download starts on its own.
 *
 * Alongside the download it asks permission for the one thing that reaches
 * outside the root path — raising shared memory — so that everything afterwards
 * just works. Starting the database is not done here either; `autoStart` does
 * it once this settles, so that a failure to prepare and a decision not to run
 * stay separate questions.
 *
 * Three guards keep the automatic part from being presumptuous:
 *
 *   Once per machine. `globalState` is synced across machines by Settings Sync,
 *   so the flag lives in `globalStorageUri` instead — otherwise signing in on a
 *   second machine would look like "already handled" and silently skip setup,
 *   or worse, one machine's decision would speak for another's.
 *
 *   A cancel is final. Pressing Cancel records the decision and the welcome
 *   view takes over; nothing re-prompts on the next window. The partial
 *   download is kept, so choosing to continue later costs only what is left.
 *
 *   One window at a time, enforced by a lock file, since activation happens in
 *   every open window and two downloads would otherwise corrupt one file.
 */
async function prepareOnFirstRun(
  context: vscode.ExtensionContext,
  extensionPath: string,
  refresh: () => void,
): Promise<void> {
  if (isInstalled()) return;

  // A remote or web window shares the marketplace install but not the machine
  // GemDB would be setting up. Only a local desktop window should act.
  if (vscode.env.remoteName !== undefined || vscode.env.uiKind !== vscode.UIKind.Desktop) return;

  const marker = path.join(context.globalStorageUri.fsPath, 'setup-attempted');
  if (fs.existsSync(marker)) return;

  const outcome = await withSetupLock(async () => {
    // Re-check inside the lock: another window may have finished the whole
    // thing while this one was waiting to acquire it.
    if (isInstalled()) return { prepared: true, configured: await isSharedMemoryConfigured() };
    log('First run: preparing GemDB. This downloads about 210 MB and uses about 820 MB of disk.');

    // The download and the permission prompt run side by side, deliberately.
    //
    // The small reason is wall clock: the download is a minute or two, and
    // answering a password prompt is dead time bolted onto either end of it.
    //
    // The larger reason is attention. Asked *after* the download, the prompt
    // arrives two minutes after the user last thought about GemDB — by which
    // point they have very likely moved on, and it sits unanswered until they
    // wander back to a half-finished setup. Asked at the start, it catches them
    // while they are still watching the thing they just installed. Their
    // reaction time is the resource being spent here, and it is cheapest at the
    // beginning.
    //
    // The two touch nothing in common — one writes into the root path, the
    // other runs a script under sudo — so there is no ordering between them to
    // get wrong. Neither rejects: both report failure by returning.
    const files = prepare(extensionPath);
    const os = ensureOsConfigured(extensionPath).catch(() => false);
    const [prepared, configured] = await Promise.all([files, os]);
    return { prepared, configured };
  });
  if (outcome === undefined) return; // another window is doing it

  // Recorded whether it succeeded or was cancelled — either way this machine
  // has been offered setup, and a cancel is a decision to be respected.
  try {
    fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });
    fs.writeFileSync(marker, new Date().toISOString());
  } catch {
    /* worst case it is offered once more */
  }

  refresh();
  if (!outcome.prepared) return;

  // Declining the permission is not a failure. The setting persists once made,
  // so it is normally asked once per machine and never again; if it is declined
  // or cannot be done, the panel keeps showing what is missing and
  // `ensureRunning` asks again when it genuinely blocks work. What we never do
  // is re-prompt on every activation, which would nag anyone who said no or
  // cannot say yes.
  void vscode.window
    .showInformationMessage(
      outcome.configured
        ? 'GemDB is ready. The database starts by itself the first time you run Python.'
        : 'GemDB is set up, but still needs a shared-memory change before the database can run. ' +
            'It will ask again when you run Python.',
      'Open Python REPL',
      'New Notebook',
    )
    .then((choice) => {
      if (choice === 'Open Python REPL') void vscode.commands.executeCommand('gemdb.openRepl');
      else if (choice === 'New Notebook') void vscode.commands.executeCommand('gemdb.newNotebook');
    });
}

export function deactivate(): void {
  logoutAll();
}

/**
 * Start the database on activation, so the first notebook cell just runs.
 *
 * This is the friction the first run is really made of: setup finishes, and the
 * user's next action still has to wait for a database to come up. Starting here
 * spends that wait while they are still reading the "ready" notification.
 *
 * Three things keep it from being presumptuous, and all three matter:
 *
 *   A user who stopped the database is obeyed. `autoStartSuppressed` is the
 *   record of that, cleared the moment they ask for a database again.
 *
 *   It never prompts. If shared memory has not been raised, starting would put
 *   a sudo dialog in front of someone who only opened an editor — so this
 *   checks first and leaves it to `ensureRunning` at first use, which is where
 *   a prompt has a visible cause.
 *
 *   One window at a time. Activation runs in every window, and two concurrent
 *   `startstone` calls race; the setup lock already serialises exactly this.
 */
async function autoStart(extensionPath: string, refresh: () => void): Promise<void> {
  if (!isSupportedPlatform() || !isInstalled()) return;
  if (autoStartSuppressed()) return;
  if (isRunning()) return;
  if (!(await isSharedMemoryConfigured())) return;

  await withSetupLock(async () => {
    if (isRunning()) return;
    log('Starting the database, so it is ready when you are.');
    await ensureRunning(extensionPath);
  });
  refresh();
}
