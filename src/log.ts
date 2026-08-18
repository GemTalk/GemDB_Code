import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

function getChannel(): vscode.OutputChannel {
  if (!channel) channel = vscode.window.createOutputChannel('GemDB');
  return channel;
}

/** Append a line to the GemDB output channel. */
export function log(message: string): void {
  getChannel().appendLine(message);
}

/** Append a labelled section header — used to frame long-running steps. */
export function logStep(title: string): void {
  getChannel().appendLine(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`);
}

export function showLog(): void {
  getChannel().show(true);
}

export function disposeLog(): void {
  channel?.dispose();
  channel = undefined;
}

/** Normalize anything thrown into a message suitable for a notification. */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
