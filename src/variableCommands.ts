import * as vscode from 'vscode';
import { DEBUG_TYPE, pauseForDebugSession } from './debugger';
import { errorMessage } from './log';

/**
 * Two items on a Variables row's menu, each ending in the Debug Console:
 *
 * - **Show in Debug Console** puts the row's object there, as an entry that
 *   expands like the row, so the next line can be typed beside it without
 *   first clicking over to the console.
 * - **Evaluate with self…** asks for an expression and runs it with `self`
 *   bound to the row's object — `len(self.history)` on any row, however deep
 *   — in the frame selected in Call Stack, as a console line runs.
 *
 * The row's object is reached the way **Add to Persisted Objects…** reaches
 * it: by its registry handle (`Pause.handleFor`), not by a Python path, so a
 * row nested deep in the tree needs no expression to name it. The work is the
 * adapter's `gemdbShowRow` request (`PauseDebugAdapter.showRow`), sent through
 * the debug session so the output lands in that session's console.
 */

export const SHOW_IN_CONSOLE = 'gemdb.showInDebugConsole';
export const EVALUATE_WITH_SELF = 'gemdb.evaluateWithSelf';

/** What VS Code hands a `debug/variables/context` command. */
export interface VariableContext {
  sessionId?: string;
  container?: { variablesReference?: number };
  variable?: { name: string; value: string; variablesReference: number };
}

const NOT_PAUSED =
  'This works on a variable in Run and Debug, while a GemDB notebook cell or Debug Python File ' +
  'run is paused in the debugger.';

/** The paused session, and the right-clicked row's name and registry handle; undefined after saying why. */
function rowTarget(
  context: VariableContext,
): { session: vscode.DebugSession; name: string; handle: number } | undefined {
  const session = vscode.debug.activeDebugSession;
  const pause = pauseForDebugSession(context.sessionId ?? session?.id);
  const variable = context.variable;
  if (
    !session ||
    session.type !== DEBUG_TYPE ||
    (context.sessionId !== undefined && session.id !== context.sessionId) ||
    !pause ||
    !variable
  ) {
    void vscode.window.showErrorMessage(NOT_PAUSED);
    return undefined;
  }
  const handle =
    variable.variablesReference > 0
      ? variable.variablesReference
      : pause.handleFor?.(context.container?.variablesReference ?? 0, variable.name);
  if (!handle) {
    void vscode.window.showErrorMessage(`"${variable.name}" is not an object of its own.`);
    return undefined;
  }
  return { session, name: variable.name, handle };
}

/** The frame selected in Call Stack, when it is in this session. */
function selectedFrame(session: vscode.DebugSession): number | undefined {
  const item = vscode.debug.activeStackItem;
  return item instanceof vscode.DebugStackFrame && item.session.id === session.id
    ? item.frameId
    : undefined;
}

async function showRow(session: vscode.DebugSession, args: Record<string, unknown>): Promise<void> {
  // The console first, so a line that takes a while is seen to be running.
  await vscode.commands.executeCommand('workbench.debug.action.focusRepl');
  try {
    await session.customRequest('gemdbShowRow', args);
  } catch (e) {
    void vscode.window.showErrorMessage(errorMessage(e));
  }
}

/** Show the right-clicked row's object in the Debug Console. */
export async function showInDebugConsole(context: VariableContext): Promise<void> {
  const target = rowTarget(context);
  if (!target) return;
  await showRow(target.session, { handle: target.handle, name: target.name });
}

/** Ask for an expression and show what it gives with `self` bound to the right-clicked row's object. */
export async function evaluateWithSelf(context: VariableContext): Promise<void> {
  const target = rowTarget(context);
  if (!target) return;
  const expression = await vscode.window.showInputBox({
    title: `Evaluate with self = ${target.name}`,
    prompt: `Python, with self bound to ${target.name}. The result opens in the Debug Console.`,
    value: 'self',
    ignoreFocusOut: true,
  });
  if (expression === undefined || !expression.trim()) return;
  const frameId = selectedFrame(target.session);
  await showRow(target.session, {
    handle: target.handle,
    name: target.name,
    expression,
    ...(frameId === undefined ? {} : { frameId }),
  });
}

export function registerVariableCommands(): vscode.Disposable {
  return vscode.Disposable.from(
    vscode.commands.registerCommand(SHOW_IN_CONSOLE, (context: VariableContext) =>
      showInDebugConsole(context),
    ),
    vscode.commands.registerCommand(EVALUATE_WITH_SELF, (context: VariableContext) =>
      evaluateWithSelf(context),
    ),
  );
}
