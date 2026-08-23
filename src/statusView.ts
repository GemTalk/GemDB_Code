import * as vscode from 'vscode';
import { engineVersion, isEngineVersionOverridden } from './config';
import { bundledGrailStamp, grailLabel } from './grail';
import { isInstalled } from './lifecycle';
import { isRemoveIpcConfigured, isSharedMemoryConfigured, sharedMemoryLabel } from './osConfig';
import { databaseExists, databasePath, enginePath, installedGrailStamp } from './paths';
import { isSupportedPlatform, setContext } from './platform';
import { isListening, isRunning, listProcesses } from './processes';
import { sessionRegistry } from './session';

/** "20 min" — the same scale the session-limit message uses. */
function humanIdle(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 6) / 10} h`;
}

export type GemDbState = 'unsupportedPlatform' | 'notInstalled' | 'stopped' | 'running';

interface Row {
  label: string;
  description?: string;
  tooltip?: string;
  icon?: vscode.ThemeIcon;
  command?: vscode.Command;
}

/**
 * The whole GemDB view: a handful of rows saying what is installed, whether it
 * is running, and what to do next.
 *
 * Jasper has seven views here — versions, databases, processes, logins, OS
 * configuration, and more — because it is a tool for running GemStone. GemDB
 * is a tool for writing Python, so the database is reduced to the smallest
 * status readout that still tells the truth when something is wrong.
 */
export class StatusViewProvider implements vscode.TreeDataProvider<Row> {
  private readonly emitter = new vscode.EventEmitter<Row | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private rows: Row[] | undefined;

  constructor(
    private readonly extensionPath: string,
    private readonly onStateRead: () => void = () => {},
  ) {}

  refresh(): void {
    this.rows = undefined;
    this.emitter.fire(undefined);
  }

  getTreeItem(row: Row): vscode.TreeItem {
    const item = new vscode.TreeItem(row.label, vscode.TreeItemCollapsibleState.None);
    item.description = row.description;
    item.tooltip = row.tooltip;
    item.iconPath = row.icon;
    item.command = row.command;
    return item;
  }

  getChildren(row?: Row): Row[] | Promise<Row[]> {
    if (row) return [];
    if (this.rows) return this.rows;
    // Reading shared memory shells out, so the first paint returns a
    // placeholder and the real rows arrive on the refresh that follows.
    void this.load();
    return [{ label: 'Checking…', icon: new vscode.ThemeIcon('loading~spin') }];
  }

  /** The state the view is in, also published as a context key. */
  async currentState(): Promise<GemDbState> {
    if (!isSupportedPlatform()) return 'unsupportedPlatform';
    if (!isInstalled()) return 'notInstalled';
    return isRunning(listProcesses()) ? 'running' : 'stopped';
  }

  private async load(): Promise<void> {
    const state = await this.currentState();
    setContext('gemdb.state', state);
    setContext('gemdb.installed', state !== 'notInstalled' && state !== 'unsupportedPlatform');
    setContext('gemdb.running', state === 'running');
    // The status bar reads the same process list, so it is refreshed from here
    // rather than polling separately and risking the two disagreeing.
    this.onStateRead();

    if (state === 'unsupportedPlatform' || state === 'notInstalled') {
      // viewsWelcome covers both — an empty row list is what makes it show.
      this.rows = [];
      this.emitter.fire(undefined);
      return;
    }

    const ok = (label: string): vscode.ThemeIcon =>
      new vscode.ThemeIcon(label, new vscode.ThemeColor('testing.iconPassed'));
    const warn = (label: string): vscode.ThemeIcon =>
      new vscode.ThemeIcon(label, new vscode.ThemeColor('problemsWarningIcon.foreground'));

    const rows: Row[] = [];

    // The listener can be down while the database is up — a refused stop leaves
    // exactly that. Saying so beats a bare "Running" that does not explain why
    // nothing can connect.
    const listening = state === 'running' ? isListening() : true;

    rows.push(
      state === 'running'
        ? {
            label: 'Running',
            description: listening
              ? 'Python runs inside the database'
              : 'Running, but not accepting new sessions',
            icon: listening ? ok('pass-filled') : warn('warning'),
            command: { command: 'gemdb.openRepl', title: 'Open GemDB Shell' },
          }
        : {
            label: 'Stopped',
            description: 'Start GemDB to run Python',
            icon: new vscode.ThemeIcon('circle-outline'),
            command: { command: 'gemdb.start', title: 'Start GemDB' },
          },
    );

    const engine = enginePath();
    rows.push({
      label: 'Database engine',
      description: isEngineVersionOverridden()
        ? `${engineVersion()} (overridden)`
        : engineVersion(),
      tooltip: engine ?? 'Not installed',
      icon: new vscode.ThemeIcon('server'),
    });

    rows.push({
      label: 'Database',
      description: databaseExists() ? 'ready' : 'missing',
      tooltip: databasePath(),
      icon: databaseExists() ? new vscode.ThemeIcon('database') : warn('warning'),
    });

    // Grail is filed into the database only once the database has run, so
    // "prepared but never started" is a normal state, not a fault — say so
    // plainly rather than showing it as missing.
    const installed = installedGrailStamp();
    const bundled = bundledGrailStamp(this.extensionPath);
    const neverInstalled = installed === undefined;
    const outdated = !neverInstalled && bundled !== undefined && installed !== bundled;
    rows.push({
      label: 'Python',
      description: neverInstalled
        ? 'installs when you first run Python'
        : outdated
          ? `${grailLabel(installed)} — update available`
          : grailLabel(installed),
      tooltip: neverInstalled
        ? `Python support ${grailLabel(bundled)} is ready to be added to the database. That happens ` +
          'automatically the first time you open the GemDB Shell or run a notebook cell.'
        : outdated
          ? `This GemDB update ships Python support ${grailLabel(bundled)}. It will be installed the next time GemDB starts.`
          : 'The Python implementation installed in your database.',
      icon: neverInstalled
        ? new vscode.ThemeIcon('symbol-namespace')
        : outdated
          ? warn('arrow-circle-up')
          : ok('symbol-namespace'),
      command: outdated
        ? { command: 'gemdb.reinstallPython', title: 'Reinstall the Python Execution Engine' }
        : undefined,
    });

    // Sessions are scarce and invisible, which is a bad combination: each
    // notebook holds one so it gets its own transaction, the database allows
    // ten at once, and its own gems spend some of that. So say what this
    // window is holding, and which one has been idle longest — that is the one
    // to close when the database has none left to give. Only shown when
    // something is connected; a row saying "0" would be noise.
    const held = sessionRegistry();
    if (held.length > 0) {
      const idlest = held[0];
      rows.push({
        label: 'Sessions',
        description: `${held.length} in this window`,
        tooltip:
          held
            .map(
              (s) =>
                `${s.owner.label}${s.serial === undefined ? '' : ` — session ${s.serial}`}` +
                ` (idle ${humanIdle(s.idleMs)})`,
            )
            .join('\n') +
          `\n\nIdle longest: ${idlest.owner.label}. The database allows a limited number of ` +
          'sessions at once, shared with other windows and its own gems.',
        icon: new vscode.ThemeIcon('plug'),
      });
    }

    const sharedMemoryOk = await isSharedMemoryConfigured();
    rows.push({
      label: 'Shared memory',
      description: sharedMemoryOk ? await sharedMemoryLabel() : 'needs configuring',
      tooltip: sharedMemoryOk
        ? 'The database has the shared memory it needs.'
        : 'The database needs at least 1 GB of shared memory to start.',
      icon: sharedMemoryOk ? ok('check') : warn('warning'),
      command: sharedMemoryOk
        ? undefined
        : { command: 'gemdb.configureSharedMemory', title: 'Configure Shared Memory' },
    });

    // Only worth a row when it is wrong — on macOS it never applies, and on a
    // correctly configured Linux box it is noise.
    if (process.platform === 'linux' && !isRemoveIpcConfigured()) {
      rows.push({
        label: 'Survives logout',
        description: 'not configured',
        tooltip:
          'systemd will destroy the database’s shared memory when you log out of this machine. ' +
          'GemDB offers to fix this when it starts.',
        icon: warn('warning'),
      });
    }

    this.rows = rows;
    this.emitter.fire(undefined);
  }
}
