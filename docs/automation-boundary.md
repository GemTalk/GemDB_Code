# The automation boundary

The rule, from CLAUDE.md: **automate what is inert and reversible; ask about
what is persistent or global.** Below is where each automated step sits and
why. Check a new step against these before adding it.

## Automated

**Download, unpack, create the database, stage Grail.** Runs on first
activation (`prepare`). Everything lives in the root path, so deleting it
undoes all of it.

**Starting the stone and NetLDI.** Started on activation so the first notebook
cell doesn't wait. These processes detach and outlive VS Code, the one
automated act outside the root path. That is acceptable only because:

- the status bar always shows it, and clicking it stops the database;
- `autoStart.ts` remembers a stop and doesn't restart until the user asks;
- it never prompts. If shared memory isn't raised it stands down and leaves
  the `sudo` prompt to `ensureRunning`.

**The MCP server, and registering it with VS Code** — only once the user
turns on `gemdb.mcp.enabled`, which is off by default. Reconnecting clients
leak a worker gem each, and that has locked a real user out of their database
(see [`mcp-server.md`](mcp-server.md), "The session leak"). The default comes
back when the router can cap its workers. Once enabled:

- it starts as part of `ensureRunning`, but a failure to start it never fails
  `ensureRunning`;
- VS Code registration uses `registerMcpServerDefinitionProvider`, which goes
  away with the extension.

**`gemdb` on the PATH of VS Code terminals** (`putCliOnPath` in `cli.ts`).
VS Code owns the reversal: it applies only to terminals the editor opens and
goes away when the extension is disabled. Call `clear()` before `prepend`:
the collection persists across reloads, so skipping it stacks duplicate
entries and keeps a stale root path first.

## Asked

**Raising shared memory — always prompts; never automate it.** It needs
`sudo`, affects the whole machine and survives reboots.

The prompt appears when first-run setup starts, while the download is
running. Two earlier placements failed:

- On "Open GemDB Shell": the prompt had no visible link to the click.
- After the download: it arrived minutes later, after the user had moved on,
  and sat unanswered.

`ensureRunning` checks again as a backstop; nothing re-prompts on each
activation. Verified end to end on 2026-08-14.

Known cost: the modal dialog disables the download's Cancel button until
answered. Accepted, since a non-modal prompt could be missed.

**Configuring other MCP clients** (Claude Code, Claude Desktop, Cursor). Their
config files belong to the user, so `gemdb.registerMcpClient` copies the
command or snippet to the clipboard and stops.

**Editing the user's shell profile.** Persistent and not ours to undo, so the
README tells the user how instead.
