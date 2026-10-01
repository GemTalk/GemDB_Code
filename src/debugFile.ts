import * as path from 'path';
import * as vscode from 'vscode';
import { fileOwner } from './fileOwner';
import { ensureRunning } from './lifecycle';
import { errorMessage, log } from './log';
import { PyResult, isErrorResult, runPythonFile } from './pythonQueries';
import { SessionOwner, closeSessionFor, interruptSessionFor } from './session';
import { EVIDENCE, SURFACE, TRIGGER, reportPythonUsed } from './telemetry';

/**
 * Debug Python File in GemDB: run a `.py` file in a session this window
 * holds, so a breakpoint() in it opens Run and Debug the way a notebook
 * cell's does. Run Python File stays as it was — a terminal running the
 * `gemdb` command, which has no debugger to open.
 *
 * The file's session lives as long as its terminal: it outlasts the run, so
 * Persisted Objects can still commit or abort what the run added, and closing
 * the terminal logs it out, as ending `gemdb file.py` would.
 */

/** Text for a terminal, which wants carriage returns. */
export function terminalText(text: string): string {
  return text.replace(/\r?\n/g, '\r\n');
}

const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

/** What the terminal says once a run is over. */
export function endOfRun(result: PyResult | Error): string {
  if (result instanceof Error) return `${RED}${result.message}${RESET}\r\n`;
  if (result.stopped) return `${DIM}Stopped.${RESET}\r\n`;
  if (isErrorResult(result.value)) return `${RED}${terminalText(result.value)}${RESET}\r\n`;
  return `${DIM}Finished.${RESET}\r\n`;
}

/** One file's terminal, and its run if one is going. */
class FileTerminal {
  private readonly writes = new vscode.EventEmitter<string>();
  private readonly opened: Promise<void>;
  readonly terminal: vscode.Terminal;
  running: Promise<void> | undefined;
  closed = false;

  constructor(
    private readonly owner: SessionOwner,
    onClosed: () => void,
  ) {
    let markOpen = (): void => {};
    this.opened = new Promise((resolve) => (markOpen = resolve));
    this.terminal = vscode.window.createTerminal({
      name: `GemDB Debug: ${owner.label}`,
      iconPath: new vscode.ThemeIcon('debug-alt'),
      pty: {
        onDidWrite: this.writes.event,
        open: () => markOpen(),
        close: () => {
          this.closed = true;
          onClosed();
          // Ending the terminal ends the run, then the session it ran in.
          if (this.running) interruptSessionFor(owner.key);
          void (this.running ?? Promise.resolve()).finally(() => closeSessionFor(owner.key));
        },
        handleInput: (data: string) => {
          if (data === '\x03' && this.running) interruptSessionFor(owner.key);
        },
      },
    });
  }

  write(text: string): void {
    void this.opened.then(() => this.writes.fire(text));
  }
}

const terminals = new Map<string, FileTerminal>();

export async function debugFile(
  extensionPath: string,
  uri: vscode.Uri | undefined,
  onFinished: () => void = () => {},
): Promise<void> {
  const target = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!target) {
    void vscode.window.showErrorMessage('Open a Python file to debug it in GemDB.');
    return;
  }
  const file = target.fsPath;
  if (!file.endsWith('.py')) {
    void vscode.window.showErrorMessage(`${path.basename(file)} is not a Python file.`);
    return;
  }
  // Run File and notebook cells get VS Code's own trust prompt, because a terminal or a
  // kernel runs them. This runs through GemDB's session, which VS Code never sees.
  if (!vscode.workspace.isTrusted) {
    const choice = await vscode.window.showWarningMessage(
      `${path.basename(file)} runs your code, and VS Code has not been told to trust this folder.`,
      'Manage Workspace Trust',
    );
    if (choice === 'Manage Workspace Trust') {
      await vscode.commands.executeCommand('workbench.trust.manage');
    }
    return;
  }
  const owner = fileOwner(file);
  const existing = terminals.get(owner.key);
  if (existing?.running) {
    existing.terminal.show();
    void vscode.window.showInformationMessage(
      `${owner.label} is already running in GemDB. Stop it, or let it finish, to run it again.`,
    );
    return;
  }
  if (!(await ensureRunning(extensionPath, TRIGGER.debugFile))) return;

  // The database reads the file from disk, so an unsaved buffer would run the previous version.
  const document = vscode.workspace.textDocuments.find(
    (d) => d.uri.toString() === target.toString(),
  );
  if (document?.isDirty) await document.save();

  let term = terminals.get(owner.key);
  if (!term || term.closed) {
    term = new FileTerminal(owner, () => terminals.delete(owner.key));
    terminals.set(owner.key, term);
  }
  const shown = term;
  shown.terminal.show();
  shown.write(`${DIM}▶ ${owner.label} — breakpoint() opens Run and Debug${RESET}\r\n`);

  const run = (async () => {
    let result: PyResult | Error;
    try {
      result = await runPythonFile(file, owner, (chunk) => shown.write(terminalText(chunk)));
      if (result.output) shown.write(terminalText(result.output));
      reportPythonUsed(SURFACE.debugFile, EVIDENCE.executed);
    } catch (e) {
      log(`Debug Python File failed: ${errorMessage(e)}`);
      result = new Error(errorMessage(e));
    } finally {
      onFinished();
    }
    shown.write(endOfRun(result));
  })();
  shown.running = run;
  try {
    await run;
  } finally {
    shown.running = undefined;
  }
}
