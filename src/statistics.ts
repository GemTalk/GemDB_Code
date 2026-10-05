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
 * `scripts/bundle-stats.mjs` turns GemDB Stats' index.html into `host.html`,
 * a template carrying the page's CSP and a loader that registers no service
 * worker. What is left for here is what differs per panel: the four
 * `{{GEMDB_*}}` placeholders.
 */

/** The custom editor's view type, as package.json declares it. */
export const STATISTICS_VIEW_TYPE = 'gemdb.statistics';

/**
 * What the page is told about its host, as `window.gemdbStatsHost`. This is
 * the contract with GemDB Stats: the app reads it at startup and fetches
 * `file.url`, which serves the file's bytes exactly as they are on disk —
 * gzip-compressed for a `.out.gz`.
 */
export interface StatsHost {
  file: { url: string; name: string };
}

export interface HostPageValues {
  /** The build's own resource URL, ending in `/`; relative URLs resolve against it. */
  base: string;
  /** The webview's resource origin, which serves the build and the file. */
  cspSource: string;
  /** Fresh for every page, so nothing injected into the page can guess it. */
  nonce: string;
  host: StatsHost;
}

/** `host.html` with this panel's values in place of its placeholders. */
export function fillHostPage(template: string, values: HostPageValues): string {
  // `<` is escaped so a file named `</script>` cannot end the script it sits in.
  const host = JSON.stringify(values.host).replace(/</g, '\\u003c');
  const fills: Record<string, string> = {
    '{{GEMDB_BASE}}': values.base,
    '{{GEMDB_CSP_SOURCE}}': values.cspSource,
    '{{GEMDB_NONCE}}': values.nonce,
    '{{GEMDB_HOST}}': host,
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

class StatisticsEditorProvider implements vscode.CustomReadonlyEditorProvider {
  constructor(private readonly extensionUri: vscode.Uri) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => {} };
  }

  resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): void {
    const webview = panel.webview;
    const build = vscode.Uri.joinPath(this.extensionUri, 'stats');
    webview.options = {
      enableScripts: true,
      // The build, and the folder holding the file. A root is a folder, so the
      // page could fetch the file's neighbours too — read-only, and only what
      // the user's own editor could already open.
      localResourceRoots: [build, vscode.Uri.joinPath(document.uri, '..')],
    };
    const nonce = crypto.randomBytes(16).toString('base64');
    let template: string;
    try {
      template = fs.readFileSync(path.join(build.fsPath, 'host.html'), 'utf8');
    } catch (error) {
      log(`GemDB Stats is not in this build: ${errorMessage(error)}`);
      webview.html = unavailablePage(
        nonce,
        'This build of GemDB Code does not include GemDB Stats. ' +
          'A development build gets it from `npm run bundle:stats`.',
      );
      return;
    }
    webview.html = fillHostPage(template, {
      base: `${webview.asWebviewUri(build).toString()}/`,
      cspSource: webview.cspSource,
      nonce,
      host: {
        file: {
          url: webview.asWebviewUri(document.uri).toString(),
          name: path.posix.basename(document.uri.path),
        },
      },
    });
  }
}

/** Open Statistics File…: the file the command was given, or one the user picks. */
async function openStatistics(uri?: vscode.Uri): Promise<void> {
  const target =
    uri ??
    (
      await vscode.window.showOpenDialog({
        title: 'Open Statistics File',
        openLabel: 'Open',
        canSelectMany: false,
        filters: { 'statmon files': ['out', 'gz'], 'All files': ['*'] },
      })
    )?.[0];
  if (!target) return;
  await vscode.commands.executeCommand('vscode.openWith', target, STATISTICS_VIEW_TYPE);
}

export function registerStatistics(extensionUri: vscode.Uri): vscode.Disposable {
  return vscode.Disposable.from(
    vscode.window.registerCustomEditorProvider(
      STATISTICS_VIEW_TYPE,
      new StatisticsEditorProvider(extensionUri),
      {
        // A hidden webview is discarded by default, and bringing it back would
        // start Flutter and parse the file again — seconds for a small file,
        // tens of seconds for a large one. Kept, at the cost of its memory.
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: true,
      },
    ),
    vscode.commands.registerCommand('gemdb.openStatistics', (uri?: vscode.Uri) =>
      openStatistics(uri),
    ),
  );
}
