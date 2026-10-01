/**
 * Just enough of the editor API to unit-test the parts of GemDB that only
 * touch it to read a setting — plus, since `activate()` is now under test too,
 * the handful of surfaces it reaches at activation time: registering
 * commands, a status bar item, a tree view, and the three `workspace.on*`
 * listeners it wires up. Anything else stays deliberately absent: a test that
 * needs more than this is a test that should be exercising something else.
 *
 * `env.createTelemetryLogger` is the one deliberate exception to "just enough
 * to read a setting". It is real VS Code plumbing, and what records every
 * event: the stand-in `TelemetryReporter` at the repo root's
 * `__mocks__/@vscode/extension-telemetry.ts` calls straight through to it,
 * since the real package cannot load outside an extension host (see that
 * file). So a test exercises the real `telemetry.ts` — real `send`, real
 * `baseProperties` merging, real event names — and only the third-party
 * reporter between it and this logger is faked. The failure mode it guards
 * against is silent data loss (an event nobody notices never arrived), not a
 * broken feature, which is worth the departure from the rest of this file.
 */

const settings = new Map<string, unknown>();

/** Lines written to the output channel, for a test that wants to assert on them. */
export const __log: string[] = [];

/** Every event the fake telemetry logger has seen, in order. */
export interface FakeTelemetryEvent {
  name: string;
  properties: Record<string, unknown>;
  measurements: Record<string, number> | undefined;
}
export const __telemetry: FakeTelemetryEvent[] = [];

/** Set a setting for the duration of a test, e.g. `gemdb.rootPath`. */
export function __setSetting(key: string, value: unknown): void {
  settings.set(key, value);
}

export function __resetSettings(): void {
  settings.clear();
  __log.length = 0;
  __controllers.length = 0;
  __commands.clear();
  __telemetry.length = 0;
}

/** Command ids registered so far, so a test can assert on them or invoke one. */
export const __commands = new Map<string, (...args: unknown[]) => unknown>();

export class Disposable {
  constructor(private readonly callOnDispose: () => void) {}
  dispose(): void {
    this.callOnDispose();
  }
}

export interface FakeStatusBarItem {
  text: string;
  tooltip: unknown;
  command: string | undefined;
  name: string | undefined;
  show(): void;
  hide(): void;
  dispose(): void;
}

export const StatusBarAlignment = { Left: 1, Right: 2 } as const;

export const UIKind = { Desktop: 1, Web: 2 } as const;

export const ExtensionMode = { Production: 1, Development: 2, Test: 3 } as const;

/**
 * A fake `env.createTelemetryLogger`, standing in for VS Code's own.
 *
 * `isUsageEnabled: false` is insurance, and measured: no suite runs the real
 * package today, but if one ever did, `@vscode/extension-telemetry` only
 * instantiates its App Insights sender when the logger reports enabled,
 * while `logUsage` records every event regardless — so this
 * sees every event with its real properties and makes no network call.
 *
 * Replicates VS Code's own merge quirk: when `data.properties` is falsy, its
 * real `TelemetryLogger` mixes `common.*` properties into the top level of
 * `data` instead of into `data.properties` — which is silently dropped by any
 * reader that looks only at `data.properties`. Modelled here with one fake
 * common property, so a call that forgets to pass a properties object (see
 * `telemetry.ts`'s own warning against ever doing that) is regression-tested
 * rather than only commented on.
 */
const FAKE_COMMON_PROPERTIES: Record<string, string> = { 'common.fake': 'yes' };

/** Two-line insurance: nothing here reads `env` today, but `activate()` does. */
export const env = {
  remoteName: undefined as string | undefined,
  clipboard: {
    writeText: (text: string): Promise<void> => {
      __clipboard.text = text;
      return Promise.resolve();
    },
  },
  uiKind: UIKind.Desktop,
  createTelemetryLogger(
    _sender: unknown,
    _options?: unknown,
  ): {
    isUsageEnabled: boolean;
    isErrorsEnabled: boolean;
    onDidChangeEnableStates: (listener: () => void) => Disposable;
    logUsage: (
      name: string,
      data?: { properties?: Record<string, unknown>; measurements?: Record<string, number> },
    ) => void;
    logError: (name: string) => void;
    dispose: () => void;
  } {
    return {
      isUsageEnabled: false,
      isErrorsEnabled: false,
      onDidChangeEnableStates: () => new Disposable(() => {}),
      logUsage: (name, data) => {
        const properties = data?.properties;
        __telemetry.push({
          name,
          properties: properties ? { ...FAKE_COMMON_PROPERTIES, ...properties } : {},
          measurements: data?.measurements,
        });
      },
      logError: () => {},
      dispose: () => {},
    };
  },
};

/** A tree view as created, recording what it was asked to reveal. */
export interface FakeTreeView {
  id: string;
  options: unknown;
  message: string | undefined;
  description: string | undefined;
  reveals: Array<{ element: unknown; options: unknown }>;
  reveal(element: unknown, options?: unknown): Promise<void>;
  onDidChangeVisibility(listener: (event: { visible: boolean }) => void): Disposable;
  dispose(): void;
}

/** Tree views created so far, by view id. */
export const __treeViews = new Map<string, FakeTreeView>();

/** What was last written to the clipboard. */
export const __clipboard = { text: '' };

export const window = {
  createOutputChannel(_name: string) {
    return {
      appendLine: (line: string) => __log.push(line),
      show: () => {},
      dispose: () => {},
    };
  },
  createStatusBarItem(_alignment?: unknown, _priority?: number): FakeStatusBarItem {
    return {
      text: '',
      tooltip: undefined,
      command: undefined,
      name: undefined,
      show: () => {},
      hide: () => {},
      dispose: () => {},
    };
  },
  registerTreeDataProvider(_viewId: string, _provider: unknown): Disposable {
    return new Disposable(() => {});
  },
  createTreeView(viewId: string, options: unknown): FakeTreeView {
    const view: FakeTreeView = {
      id: viewId,
      options,
      message: undefined,
      description: undefined,
      reveals: [],
      reveal: async (element: unknown, revealOptions?: unknown) => {
        view.reveals.push({ element, options: revealOptions });
      },
      onDidChangeVisibility: (_listener: (event: { visible: boolean }) => void) =>
        new Disposable(() => {}),
      dispose: () => {},
    };
    __treeViews.set(viewId, view);
    return view;
  },
  /** What the active notebook editor shows, if a test sets one. */
  activeNotebookEditor: undefined as { notebook: { uri: { toString(): string } } } | undefined,
  /** Answers undefined (Escape) unless a test spies on it. */
  showInputBox(_options?: unknown): Promise<string | undefined> {
    return Promise.resolve(undefined);
  },
  /** Answers undefined (Escape) unless a test spies on it. */
  showQuickPick<T>(_items: T[], _options?: unknown): Promise<T | undefined> {
    return Promise.resolve(undefined);
  },
  onDidChangeWindowState(_listener: (state: { focused: boolean }) => void): Disposable {
    return new Disposable(() => {});
  },
  showInformationMessage(_message: string, ..._items: unknown[]): Promise<string | undefined> {
    return Promise.resolve(undefined);
  },
  showWarningMessage(_message: string, ..._items: unknown[]): Promise<string | undefined> {
    return Promise.resolve(undefined);
  },
  showErrorMessage(_message: string, ..._items: unknown[]): Promise<string | undefined> {
    return Promise.resolve(undefined);
  },
  /** A terminal that records nothing and does nothing — callers only ever `show()`/`sendText()` it. */
  createTerminal(_nameOrOptions?: unknown): {
    show(): void;
    sendText(text: string): void;
    dispose(): void;
  } {
    return { show: () => {}, sendText: () => {}, dispose: () => {} };
  },
  /**
   * Progress is a pass-through here: run the callback and return its result.
   * Nothing asserts on the notification itself — that is the editor's job,
   * not ours — and the token never reports cancelled, since nothing here can
   * drive one.
   */
  withProgress<T>(
    _options: unknown,
    task: (
      progress: { report: (value: { message?: string }) => void },
      token: { isCancellationRequested: boolean },
    ) => Thenable<T>,
  ): Thenable<T> {
    return task({ report: () => {} }, { isCancellationRequested: false });
  },
};

export const commands = {
  registerCommand(id: string, callback: (...args: unknown[]) => unknown): Disposable {
    __commands.set(id, callback);
    return new Disposable(() => __commands.delete(id));
  },
  executeCommand(id: string, ...args: unknown[]): unknown {
    return __commands.get(id)?.(...args);
  },
};

export const ProgressLocation = { Notification: 15 } as const;

/** Minimal event plumbing, enough for a tree view's change emitter. */
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

export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 } as const;

export const InputBoxValidationSeverity = { Info: 1, Warning: 2, Error: 3 } as const;

export class MarkdownString {
  constructor(readonly value: string = '') {}
}

export class TreeItem {
  description?: string;
  tooltip?: string | MarkdownString;
  iconPath?: unknown;
  contextValue?: string;
  command?: unknown;
  constructor(
    readonly label: string,
    readonly collapsibleState: number = 0,
  ) {}
}

export class ThemeColor {
  constructor(readonly id: string) {}
}

export class ThemeIcon {
  constructor(
    readonly id: string,
    readonly color?: ThemeColor,
  ) {}
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
  interruptHandler?: (notebook: unknown) => unknown;
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

export const NotebookCellKind = { Markup: 1, Code: 2 } as const;

/** What `debug.startDebugging` answers; a test sets it to false to refuse, or to an Error to reject. */
export const __debugStartResult: { value: boolean | Error } = { value: true };

/** What `debug.startDebugging` was asked to start, for a test to inspect. */
export const __debugStarts: unknown[] = [];
/** The options each of those starts passed. */
export const __debugStartOptions: unknown[] = [];

/** Debug adapter factories registered so far, by debug type. */
export const __debugFactories = new Map<string, unknown>();

export const debug = {
  registerDebugAdapterDescriptorFactory: (type: string, factory: unknown) => {
    __debugFactories.set(type, factory);
    return new Disposable(() => __debugFactories.delete(type));
  },
  startDebugging: (
    _folder: unknown,
    configuration: unknown,
    options?: unknown,
  ): Promise<boolean> => {
    __debugStarts.push(configuration);
    __debugStartOptions.push(options);
    const result = __debugStartResult.value;
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  },
  stopDebugging: (): Promise<void> => Promise.resolve(),
  activeDebugSession: undefined as { id: string; type: string } | undefined,
};

export class DebugAdapterInlineImplementation {
  constructor(readonly implementation: unknown) {}
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
  notebookDocuments: [] as unknown[],
  getConfiguration(section: string) {
    return {
      get<T>(key: string, fallback: T): T {
        const value = settings.get(`${section}.${key}`);
        return (value as T) ?? fallback;
      },
    };
  },
  /** No open documents by default — `runFile` reads a saved file either way. */
  textDocuments: [] as {
    uri: { toString(): string };
    isDirty: boolean;
    save(): Promise<boolean>;
  }[],
  onDidCloseNotebookDocument(_listener: (notebook: unknown) => void): Disposable {
    return new Disposable(() => {});
  },
  onDidRenameFiles(
    _listener: (event: { files: { oldUri: unknown; newUri: unknown }[] }) => void,
  ): Disposable {
    return new Disposable(() => {});
  },
  onDidChangeConfiguration(
    _listener: (event: { affectsConfiguration(section: string): boolean }) => void,
  ): Disposable {
    return new Disposable(() => {});
  },
};
