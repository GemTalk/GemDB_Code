import * as vscode from 'vscode';
import { isRunning, listProcesses } from './processes';

/**
 * An always-visible indicator that a database is running.
 *
 * This exists because GemDB starts the database on your behalf the first time
 * you run Python. The processes it starts detach from the editor and outlive
 * it, so something has to say so somewhere you cannot miss — a status readout
 * buried in a view you have to open first is not good enough for a process you
 * never explicitly started.
 *
 * It is shown only while the database is up. Absence means nothing is running,
 * which is the honest reading and keeps the status bar quiet the rest of the
 * time.
 */
export class GemDbStatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    // Right-aligned, low priority: this is ambient state, not something to
    // push the user's language and line-ending indicators around.
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    this.item.command = 'gemdb.stop';
    this.item.name = 'GemDB';
  }

  /** Re-read the engine's process list and show or hide accordingly. */
  refresh(): void {
    // The stone alone decides this. A database with no listener is still a
    // database holding your data, and hiding the indicator would take away the
    // one control that stops it.
    if (!isRunning(listProcesses())) {
      this.item.hide();
      return;
    }
    this.item.text = '$(database) GemDB';
    this.item.tooltip = new vscode.MarkdownString(
      'The GemDB database is **running**.\n\n' +
        'It keeps running after you close the editor, so your data stays available.\n\n' +
        'Click to stop it.',
    );
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
