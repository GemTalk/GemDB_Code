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
 * - **Local scope, in the first workspace folder.** `local` is keyed by the
 *   directory the command runs in, so it reaches Claude Code sessions in this
 *   project and nowhere else. The first folder because that is where the
 *   Claude Code panel runs: its extension takes `workspaceFolders[0]` (or the
 *   home directory in an empty window) wherever it needs a root, so in a
 *   multi-root window any other folder would register GemDB where the panel
 *   never looks. `user` would reach every project, and every Claude Code
 *   session connects to every server it is configured with at startup — each
 *   one a worker holding one of the database's ten sessions, and a restarted
 *   one leaving its worker for up to half an hour (docs/mcp-server.md, "The
 *   session leak"). `project` would commit a 127.0.0.1 URL into the
 *   repository for teammates who may not run GemDB.
 * - **Add first; replace only when asked.** `claude mcp add` fails, saying
 *   the name "already exists in local config", when there is one, and there
 *   is no upsert. So the add is tried first, and only that answer leads to a
 *   remove — after asking, because the entry may be one the user wrote
 *   themselves (another URL, a proxy) rather than GemDB's from an earlier
 *   port. Any other failure removes nothing, and so does a change in that
 *   wording: it reads as a failure, not as permission to delete. `claude mcp
 *   get` is deliberately not used to look first: it connects to the server to
 *   report its status, which for GemDB is a worker gem spent on a question
 *   the add answers for free.
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
  trusted: () => boolean;
  /** Ask before replacing the `gemdb` entry already configured for `folder`. */
  confirmReplace: (folder: string) => Promise<boolean>;
  run: (claude: string, args: string[], cwd: string) => Promise<RunResult>;
}

export type ClaudeCodeOutcome =
  | { kind: 'connected'; folder: string; replaced: boolean }
  | { kind: 'noFolder' }
  | { kind: 'untrusted' }
  | { kind: 'noClaude' }
  | { kind: 'cancelled' }
  /** `removedOld`: the previous entry is gone, so the user must be told. */
  | { kind: 'failed'; output: string; removedOld: boolean };

/** Claude Code's own answer when the name is taken; measured on 2.1.283. */
const ALREADY_EXISTS = /already exists/i;

/** The folder a connection would be made for, if one could be made here at all. */
export function connectableFolder(
  world: Omit<ClaudeCodeWorld, 'run' | 'confirmReplace'>,
): string | undefined {
  const folder = world.folders()[0];
  return folder !== undefined && world.trusted() && world.findClaude() ? folder : undefined;
}

/** The decision half: which folder, whether it may run, and what to run. */
export async function connectClaudeCode(
  world: ClaudeCodeWorld,
  url: string,
): Promise<ClaudeCodeOutcome> {
  // A local-scope entry belongs to a directory, and an empty window has none
  // to give it — guessing one would register GemDB for a project the user
  // never named.
  const folder = world.folders()[0];
  if (folder === undefined) return { kind: 'noFolder' };
  if (!world.trusted()) return { kind: 'untrusted' };

  const claude = world.findClaude();
  if (!claude) return { kind: 'noClaude' };

  const added = await world.run(claude, addArgs(url), folder);
  if (added.code === 0) return { kind: 'connected', folder, replaced: false };
  if (!ALREADY_EXISTS.test(added.output)) {
    return { kind: 'failed', output: added.output, removedOld: false };
  }

  if (!(await world.confirmReplace(folder))) return { kind: 'cancelled' };
  const removed = await world.run(claude, removeArgs(), folder);
  if (removed.code !== 0) return { kind: 'failed', output: removed.output, removedOld: false };
  const readded = await world.run(claude, addArgs(url), folder);
  if (readded.code !== 0) return { kind: 'failed', output: readded.output, removedOld: true };
  return { kind: 'connected', folder, replaced: true };
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

/** Long enough for a cold start of a large binary; `mcp add` itself is instant. */
const RUN_TIMEOUT_MS = 30_000;

/** Run the CLI, logging exactly what ran, what it said, and how it ended. */
function run(claude: string, args: string[], cwd: string): Promise<RunResult> {
  log(`Running ${spelled(args)} in ${cwd}`);
  return new Promise((resolve) => {
    const child = spawn(claude, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: RUN_TIMEOUT_MS,
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    // A spawn failure (a binary that vanished between finding and running)
    // is reported as a failed run, so it takes the same path as any other.
    child.on('error', (e) => resolve({ code: -1, output: e.message }));
    child.on('close', (code, signal) => {
      // A run the timeout killed says nothing of its own, so without this the
      // user is shown an error with no text and the log has no line at all.
      if (signal) {
        output += `\nclaude was stopped (${signal}) after ${RUN_TIMEOUT_MS / 1000} seconds.`;
      }
      if (output.trim()) log(output.trim());
      log(`claude ${args[1]} ended with ${signal ?? `exit code ${String(code)}`}`);
      resolve({ code: code ?? -1, output: output.trim() });
    });
  });
}

const here = {
  findClaude,
  folders: () => (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
  trusted: () => vscode.workspace.isTrusted,
};

/** The folder GemDB would connect Claude Code for in this window, if it can. */
export function connectableFolderHere(): string | undefined {
  return connectableFolder(here);
}

/**
 * The run in progress, if any. Two overlapping runs could interleave — one's
 * remove deleting the entry the other just added — and a second click is the
 * likely result of a slow first one, so it waits for that one instead.
 */
let inFlight: Promise<ClaudeCodeOutcome> | undefined;

/** `connectClaudeCode` against the real editor, under a progress notification. */
export function connectClaudeCodeHere(url: string): Promise<ClaudeCodeOutcome> {
  if (inFlight) return inFlight.then(() => ({ kind: 'cancelled' }) as const);
  const world: ClaudeCodeWorld = {
    ...here,
    confirmReplace: async (folder) => {
      const choice = await vscode.window.showWarningMessage(
        `Claude Code already has a server named "gemdb" for ${path.basename(folder)}. Replace it?`,
        {
          modal: true,
          detail:
            `It will point at ${url}. If you set that entry up yourself for something ` +
            'else, keep it and add GemDB under another name instead.',
        },
        'Replace It',
      );
      return choice === 'Replace It';
    },
    run,
  };
  inFlight = Promise.resolve(
    vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Connecting Claude Code to GemDB…' },
      () => connectClaudeCode(world, url),
    ),
  ).finally(() => {
    inFlight = undefined;
  });
  return inFlight;
}
