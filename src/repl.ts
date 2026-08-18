import * as path from 'path';
import * as vscode from 'vscode';
import { shellQuote } from './osConfig';
import { grailPath } from './paths';
import { engineEnvironment, findNetldi, findStone } from './processes';
import { ensureRunning } from './lifecycle';

const REPL_TERMINAL = 'GemDB Python';

/**
 * Run Python through Grail's own topaz driver.
 *
 * Grail ships `scripts/grail.tpz`, which is both its REPL and its script
 * runner — the same entry point its `./grail` command uses. Driving that
 * directly means the terminal experience here is exactly the one Grail's own
 * documentation describes, rather than a second implementation of it that can
 * disagree.
 *
 * The two configuration flags match Grail's `./grail`: a larger temporary
 * object space and a larger code cache than the stock session, both of which
 * Python needs well before Smalltalk does.
 */
const TOPAZ_ARGS = [
  '-lq',
  '-S',
  'scripts/grail.tpz',
  '-T',
  '400000',
  '-C',
  'GEM_TEMPOBJ_CODE_SIZE=300000;',
];

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

/** Open (or reveal) a Python prompt running inside the database. */
export async function openRepl(extensionPath: string): Promise<void> {
  if (!(await requireRunning(extensionPath))) return;

  const existing = vscode.window.terminals.find((t) => t.name === REPL_TERMINAL);
  if (existing) {
    existing.show();
    return;
  }

  const terminal = vscode.window.createTerminal({
    name: REPL_TERMINAL,
    cwd: grailPath(),
    env: engineEnvironment(),
    iconPath: new vscode.ThemeIcon('symbol-namespace'),
  });
  terminal.show();
  terminal.sendText(`topaz ${TOPAZ_ARGS.map(shellQuote).join(' ')} --`);
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

  const terminal = vscode.window.createTerminal({
    name: `GemDB: ${path.basename(target.fsPath)}`,
    cwd: grailPath(),
    env: engineEnvironment(),
    iconPath: new vscode.ThemeIcon('play'),
  });
  terminal.show();
  terminal.sendText(
    `topaz ${TOPAZ_ARGS.map(shellQuote).join(' ')} -- ${shellQuote(target.fsPath)}`,
  );
}
