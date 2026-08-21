import * as vscode from 'vscode';
import { ensureRunning } from './lifecycle';
import { errorMessage, log } from './log';
import { PyResult, isErrorResult, resetScope, runPython } from './pythonQueries';
import { interrupt } from './session';

/**
 * A Jupyter kernel whose Python runs inside the database.
 *
 * VS Code ships the `jupyter-notebook` notebook type and its `.ipynb`
 * serializer as a built-in, so registering a controller against it is enough
 * to make GemDB appear in the kernel picker of any notebook the user opens —
 * no other extension required.
 *
 * Cells share globals the way a notebook user expects: `x = 1` in one cell is
 * visible in the next. That state lives in the database session, keyed by the
 * notebook's URI, so two open notebooks do not see each other's variables.
 */
export const NOTEBOOK_TYPE = 'jupyter-notebook';
export const CONTROLLER_ID = 'gemdb-python';

export class GemDbNotebookController {
  private readonly controller: vscode.NotebookController;
  private executionOrder = 0;

  constructor(private readonly extensionPath: string) {
    this.controller = vscode.notebooks.createNotebookController(
      CONTROLLER_ID,
      NOTEBOOK_TYPE,
      'GemDB (Python in the database)',
    );
    this.controller.supportedLanguages = ['python'];
    this.controller.supportsExecutionOrder = true;
    this.controller.description = 'Runs Python inside your GemDB database';
    this.controller.executeHandler = (cells) => this.executeCells(cells);
    this.controller.interruptHandler = async () => interrupt();
  }

  dispose(): void {
    this.controller.dispose();
  }

  /**
   * Cells run one at a time. They share a single database session and the
   * call into it is synchronous, so there is no concurrency to be had — and
   * running them in order is what makes a notebook reproducible anyway.
   */
  private async executeCells(cells: vscode.NotebookCell[]): Promise<void> {
    // Running a cell is a request to run Python, and Python only runs inside
    // the database — so start it rather than asking. Done once for the whole
    // batch, before any cell reports a spurious failure.
    if (!(await ensureRunning(this.extensionPath))) {
      for (const cell of cells)
        this.failCell(cell, 'GemDB is not running, so the cell was not run.');
      return;
    }
    for (const cell of cells) {
      await this.executeCell(cell);
    }
  }

  /** Mark a cell failed without having attempted it. */
  private failCell(cell: vscode.NotebookCell, message: string): void {
    const execution = this.controller.createNotebookCellExecution(cell);
    execution.start(Date.now());
    this.endWithError(execution, message);
  }

  private async executeCell(cell: vscode.NotebookCell): Promise<void> {
    const execution = this.controller.createNotebookCellExecution(cell);
    execution.executionOrder = ++this.executionOrder;
    execution.start(Date.now());

    const source = cell.document.getText();
    if (!source.trim()) {
      execution.replaceOutput([]);
      execution.end(true, Date.now());
      return;
    }

    // print() streams: each chunk repaints the cell's text output, so a
    // long-running cell shows its progress while it runs instead of one block
    // at the end. The final result (or error) is appended after it, below.
    let printed = '';
    const textOutput = (text: string): vscode.NotebookCellOutput =>
      new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.text(text, 'text/plain')]);

    let result: PyResult;
    try {
      result = await runPython(source, cell.notebook.uri.toString(), (chunk) => {
        printed += chunk;
        execution.replaceOutput([textOutput(printed)]);
      });
    } catch (e) {
      // Everything that is not the Python code's own fault arrives here: the
      // database is stopped, the session dropped, Grail is missing. Those are
      // about the environment, not the cell, so they are worth logging too.
      const message = errorMessage(e);
      log(`Notebook cell failed: ${message}`);
      this.endWithError(execution, message);
      return;
    }

    // What the cell printed and what it evaluated to are different outputs,
    // shown in that order — print() first, the way the code produced them.
    // `result.output` is the buffered spelling of the same text (a session
    // that could not stream); with streaming it is empty and `printed` has
    // already accumulated everything.
    if (result.output) printed += result.output;
    const outputs: vscode.NotebookCellOutput[] = [];
    if (printed) outputs.push(textOutput(printed));

    if (isErrorResult(result.value)) {
      execution.replaceOutput(outputs);
      this.appendError(execution, result.value);
      return;
    }

    if (result.value) outputs.push(textOutput(result.value));
    execution.replaceOutput(outputs);
    execution.end(true, Date.now());
  }

  private endWithError(execution: vscode.NotebookCellExecution, message: string): void {
    execution.replaceOutput([this.errorOutput(message)]);
    execution.end(false, Date.now());
  }

  /** Fail the cell while keeping what it already printed on screen. */
  private appendError(execution: vscode.NotebookCellExecution, message: string): void {
    execution.appendOutput([this.errorOutput(message)]);
    execution.end(false, Date.now());
  }

  private errorOutput(message: string): vscode.NotebookCellOutput {
    const error = new Error(message);
    error.name = 'GemDBError';
    return new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.error(error)]);
  }
}

/** Forget the active notebook's globals — the "restart kernel" of this kernel. */
export async function resetActiveNotebook(): Promise<void> {
  const editor = vscode.window.activeNotebookEditor;
  if (!editor) {
    void vscode.window.showErrorMessage('Open a notebook to reset it.');
    return;
  }
  try {
    resetScope(editor.notebook.uri.toString());
    void vscode.window.showInformationMessage('Notebook variables cleared.');
  } catch (e) {
    void vscode.window.showErrorMessage(`Could not clear the notebook: ${errorMessage(e)}`);
  }
}

/**
 * Open a new notebook with one Python cell, ready to run.
 *
 * The starter cell is not decoration: `import gemstone` is the one thing that
 * makes this different from any other Python notebook, and showing it here is
 * cheaper than explaining it.
 */
export async function newNotebook(): Promise<void> {
  const starter = [
    '# Python here runs inside your GemDB database.',
    '# The gemstone module reaches the data stored in it.',
    'import gemstone',
    '',
    'gemstone["greeting"] = "Hello from GemDB!"',
    'gemstone.system.commit()',
    'gemstone["greeting"]',
  ].join('\n');

  const cell = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, starter, 'python');
  const data = new vscode.NotebookData([cell]);
  data.metadata = {
    // Tells the .ipynb serializer this notebook is Python, so the cell
    // language and syntax highlighting are right from the first open.
    metadata: {
      kernelspec: { display_name: 'GemDB', language: 'python', name: 'gemdb' },
      language_info: { name: 'python' },
    },
  };

  const document = await vscode.workspace.openNotebookDocument(NOTEBOOK_TYPE, data);
  await vscode.window.showNotebookDocument(document);
}
