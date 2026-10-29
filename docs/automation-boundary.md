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

**Connecting Claude Code to the MCP server — on request only** (`claudeCode.ts`).
Picking Claude Code from **Connect an AI Agent to GemDB** runs `claude mcp add`
at local scope in the first workspace folder, and shows what ran and the
command that undoes it. If a `gemdb` entry already exists there, it asks before
replacing it, since the user may have written that one themselves. It used to copy the
command instead, like the other clients. Three things moved it:

- the pick is the consent, and it is a request for exactly this;
- Claude Code's own CLI writes its own file, so GemDB edits nothing it does
  not own, and the undo is one command;
- the paste it replaced did not work for most users: the Claude Code VS Code
  extension ships its own `claude` and does not put it on the PATH, so
  pasting into a terminal said "command not found". GemDB finds the bundled
  one.

Local scope, not user, because every Claude Code session connects to every
server it is configured with, and each connection holds one of the database's
ten sessions. At user scope, every Claude Code window in every project would
spend one. GemDB never uses `claude mcp get` or `list` to look before
changing anything, because both connect to the server to report its status.
It runs only in a trusted folder (see "Workspace Trust" under "Asked").

**Capping the database at the license's 10 GB, and reserving it on disk**
(`ensureSpaceLimits` in `database.ts`). Three lines in `conf/system.conf`,
which GemDB wrote in the first place, added before the stone starts:
`DBF_EXTENT_SIZES`, `STN_FREE_SPACE_THRESHOLD` and `DBF_PRE_GROW`. They live in
the root path, take effect at the next start, and a value the user set in any
configuration file is left alone. The cost is 10 GB of disk from the first
start, which is the persistent kind of cost and was chosen deliberately: a
disk that fills under a growing extent becomes a smaller cap without a word,
and leaves the disk full for everything else (measured). It stays on this side
because it is confined to the root path, undone by deleting the database, and
checked first — setup and every start refuse, with the numbers and a way to
choose another folder, when the disk cannot hold it. The setup footprint and
the walkthrough say 11–12 GB. See [`repository-space.md`](repository-space.md).

**Creating the `gemdb` database account** (`account.ts`). A committed write
to GemDB's own database, made as DataCurator on the way to a running
database, before Python is installed into the account: the user, its own
security policy, two privileges, and a generated password in the root path.
Inert and reversible for the same reason creating the database is — the
database is GemDB's, and deleting it undoes this. Never on an external
database, whose accounts are its administrator's.

**Aborting idle sessions that have nothing to commit** (`abortIfClean`,
`gemdb.maintenance.abortIdleSessionsAfterMinutes`). Only when `System
needsCommit` is false, so it discards nothing, and the variables survive
(SessionTemps). It never counts as use and never touches a session that is
running or paused. The Shell does the same for its own session. Without it, an
idle `autoBegin` session holds back every collection, and the stone's own
remedies do not apply to it.

**Collecting garbage** (`maintenance.ts`). Runs on a schedule once the window
is quiet, or whenever less than 2 GB is left, and only for a database GemDB
manages. It changes no data, and the space it frees is the user's. When free
space is already below the threshold, it lowers the threshold as SystemUser
for the duration and puts the value back. That runtime-only change is reverted
at the end and by any stone restart, and without it the collection frees
nothing, because the reclaim gem stops below the threshold.

**Recording statistics** (`statmonitor.ts`, `gemdb.statistics.collect`, on
by default). Before every start, GemDB writes a block of its own into
`conf/system.conf`, and the stone starts a statmonitor that records to
`<root>/db/stat`. It is on by default because statistics only help if they
were already being recorded when something went wrong. Four things keep it on
this side:

- the statmonitor is the stone's child and exits with it (measured);
- it takes none of the ten sessions (measured);
- it writes only under the root path, a few MB a day;
- GemDB deletes files older than `gemdb.statistics.keepDays`, and never a
  file it did not name.

Turning it off removes the block at the next start. A value the developer
sets in any configuration file wins, and the block is removed in favour of
it. Never on an external database. See
[`statistics.md`](statistics.md), "Recording statistics".

**Installing a newer Grail into a database that already has Python support**
(`grailFileInDue` in `lifecycle.ts`), unless `gemdb.reinstallPythonOnUpdate`
is off. A first install was always automated; an update now is too, from
every trigger, as the MCP server's is.

From 1.7.0 to 1.9.0 it was asked instead, once per build and only of someone
who asked for the database, because it was not inert. Measured 2026-10-15 on a
database populated under 1.6.0's Grail (`beef473`), Brain Freeze included:
after filing in `9fb5d23`, committed datetimes, dates, timedeltas, Decimals,
tuples, sets, instances of user classes and a stored `None` no longer passed
`isinstance` or compared, and Brain Freeze died on its first request.
`install.gs` recreated every runtime class, and committed objects kept the old
ones. The setting was ignored then, and kept in the manifest, deprecated.

That reason is gone. Grail upgrades in place: the Rowan load keeps Grail's
classes, and `install-grail.sh` rebuilds every deployed module into its
committed instance and classes (`scripts/redeployModules.gs`; Grail #1791,
Grail's `docs/Persistent_Modules_and_Classes.md` D7). Grail's upgrade test
writes an application's data under one Grail, installs another over it, and
checks that every stored object is still an instance of the current class and
runs its code: dates, datetimes, timedeltas, Decimals, Fractions, tuples, sets,
`None`, enum members, namedtuples, exceptions and instances of user classes.
Its nightly runs it from 1.9.0's pin (`c8cbc92`), the Grail every database
GemDB 1.9.0 created has, and #1867 measured that case at 243 checks, 0 failures.
The engine upgrade already reinstalled Grail without a second question, which
the warning contradicted.

What an update still does not carry over, and where it is said instead of in
a question:

- a class whose bases the update changed while instances of it, or of a class
  below it, are stored. The redeploy rebuilds such a class when nothing is
  stored against it; otherwise its module stays stale, the GemDB log names it,
  and importing it raises with the advice to run `gemdb.schema.rebase`;
- a class statement inside a function other than `namedtuple`'s, which makes a
  new class on every rebuild, so instances stored before keep the old class.

Neither is helped by asking before the install: the first is refused with
its remedy, and the second happens on any rebuild of the module, an edit of
its source included.

It is persistent, which the rule says to ask about, and is automated anyway
for the reason the MCP server's install is: it is GemDB's own code in GemDB's
own database, and the next engine upgrade installs it regardless. So the
setting governs it again, default on: off, the update waits for **Reinstall
the Python Execution Engine**, which the status view's row offers and which
does not ask (the command is the request). A value set before 1.7.0 means
again what it meant then. The `.gemdb-grail-declined` record 1.7.0–1.9.0
wrote is ignored, and removed by the next install.

`resumeRunning` still files Grail in only for a first install: after an
extension update every window activates at once onto the running database, and
an update waits for its next use rather than racing installs from editors that
only opened.

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
nothing (issue #45). The script sends logind SIGHUP so the setting applies
without a reboot, and the row reads logind's live `RemoveIPC` property rather
than its config files: logind consults the loaded value when a user's last
session ends, so a file it has not reloaded protects nothing, and checking
the file let the row vanish while a logout still killed the database.
Measured 2026-10-12 on systemd 249 and 255: the reload applies it, no restart
of logind, and a segment survives a logout that destroys it under the default.

**Upgrading the database to a newer engine — always asked, modal.** A pin
move whose `from -> to` pair is in `ENGINE_UPGRADES` (database.ts) upgrades
the database in place rather than refusing it: `ensureRunning` stops the
previous engine's stone and listener and runs Grail's
`scripts/upgrade_engine.sh --in-place` (`engineUpgrade.ts`). It rewrites the
user's only copy of their data, so it is asked even though it is recoverable:
the script copies the extent to `<extent>.pre-<from>` first and copies it back
if anything fails, but undoing a *successful* upgrade is by hand. The question
says where the copy goes and that it stays until the user deletes it. Asked
only from the triggers that are someone asking for the database
(`ASKS_ABOUT_ENGINE_UPGRADES` in `lifecycle.ts`). Auto-start and an agent get
a warning with **Upgrade Database…**, which runs Start and so asks; a modal nobody asked for would sit
unanswered, and the upgrade stops the database for minutes. Python support
and the MCP server are then installed again without a second question: the
upgrade removed their compiled methods, and the question already said so.

**Choosing another root path when the default is on NFS — asked, once setup
has refused.** The stone will not open a repository on an NFS mount, and on
many shared Linux machines `~` is one (#69). Setup checks before downloading
anything (`assertDatabaseIsLocal`, checked again before the stone starts) and
stops with **Choose a Local Folder…**. GemDB never picks the directory itself:
the root path is a user-level setting that decides where uninstall deletes,
and nothing GemDB could pick unasked is known to be local, backed up and big
enough. The folder dialog is the consent, to the setting and to setting up
there; the setup that follows is the ordinary automated one. Nothing is moved
or deleted from the old directory. The first run skips the shared-memory
prompt in this case, since nothing can use the change until the root path
moves.

**Configuring Claude Desktop and Cursor for the MCP server.** Their config
files belong to the user, and neither has a CLI that would do the edit for us,
so `gemdb.registerMcpClient` copies the snippet to the clipboard and stops.

**Workspace Trust — VS Code asks, GemDB never does.** GemDB declares
`"limited"` Restricted Mode support and adds almost no trust checks of its
own, because VS Code already asks at the two points where a folder's code
would run: before a notebook cell executes (its notebook execution service calls
`requestWorkspaceTrust` for every kernel, not just Jupyter's) and before a
terminal process starts, which covers the GemDB Shell and Run File. Both
read from the VS Code 1.139.1 bundle on 2026-09-25. What is left runs no folder
content — setup, start and stop, the status view, the README preview — and
machine-scoped settings mean a folder's `.vscode/settings.json` cannot steer
it. `manifest.test.ts` holds both halves. The one exception is connecting
Claude Code, which runs Claude Code's CLI with the folder as its working
directory, outside both of VS Code's gates. It checks `isTrusted` and, in an
untrusted folder, offers the trust editor or the clipboard instead.

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

**A notebook left idle with uncommitted changes, holding back garbage
collection — asked, once per stretch of idleness.** Commit, Abort… (which
confirms) or Leave It. Only once the notebook is at least 20 commits behind
(`STN_SIGNAL_ABORT_CR_BACKLOG`'s default): a dirty notebook that nothing else
commits past holds nothing back, and a prompt then would be noise.

**Stopping a database session — asked, every time** (`gemdb.stopSession`).
Whatever the session has not committed is lost, so it is a modal with the
session named. It is never automated, and neither of the stone's automatic
versions is used. `STN_GEM_TIMEOUT` would end idle notebooks and Shells with
their variables.

**Ending sessions below the free-space threshold — the stone's, not GemDB's,
and left on.** Three minutes below the threshold the stone ends the `gemdb`
sessions holding the oldest commit record (`STN_DISKFULL_TERMINATION_INTERVAL`,
at its default). That loses their uncommitted work, unasked, and is accepted:
the alternative is a repository with no free pages, where nothing can be
collected and committed work is at risk. GemDB's part is to warn — at once,
and again at two minutes — and to start collecting the moment it notices (see
[`repository-space.md`](repository-space.md)).
