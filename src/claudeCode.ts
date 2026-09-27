import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { log } from './log';

/**
 * Connecting Claude Code to GemDB's MCP server, by running Claude Code's own
 * `claude mcp add` rather than handing the user a command to paste.
 *
 * Claude Code is the one client this is done for, and it is done only on an
 * explicit request — the user picked "Claude Code" from "Connect an AI Agent to
 * GemDB". Three things put that on the automated side of GemDB's line where
 * editing Claude Desktop's or Cursor's JSON is not: Claude Code's own CLI does
 * the writing, so GemDB never edits a file it does not own; the change is one
 * command to undo, which GemDB shows; and the paste it replaces did not work
 * for most people who would use it, because the VS Code extension ships its
 * own `claude` and does not put it on the PATH.
 *
 * Why it is done this way rather than any other, all measured against Claude
 * Code 2.1.283:
 *
 * - **Local scope, in the workspace folder.** `local` is keyed by the directory
 *   the command runs in, so it reaches Claude Code sessions in this project
 *   and nowhere else. `user` would reach every project, and every Claude Code
 *   session connects to every server it is configured with at startup — each
 *   one a worker holding one of the database's ten sessions, and a restarted
 *   one leaving its worker for up to half an hour (docs/mcp-server.md, "The
 *   session leak"). `project` would commit a 127.0.0.1 URL into the
 *   repository for teammates who may not run GemDB.
 * - **Remove, then add.** `claude mcp add` fails when the name already exists
 *   in that scope, and there is no upsert. Removing first makes a second run
 *   the way to pick up a changed port, and a remove that finds nothing fails
 *   harmlessly. `claude mcp get` is deliberately not used to look first: it
 *   connects to the server to report its status, which for GemDB is a worker
 *   gem spent on a question the config file could answer.
 * - **Only in a trusted folder.** This runs a program with the folder as its
 *   working directory, and Claude Code reads a project's own settings when it
 *   runs in one — nobody has established that `mcp add` is an exception. A
 *   folder VS Code has not been told to trust is exactly the one whose
 *   settings should not get that chance, so this is the `isTrusted` check
 *   CLAUDE.md asks of anything that runs folder content outside a cell or a
 *   terminal.
 */

/** The name Claude Code lists the server under, and the one `remove` targets. */
export const CLAUDE_SERVER_NAME = 'gemdb';

/** The Claude Code extension, whose bundled CLI is where most users' `claude` is. */
const CLAUDE_EXTENSION_ID = 'anthropic.claude-code';

/**
 * Where the Claude Code extension keeps its CLI, relative to its install
 * directory. Not a documented interface — read from the 2.1.283 package — so
 * a layout change is expected to land here, and `findClaude` falls through to
 * the PATH when it does.
 */
const BUNDLED_CLI = path.join('resources', 'native-binary', 'claude');

export function addArgs(url: string): string[] {
  return ['mcp', 'add', '--transport', 'http', '--scope', 'local', CLAUDE_SERVER_NAME, url];
}

export function removeArgs(): string[] {
  return ['mcp', 'remove', CLAUDE_SERVER_NAME, '--scope', 'local'];
}

/** The command a user would type, for showing what was run and how to undo it. */
export function spelled(args: string[]): string {
  return ['claude', ...args].join(' ');
}

export interface RunResult {
  code: number;
  output: string;
}

export interface ClaudeCodeWorld {
  /** Claude Code's CLI, or undefined when neither the extension nor the PATH has one. */
  findClaude: () => string | undefined;
  /** The folders open in this window. */
  folders: () => string[];
  /** Ask which folder, when there is more than one; undefined if dismissed. */
  pickFolder: (folders: string[]) => Promise<string | undefined>;
  trusted: () => boolean;
  run: (claude: string, args: string[], cwd: string) => Promise<RunResult>;
}

export type ClaudeCodeOutcome =
  | { kind: 'connected'; folder: string; replaced: boolean }
  | { kind: 'noFolder' }
  | { kind: 'untrusted' }
  | { kind: 'noClaude' }
  | { kind: 'cancelled' }
  | { kind: 'failed'; output: string };

/** The decision half: which folder, whether it may run, and what to run. */
export async function connectClaudeCode(
  world: ClaudeCodeWorld,
  url: string,
): Promise<ClaudeCodeOutcome> {
  // A local-scope entry belongs to a directory, and an empty window has none
  // to give it — guessing one would register GemDB for a project the user
  // never named.
  const folders = world.folders();
  if (folders.length === 0) return { kind: 'noFolder' };
  if (!world.trusted()) return { kind: 'untrusted' };

  const claude = world.findClaude();
  if (!claude) return { kind: 'noClaude' };

  const folder = folders.length === 1 ? folders[0] : await world.pickFolder(folders);
  if (!folder) return { kind: 'cancelled' };

  const removed = await world.run(claude, removeArgs(), folder);
  const added = await world.run(claude, addArgs(url), folder);
  if (added.code !== 0) return { kind: 'failed', output: added.output };
  return { kind: 'connected', folder, replaced: removed.code === 0 };
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * The extension's bundled CLI first, then the PATH.
 *
 * The bundled one is what the Claude Code panel in this editor runs, so it is
 * the version certain to agree with the panel about the file both read; a
 * `claude` on the PATH may be a standalone install of any age.
 */
function findClaude(): string | undefined {
  const extension = vscode.extensions.getExtension(CLAUDE_EXTENSION_ID);
  if (extension) {
    const bundled = path.join(extension.extensionPath, BUNDLED_CLI);
    if (isExecutable(bundled)) return bundled;
  }
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'claude');
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

/** Run the CLI, logging exactly what ran and what it said. */
function run(claude: string, args: string[], cwd: string): Promise<RunResult> {
  log(`Running ${spelled(args)} in ${cwd}`);
  return new Promise((resolve) => {
    const child = spawn(claude, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    // A spawn failure (a binary that vanished between finding and running)
    // is reported as a failed run, so it takes the same path as any other.
    child.on('error', (e) => resolve({ code: -1, output: e.message }));
    child.on('close', (code) => {
      if (output.trim()) log(output.trimEnd());
      resolve({ code: code ?? -1, output: output.trim() });
    });
  });
}

/** `connectClaudeCode` against the real editor. */
export function connectClaudeCodeHere(url: string): Promise<ClaudeCodeOutcome> {
  return connectClaudeCode(
    {
      findClaude,
      folders: () => (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
      pickFolder: async (folders) => {
        const picked = await vscode.window.showQuickPick(
          folders.map((folder) => ({ label: path.basename(folder), description: folder, folder })),
          { title: 'Connect Claude Code to GemDB in which folder?' },
        );
        return picked?.folder;
      },
      trusted: () => vscode.workspace.isTrusted,
      run,
    },
    url,
  );
}
