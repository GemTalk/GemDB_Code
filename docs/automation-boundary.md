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

**Installing the Brain Freeze demo** (`demo.ts`) — cloning it, opening it, and
showing its README, once the user picks the command. The clone lands at
`<rootPath>/brain-freeze`, which is what moves it here from "Asked": it used
to clone wherever a folder dialog said, which was a persistent write outside
the root path, and the dialog was the consent. With the location fixed it is
one more directory GemDB owns. Two things keep it on this side:

- a second run opens the existing clone and never clones over it, since it
  may hold the user's commits — for the same reason `uninstall` never removes
  the root path wholesale;
- the window is chosen, not asked about: an empty window is reused, and a
  window with a folder open is left alone while the demo gets a new one.
  Replacing someone's workspace unasked is the one step here that would not be
  reversible by closing something.

The fresh clone opens in Restricted Mode, and VS Code asks about trust the
first time the user runs a cell or opens a terminal there. That question stays
VS Code's: see "Workspace Trust" under "Asked".

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

**Setting `RemoveIPC=no` (Linux only) — offered, never raises the modal by
itself.** Also `sudo` and machine-wide, but advisory: without it the database
still starts, it just does not survive a logout. It joins the shared-memory
modal when that is being asked anyway. Otherwise the status view's "Survives
logout" row offers it (`gemdb.configureRemoveIpc`). It used to raise the modal
alone, which on stock Linux (where shared memory is already far above 1 GB)
meant every Linux user was asked for `sudo` over a setting that blocks
nothing (issue #45).

**Configuring other MCP clients** (Claude Code, Claude Desktop, Cursor). Their
config files belong to the user, so `gemdb.registerMcpClient` copies the
command or snippet to the clipboard and stops.

**Workspace Trust — VS Code asks, GemDB never does.** GemDB declares
`"limited"` Restricted Mode support and adds no trust checks of its own,
because VS Code already asks at the two points where a folder's code would
run: before a notebook cell executes (its notebook execution service calls
`requestWorkspaceTrust` for every kernel, not just Jupyter's) and before a
terminal process starts, which covers the GemDB Shell and Run File. Both
read from the VS Code 1.139.1 bundle on 2026-09-25. What is left runs no folder
content — setup, start and stop, the status view, the README preview — and
machine-scoped settings mean a folder's `.vscode/settings.json` cannot steer
it. `manifest.test.ts` holds both halves.

Two things GemDB deliberately does not do. It does not prompt for trust
itself: the stable API can only read trust (`isTrusted`,
`onDidGrantWorkspaceTrust`), and a GemDB notification ahead of VS Code's
dialog would be a second question about the same thing. And it does not touch
`security.workspace.trust.*`: those are the user's security settings, global
and persistent. In VS Code 1.139.1 `startupPrompt` defaults to `never`, so a
new folder opens restricted with only a banner; the lower-friction path is
trusting `~/GemDB` once, which covers every subfolder, and the walkthrough
says so.

**Editing the user's shell profile.** Persistent and not ours to undo, so the
README tells the user how instead.
