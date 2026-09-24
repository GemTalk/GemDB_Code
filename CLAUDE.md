# GemDB

A VS Code extension that installs a database which runs Python, and gets out of
the way. Single npm package; entry point `src/extension.ts`, bundled to
`out/extension.js` by esbuild.

## Commands

```sh
nvm use                    # Node 22.15+ (see engines in package.json)
npm install
npm run typecheck          # tsc --noEmit
npm run typecheck:strict   # extra checks the first-party code is held to
npm run lint
npm run lint:toolchain     # guards against `tsc` silently resolving to the wrong TypeScript
npm run format:check
npm test                   # unit tests, mocked, milliseconds
npm run test:integration   # a real database in a temp root path; seconds
npm run bundle             # esbuild -> out/extension.js
npm run bundle:grail       # assemble the Grail payload (needs a C toolchain)
npm run bundle:mcp         # assemble the MCP server payload (needs nothing)
npm run test:extent        # build the extent the integration suite starts from
npm run package            # .vsix
npm run hooks:uninstall    # remove the local git hooks npm install added
scripts/install-engine.sh  # download + extract the pinned engine, no editor involved
scripts/check-vsix.sh      # assert a packaged .vsix carries what an install needs
```

Before calling something done: `npm run lint && npm run format:check && npm run typecheck && npm run typecheck:strict`.

Never add `eslint-disable` or change a rule's severity to silence a lint error — fix the underlying code. If a rule genuinely can't be satisfied, add a scoped disable (single line, not file-wide) with a comment explaining why, and flag it to the user before committing. `eslint-comments/require-description` enforces that every disable comment carries a `-- reason`, so an undocumented one fails `npm run lint` outright.

## The automation line

GemDB automates aggressively, along one rule: **automate what is inert and
reversible; ask about what is persistent or global.**

Two placements are fixed whatever else changes: raising shared memory
(`sudo`, machine-wide, survives reboots) **always prompts**, and a failure to
start the MCP server **never fails `ensureRunning`**. **Adding or changing an
automated step? Read
[`docs/automation-boundary.md`](docs/automation-boundary.md) first** — it
records where each shipped step sits on the line and why, including what was
measured about when to ask for shared memory.

`ensureRunning` in `lifecycle.ts` is the single path to a running database,
whether the user pressed Start or just ran a notebook cell. It finishes any
outstanding preparation, prompts for shared memory, starts the processes, files
Grail in, and brings the MCP server up. New entry points that need a database
should call it rather than checking and asking.

## CI

`.github/workflows/ci.yml`, two jobs split on what they need. `checks` runs
lint, both typechecks, the unit suite and the packaging path on Linux in a
couple of minutes — the unit suite is host-free by design, and running it
somewhere that cannot possibly host a database is what keeps it that way.
`integration` runs the whole thing for real, once per shipped target on a
runner of that architecture: `install-engine.sh`, the shared-memory script for
that OS under `sudo` (a throwaway machine is the one place raising shared
memory unattended is uncontroversial), `bundle:grail`, `test:extent`,
`test:integration`, then `package.sh` for that target — which packages and
checks in one step. Each leg uploads its `.vsix`, so a release can be assembled
from CI rather than from three machines. Require `ci-complete` in branch
protection, not the job names: it fans the matrix in to one check.

Two things about it are load-bearing:

**A green integration run has to mean the suite ran.** Every integration file
skips itself when the engine, the payload or the test extent is missing — right
locally, where a fresh checkout should still have a green suite, and dangerous
in CI, where an artifact that failed to build would report success for a suite
that executed nothing. The `Confirm the suite has something to run against`
step asserts those paths instead of trusting the exit code — the engine, the
payload, the shim, the test extent, `out/gemdb-shell.js` (which `repl.test.ts`
needs because it drives the shell as a real process), and the MCP payload.
Anything new that skips on a missing artifact belongs in that list.

**`bundle:grail` and `bundle:mcp` clone the commits pinned in `vendor-pins.sh`**, not
upstream's default branch — so a release is reproducible from its tag, and two
`.vsix` files built from the same GemDB sha carry the same upstream code. The
cost, taken deliberately: this is no longer an early warning that a Grail or
mcp_server change broke GemDB's installer, since CI no longer builds against
upstream HEAD on every run. To check upstream deliberately, dispatch the
workflow (Actions → CI → Run workflow) with `grail-ref: main` and/or
`mcp-ref: main`; those become `GRAIL_REF`/`MCP_REF` for `bundle-grail.sh` and
`bundle-mcp.sh`, which still verify everything GemDB's installer reads. Bumping
a pin is a one-line `vendor-pins.sh` PR whose CI run is the proof the new upstream
commit works.

CI never publishes. `.github/workflows/release.yml` does, and it is dispatched
by hand, holds at a required-reviewer gate, and **builds nothing** — it
publishes the `.vsix` files CI uploaded for that exact commit. That is not a
shortcut: no runner can compile all three shims, and `bundle:grail` clones
Grail's default branch, so a rebuild at release time would ship a payload
nothing tested under a version number that says otherwise. Artifact retention
on `main` is 90 days for the same reason — those uploads are the only copies
that exist.

Its order follows one rule: **publishing is the only irreversible step**, since
both registries are immutable per `(publisher, name, version, targetPlatform)`.
So everything recoverable happens first — collect, check, scan, approve — and
the GitHub Release is created before either registry sees a file, so both
publish jobs send bytes fetched from an immutable asset. Two consequences worth
knowing before editing it: a check that can run without a checkout belongs in
`validate`, and one that needs the tree belongs in `collect`, which is the
first job with one and the last point before a human is asked to approve
anything. And `scripts/publish-to-registry.sh` decides what a registry's answer
*means* — `--skip-duplicate` mishandles an uploaded-but-inactive package, which
is exactly the state a re-run meets — so it is covered by
`publishToRegistry.test.ts` rather than discovered during a release, where the
first signal would be a red job on a version number that can never be reused.

## The things that are easy to get wrong

**A session is a unit of work, so each notebook owns one.** Sharing a session
across notebooks would mean sharing a transaction: a commit in one notebook
commits another's half-finished changes, and `gemdb.transaction()` refuses to
start because a notebook the user is not looking at left the session dirty. So
`sessionFor(owner)` keys sessions by owner — a notebook's URI, or
`EXTENSION_OWNER` for administrative queries that must work with no notebook
open. This also matches what every other notebook tool does: VS Code's Jupyter
extension starts a kernel per notebook.

Three consequences are easy to miss. **Anything that invalidates the database
must log out _every_ session**, not the extension's own — `logoutAll()`, which
is why installing Grail, uninstalling, and a root-path change all call it; a
notebook left logged in would keep a view of a database that no longer exists.
**Anything that runs in a notebook's scope must run in that notebook's
session**: the scope dictionary lives in that session's SessionTemps, so
`resetScope` takes an owner and clears nothing if that owner has no session
yet. And **sessions are scarce** — the Community Edition keyfile GemDB installs
says `Stone Session limit: 10`, the database's own gems (SymbolGem, GcReclaim)
spend some of it, and every GemDB Shell terminal is another. So a closed
notebook gives its session back (`onDidCloseNotebookDocument`), and a login
refused with GemStone error 4039, 4041 or 4050 becomes a `SessionLimitError`
naming what this window holds and which session has been idle longest. **The
MCP server spends them too** — the router gem holds one for as long as it runs
and gives each connected client another — which is why the status view says so
in that row rather than leaving it to be discovered at a `SessionLimitError`.

`sessionRegistry()` is the map from a session to the UI that owns it, idlest
first, carrying GemStone's own session serial so a row here can be matched to
`gemdb.sessions.all()` over there. The status view shows it.

That registry is private to one extension host, which is why every session also
publishes itself with **`System cacheName:`** — `cacheNameFor` in `session.ts`.
It writes the shared page cache, so the name is readable by every session on
the host (`System cacheStatisticsForAllSlots`, whose rows are
`(name, pid, sessionId)`), which is what lets another window, topaz, or a
dashboard attribute a session GemDB did not open for it. Preferred over a
committed registry deliberately: it costs no commit, and the entry dies with
the process rather than outliving a window that crashed. **The limit is 31
characters** — 32 raises `OutOfRange` (2061), measured — so the name is a
label and the sessionId remains the identifier; `cacheNameFor` truncates and
strips non-ASCII rather than letting a long notebook title fail a login. File
mode needs its own copy of this in `gemdb-run.tpz`, because linked topaz never
reaches `session.ts` and would otherwise show as the stock `TopazL` (an
unnamed RPC gem is `TopazR` — also measured).

Names read `GemDB nb analysis`, `GemDB Shell 41234`, `GemDB Code`,
`GemDB run backfill`. The product names are capitalised as the product is
written, per the GemDB Shell rule above — an administrator reading a session
list is a user — while `nb` and `run` are common nouns and stay lowercase.
`nb` is abbreviated where `Shell` is spelled out because a shell's suffix is a
fixed-width pid while a notebook's is a filename, and every character the tag
takes is one the title loses: 22 against 16. GemStone's own names in that
column are PascalCase (`GcReclaim`, `SymbolGem`, `ShrPcMonitor`, `TopazR`);
the one lowercase entry is the stone's slot, which carries the stone's
configured name rather than a product's, so it is not a counter-example.

**A notebook's URI is its session key _and_ its namespace key, so a rename
moves both.** `renameOwner` in `pythonQueries.ts` is that move — it re-keys the
scope dictionary inside the session, then `renameSession` re-keys the map and
re-publishes the cache name. Without it a rename strands the old session
(logged in, spending one of ten, owned by a URI nothing will ask for again) and
hands the notebook an empty namespace, which reads as lost variables. Wired to
`onDidRenameFiles`, which is explicit renames only; saving under a new name
makes a second document and correctly gets a session of its own.

Two things the GCI headers say, so nobody goes looking again: there is no
`GciInit` equivalent in the thread-safe library at all, `GciInitAppName` "has
no effect in remote GCI applications", and `GciSetCacheName_` does nothing when
`GciIsRemote()`. The Smalltalk send is the only route that works for GemDB.
For reporting on sessions, `System descriptionOfSession:` carries what matters
in slots 5 (last begin/commit/abort), 16 (commits behind this session's view),
8 (holding the oldest commit record) and 21 (the client's pid, RPC only).

**`gemdb` with no arguments IS the GemDB Shell — one REPL, bundled twice, run
once.** `out/gemdb-shell.js` is esbuild's second bundle: `cliMain.ts` wrapping
the same `pyRepl.ts`/`pythonQueries.ts`/`session.ts` the extension uses, with
the `vscode` module replaced by the environment-backed `cliVscode.ts` (the
same alias move vitest makes for unit tests). `writeCliScripts` stages the
bundle and `node_modules/koffi` (this platform's binary only) to
`<rootPath>/bin`, and the wrapper runs it under the editor's own Node —
`process.execPath` recorded at generation time, `ELECTRON_RUN_AS_NODE=1`, a
PATH `node` as fallback. "Open GemDB Shell" opens a terminal on that wrapper,
so the shell is out of the extension host entirely: a wedged FFI call is a
dead tab, not a dead window. The reason this exists is measured topaz history:
Grail's own topaz REPL (`gemdb`'s old no-argument handoff) wraps evaluation in
`on: Error do:`, and Grail's Python exceptions descend from
`AbstractException`, not `Error` — so a `ZeroDivisionError` printed a
Smalltalk stack and stranded the user at `topaz 1>`, Ctrl+C did the same via
`Break` (6003), and Ctrl+D raised `EOF from stdin!`. Do not hand the
no-argument mode back to `grail.tpz`. The shell is exercised end to end —
through a real pty, `expect(1)` — in `src/__integration__/repl.test.ts`.

**An engine upgrade orphans the database, and the engine will not say so until
a login fails.** `assertDatabaseMatchesEngine` in `database.ts` is the guard,
and it exists because the failure without it looks like success: measured on
2026-09-11 moving 3.7.5 → 4.0.0.Alpha1, the extent *format* is unchanged
(`compatibilityLevel: 855` either way), so the new stone **starts** on the old
repository and `gslist` reports it OK — status bar green, database "running" —
and then every login fails with GemStone error 4045, "The Gem and dbf versions
are incompatible". The first notebook cell, the shell and the MCP server all
break at once with an error naming neither cause nor cure.

**One alpha to the next is the same story, and it is the one users actually
meet.** 4.0.0.Alpha1 was withdrawn from the catalog on 2026-09-16, the day
4.0.0.a2 replaced it, so every database in the field was written by an engine
that can no longer be downloaded. Measured that day: an Alpha1 extent still
reads `compatibilityLevel: 855` under a2, so the a2 stone starts on it and only
the logins fail. The guard is what turns that into a sentence.

There is no upgrade to offer instead: 3.7.5 shipped `bin/upgradeImage`, and no
4.0 alpha ships one (checked again on a2), so converting the image is not
something GemDB could do on a user's behalf. The guard reads the repository's
version with
`copydbf -i` and refuses, naming both versions and the directory to delete.
Checked in two places, and both are needed: `prepareFiles`, which is the
first-install path, and `startProcesses` before the stone starts, because an
extension update reaches that line without preparing anything — engine
downloaded, database present, Grail staged, so `isInstalled()` is true.

## What the shell is called

The interactive Python prompt is **GemDB Shell** everywhere a user can see it:
the command title, the terminal tab, the walkthrough, the README. The internal
names are unchanged and deliberately so — `gemdb.openRepl`, `repl.ts`,
`pyRepl.ts` — because the command id is the one part a user can bind a key to,
and renaming it would break those bindings for no gain. When adding a
user-visible string, write "GemDB Shell"; when naming code, `repl` is still
the house term.

The `gemdb` CLI's no-argument mode _is_ the GemDB Shell — the identical
program, since "Open GemDB Shell" just runs the wrapper in a terminal. See the
note below for how the bundle is built and staged.

## Layout

`src/*.ts` files are named for what they do and are self-explanatory on read.
Exceptions worth flagging, because they aren't derivable from the file itself:

- **`gci/` and `src/gci/` are vendored from Jasper — do not edit.** Copied
  byte-for-byte from Jasper's `client/src/gciLibrary.ts`, `gciConstants.ts`,
  and `gciLibraryError.ts` so upstream fixes can be pulled in with a plain
  `cp`. ESLint ignores it; keep it that way, and send fixes upstream rather
  than patching here.
- **`demo.ts` is the one command that writes outside the root path** —
  cloning the Brain Freeze demo needs a folder-dialog consent, since
  everything else GemDB does is confined to (and undone by deleting) the root
  path.

`docs/` holds design notes — decisions and measurements, not shipped.
[`docs/README.md`](docs/README.md) says which one to read before which change.

**Building on Grail, or touching the Python↔GCI bridge? Read
[`docs/grail.md`](docs/grail.md) first** — it covers install/staging
mechanics, the bridge internals (exit codes, `input()`, `print()`, encoding),
and the gotchas found building Brain Freeze (class identity across
commits/aborts, schema changes, `sys.path`, the dirty-session-on-first-
statement trap).

## Relationship to Jasper

Jasper is the full GemStone IDE and exposes the whole administrative surface —
versions, databases, processes, logins. GemDB hides all of it and pins one
tested combination, because its audience is a developer who wants to write
Python, not run a database. When a behaviour here looks under-featured compared
to Jasper, that is usually the point; check before "fixing" it.

The two are designed to coexist on one machine: GemDB keeps its files under
`~/GemDB` and names its stone `gemdb` and its listener `gemdbldi`, so neither
the directories nor the process names collide with Jasper's defaults.

## Platform support

**Three targets: `darwin-arm64`, `linux-x64`, `linux-arm64`.**
`isSupportedPlatform()` in `platform.ts` is the single gate, and its job is to
agree with the payload: a build without a matching Grail shim installs cleanly
and then fails at the first `import`. CI builds each target's shim on a runner
of that architecture, which is what makes the gate honest — a shim can only be
compiled where it runs.

**Intel macOS will not be supported.** It used to be one machine away: the
3.7.x catalog published an `i386.Darwin` engine (the vendor's historical name
for the 64-bit Intel build) and only the shim was missing, for want of hardware
that could compile it natively. At 4.0 the engine itself is gone —
`dl.gemdb.com` publishes `arm64.Darwin`, `arm64.Linux` and `x86_64.Linux`, and
nothing for Intel — so there is no build to support even if a machine appeared.
`platformKey` answers undefined there rather than spelling a key that names
nothing.

Adding a platform is still two steps in this order: build its shim so
`grail/prebuilt/<key>/` carries it, then widen the gate. The reverse order is
the bug the gate exists to prevent. Four places must agree, and
`check-vsix.sh`'s `case` will fail loudly if they do not: `isSupportedPlatform`,
the koffi list in `.vscodeignore`, the targets in `package.json`, and that
`case`.

Each `.vsix` is platform-specific, so the Marketplace never offers one to a
machine that cannot run it. `scripts/package.sh` builds this machine's target
(or `--all`) and hands every package to `check-vsix.sh` — nothing here produces
a `.vsix` that has not been inspected. All three shims ride along in every
package: a shim is 276 KB, so pruning per target would save a fraction of a
megabyte and cost a move-and-restore dance around build artifacts. The same
trade is made for koffi's binaries in `.vscodeignore`.

Windows is out of scope in the shipped product, and the obstacle is not the
extension: there is no GemStone server for Windows, so any Windows story puts
the database on Linux and decides where the seam falls. **Do not add partial
Windows paths.** The options — VS Code's WSL window (which needs no new code at
all), a native Windows client against a remote server, and Docker as a server
backend — are worked through in
[`docs/reaching-windows.md`](docs/reaching-windows.md), together with what was
measured and what still needs a Windows machine. Read that before starting any
of it.
