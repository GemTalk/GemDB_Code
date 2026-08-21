/**
 * Just enough of the editor API to unit-test the parts of GemDB that only
 * touch it to read a setting.
 *
 * Most of this extension is inseparable from the editor and is not worth
 * faking. The pieces worth testing — path resolution, the setup lock — reach
 * `vscode` only to read a setting or write a log line, so that is all this
 * provides. Anything else stays deliberately absent: a test that needs more
 * than this is a test that should be exercising something else.
 */

const settings = new Map<string, unknown>();

/** Lines written to the output channel, for a test that wants to assert on them. */
export const __log: string[] = [];

/** Set a setting for the duration of a test, e.g. `gemdb.rootPath`. */
export function __setSetting(key: string, value: unknown): void {
  settings.set(key, value);
}

export function __resetSettings(): void {
  settings.clear();
  __log.length = 0;
  __controllers.length = 0;
}

export const window = {
  createOutputChannel(_name: string) {
    return {
      appendLine: (line: string) => __log.push(line),
      show: () => {},
      dispose: () => {},
    };
  },
};

/**
 * Progress is a pass-through here.
 *
 * `withProgress` exists in this stub only because `stop` is wrapped in one;
 * running the callback and returning its result is the whole of what a test
 * cares about. Nothing asserts on the notification itself — that is the
 * editor's job, not ours.
 */
export const ProgressLocation = { Notification: 15 } as const;

/** Minimal event plumbing, enough for a Pseudoterminal's emitters. */
export class EventEmitter<T> {
  private listeners: Array<(value: T) => void> = [];
  readonly event = (listener: (value: T) => void): { dispose(): void } => {
    this.listeners.push(listener);
    return { dispose: () => this.listeners.splice(this.listeners.indexOf(listener), 1) };
  };
  fire(value: T): void {
    for (const listener of [...this.listeners]) listener(value);
  }
  dispose(): void {
    this.listeners = [];
  }
}

export class ThemeIcon {
  constructor(readonly id: string) {}
}

/**
 * Enough of the notebook API to drive the kernel without an editor.
 *
 * This is the largest thing the stub fakes, and it is here for one reason: the
 * controller's `executeHandler` is the entry point VS Code itself calls, so
 * capturing it lets a test exercise the real path rather than a private method
 * reached through a back door. What is faked is only the recording surface —
 * which cells were started, in what order, and what output they ended with.
 * Whether VS Code offers the controller in the kernel picker is VS Code's
 * business and is not modelled here.
 */
export class NotebookCellOutputItem {
  constructor(
    readonly data: string,
    readonly mime: string,
  ) {}

  static text(value: string, mime = 'text/plain'): NotebookCellOutputItem {
    return new NotebookCellOutputItem(value, mime);
  }

  static error(err: Error): NotebookCellOutputItem {
    return new NotebookCellOutputItem(err.message, 'application/vnd.code.notebook.error');
  }
}

export class NotebookCellOutput {
  constructor(readonly items: NotebookCellOutputItem[]) {}
}

export interface FakeExecution {
  cell: unknown;
  executionOrder?: number;
  started: boolean;
  success?: boolean;
  output: NotebookCellOutput[];
}

export interface FakeController {
  id: string;
  notebookType: string;
  supportedLanguages?: string[];
  supportsExecutionOrder?: boolean;
  description?: string;
  executeHandler?: (cells: unknown[]) => unknown;
  interruptHandler?: () => unknown;
  /** Every execution this controller created, in the order it created them. */
  executions: FakeExecution[];
  createNotebookCellExecution(cell: unknown): {
    executionOrder?: number;
    start(): void;
    end(success: boolean): void;
    replaceOutput(output: NotebookCellOutput[]): void;
    appendOutput(output: NotebookCellOutput[]): void;
  };
  dispose(): void;
}

/** Controllers created so far, so a test can reach the one under test. */
export const __controllers: FakeController[] = [];

export const notebooks = {
  createNotebookController(id: string, notebookType: string, _label: string): FakeController {
    const controller: FakeController = {
      id,
      notebookType,
      executions: [],
      createNotebookCellExecution(cell: unknown) {
        const record: FakeExecution = { cell, started: false, output: [] };
        controller.executions.push(record);
        return {
          set executionOrder(order: number | undefined) {
            record.executionOrder = order;
          },
          get executionOrder(): number | undefined {
            return record.executionOrder;
          },
          start: () => {
            record.started = true;
          },
          end: (success: boolean) => {
            record.success = success;
          },
          replaceOutput: (output: NotebookCellOutput[]) => {
            record.output = output;
          },
          appendOutput: (output: NotebookCellOutput[]) => {
            record.output = [...record.output, ...output];
          },
        };
      },
      dispose: () => {},
    };
    __controllers.push(controller);
    return controller;
  },
};

export const workspace = {
  getConfiguration(section: string) {
    return {
      get<T>(key: string, fallback: T): T {
        const value = settings.get(`${section}.${key}`);
        return (value as T) ?? fallback;
      },
    };
  },
};
