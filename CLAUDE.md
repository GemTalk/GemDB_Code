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
npm run format:check
npm test                   # unit tests, mocked, milliseconds
npm run test:integration   # a real database in a temp root path; seconds
npm run bundle             # esbuild -> out/extension.js
npm run bundle:grail       # assemble the Grail payload (needs a C toolchain)
npm run bundle:extent      # build the preloaded extent (needs an engine + shared memory)
npm run package            # .vsix
scripts/install-engine.sh  # download + extract the pinned engine, no editor involved
scripts/check-vsix.sh      # assert a packaged .vsix carries what an install needs
```

Before calling something done: `npm run lint && npm run format:check && npm run typecheck && npm run typecheck:strict`.

## The automation line

GemDB automates aggressively, along one rule: **automate what is inert and
reversible; ask about what is persistent or global.**

- Download, unpack, create the database, stage Grail — all inside the root path,
  all undone by deleting it. Runs unasked on first activation (`prepare`).
- Raising shared memory — needs `sudo`, changes the machine for all software,
  survives reboots. **Always prompts.** Do not automate this, whatever else
  changes. Asked _at the start of first-run setup, concurrently with the
  download_ — not at first use, and not after the download finishes. Two earlier
  placements were worse: attached to "Open GemDB Shell" it arrived with no
  visible connection to what was clicked; at the end of the download it arrived
  two minutes after the user last thought about GemDB, by which point they have
  moved on and it sits unanswered. Running it alongside the download spends
  their attention while they still have it. `ensureRunning` still checks, as the
  backstop for a decline or a machine that changed; nothing re-prompts on every
  activation. Verified end to end on 2026-08-14. One known cost, accepted rather
  than overlooked: being modal, the dialog dims the download's Cancel button
  until it is answered. Dismissing the dialog frees it, and a non-modal prompt
  would trade a rare, recoverable friction for the very thing the early
  placement buys — a prompt that cannot be missed.
- Starting the stone and NetLDI — those processes detach (`ppid` 1) and outlive
  VS Code. Started on activation, so a new developer's first notebook cell does
  not wait for a database; the status bar always says so, and clicking it stops
  it. This is the one automated act that is not confined to the root path, and
  it is only defensible because of `autoStart.ts`: a user who stops the database
  is obeyed until they ask for one again. It never prompts — if shared memory is
  unraised it stands down and leaves that to `ensureRunning`, where a `sudo`
  dialog has a visible cause.

`ensureRunning` in `lifecycle.ts` is the single path to a running database,
whether the user pressed Start or just ran a notebook cell. It finishes any
outstanding preparation, prompts for shared memory, starts the processes, and
files Grail in. New entry points that need a database should call it rather than
checking and asking.

## The two test suites

`npm test` is mocked and fast, and covers decisions: the setup lock, the
`gslist` parser, what `runStop` does when the stone refuses, what the notebook
kernel does with a batch of cells, every keystroke the REPL's line editor
interprets, and the REPL loop around it — the continuation rule, exit(),
type-ahead, KeyboardInterrupt (`lineEditor.ts` is pure and `pyRepl.ts` takes
its collaborators as a `ReplWorld` argument for exactly that reason). Anything
with a branch worth defending belongs here, which is why `runStop` takes its
collaborators as a `StopWorld` argument rather than reaching for them.

The kernel is tested through the `executeHandler` the controller publishes —
the same entry point VS Code calls — by way of a fake controller in
`src/__mocks__/vscode.ts`. Deliberately no `@vscode/test-electron`: what is left
once the batching, scope keying and output shaping are covered is whether VS
Code offers the controller in the kernel picker, which is VS Code's behaviour
and not worth a downloaded editor per run to assert.

`npm run test:integration` starts a real database and is a separate command
because it is seconds rather than milliseconds and leaves processes behind if it
fails badly. It borrows the installed engine by symlink and points
`gemdb.rootPath` at a temporary directory; since `engineEnvironment` sets
`GEMSTONE_GLOBAL_DIR` to the root path, and that is where the engine keeps its
lock files, the test stone and a real one can both be called `gemdb` and stay
invisible to each other. It skips itself when no engine is installed.

Download and extraction stay out of both: 210 MB to test an HTTP range request.

## CI

`.github/workflows/ci.yml`, two jobs split on what they need. `checks` runs
lint, both typechecks, the unit suite and the packaging path on Linux in a
couple of minutes — the unit suite is host-free by design, and running it
somewhere that cannot possibly host a database is what keeps it that way.
`integration` runs the whole thing for real, once per shipped target on a
runner of that architecture: `install-engine.sh`, the shared-memory script for
that OS under `sudo` (a throwaway machine is the one place raising shared
memory unattended is uncontroversial), `bundle:grail`, `bundle:extent`,
`test:integration`, then `package.sh` for that target — which packages and
checks in one step. Each leg uploads its `.vsix`, so a release can be assembled
from CI rather than from three machines. Require `ci-complete` in branch
protection, not the job names: it fans the matrix in to one check.

Two things about it are load-bearing:

**A green integration run has to mean the suite ran.** Every integration file
skips itself when the engine, the payload or the extent is missing — right
locally, where a fresh checkout should still have a green suite, and dangerous
in CI, where an artifact that failed to build would report success for a suite
that executed nothing. The `Confirm the suite has something to run against`
step asserts those paths instead of trusting the exit code — the engine, the
payload, the shim, the extent, and `out/gemdb-shell.js`, which `repl.test.ts`
needs because it drives the shell as a real process. Anything new that skips on
a missing artifact belongs in that list.

**`bundle:grail` clones Grail's default branch**, so the integration job is
also the early warning that a Grail change broke GemDB's installer — and it
means a GemDB branch that depends on unmerged Grail work is red until that
Grail PR lands. Prove it in the meantime with `workflow_dispatch` and its
`grail-ref` input, which becomes `GRAIL_REF` for `bundle-grail.sh`.

Releases are deliberately not automated: publishing stays a developer's act
from a Mac, per CONTRIBUTING.md. CI packages a `.vsix` and inspects it, but
never publishes one.

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
says `Stone Session limit: 10`, the database's own gems (GcUser, SymbolUser)
spend some of it, and every GemDB Shell terminal is another. So a closed
notebook gives its session back (`onDidCloseNotebookDocument`), and a login
refused with GemStone error 4039, 4041 or 4050 becomes a `SessionLimitError`
naming what this window holds and which session has been idle longest.

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

**A release ships a database, not just the code to build one.**
`scripts/bundle-extent.sh` creates a scratch database, files Grail into it, and
stages the result as `extent/gemdb.dbf`; `createDatabase` copies that instead of
the engine's stock `extent0.dbf`, so Python works the moment the files are on
disk. The engine's extent is still the fallback when the artifact is absent —
that keeps a fresh checkout working, and keeps the file-in path exercised, which
is what an in-place Grail upgrade will need. Both are covered:
`preloaded.test.ts` for the shipped extent, `grail.test.ts` for the file-in.

**The Grail payload is a build artifact, not source.** `grail/` is gitignored and
produced by `scripts/bundle-grail.sh`, which clones Grail, compiles its CPython
shim against the _pinned_ engine version, and stages the result. The shim links
`$GEMSTONE/lib/gciualib.o`, so it is valid only for the platform **and** the
engine version it was built against — a mismatch installs cleanly and then
fails at `import`. Changing `PINNED_ENGINE_VERSION` in `src/config.ts` means
re-running `bundle:grail` on every supported platform.

**The CLI's exit codes go through a status file, not topaz.** topaz cannot
carry an exit status out of a `run` block — `ExitClientError status:` is not
translated, and an `iferr … exit 1` action exits 0 (all measured). So
`gemdb-run.tpz` writes the status to the file named in `GEMDB_STATUS_FILE` and
the bash wrapper becomes the exit code. Errors there are caught as
`AbstractException`, not `Error`: Grail's Python exceptions live outside the
`Error` branch, which is why grail.tpz's own file mode exits 0 on a Python
error. `sys.exit(n)` is decoded by that same handler: Grail raises its own
`SystemExit` (never `ExitClientError` — `except SystemExit` and `finally`
must keep working), whose argument survives only in the exception's Python
`args` tuple (the CPython `code` attribute is absent and the `code` instVar
is never assigned — measured). The driver reads it with
`___pyAttrLoad___: #'args'` and applies CPython's contract: None → 0 silent,
int → `n \\ 256` silent, anything else → str to stderr and 1.

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

**`input()` is a round trip through a ClientForwarder, and the traps are
measured.** Grail's input() consults a per-session stdin provider
(`builtins class >> stdinProvider:`); `session.ts` installs a ClientForwarder
there at first evaluation, catches its send as GCI error 2336, and resumes with
`GciTsContinueWith` — a line (`GciTsNewUtf8String` with convertToUnicode; a raw
Utf8 reply is byte-immutable and dies on `replaceFrom:to:with:startingAt:`),
nil for EOF (→ EOFError), or the Symbol `#interrupt` (→ KeyboardInterrupt _at
the call_, catchable by the user's try/except). The interrupt must travel
in-band because both client-side routes fail: continuing with a GCI error
restarts the signalling frame, which does not search for handlers, and a soft
break queued while the gem waits in the forwarder is discarded on resume.
Gem-side, ClientForwarder is a ROOT class — even `isNil` forwards — so Grail
compares it with `==` and boxes it in an Array inside SessionTemps (whose
`at:put:` itself sends to the value). `interrupt()` during a pending read
resolves the read as `#interrupt` instead of sending a break the gem cannot
receive. All of it is exercised end to end in `src/__integration__/repl.test.ts`
(shell, via a pty) and `cli.test.ts` (file mode, which needs none of this —
a linked gem's GsFile stdin IS the process's stdin).

**`print()` reaches the user only because the query layer captures it — and it
streams when the caller can take it.** Grail routes `print()` through the
Smalltalk global `Transcript`; over an RPC session the gem's stdout is a log
file, so uncaptured output silently vanishes — that was a live notebook bug
once. `buildQuery` in `pythonQueries.ts` redirects `Transcript` per evaluation
and restores it in an `ensure:`. Two shapes: without `onOutput` it is a
WriteStream, shipped back with the result framed by a unit separator; with
`onOutput` it is a `ClientForwarder`, so each print surfaces mid-execution as
error 2336 (one `nextPutAll:` per print — Grail builds the whole line first)
and `session.ts` hands the text to the sink and resumes with the forwarder
itself (a stream returns self). The streaming `ensure:` must send _nothing_ to
the forwarder. Interrupting a print loop needed its own mechanism, all of it
measured: a break that arrives while the gem is idle in a forwarder send is
discarded on resume, a print loop is idle in one most of the time, re-sent
breaks almost never hit the microseconds of execution between sends, and
continuing the send with an error does NOT terminate anything — it re-signals
the SAME send. What works is `GciTsClearStack` on the suspended send's
GsProcess: it ends the call, runs the unwind blocks (so the `ensure:` restores
Transcript), and leaves the session usable. So `interrupt()` sends one
immediate break (for a gem that is executing) and sets `breakPending`; the
executeAsync loop clears the stack at the next forwarder stop and throws
`ExecutionInterrupted`, which the query layer reports as
`Error: KeyboardInterrupt - `. Anything new that evaluates Python should go
through that layer, not `execute` directly.

**Grail must be staged to a stable directory.** `installGrail` records Grail's
own directory _inside the database_, and every session resolves modules relative
to it. The extension directory is versioned (`gemdb.gemdb-<version>/`), so it
moves on every update; that is why `stageGrail` copies the payload to
`<rootPath>/grail` first and points `GRAIL_DIR` there.

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

| File                         | What it owns                                                                             |
| ---------------------------- | ---------------------------------------------------------------------------------------- |
| `config.ts`                  | the pinned engine version, the fixed names, the root path                                |
| `paths.ts`                   | where everything lives under the root path                                               |
| `engine.ts`                  | downloading and extracting the database engine                                           |
| `database.ts`                | creating the one database                                                                |
| `osConfig.ts`                | shared memory and RemoveIPC — the `sudo` prompts                                         |
| `processes.ts`               | `gslist` parsing, start/stop, and the environment sessions inherit                       |
| `grail.ts`                   | staging and installing the Grail payload                                                 |
| `autoStart.ts`               | whether the database may start unasked, and the record of a deliberate stop              |
| `lifecycle.ts`               | `prepare` (inert, unattended) and `ensureRunning` (prompts, starts)                      |
| `lock.ts`                    | the cross-window setup lock — activation runs in every window                            |
| `statusBar.ts`               | the always-visible "a database is running" indicator                                     |
| `session.ts`                 | GCI sessions, one per owner, and who owns which                                          |
| `pythonQueries.ts`           | the Smalltalk that runs Python and reports its errors                                    |
| `notebook.ts`                | the notebook kernel — one session per notebook                                           |
| `pyRepl.ts`, `lineEditor.ts` | the GemDB Shell: the REPL loop and its line editing, both host-free                      |
| `cliMain.ts`                 | the shell as a process — a raw tty wired to `pyRepl.ts`; bundled to `out/gemdb-shell.js` |
| `cliVscode.ts`               | the environment-backed stand-in for `vscode` in that bundle                              |
| `repl.ts`                    | opening GemDB Shell terminals (on the CLI); running a `.py` file via the CLI             |
| `cli.ts`                     | generates `<rootPath>/bin/gemdb` and stages the shell bundle beside it                   |
| `statusView.ts`              | the one tree view                                                                        |
| `gci/`                       | **vendored from Jasper — do not edit**                                                   |

`docs/` holds design notes that are not part of the shipped extension
(`.vscodeignore` keeps them out of the `.vsix`): decisions taken, what was
measured, and what is still open. Start with
[`docs/reaching-windows.md`](docs/reaching-windows.md).
[`docs/demo-rabbit-in-the-hat.md`](docs/demo-rabbit-in-the-hat.md) is the
five-minute demo of persistence and sessions, with runnable scripts in
`docs/demo/`; every command and output in it was measured, which is how the
`runPath` gap below was found.

**`gemdb file.py` starts with a dirty session, so `gemdb.transaction()` cannot
be a script's first statement.** Measured 2026-08-23, and it contradicts what
`cli.ts` claims a few lines above its driver. Walking the preamble one send at
a time in a clean session: `___canonicalClassesEnabled___: true` leaves
`System needsCommit` false, the `#GrailConsole` store leaves it false, and
`importlib runPath:` sets it true — twice from clean, so it is `runPath`
itself, not the file's own code (a script whose first line is
`import gemstone; print(gemstone.needs_commit)` already prints True). The
transaction block's entry check then blames the user for Grail's plumbing.
Shell and notebook sessions are unaffected: they evaluate through
`evaluateSource:usingModuleScope:` and a fresh one runs a transaction block as
its first action. The fix belongs in Grail; until it lands, scripts should
`commit()` or `abort()` first.

`src/gci/` is copied byte-for-byte from Jasper's `client/src/gciLibrary.ts`,
`gciConstants.ts`, and `gciLibraryError.ts` so upstream fixes can be pulled in
with a plain `cp`. ESLint ignores it; keep it that way, and send fixes upstream
rather than patching here.

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

Intel macOS is the deliberate omission, and not for lack of code:
`platformKey` spells it `i386.Darwin` (the vendor's historical name for the
64-bit Intel build; there is no `x86_64.Darwin` in the catalog, and that URL
404s), the engine is published, and every branch handles it. What is missing is
a machine — Apple Silicon hardware and CI runners cannot build its shim without
cross-compiling, and a cross-built shim nobody has run is exactly what the gate
refuses to promise.

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
