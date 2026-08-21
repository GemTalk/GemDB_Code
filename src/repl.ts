import * as path from 'path';
import * as vscode from 'vscode';
import { shellQuote } from './osConfig';
import { findNetldi, findStone } from './processes';
import { ensureRunning } from './lifecycle';
import { PyReplTerminal } from './pyRepl';
import { cliPath } from './cli';

/**
 * Make sure the database is up, starting it if it is not.
 *
 * Asking "shall I start it?" here would be a question with one sensible
 * answer: the user has just asked to run Python, and Python only runs inside
 * the database. So this starts it instead — the one thing that genuinely needs
 * consent, raising shared memory, still prompts on its way through.
 */
async function requireRunning(extensionPath: string): Promise<boolean> {
  if (findStone() && findNetldi()) return true;
  return ensureRunning(extensionPath);
}

/**
 * Open a Python prompt running inside the database — a new one every time.
 *
 * Deliberately not "reveal the existing terminal": each press is a fresh
 * database session, so opening two is the two-connection demonstration —
 * separate uncommitted state, one database. The counter names them the way a
 * user will refer to them.
 */
let replCounter = 0;
export async function openRepl(extensionPath: string): Promise<void> {
  if (!(await requireRunning(extensionPath))) return;

  replCounter += 1;
  const name = replCounter === 1 ? 'GemDB Shell' : `GemDB Shell ${replCounter}`;
  const terminal = vscode.window.createTerminal({
    name,
    pty: new PyReplTerminal(extensionPath, name),
    iconPath: new vscode.ThemeIcon('symbol-namespace'),
  });
  terminal.show();
}

/**
 * Run a Python file inside the database.
 *
 * Each run gets its own terminal session, which is the semantics a developer
 * expects from "run this file" — the REPL's accumulated state is a separate
 * thing, and reusing it would make runs depend on what was typed earlier.
 */
export async function runFile(extensionPath: string, uri?: vscode.Uri): Promise<void> {
  const target = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!target) {
    void vscode.window.showErrorMessage('Open a Python file to run it in GemDB.');
    return;
  }
  if (!target.fsPath.endsWith('.py')) {
    void vscode.window.showErrorMessage(`${path.basename(target.fsPath)} is not a Python file.`);
    return;
  }
  if (!(await requireRunning(extensionPath))) return;

  // Save first: the database reads the file from disk, so an unsaved buffer
  // would silently run the previous version.
  const document = vscode.workspace.textDocuments.find(
    (d) => d.uri.toString() === target.toString(),
  );
  if (document?.isDirty) await document.save();

  // The same command a user could type themselves: the generated gemdb
  // wrapper sets its own environment, so the terminal needs none from us —
  // and what scrolls past is exactly what the CLI section of the README says.
  const terminal = vscode.window.createTerminal({
    name: `GemDB: ${path.basename(target.fsPath)}`,
    iconPath: new vscode.ThemeIcon('play'),
  });
  terminal.show();
  terminal.sendText(`${shellQuote(cliPath())} ${shellQuote(target.fsPath)}`);
}
