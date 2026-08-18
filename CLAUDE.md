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
```

Before calling something done: `npm run lint && npm run format:check && npm run typecheck && npm run typecheck:strict`.

## The automation line

GemDB automates aggressively, along one rule: **automate what is inert and
reversible; ask about what is persistent or global.**

- Download, unpack, create the database, stage Grail — all inside the root path,
  all undone by deleting it. Runs unasked on first activation (`prepare`).
- Raising shared memory — needs `sudo`, changes the machine for all software,
  survives reboots. **Always prompts.** Do not automate this, whatever else
  changes. Asked *at the start of first-run setup, concurrently with the
  download* — not at first use, and not after the download finishes. Two earlier
  placements were worse: attached to "Open Python REPL" it arrived with no
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
`gslist` parser, what `runStop` does when the stone refuses, and what the
notebook kernel does with a batch of cells. Anything with a branch worth
defending belongs here, which is why `runStop` takes its collaborators as a
`StopWorld` argument rather than reaching for them.

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

## The two things that are easy to get wrong

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
shim against the *pinned* engine version, and stages the result. The shim links
`$GEMSTONE/lib/gciualib.o`, so it is valid only for the platform **and** the
engine version it was built against — a mismatch installs cleanly and then
fails at `import`. Changing `PINNED_ENGINE_VERSION` in `src/config.ts` means
re-running `bundle:grail` on every supported platform.

**Grail must be staged to a stable directory.** `installGrail` records Grail's
own directory *inside the database*, and every session resolves modules relative
to it. The extension directory is versioned (`gemdb.gemdb-<version>/`), so it
moves on every update; that is why `stageGrail` copies the payload to
`<rootPath>/grail` first and points `GRAIL_DIR` there.

## Layout

| File | What it owns |
| --- | --- |
| `config.ts` | the pinned engine version, the fixed names, the root path |
| `paths.ts` | where everything lives under the root path |
| `engine.ts` | downloading and extracting the database engine |
| `database.ts` | creating the one database |
| `osConfig.ts` | shared memory and RemoveIPC — the `sudo` prompts |
| `processes.ts` | `gslist` parsing, start/stop, and the environment sessions inherit |
| `grail.ts` | staging and installing the Grail payload |
| `autoStart.ts` | whether the database may start unasked, and the record of a deliberate stop |
| `lifecycle.ts` | `prepare` (inert, unattended) and `ensureRunning` (prompts, starts) |
| `lock.ts` | the cross-window setup lock — activation runs in every window |
| `statusBar.ts` | the always-visible "a database is running" indicator |
| `session.ts` | the single GCI session |
| `pythonQueries.ts` | the Smalltalk that runs Python and reports its errors |
| `notebook.ts`, `repl.ts` | the two ways to run Python |
| `statusView.ts` | the one tree view |
| `gci/` | **vendored from Jasper — do not edit** |

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

macOS and Linux. Windows is out of scope for now — reaching it means routing
every command through WSL, as Jasper does. Do not add partial Windows paths;
`isSupportedPlatform()` is the single gate.
