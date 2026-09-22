# Grail

[Grail](https://github.com/GemTalk/grail) is the CPython-in-a-gem bridge that
lets GemDB run Python inside GemStone. This note covers how its payload is
built and staged, how the Python↔GCI bridge behaves, and what to know before
building an application on top of it. The invariants that must not be broken
are in CLAUDE.md; this is the reasoning and the measurements.

## Install and staging

**A release ships code to build a database, not a database.** GemDB used to
ship a prepared `extent/gemdb.dbf` with Grail already filed in, so that Python
worked the moment the files were on disk. That is gone, and the reason is the
whole point of the product: this is a *database*. A user's extent accumulates
their data, so an update cannot replace it — Grail and the MCP server have to
be installed into whatever is already there and upgraded in place. Shipping a
prepared extent made the first install fast and made every upgrade afterwards
take a different, less-exercised path, which is precisely backwards: the path
that has to keep working for the life of the database is the one that should
run every time. So `createDatabase` always copies the engine's own
`bin/extent0.dbf`, and `ensureRunning` files Grail in.

What that costs is minutes of topaz on a first run, worth paying once per user
and not worth paying once per integration test file — so
`scripts/build-test-extent.sh` (`npm run test:extent`) builds the same thing as
a **test** artifact at `.test-extent/gemdb.dbf`, and the tests that need Python
but are not testing the file-in start from it. `grail.test.ts` still files Grail
into a stock extent, because that is the path every real install takes.

**The Grail payload is a build artifact, not source.** `grail/` is gitignored and
produced by `scripts/bundle-grail.sh`, which clones the Grail commit pinned in
`vendor-pins.sh`, compiles its CPython shim against the pinned engine version (a
different pin, in `src/config.ts`), and stages the result. The shim links
`$GEMSTONE/lib/gciualib.o`, so it is valid only for the platform **and** the
engine version it was built against — a mismatch installs cleanly and then
fails at `import`. Changing `PINNED_ENGINE_VERSION` in `src/config.ts` means
re-running `bundle:grail` on every supported platform.

**Grail must be staged to a stable directory.** `installGrail` records Grail's
own directory _inside the database_, and every session resolves modules relative
to it. The extension directory is versioned (`gemdb.gemdb-<version>/`), so it
moves on every update; that is why `stageGrail` copies the payload to
`<rootPath>/grail` first and points `GRAIL_DIR` there.

**Stage Grail before stamping it, and stamp only what this run created.**
`stageAndRecordGrail` in `grail.ts` owns that order. Reversed, it broke both
ways at once: on a first install `<rootPath>/grail` does not exist yet, so
writing the stamp threw ENOENT and setup died just after "Database created"
(reported from the field, 2026-08-24); on an upgrade the stamp landed in the
*previous* version's directory, `grailNeedsUpdate` then compared the bundled
stamp against itself and skipped staging, so the old payload stayed on disk
labelled as the new one and `writeCliScripts` never refreshed `bin/gemdb`. It
could not have worked regardless — `stageGrail` replaces the directory
wholesale, stamp included. Neither failure reproduces on a machine that has run
an earlier version, and the integration suite calls `stageGrail` itself rather
than going through `prepare`, which is why `src/__tests__/grailStaging.test.ts`
starts from a root path that does not exist. Since GemDB stopped shipping an
extent there is only one answer to *when* the stamp may be written — after a
successful file-in, by `recordGrailInstalled`, and nowhere else — so staging no
longer stamps at all and the ordering question has gone with it.

## The Python↔GCI bridge

**The CLI's exit codes go through a status file, not topaz.** topaz cannot
carry an exit status out of a `run` block — `ExitClientError status:` is not
translated, and an `iferr … exit 1` action exits 0 (all measured). The driver
therefore ends with no `exit` command at all, and must not grow one: `topaz -h`
says of `-S` that topaz "exits when the script completes" and that "exit and
quit commands are ignored". Ignored silently when stdin is a pipe — which is
every CI run, every test, and every `gemdb x.py | cat` — and out loud when
stdin is a tty, where it printed four lines of explanation and a
`Logging out session 1.` in front of the user. So
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

**The console box says what the sink takes, because the sink cannot be
asked.** `SessionTemps #GrailConsole` holds an Array; slot 1 is the sink, and
slot 2 — `#'utf8'` — declares that it takes bytes. `gemdb-run.tpz` sets it,
because its sink is `GsFile stdout` and `nextPutAll:` writes a Unicode string's
code units straight through: `print('café')` was UTF-16BE on the terminal, a
NUL between every ASCII character, while the same print through the shell was
right. Grail encodes with `nextPutAsUtf8:` when the slot says so. It cannot
instead probe the sink: the shell installs a `ClientForwarder`, and *any* send
to one — `class`, `respondsTo:`, `isNil` — forwards to the client as error
2336, which is not a Smalltalk exception and is not catchable in the gem
(measured; `on: AbstractException` around `forwarder class` does not run). A
probe would turn every print in a streaming session into a spurious client
stop. The read side is the same seam from the other direction: `GsFile stdin`
answers bytes, so Grail decodes that one branch with `decodeFromUTF8`, keeping
the raw line when it is not UTF-8. Both directions are pinned in
`src/__integration__/cli.test.ts`.

## Building an app on Grail

`gemdb.cloneBrainFreeze` (`demo.ts`) gets a user a real example:
[GemTalk/brain-freeze](https://github.com/GemTalk/brain-freeze), a Flask app
that lives in the database, covering the notebook, the MCP surface and a
schema change. The version that lived in this repo is preserved at
[`c9c261a`](https://github.com/GemTalk/GemDB_Code/tree/c9c261ac017fd7831cd29aa71b79da4ee8c1ed9b/docs/demo/brain-freeze).
Its findings are worth reading before building a second application on this,
and each is filed upstream so a workaround here can be retired against an
issue rather than rediscovered:

- Commit after the imports, not abort — aborting breaks `isinstance` for
  records written seconds earlier by identical source (class identity has to
  stay stable across sessions).
- A schema change keeps `isinstance` for records written before it, but leaves
  them without the new attribute, so optional fields must be read with
  `getattr`. (Grail #851 covers compiling-as-a-write, of which this is one
  face; see the dirty-session note below.)
- An exception in a Flask view is invisible unless the app registers its own
  `Exception` handler — Flask logs with `exc_info=`, and Grail's `logging` is a
  stub that raises on it. That handler must print with
  `print(traceback.format_exc())`, not `traceback.print_exc()`: `sys.stderr` is
  None in a gem, so `print_exc()` raises inside the handler and drops the
  connection anyway. (Grail #848, #849.)
- **`gemdb file.py` does not put the script's directory on `sys.path`** the way
  `python3 file.py` does, and `sys.path` is otherwise empty, so a script cannot
  import the file next to it until it inserts its own directory. (Grail #847.)
- Two sessions racing to compile the same never-before-called method collide
  on a method neither of them typed, so the commit that settles a session has
  to abort on conflict or the app wedges for good. (Grail #851, #850 for
  `sys.argv` being topaz's.)

Two of those were measured on Grail `46c2a68` and **do not reproduce on
`c875e56`**: a schema change no longer keeps `isinstance` at all (a record
written before the change fails `isinstance` against the edited class — use
`type(obj).__name__` instead), and a first call to a never-compiled function no
longer dirties the session by itself (what dirties it is running the code at
all — see below). Both are reproducible either way, and
[GemTalk/brain-freeze](https://github.com/GemTalk/brain-freeze) carries
scripts that print which behaviour the Grail in front of you has. Check which
Grail commit is pinned (`vendor-pins.sh`) before relying on either version of
these findings.

**`gemdb file.py` starts with a dirty session, so `gemdb.transaction()` cannot
be a script's first statement.** `commit()` or `abort()` first. Walking the
preamble one send at a time in a clean session: setting the flag left `System
needsCommit` false, the `#GrailConsole` store leaves it false, and `importlib
runPath:` sets it true — so it is `runPath` itself, not the file's own code (a
script whose first line is `import gemstone; print(gemstone.needs_commit)`
already prints True). The transaction block's entry check then blames the user
for Grail's plumbing. Shell and notebook sessions are unaffected: they evaluate
through `evaluateSource:usingModuleScope:` and a fresh one runs a transaction
block as its first action. The fix belongs in Grail (filed as Grail #851, with
the other two faces of the same root cause).
