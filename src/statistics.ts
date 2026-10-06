import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { errorMessage, log } from './log';

/**
 * GemDB Stats in an editor tab: a statmon file charted by GemTalk's statmon
 * viewer, whose Flutter web build ships in the .vsix as `stats/`.
 *
 * It is a webview rather than the desktop app because the editor is not always
 * on the machine with the files. Under code-server the only screen is a
 * browser tab, and a webview is an iframe in that tab whose files are served
 * by the remote machine — so the same panel works wherever the editor does,
 * with no port, no server process and no login of its own. The page fetches
 * the statmon file from the webview's resource origin, the same way it
 * fetches its own code.
 *
 * Viewing statistics needs no database, so none of this waits for one, and it
 * works on platforms GemDB cannot host a database on.
 *
 * The page and GemDB Code talk in three messages, specified on GemDB Stats'
 * side in its docs/embedding.md: the app says `ready`, GemDB Code answers
 * `open` with the file's URL, and a click on the file name in the app asks for
 * another with `pickFile`. That last one is answered with VS Code's own open
 * dialog, because under code-server the browser's would browse the user's
 * laptop rather than the server the statmon files are on.
 *
 * `scripts/bundle-stats.mjs` turns the build's index.html into `host.html`, a
 * template carrying the page's CSP. What is left for here is what differs per
 * panel: its three `{{GEMDB_*}}` placeholders.
 */

/** The webview panel's view type. */
export const STATISTICS_VIEW_TYPE = 'gemdbStats';

/** What GemDB Code sends the page: show this file, replacing any before it. */
export interface OpenMessage {
  type: 'open';
  url: string;
  name: string;
}

export interface HostPageValues {
  /** The build's own resource URL, ending in `/`; relative URLs resolve against it. */
  base: string;
  /** The webview's resource origin, which serves the build and the file. */
  cspSource: string;
  /** Fresh for every page, so nothing injected into the page can guess it. */
  nonce: string;
}

/** `host.html` with this panel's values in place of its placeholders. */
export function fillHostPage(template: string, values: HostPageValues): string {
  const fills: Record<string, string> = {
    '{{GEMDB_BASE}}': values.base,
    '{{GEMDB_CSP_SOURCE}}': values.cspSource,
    '{{GEMDB_NONCE}}': values.nonce,
  };
  // One pass, so a value that happens to contain a placeholder is not filled
  // in turn.
  return template.replace(
    /\{\{GEMDB_[A-Z_]+\}\}/g,
    (placeholder) => fills[placeholder] ?? placeholder,
  );
}

/** A page that says why there is no chart, in the editor's own colours. */
export function unavailablePage(nonce: string, message: string): string {
  const text = message.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'">
  <style nonce="${nonce}">
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 2em; }
  </style>
</head>
<body><p>${text}</p></body>
</html>`;
}

/**
 * What the tabs need from VS Code, passed in so the unit tests can stand in
 * for it.
 */
export interface StatisticsWorld {
  /** The bundled build: `stats/` in the extension. */
  build(): vscode.Uri;
  /** `host.html` from the build; throws when the build is not there. */
  hostTemplate(): string;
  /** A tab for `file`, whose page may fetch the build and that file. */
  createPanel(file: vscode.Uri, column: vscode.ViewColumn | undefined): vscode.WebviewPanel;
  /** VS Code's open dialog, for a statmon file. */
  pickFile(near?: vscode.Uri): Promise<vscode.Uri | undefined>;
}

function vscodeWorld(extensionUri: vscode.Uri): StatisticsWorld {
  const build = () => vscode.Uri.joinPath(extensionUri, 'stats');
  return {
    build,
    hostTemplate: () => fs.readFileSync(path.join(build().fsPath, 'host.html'), 'utf8'),
    createPanel: (file, column) =>
      vscode.window.createWebviewPanel(
        STATISTICS_VIEW_TYPE,
        nameOf(file),
        column ?? vscode.ViewColumn.Active,
        {
          enableScripts: true,
          // A hidden webview is discarded by default, and bringing it back would
          // start Flutter and parse the file again — tens of seconds for a large
          // one. Kept, at the cost of its memory.
          retainContextWhenHidden: true,
          // The file's folder, not the file: VS Code refuses a request for a
          // resource that is itself a root, so a root has to be a folder above
          // it (read in VS Code 1.140's loader, 2026-10-06). The folder is as
          // narrow as the page's access can be.
          localResourceRoots: [build(), vscode.Uri.joinPath(file, '..')],
        },
      ),
    pickFile: async (near) =>
      (
        await vscode.window.showOpenDialog({
          title: 'Open Statistics File',
          openLabel: 'Open',
          canSelectMany: false,
          defaultUri: near,
          filters: { 'statmon files': ['out', 'gz'], 'All files': ['*'] },
        })
      )?.[0],
  };
}

const nameOf = (file: vscode.Uri): string => path.posix.basename(file.path);
const same = (a: vscode.Uri, b: vscode.Uri): boolean => a.toString() === b.toString();

/**
 * One GemDB Stats tab, showing one file for as long as it is open.
 *
 * A file picked from inside the tab gets a tab of its own, opened where this
 * one is, which then closes. Widening this page's resource roots to the new
 * file's folder instead would reload the page anyway, would leave it able to
 * read every folder it had ever been shown, and whether VS Code delivered a
 * message posted across that reload would decide whether a large file was
 * parsed once or twice.
 */
class StatisticsPanel {
  readonly panel: vscode.WebviewPanel;

  constructor(
    private readonly world: StatisticsWorld,
    readonly file: vscode.Uri,
    column: vscode.ViewColumn | undefined,
    tabs: StatisticsTabs,
  ) {
    this.panel = world.createPanel(file, column);
    this.panel.onDidDispose(() => tabs.closed(this));
    this.panel.webview.onDidReceiveMessage((message: { type?: unknown }) => {
      if (message.type === 'ready') {
        // Every time, not just the first: a page that reloads says `ready`
        // again and has to be told its file again.
        this.post();
      } else if (message.type === 'pickFile') {
        void world.pickFile(file).then((picked) => {
          if (picked) tabs.picked(this, picked);
        });
      }
    });
    this.panel.webview.html = this.page();
  }

  private post(): void {
    const message: OpenMessage = {
      type: 'open',
      url: this.panel.webview.asWebviewUri(this.file).toString(),
      name: nameOf(this.file),
    };
    void this.panel.webview.postMessage(message);
  }

  private page(): string {
    const webview = this.panel.webview;
    const nonce = crypto.randomBytes(16).toString('base64');
    let template: string;
    try {
      template = this.world.hostTemplate();
    } catch (error) {
      log(`GemDB Stats is not in this build: ${errorMessage(error)}`);
      return unavailablePage(
        nonce,
        'This build of GemDB Code does not include GemDB Stats. ' +
          'A development build gets it from `npm run bundle:stats`.',
      );
    }
    return fillHostPage(template, {
      base: `${webview.asWebviewUri(this.world.build()).toString()}/`,
      cspSource: webview.cspSource,
      nonce,
    });
  }
}

/**
 * Every open GemDB Stats tab. A file already open in one is brought forward
 * rather than opened again: a second tab would parse it again and hold a
 * second copy in memory.
 */
class StatisticsTabs {
  private readonly tabs = new Set<StatisticsPanel>();

  constructor(private readonly world: StatisticsWorld) {}

  open(file: vscode.Uri, column?: vscode.ViewColumn): void {
    const existing = this.showing(file);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    this.tabs.add(new StatisticsPanel(this.world, file, column, this));
  }

  /** A file picked from inside `tab`: shown in its place. */
  picked(tab: StatisticsPanel, file: vscode.Uri): void {
    if (same(tab.file, file)) return;
    const existing = this.showing(file);
    if (existing) {
      // Open in another tab already: that one comes forward, and this one
      // keeps its file.
      existing.panel.reveal();
      return;
    }
    this.open(file, tab.panel.viewColumn);
    tab.panel.dispose();
  }

  closed(tab: StatisticsPanel): void {
    this.tabs.delete(tab);
  }

  private showing(file: vscode.Uri): StatisticsPanel | undefined {
    return [...this.tabs].find((tab) => same(tab.file, file));
  }
}

export function registerStatistics(
  extensionUri: vscode.Uri,
  world: StatisticsWorld = vscodeWorld(extensionUri),
): vscode.Disposable {
  const tabs = new StatisticsTabs(world);
  return vscode.Disposable.from(
    // From the Command Palette: pick a file first.
    vscode.commands.registerCommand('gemdb.openStatistics', async () => {
      const file = await world.pickFile();
      if (file) tabs.open(file);
    }),
    // From the explorer: every selected file, or, with none (a keybinding),
    // one the user picks.
    vscode.commands.registerCommand(
      'gemdb.openInStats',
      async (file?: vscode.Uri, selected?: vscode.Uri[]) => {
        const files = selected?.length ? selected : file ? [file] : [];
        if (files.length === 0) {
          const picked = await world.pickFile();
          if (picked) files.push(picked);
        }
        for (const each of files) tabs.open(each);
      },
    ),
  );
}
