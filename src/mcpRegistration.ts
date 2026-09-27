import * as path from 'path';
import * as vscode from 'vscode';
import {
  type ClaudeCodeOutcome,
  addArgs,
  connectClaudeCodeHere,
  connectableFolderHere,
  removeArgs,
  spelled,
} from './claudeCode';
import { mcpEnabled, mcpReadOnly } from './config';
import { log } from './log';
import { bundledMcpStamp, mcpLabel, mcpUrl } from './mcp';
import { isSupportedPlatform } from './platform';

/**
 * Getting the MCP server in front of a client, which is two different problems
 * with two different answers.
 *
 * **VS Code is registered automatically.** The editor has an API for exactly
 * this — an extension contributes a server definition provider and the server
 * appears in the MCP list with nothing for the user to write. That lands on the
 * automated side of GemDB's line for the same reason `putCliOnPath` does: VS
 * Code owns the reversal. The definition exists only while this extension is
 * enabled, it is scoped to this editor, and disabling GemDB takes it away.
 * Nothing is written to a file the user would have to find and undo.
 *
 * **Claude Code is configured on request, by its own CLI.** Picking it from
 * "Connect an AI Agent to GemDB" runs `claude mcp add` for this folder — see
 * `claudeCode.ts` for why that one client, why local scope, and why only when
 * asked. The pick is the consent, Claude Code's CLI does the writing, and the
 * undo is one command GemDB shows. When it cannot run (no folder, an untrusted
 * one, no `claude` to be found) it falls back to the clipboard below.
 *
 * **Every other client is handed the details, never configured.** Claude
 * Desktop and Cursor are configured by a JSON file the user owns —
 * `claude_desktop_config.json`, `~/.cursor/mcp.json` — with no CLI of their
 * own to do it, and GemDB editing those files is the other side of the line:
 * persistent, global, outside the root path, and not ours to undo. It is the
 * same call the README makes about the shell profile, which asks rather than
 * does. So `registerWithClient` offers the exact snippet for the client the
 * user picks, puts it on the clipboard, and stops there.
 */

/** The id in `contributes.mcpServerDefinitionProviders`; the two must match. */
export const MCP_PROVIDER_ID = 'gemdbMcpProvider';

/** The name a client shows for this server. */
const SERVER_LABEL = 'GemDB';

/**
 * Publish the server to VS Code, and re-publish it whenever it moves.
 *
 * `onDidChangeMcpServerDefinitions` is what makes the port and read-only
 * settings live: change either and the editor re-reads the definition rather
 * than holding the URL it saw at activation. The version string carries the
 * payload build for the same reason — VS Code tells the user tools may have
 * changed when it changes, which is exactly what a GemDB update that ships a
 * newer MCP server means.
 *
 * `resolveMcpServerDefinition` is the interesting half. The editor calls it
 * when it is about to start the server, which is GemDB's chance to make sure
 * there is something to connect to: the database up, the classes filed in, the
 * router forked. That is the whole reason an agent can be pointed at GemDB and
 * simply work — the first tool call brings the database up the same way the
 * first notebook cell does.
 */
export function registerMcpProvider(
  extensionPath: string,
  ensureServing: () => Promise<boolean>,
): vscode.Disposable {
  // Guarded because `engines.vscode` admits 1.101 and up, and an editor is a
  // moving target: a missing API should cost the user the registration, not
  // the activation of everything after it.
  if (typeof vscode.lm?.registerMcpServerDefinitionProvider !== 'function') {
    log('This editor has no MCP server API, so GemDB cannot register itself with it.');
    return new vscode.Disposable(() => {});
  }

  const changed = new vscode.EventEmitter<void>();
  const definition = (): vscode.McpHttpServerDefinition[] => {
    // Offering nothing beats offering a server that cannot start. On a
    // platform GemDB does not run on there will never be a database behind
    // this URL, and an agent's tool call failing tells the user far less than
    // the server simply not being in the list.
    if (!mcpEnabled() || !isSupportedPlatform()) return [];
    return [
      new vscode.McpHttpServerDefinition(
        SERVER_LABEL,
        vscode.Uri.parse(mcpUrl()),
        {},
        mcpLabel(bundledMcpStamp(extensionPath)),
      ),
    ];
  };

  const provider = vscode.lm.registerMcpServerDefinitionProvider(MCP_PROVIDER_ID, {
    onDidChangeMcpServerDefinitions: changed.event,
    provideMcpServerDefinitions: () => definition(),
    resolveMcpServerDefinition: async (server) => {
      // Returning undefined tells the editor not to start the server, which is
      // the honest answer when the database could not be brought up — better
      // than handing back a URL whose first request fails.
      return (await ensureServing()) ? server : undefined;
    },
  });

  const settings = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('gemdb.mcp') || event.affectsConfiguration('gemdb.rootPath')) {
      changed.fire();
    }
  });

  return new vscode.Disposable(() => {
    settings.dispose();
    provider.dispose();
    changed.dispose();
  });
}

interface ClientRecipe {
  /** What the code matches on, so a relabelled menu item keeps its behaviour. */
  id: 'claudeCode' | 'claudeDesktop' | 'cursor' | 'url';
  label: string;
  detail: string;
  /** What goes on the clipboard. */
  snippet: (url: string) => string;
  /** How to explain what to do with it. */
  instruction: string;
  documentation?: string;
}

/**
 * One recipe per client, each in that client's own idiom.
 *
 * Claude Code gets a command because it has one and it is the shortest correct
 * answer. The others get the JSON they need, because their configuration is a
 * file. All of them name the transport explicitly: this is a Streamable HTTP
 * server on a URL, not a command to spawn, and a client told to spawn it will
 * report something unhelpful about a missing executable.
 */
const CLIENT_RECIPES: ClientRecipe[] = [
  {
    id: 'claudeCode',
    label: 'Claude Code',
    detail: 'a `claude mcp add` command',
    snippet: (url) => `claude mcp add --transport http gemdb ${url}`,
    instruction:
      'Paste it into a terminal in the project you use Claude Code in. It applies to that project ' +
      'only. `--scope user` would apply it to every project, at the cost of one database session ' +
      'for every Claude Code session you run.',
    documentation: 'https://docs.claude.com/en/docs/claude-code/mcp',
  },
  {
    id: 'claudeDesktop',
    label: 'Claude Desktop',
    detail: 'JSON for claude_desktop_config.json',
    snippet: (url) => JSON.stringify({ mcpServers: { gemdb: { type: 'http', url } } }, null, 2),
    instruction:
      'Merge it into claude_desktop_config.json (Settings → Developer → Edit Config), then restart Claude Desktop.',
  },
  {
    id: 'cursor',
    label: 'Cursor',
    detail: 'JSON for ~/.cursor/mcp.json',
    snippet: (url) => JSON.stringify({ mcpServers: { gemdb: { url } } }, null, 2),
    instruction: 'Merge it into ~/.cursor/mcp.json, or the workspace .cursor/mcp.json.',
  },
  {
    id: 'url',
    label: 'Something else',
    detail: 'just the URL',
    snippet: (url) => url,
    instruction:
      'Any client that speaks the MCP Streamable HTTP transport can use this URL directly.',
  },
];

/**
 * Turn the server on if it is not, since asking to connect an agent is asking
 * for exactly that.
 *
 * `gemdb.mcp.enabled` is off by default (see `config.ts` for the measured
 * reason), so this command is where most users meet the feature — and stopping
 * to say "change a setting first" would be a strange answer to someone who
 * just asked to connect an agent. Writing GemDB's own setting on an explicit
 * request is not the line the other clients' files are on: it is ours, it is
 * visible in Settings, and the same command shows what it costs before asking.
 *
 * Returns false when the user declines, so the caller offers nothing further
 * — and it is the caller's job to ask this BEFORE starting a database, since
 * starting one for somebody who is about to decline is the wrong order.
 */
export async function confirmMcpEnabled(): Promise<boolean> {
  if (mcpEnabled()) return true;

  const choice = await vscode.window.showInformationMessage(
    'Turn on GemDB’s MCP server?',
    {
      modal: true,
      detail:
        'This lets AI agents query and change your database.\n\n' +
        'It is off by default because each connected agent uses one of the limited number ' +
        'of sessions your database allows, and an agent that disconnects badly keeps its ' +
        'own for up to 30 minutes — enough repeated reconnections can leave you unable to ' +
        'log in until they are released.\n\n' +
        'You can turn it off again in Settings, under GemDB.',
    },
    'Turn It On',
  );
  if (choice !== 'Turn It On') return false;

  await vscode.workspace
    .getConfiguration('gemdb')
    .update('mcp.enabled', true, vscode.ConfigurationTarget.Global);
  log('The MCP server was turned on from "Connect an AI Agent to GemDB".');
  return true;
}

/**
 * Show the server's address and connect one client: Claude Code by running its
 * CLI, the rest by the clipboard. See the note at the top of this file for why
 * GemDB treats them differently.
 */
export async function registerWithClient(): Promise<void> {
  const url = mcpUrl();
  const readOnly = mcpReadOnly();

  // Worked out now rather than written into the recipe: whether GemDB can do
  // it for you depends on this window, and a menu that promises "added for
  // you" and then copies a command has told the user something untrue.
  const claudeFolder = connectableFolderHere();
  const picked = await vscode.window.showQuickPick(
    CLIENT_RECIPES.map((recipe) => ({
      label: recipe.label,
      description:
        recipe.id === 'claudeCode' && claudeFolder
          ? `added for ${path.basename(claudeFolder)} by Claude Code’s own CLI`
          : recipe.detail,
      recipe,
    })),
    {
      title: `GemDB's MCP server — ${url}`,
      placeHolder: readOnly
        ? 'Which client? (this server is read-only)'
        : 'Which client should GemDB give the configuration for?',
      matchOnDescription: true,
    },
  );
  if (!picked) return;

  if (picked.recipe.id === 'claudeCode') {
    await reportClaudeCode(await connectClaudeCodeHere(url), picked.recipe, url);
    return;
  }
  await copyRecipe(picked.recipe, url);
}

/**
 * Put one client's configuration on the clipboard and say what to do with it.
 *
 * `why`, when given, is the reason GemDB is copying rather than doing — shown
 * first, so a user who expected Claude Code to be connected learns why it was
 * not before reading instructions for doing it by hand.
 */
async function copyRecipe(recipe: ClientRecipe, url: string, why?: string): Promise<void> {
  const snippet = recipe.snippet(url);
  await vscode.env.clipboard.writeText(snippet);

  const choice = await vscode.window.showInformationMessage(
    `Copied the ${recipe.label} configuration for GemDB's MCP server.`,
    {
      modal: true,
      detail: [why, snippet, recipe.instruction].filter(Boolean).join('\n\n'),
    },
    ...(recipe.documentation ? ['Open the Docs'] : []),
  );
  if (choice === 'Open the Docs' && recipe.documentation) {
    await vscode.env.openExternal(vscode.Uri.parse(recipe.documentation));
  }
}

/** Tell the user what connecting Claude Code did, or hand them the command. */
async function reportClaudeCode(
  outcome: ClaudeCodeOutcome,
  recipe: ClientRecipe,
  url: string,
): Promise<void> {
  switch (outcome.kind) {
    case 'cancelled':
      return;
    case 'connected': {
      log(`Claude Code is connected to GemDB in ${outcome.folder}.`);
      // Modal, like the clipboard path, because what it carries — the command
      // that ran and the one that undoes it — is the part a user needs to be
      // able to read, and a toast that fades takes both with it.
      await vscode.window.showInformationMessage(
        `${outcome.replaced ? 'Updated' : 'Connected'} Claude Code to GemDB in ${path.basename(outcome.folder)}.`,
        {
          modal: true,
          detail:
            'Start a new Claude Code session to use it: a session that is already running ' +
            'loaded its MCP servers when it started.\n\n' +
            `GemDB ran, in ${outcome.folder}:\n${spelled(addArgs(url))}\n\n` +
            'It applies to this folder only. To undo it:\n' +
            spelled(removeArgs()),
        },
      );
      return;
    }
    case 'untrusted': {
      const choice = await vscode.window.showWarningMessage(
        'GemDB connects Claude Code by running its CLI in this folder, and VS Code has not been told to trust it.',
        'Manage Workspace Trust',
        'Copy the Command',
      );
      if (choice === 'Manage Workspace Trust') {
        await vscode.commands.executeCommand('workbench.trust.manage');
      } else if (choice === 'Copy the Command') {
        await copyRecipe(recipe, url);
      }
      return;
    }
    case 'noFolder':
      await copyRecipe(
        recipe,
        url,
        'Open a folder and GemDB adds it for you: Claude Code is connected one project at a time.',
      );
      return;
    case 'noClaude':
      await copyRecipe(
        recipe,
        url,
        'GemDB could not find Claude Code: neither the Claude Code extension nor a `claude` on the PATH.',
      );
      return;
    case 'failed':
      await copyRecipe(
        recipe,
        url,
        (outcome.removedOld
          ? 'GemDB removed the old "gemdb" entry, and Claude Code then could not add the new one, ' +
            'so Claude Code has no GemDB server for this folder now. Paste this to add it'
          : 'Claude Code could not add the server') + ` (see the GemDB log):\n${outcome.output}`,
      );
      return;
  }
}

/** The recipes, for a test to check the shape of what gets copied. */
export function clientRecipesFor(url: string): { label: string; snippet: string }[] {
  return CLIENT_RECIPES.map((recipe) => ({ label: recipe.label, snippet: recipe.snippet(url) }));
}
