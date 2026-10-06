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

/** VS Code's open dialog, for a statmon file. */
async function pickStatmonFile(near?: vscode.Uri): Promise<vscode.Uri | undefined> {
  const picked = await vscode.window.showOpenDialog({
    title: 'Open Statistics File',
    openLabel: 'Open',
    canSelectMany: false,
    defaultUri: near,
    filters: { 'statmon files': ['out', 'gz'], 'All files': ['*'] },
  });
  return picked?.[0];
}

const folderOf = (file: vscode.Uri): vscode.Uri => vscode.Uri.joinPath(file, '..');
const nameOf = (file: vscode.Uri): string => path.posix.basename(file.path);

/** One GemDB Stats tab, and the file it is showing. */
class StatisticsPanel {
  private readonly panel: vscode.WebviewPanel;
  /** Every folder a file has been opened from, beside the build itself. */
  private readonly roots: vscode.Uri[];

  constructor(
    private readonly build: vscode.Uri,
    private file: vscode.Uri,
    onDidDispose: () => void,
  ) {
    this.roots = [build, folderOf(file)];
    this.panel = vscode.window.createWebviewPanel(
      STATISTICS_VIEW_TYPE,
      nameOf(file),
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        // A hidden webview is discarded by default, and bringing it back would
        // start Flutter and parse the file again — tens of seconds for a large
        // one. Kept, at the cost of its memory.
        retainContextWhenHidden: true,
        localResourceRoots: this.roots,
      },
    );
    this.panel.onDidDispose(onDidDispose);
    this.panel.webview.onDidReceiveMessage((message: { type?: unknown }) => {
      if (message.type === 'ready') {
        // Every time, not just the first: a page that reloads says `ready`
        // again and has to be told its file again.
        this.post();
      } else if (message.type === 'pickFile') {
        void pickStatmonFile(folderOf(this.file)).then((picked) => {
          if (picked) this.show(picked);
        });
      }
    });
    this.panel.webview.html = this.page();
  }

  get showing(): vscode.Uri {
    return this.file;
  }

  reveal(): void {
    this.panel.reveal();
  }

  /** Show `file` in this tab, in place of the one it was showing. */
  show(file: vscode.Uri): void {
    this.file = file;
    this.panel.title = nameOf(file);
    const folder = folderOf(file);
    if (!this.roots.some((root) => root.toString() === folder.toString())) {
      // The page may only fetch under its roots. Changing them reloads the
      // page, and the reloaded page says `ready`, which sends the file; the
      // `open` below then goes to the page being replaced and is lost.
      this.roots.push(folder);
      this.panel.webview.options = {
        ...this.panel.webview.options,
        localResourceRoots: this.roots,
      };
    }
    this.post();
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
      template = fs.readFileSync(path.join(this.build.fsPath, 'host.html'), 'utf8');
    } catch (error) {
      log(`GemDB Stats is not in this build: ${errorMessage(error)}`);
      return unavailablePage(
        nonce,
        'This build of GemDB Code does not include GemDB Stats. ' +
          'A development build gets it from `npm run bundle:stats`.',
      );
    }
    return fillHostPage(template, {
      base: `${webview.asWebviewUri(this.build).toString()}/`,
      cspSource: webview.cspSource,
      nonce,
    });
  }
}

export function registerStatistics(extensionUri: vscode.Uri): vscode.Disposable {
  const panels = new Set<StatisticsPanel>();

  // A file already open in a tab is brought forward rather than opened twice:
  // a second tab would parse it again and hold a second copy in memory.
  const open = (file: vscode.Uri): void => {
    const existing = [...panels].find((p) => p.showing.toString() === file.toString());
    if (existing) {
      existing.reveal();
      return;
    }
    const build = vscode.Uri.joinPath(extensionUri, 'stats');
    const panel: StatisticsPanel = new StatisticsPanel(build, file, () => panels.delete(panel));
    panels.add(panel);
  };

  return vscode.Disposable.from(
    // From the Command Palette: pick a file first.
    vscode.commands.registerCommand('gemdb.openStatistics', async () => {
      const file = await pickStatmonFile();
      if (file) open(file);
    }),
    // From a .out or .out.gz in the explorer: that file.
    vscode.commands.registerCommand('gemdb.openInStats', (file?: vscode.Uri) => {
      if (file) open(file);
    }),
  );
}
