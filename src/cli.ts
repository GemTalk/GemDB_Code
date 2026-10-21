import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  PINNED_ENGINE_VERSION,
  abortIdleSessionsAfterMinutes,
  dbPassword,
  dbUser,
  engineVersion,
  externalDatabase,
  rootPath,
  stoneName,
} from './config';
import { GRAIL_NOT_INSTALLED } from './grailMessages';
import { log } from './log';
import { shellQuote } from './osConfig';
import { cliStampPath, enginePath, grailPath, grailStampPath } from './paths';
import { sharedLibraryExtension } from './platform';

/**
 * The `gemdb` shell command: CPython's command line, backed by the database.
 *
 *   gemdb hello.py        like python3 hello.py
 *   gemdb -m some.module  like python3 -m some.module
 *   gemdb -c 'print(1)'   like python3 -c
 *   gemdb                 the GemDB Shell — the same REPL the editor opens
 *
 * Generated files under `<rootPath>/bin`, rewritten on every staging so they
 * always match the installed engine and the staged Grail:
 *
 *   `gemdb`               the wrapper. Sets the whole engine environment
 *                         itself, so it works from any shell with no setup
 *                         beyond PATH.
 *   `gemdb-run.tpz`       the topaz driver for running a file or module.
 *   `gemdb-run-init.tpz`  its init file, which keeps topaz's own output off
 *                         the terminal (see TOPAZ_INIT below).
 *   `gemdb-shell.js`      the GemDB Shell, staged out of the extension's
 *                         build together with `node_modules/koffi` beside it.
 *
 * File mode drives *linked* topaz — the right login for a batch run: its own
 * process, one session, crash isolation by construction, and real stdin/stdout
 * so output streams as the program prints it. The shell is the extension's own
 * REPL (`pyRepl.ts` hosted by `cliMain.ts`), logged in through the listener
 * like the notebooks; it is staged here rather than run from the extension
 * directory because that directory moves on every update — the same reason
 * Grail is staged. It runs under the editor's own Node runtime, recorded at
 * generation time and started with ELECTRON_RUN_AS_NODE, falling back to a
 * `node` on PATH when the editor has moved since this file was written.
 *
 * Exit codes are the part that took working out, so it is recorded here:
 * topaz does not translate a gem-side `ExitClientError status:` into a process
 * exit status from a `run` block, and its `iferr … exit 1` action exits 0.
 * The only reliable carrier found was a plain `exit <n>` script line — so the
 * driver instead reports the status through a file named in GEMDB_STATUS_FILE,
 * and the wrapper turns that into the process exit code. The status file is
 * passed by environment variable, not argument, so the user's argv reaches
 * their program untouched.
 *
 * `sys.exit(n)` carries its real status: the driver decodes Grail's
 * SystemExit itself (see the note above the driver below). `input()` works in
 * both modes since Grail's stdin hook: a linked run reads the process's real
 * stdin (GsFile stdin IS the pipe or terminal), and the shell answers through
 * its session's stdin provider — see session.ts.
 */

export function cliDirPath(): string {
  return path.join(rootPath(), 'bin');
}

export function cliPath(): string {
  return path.join(cliDirPath(), 'gemdb');
}

const TOPAZ_TUNING = `-T 400000 -C 'GEM_TEMPOBJ_CODE_SIZE=300000;'`;

/**
 * The init file (`-I`) for a file run: everything topaz itself says goes to a
 * per-run log the wrapper names in GEMDB_TOPAZ_LOG, and never to the terminal.
 *
 * The program's own output is unaffected, because it never passes through
 * topaz: print() and the driver's reports write to `GsFile stdout`/`stderr`,
 * which in linked topaz are the process's real descriptors. What this removes
 * is topaz talking over the program. Ctrl-C used to end a run with
 *
 *   [Sending soft break]
 *    Near line 155 of file …/gemdb-run.tpz
 *   KeyboardInterrupt
 *   ERROR 3004 , a ExitClientError occurred (error 3004)
 *   Logging out session 1.
 *
 * where CPython prints only the KeyboardInterrupt — and the ERROR line, which
 * is the driver's deliberate way out (see the end of the driver), read as a
 * failure (GemTalk/GemDB_Code#131). Each piece here was measured on 4.0.0.a4:
 *
 * - **`-P`, not `-S`.** Under `-S`, `OUTPUT PUSH … ONLY` has no effect on
 *   stdout (topaz's own help says so, and `output push /dev/null only` changed
 *   nothing). Under `-P` it takes effect, the soft-break notice on stderr
 *   included.
 * - **Pushed here, not in the driver.** `-P` echoes each script line to the
 *   terminal until the push takes effect, so a push on the driver's first line
 *   still printed that line and the one before it. An `-I` file is not echoed.
 *   `-i` is no substitute: it did not stop `-P`'s echo, and it ignores `-I`.
 * - **A log, not /dev/null.** A refused login (the session limit, the space
 *   threshold, an external database's password) or a session the stone ends
 *   mid-run is reported by topaz and nothing else, so the wrapper shows the
 *   log whenever the run did not report a status.
 *
 * `-I` also means no `.topazini` is read, from home or from the current
 * directory — which the driver's `set` lines already overrode for the login,
 * and which a cloned repository could otherwise use to run topaz commands.
 */
const TOPAZ_INIT = `output push $GEMDB_TOPAZ_LOG only
`;

/**
 * Copy the shell bundle and its one native dependency beside the wrapper.
 *
 * koffi is copied whole except its per-platform binaries, of which only this
 * machine's is kept — the same pruning .vscodeignore applies to the copy the
 * extension itself ships. A build without the bundle (a fresh checkout that
 * has not run `npm run bundle`) stages nothing and says so; the wrapper then
 * reports the missing shell at run time rather than failing here, because a
 * file or module run against a database that is already up works without it.
 * A cold start does not: it is the shell program's `--ensure-stone` that starts
 * the database.
 */
function stageShell(extensionPath: string): void {
  const bundle = path.join(extensionPath, 'out', 'gemdb-shell.js');
  if (!fs.existsSync(bundle)) {
    log(
      'This build has no shell bundle (out/gemdb-shell.js); `gemdb` without arguments will report it.',
    );
    return;
  }
  fs.copyFileSync(bundle, path.join(cliDirPath(), 'gemdb-shell.js'));

  const koffiSource = path.join(extensionPath, 'node_modules', 'koffi');
  const koffiDest = path.join(cliDirPath(), 'node_modules', 'koffi');
  const machine = `${process.platform}_${process.arch}`;
  fs.rmSync(koffiDest, { recursive: true, force: true });
  fs.cpSync(koffiSource, koffiDest, {
    recursive: true,
    dereference: true,
    filter: (source) => {
      const parts = path.relative(koffiSource, source).split(path.sep);
      if (parts[0] === 'doc') return false;
      if (parts[0] === 'build' && parts[1] === 'koffi' && parts.length >= 3) {
        return parts[2] === machine;
      }
      return true;
    },
  });
}

/**
 * What is staged, in one line, so staging can tell whether it has work to do.
 *
 * Content rather than a version number, because the thing that goes stale is
 * content: `out/gemdb-shell.js` is rebuilt on every `npm run bundle`, and the
 * wrapper bakes in the editor's own `process.execPath`, which moves when VS
 * Code updates. A version stamp would miss both.
 */
function cliFingerprint(wrapper: string, driver: string, shellBundle: string): string {
  const hash = crypto.createHash('sha256');
  hash.update(wrapper);
  hash.update(driver);
  hash.update(TOPAZ_INIT);
  hash.update(fs.existsSync(shellBundle) ? fs.readFileSync(shellBundle) : Buffer.of());
  return hash.digest('hex');
}

/** Is what is on disk already exactly what this call would write? */
function cliIsCurrent(fingerprint: string): boolean {
  if (!fs.existsSync(cliPath())) return false;
  try {
    return fs.readFileSync(cliStampPath(), 'utf8').trim() === fingerprint;
  } catch {
    return false;
  }
}

/**
 * The slice of VS Code's `EnvironmentVariableCollection` that putting `gemdb`
 * on the PATH needs, so the decision is testable without an editor.
 */
export interface TerminalEnvironment {
  clear(): void;
  prepend(variable: string, value: string): void;
}

/**
 * Put `gemdb` on the PATH of terminals VS Code opens.
 *
 * The command is generated into `<rootPath>/bin`, which is on nobody's PATH,
 * so `which gemdb` in a VS Code terminal reported nothing and the README's
 * answer was an `export PATH=...` line the user had to add to their own
 * profile. VS Code contributes this itself, per extension: it applies to
 * terminals this editor launches, is reverted when GemDB is disabled or
 * uninstalled, and never touches the user's shell profile — which keeps it on
 * the automated side of the line (inert, reversible, and not a change to the
 * machine), where editing a profile would not be.
 *
 * `clear()` first because the collection is persisted across window reloads:
 * re-applying on activation is what keeps it right after the root path
 * changes, and without the clear it would accumulate a stale entry per
 * reload. Contributed whether or not `bin/gemdb` exists yet — on first run it
 * does not, and a terminal opened during setup should find the command once
 * setup writes it rather than needing to be reopened.
 */
export function putCliOnPath(env: TerminalEnvironment): void {
  env.clear();
  env.prepend('PATH', `${cliDirPath()}${path.delimiter}`);
}

/**
 * Guarantee `<rootPath>/bin/gemdb` exists and matches this build, for callers
 * about to hand that path to something else.
 *
 * Opening a GemDB Shell makes VS Code launch the wrapper as a terminal's shell
 * program, so a missing or stale file is not an internal detail — it is
 * "The terminal process failed to launch", or a shell running last week's
 * code. `requireRunning` cannot carry this: it returns early when the database
 * is already up, which is the common case, so `ensureRunning` — where staging
 * lives — is skipped exactly when nothing else would notice.
 *
 * Cheap to call: `writeCliScripts` fingerprints what it would write and
 * returns without touching the disk when that matches what is already there.
 */
export function ensureCliCurrent(extensionPath: string): boolean {
  try {
    writeCliScripts(extensionPath);
  } catch (e) {
    log(`Could not write the gemdb command: ${e instanceof Error ? e.message : e}`);
  }
  return fs.existsSync(cliPath());
}

export function writeCliScripts(extensionPath: string): void {
  const engine = enginePath();
  if (!engine) throw new Error('The database engine is not installed.');
  const root = rootPath();
  const grail = grailPath();
  const external = externalDatabase();
  const stone = stoneName();

  // The topaz driver for one file or module, run with `-P` after TOPAZ_INIT.
  // No ~/.topazini runs (`-I` replaces it), and the `set` lines would beat one
  // anyway, so a Jasper user's defaults cannot hijack the login. Errors are
  // caught as AbstractException, not Error — Grail's Python exceptions live
  // outside the Error branch, which is why grail.tpz's own file mode exits 0
  // on a Python error.
  //
  // `-P` is why the driver ends with `exit`. Unlike `-S`, it does not exit at
  // the end of the script: it goes on to read commands from stdin, which is
  // the user's terminal or, worse, whatever was piped to their program. A
  // topaz-level error does not change that — measured with a wrong password,
  // topaz reports the refused login, carries on through the script, and
  // leaves at this line, on a tty and on a pipe alike. Only Ctrl-C stops it
  // reading, and the ExitClientError below covers that. (Under `-S` the
  // closing exit was the opposite problem: ignored, and on a tty four lines
  // saying so.) The status still leaves through GEMDB_STATUS_FILE, not the
  // exit: sys.exit(3) → 3, an uncaught exception → 1, a missing file → 2.
  //
  // sys.exit(n) is decoded here, not upstream: Grail raises its own SystemExit
  // (never ExitClientError — input()'s except SystemExit and finally blocks
  // must keep working), and the exit argument survives only in the exception's
  // Python `args` tuple (the CPython `code` attribute is absent, and the
  // `code` instVar is never assigned — measured on 4.0). The branch below is
  // CPython's contract, each case measured: None or no argument exits 0
  // silently, an int exits `n % 256` silently (-1 → 255, 256 → 0), and
  // anything else prints str(code) to stderr and exits 1.
  // Unreadable only before a database exists; the driver is regenerated on
  // the way to a running one, by which time it is there.
  const password = ((): string => {
    try {
      return dbPassword();
    } catch {
      return '';
    }
  })();
  const driver = `! Generated by GemDB. Regenerated on every update — do not edit.
set user ${dbUser()} pass ${password}
set gemstone ${stone}
login
run
| args ofs target status statusFile label uncaught interrupted |
"No canonical-modules flag is set here; see cli.ts. Grail retired that
flag once warm binding became its only path -- what is warm is now
decided by what has been committed, which is what installing Grail
already provides -- and the send became a doesNotUnderstand that killed
every file run at this line."
args := System commandLineArguments.
1 to: args size do: [:j | (args at: j) = '--' ifTrue: [ofs := j]].
statusFile := System gemEnvironmentVariable: 'GEMDB_STATUS_FILE'.
status := 0.
interrupted := false.
"The console override, not Transcript := GsFile stdout: the Transcript
global is a committed association, and reassigning it dirties the
transaction -- gemdb.transaction() in the very script being run would
then refuse to start. Grail's console writes (print, input's prompt,
warnings) consult SessionTemps #GrailConsole first; that write is
transient and leaves System needsCommit untouched. Boxed in an Array
because that is the #GrailConsole protocol (see builtins.gs
___console___: SessionTemps at:put: sends to what it stores, which a
ClientForwarder cannot survive; a GsFile could, but one protocol).

The second slot declares what this sink takes: a GsFile takes BYTES, so
every console write must be encoded. Without it Grail wrote a Unicode16's
code units straight to stdout -- a NUL between every ASCII character, and
a non-ASCII character truncated to its low byte -- so print('caf\u00e9')
was UTF-16BE on the terminal while the same print through the shell (a
character stream over GCI) was right. Declared here rather than sniffed
there because the sink cannot be asked: the shell's sink is a
ClientForwarder, and asking one anything -- class, respondsTo:, isNil --
forwards to the client as error 2336, which is not catchable in the gem."
SessionTemps current at: #'GrailConsole'
    put: (Array with: GsFile stdout with: #'utf8').
[
    uncaught := [
        target := args at: ofs + 1.
        "Name this session in the shared cache, so a long-running script is
        identifiable from outside -- another window, topaz, a dashboard --
        rather than showing as the stock 'TopazL'. The extension does the
        same for its own sessions after login (session.ts cacheNameFor); this
        mode never goes through that code, because it is linked topaz rather
        than a GCI login. Limit is 31 characters (32 raises OutOfRange), and
        the whole thing is best-effort: a script must run even if it cannot
        be labelled."
        label := target = '-m'
            ifTrue: [args at: ofs + 2]
            ifFalse: [(target subStrings: '/') isEmpty
                ifTrue: [target]
                ifFalse: [(target subStrings: '/') last]].
        (label size > 3 and: [(label copyFrom: label size - 2 to: label size) = '.py'])
            ifTrue: [label := label copyFrom: 1 to: label size - 3].
        label := 'GemDB run ', label.
        label size > 31 ifTrue: [label := label copyFrom: 1 to: 31].
        [System cacheName: label] on: Error do: [:ignored | ignored return: nil].
        "breakpoint() has no debugger to open in file mode. Left alone, its Halt
        goes past every handler to topaz, which abandons this block and leaves
        the user at a topaz 1> prompt holding a session. So the hook says where
        it was and returns, and the script carries on -- the same sentence the
        GemDB Shell prints (session.ts breakpointNotice). Measured: assigning
        sys.breakpointhook does not dirty the transaction, and _getframe(1)
        inside the hook is the frame that called breakpoint()."
        [(System myUserProfile symbolList objectNamed: #'ModuleAst') ifNotNil: [:m |
            m evaluateSource: 'import sys
def _gemdb_breakpoint(*args, **kws):
    f = sys._getframe(1)
    sys.stderr.write("breakpoint() at %s:%d: the debugger opens in notebooks and Debug Python File in GemDB; continuing.\\n" % (f.f_code.co_filename, f.f_lineno))
sys.breakpointhook = _gemdb_breakpoint']]
            on: AbstractException do: [:ignored | ignored return: nil].
        target = '-m'
            ifTrue: [importlib runModule: (args at: ofs + 2)]
            ifFalse: [importlib runPath: target].
        nil
    ] on: AbstractException do: [:ex | ex return: ex].
    "Report after unwinding, never in the handler above. A handler runs at the
    signal point, on top of the stack that raised, and for a RecursionError
    that is the last few hundred frames of reserve: rendering a traceback
    there overflows it (Grail's own grail.tpz does, GemTalk/Grail#1261), and
    even small edits to such a handler were measured to turn the report into
    an AlmostOutOfStackError. Unwinding first also runs the script's finally
    blocks before the traceback prints, which is CPython's order."
    uncaught ifNotNil: [:ex |
        | sysExit baseExc |
        sysExit := System myUserProfile symbolList objectNamed: #'SystemExit'.
        baseExc := System myUserProfile symbolList objectNamed: #'BaseException'.
        "Ctrl-C. Topaz turns it into a soft break, and the Break reaches the
        handler above like any exception, after the script's finally blocks
        have run. Reported as CPython reports an uncaught KeyboardInterrupt, with
        the status a shell gives a process SIGINT ended (128 + 2)."
        (ex isKindOf: Break)
            ifTrue: [
                interrupted := true.
                GsFile stdout flush.
                GsFile stderr nextPutAll: 'KeyboardInterrupt'; lf; flush.
                status := 130]
            ifFalse: [(ex isKindOf: ExitClientError)
            ifTrue: [status := ex status ifNil: [1]]
            ifFalse: [(sysExit notNil and: [ex isKindOf: sysExit])
                ifTrue: [
                    | code noneObj |
                    noneObj := System myUserProfile symbolList objectNamed: #'None'.
                    code := [(ex @env1:___pyAttrLoad___: #'args') @env0:at: 1]
                        on: AbstractException do: [:x | x return: noneObj].
                    (code == noneObj or: [code == nil])
                        ifTrue: [status := 0]
                        ifFalse: [(code isKindOf: Integer)
                            ifTrue: [status := code \\\\ 256]
                            ifFalse: [
                                | msg |
                                msg := [code @env1:__str__ @env0:asString]
                                    on: AbstractException do: [:x | x return: code printString].
                                GsFile stdout flush.
                                GsFile stderr nextPutAll: msg; lf; flush.
                                status := 1]]]
                ifFalse: [
                    "What CPython prints: the traceback, ending in a newline,
                    then failing that 'Type: str(exc)'. A Smalltalk error that
                    is not a Python exception keeps its plain message."
                    | msg |
                    msg := (baseExc notNil and: [ex isKindOf: baseExc])
                        ifTrue: [[ex pythonTracebackString]
                            on: AbstractException do: [:x | x return: nil]]
                        ifFalse: [nil].
                    (msg isNil or: [msg isEmpty]) ifTrue: [
                        | detail |
                        detail := (baseExc notNil and: [ex isKindOf: baseExc])
                            ifTrue: [[ex @env1:__str__ @env0:asString]
                                on: AbstractException do: [:x | x return: nil]]
                            ifFalse: [nil].
                        msg := detail isNil
                            ifTrue: [ex messageText ifNil: [ex description]]
                            ifFalse: [detail isEmpty
                                ifTrue: [ex class name asString]
                                ifFalse: [ex class name asString , ': ' , detail]].
                        msg := msg , (String with: Character lf)].
                    GsFile stdout flush.
                    GsFile stderr nextPutAll: msg encodeAsUTF8; flush.
                    status := 1]]]].
] ensure: [
    SessionTemps current removeKey: #'GrailConsole' ifAbsent: [].
    statusFile ifNotNil: [
        | f |
        f := GsFile openWrite: statusFile.
        f nextPutAll: status printString; close].
].
"Handling the Break is not enough to end the run. Topaz saw the Ctrl-C too,
and it stops reading this script once the block returns, leaving the user at
a topaz 1> prompt still holding a session -- so nothing written after this
block would run. An ExitClientError is what makes topaz log out and exit
instead. The status still travels through GEMDB_STATUS_FILE, written above,
and topaz's ERROR 3004 for it goes to the log TOPAZ_INIT opened, which the
wrapper shows only when there is no status."
interrupted ifTrue: [ExitClientError new status: status; signal].
%
exit
`;

  const script = `#!/bin/bash
# gemdb — run Python inside the GemDB database, from any shell.
# Generated by the GemDB extension; regenerated on every update. Do not edit.
#
#   gemdb file.py [args]     run a file            gemdb -m pkg.mod   run a module
#   gemdb -c 'code'          run a string          gemdb              the GemDB Shell
#
# Put this on your PATH:   export PATH="\${HOME}/GemDB/bin:$PATH"

set -u

ROOT="${root}"
GEMSTONE="${engine}"
GRAIL_DIR="${grail}"
STONE="${stone}"

export GEMSTONE
export GEMDB_ROOT_PATH="$ROOT"
${
  external
    ? // The administrator's database: their lock directory and their config,
      // and the settings the shell program needs to find it (see cliVscode.ts).
      `export GEMSTONE_GLOBAL_DIR="${external.globalDirectory}"
export GEMDB_EXTERNAL_GEMSTONE="${external.gemstone}"
export GEMDB_EXTERNAL_GLOBAL_DIRECTORY="${external.globalDirectory}"
export GEMDB_EXTERNAL_STONE="${external.stone}"
export GEMDB_EXTERNAL_NETLDI="${external.netldi}"
export GEMDB_EXTERNAL_USER="${external.user}"
export GEMDB_EXTERNAL_PASSWORD_FILE="${external.passwordFile ?? ''}"`
    : `export GEMSTONE_GLOBAL_DIR="$ROOT"
export GEMSTONE_SYS_CONF="$ROOT/db/conf"
export GEMSTONE_EXE_CONF="$ROOT/db/conf"`
}
export GRAIL_DIR
export PYTHON_PACKAGE_PATH="$GRAIL_DIR/src/python"
export SHIM_LIB_PATH="$GRAIL_DIR/src/c/shim/libcpython_ua.${sharedLibraryExtension()}"
export PATH="$GEMSTONE/bin:$PATH"

usage() {
  sed -n '4,7p' "$0" | sed 's/^# *//'
}

case "\${1:-}" in
  -h|--help) usage; exit 0 ;;
  -V|--version)
    echo "GemDB Python ($(sed -n 's/^grail=//p' "$GRAIL_DIR/GRAIL_VERSION" 2>/dev/null || echo unknown), engine ${PINNED_ENGINE_VERSION})"
    exit 0 ;;
esac

# The shell program runs under the editor's own Node runtime, recorded here
# when this file was written; PATH is the fallback for when the editor has
# moved since. Both the GemDB Shell and a cold start (below) run it, so both
# find it the same way and fail with the same words.
find_node() {
  SHELL_JS="$ROOT/bin/gemdb-shell.js"
  if [ ! -f "$SHELL_JS" ]; then
    echo "gemdb: this installation has no shell program. Open VS Code so GemDB can finish setting up, then retry." >&2
    exit 1
  fi
  NODE="${process.execPath}"
  if [ ! -x "$NODE" ]; then NODE="$(command -v node || true)"; fi
  if [ -z "$NODE" ]; then
    echo "gemdb: no Node runtime found to run the shell. Open VS Code so GemDB can regenerate this command, or install node." >&2
    exit 1
  fi
  export GEMDB_ENGINE_VERSION="${engineVersion()}"
  export GEMDB_ABORT_IDLE_MINUTES="${abortIdleSessionsAfterMinutes()}"
  export ELECTRON_RUN_AS_NODE=1
}

# No arguments: the GemDB Shell — the same Python prompt the editor opens,
# on this terminal. It brings the database up itself (a shell session needs
# the listener too), so it runs before the stone check below.
if [ "$#" -eq 0 ]; then
  find_node
  exec "$NODE" "$SHELL_JS"
fi

# Arguments that are wrong fail here, with a message and exit code shaped like
# CPython's, before anything starts a database for them: a typo must not cost
# a start. Only the checks are here; -c's file is made after the start below.
if [ "$1" = "-c" ]; then
  [ "$#" -ge 2 ] || { echo "gemdb: -c requires an argument" >&2; exit 2; }
elif [ "$1" != "-m" ] && [ ! -e "$1" ]; then
  echo "gemdb: can't open file '$1': No such file or directory" >&2
  exit 2
fi

${
  external
    ? ''
    : // Its own database only: an external one has Python filed in by whoever
      // runs it. The same test as grailInstalled() in paths.ts.
      `# Python has to be in the database before anything is run against it. A
# database Grail has not been filed into yet would only answer a run with
# compile errors, or a login refused for want of an account. The stamp is
# written when the file-in succeeds. Before the stone check, so it holds on
# a running stone too.
GRAIL_STAMP="${grailStampPath()}"
if [ ! -f "$GRAIL_STAMP" ]; then
  echo ${shellQuote(`gemdb: ${GRAIL_NOT_INSTALLED}`)} >&2
  exit 1
fi

`
}# The database must be up — a linked gem still needs the stone. Starting it
# here is the same judgement the editor makes: running Python is the request.
#
# The wrapper only recognises the common case. A stone that answers is just
# run against, which is every run after the first, and costs one gslist. Every
# other case -- no stone, one still starting or shutting down, a status that
# needs a closer look, an external database -- goes to the shell program, which
# makes the judgement the editor and the GemDB Shell make: the same lock, the
# same pre-start guards (engine version, NFS, space), the same wait. It starts
# the stone and nothing else: a file run is a linked topaz and never goes
# through NetLDI. Not run on a terminal's stdin: --ensure-stone reads none, and
# a shell program old enough not to know the flag stops at "needs a terminal"
# rather than opening a Shell in the middle of a file run.
#
# The status as gslist -cvl lists it, lowercased (the engine prints "OK",
# "Startup", "frozen"), or nothing when the stone is not listed. One call per
# question: -v asks the stone itself, which takes about five seconds when it is
# frozen (measured). A row is status, version, owner, pid, port, three date
# fields, type and name, and "exe deleted" is the one two-word status. A row of
# any other shape is still this stone, so it answers something other than "ok".
stone_status() {
  "$GEMSTONE/bin/gslist" -cvl 2>/dev/null | awk -v s="$STONE" '$(NF-1) == "Stone" && $NF == s { print tolower(NF == 10 ? $1 : NF == 11 ? $1 " " $2 : "listed"); exit }'
}

STONE_STATUS=$(stone_status)
if [ "$STONE_STATUS" != ok ]; then
  # A subshell: find_node's exports (ELECTRON_RUN_AS_NODE above all) are for
  # the shell program, not for the user's program the run starts next, which
  # would otherwise see them on a cold start and not on a warm one.
  ( find_node; "$NODE" "$SHELL_JS" --ensure-stone </dev/null ) || exit 1
fi

# However the run ends, end_run tidies up after it: bash runs an EXIT trap on
# a normal exit, and on SIGHUP (a terminal tab closed mid-run) and SIGTERM
# too — measured with macOS's /bin/bash 3.2, the oldest this runs under.
#
# A hangup ends this script but not topaz, which ignores SIGHUP: closing the
# terminal left it running the program, holding a session (and a web app its
# port) with nobody to see it, and a program that kept printing was not ended
# by its writes failing either (#136). So if topaz is still running, it is sent
# what Ctrl-C sends — measured after closing the terminal, the program's
# finally blocks ran and topaz logged out and exited within a quarter of a
# second — and SIGTERM, which skips finally, if it has not gone in ten
# seconds. Without pgrep there is no topaz to find, and the run is left as it
# was before. The files go last, because the driver writes the status file as
# it unwinds. They are listed in a loop rather than kept in an array, because
# 3.2 calls an empty array unbound under set -u.
#
# A terminal hangs this script up twice. The tab's own shell, not this script,
# owns the terminal: on a hangup it passes SIGHUP on to its job, and the kernel
# hangs up the foreground group as well. Under bash's default the first starts
# the EXIT trap and the second ends the script as the trap is entered, before
# any line of it can ignore a second: traced on CI's Ubuntu runners, the script
# died on the call to end_run itself, leaving topaz running under init, the
# finally blocks unrun and the files behind, in 3 closes of 20 on x64 and 9 of
# 20 on arm64 (#170). No line inside the trap can close that gap.
#
# So while topaz runs this script ignores SIGHUP, and a watcher beside it
# answers the hangup: a subshell whose trap is set before topaz starts, so a
# second hangup finds a trap already there rather than bash's default. It stops
# topaz as Ctrl-C would, and this script then finishes as it does after any
# interrupted run. The watcher waits on a sleep in the background, because bash
# runs a trap only once a foreground command has ended. It does not hear
# Ctrl-C, which bash ignores in a script's background jobs, so Ctrl-C still
# reaches topaz alone. Under nohup the hangup is ignored on entry, bash will not
# trap it, and the watcher never answers, which is what nohup asks for.
CODE_FILE=""
GEMDB_STATUS_FILE=""
GEMDB_TOPAZ_LOG=""
TOPAZ_RUNNING=""
WATCHER=""
wait_for_exit() {
  local tries=0
  while kill -0 "$1" 2>/dev/null && [ "$tries" -lt "$2" ]; do
    sleep 0.1
    tries=$((tries + 1))
  done
  ! kill -0 "$1" 2>/dev/null
}
stop_topaz() {
  local pid
  pid="$(pgrep -P $$ -x topaz 2>/dev/null | head -n 1)"
  [ -n "$pid" ] || return 0
  kill -INT "$pid" 2>/dev/null
  wait_for_exit "$pid" 100 && return 0
  kill -TERM "$pid" 2>/dev/null
  wait_for_exit "$pid" 50 || true
}
HUNG_UP=""
on_hangup() {
  [ -z "$HUNG_UP" ] || return 0
  HUNG_UP=yes
  stop_topaz
  exit 0
}
watch_for_hangup() {
  trap 'kill "$!" 2>/dev/null; exit 0' TERM
  trap on_hangup HUP
  while kill -0 $$ 2>/dev/null; do
    sleep 60 &
    wait $!
  done
}
end_run() {
  trap '' HUP
  if [ -n "$WATCHER" ]; then kill "$WATCHER" 2>/dev/null; fi
  if [ -n "$TOPAZ_RUNNING" ]; then stop_topaz; fi
  local f
  for f in "$CODE_FILE" "\${CODE_FILE%.py}" "$GEMDB_STATUS_FILE" "$GEMDB_TOPAZ_LOG"; do
    if [ -n "$f" ]; then rm -f "$f"; fi
  done
}
trap end_run EXIT

# -c 'code': materialise the code as a file, like CPython's -c but visibly so.
# mktemp is given an explicit template — BSD and GNU disagree about -t.
if [ "$1" = "-c" ]; then
  CODE_FILE="$(mktemp "\${TMPDIR:-/tmp}/gemdb-c-XXXXXX").py"
  printf '%s\\n' "$2" > "$CODE_FILE"
  shift 2
  set -- "$CODE_FILE" "$@"
fi

# topaz cannot carry an exit status out of a run block, so the driver writes
# it to a file and this wrapper becomes the exit code. See gemdb-run.tpz.
# Everything topaz itself prints goes to GEMDB_TOPAZ_LOG instead of the
# terminal (gemdb-run-init.tpz), so that Ctrl-C ends a program the way it ends
# CPython. No status means the program never finished — a refused login, or a
# session ended under it — and then topaz's account is the only one, so it is
# shown, less topaz's echo of the driver.
GEMDB_STATUS_FILE="$(mktemp "\${TMPDIR:-/tmp}/gemdb-status-XXXXXX")"
GEMDB_TOPAZ_LOG="$(mktemp "\${TMPDIR:-/tmp}/gemdb-topaz-XXXXXX")"
export GEMDB_STATUS_FILE GEMDB_TOPAZ_LOG
watch_for_hangup </dev/null >/dev/null 2>&1 &
WATCHER=$!
trap '' HUP
TOPAZ_RUNNING=yes
topaz -L -q -I "$ROOT/bin/gemdb-run-init.tpz" -P "$ROOT/bin/gemdb-run.tpz" ${TOPAZ_TUNING} -- "$@"
RC=$?
TOPAZ_RUNNING=""
RUN_STATUS="$(cat "$GEMDB_STATUS_FILE" 2>/dev/null || true)"
if [ -z "$RUN_STATUS" ]; then
  sed -e '/^topaz[^>]*> run$/,/^%$/d' -e '/^topaz[^>]*> /d' "$GEMDB_TOPAZ_LOG" >&2
fi
case "$RUN_STATUS" in
  ''|*[!0-9]*) [ "$RC" -ne 0 ] && exit "$RC"; exit 1 ;;
  *) exit "$RUN_STATUS" ;;
esac
`;

  // Nothing to do when what is on disk is already exactly this. The check
  // exists for the opposite case: staging used to happen only when the Grail
  // payload changed, so an extension update that changed only code left the
  // previous `bin/gemdb` and shell bundle in place — a fix to the shell would
  // reach the editor and not the terminal it opens.
  const fingerprint = cliFingerprint(
    script,
    driver,
    path.join(extensionPath, 'out', 'gemdb-shell.js'),
  );
  if (cliIsCurrent(fingerprint)) {
    log('The gemdb command is already current.');
    return;
  }

  fs.mkdirSync(cliDirPath(), { recursive: true });
  // The driver carries the login, and for an external database that is a real
  // password, so it is readable by this user only.
  const driverPath = path.join(cliDirPath(), 'gemdb-run.tpz');
  fs.writeFileSync(driverPath, driver, { mode: 0o600 });
  fs.chmodSync(driverPath, 0o600);
  fs.writeFileSync(path.join(cliDirPath(), 'gemdb-run-init.tpz'), TOPAZ_INIT);

  // An earlier release handed the no-argument mode to Grail's topaz REPL
  // through this file; the shell replaced it, so a stale copy is only a trap.
  fs.rmSync(path.join(cliDirPath(), 'gemdb-repl.tpz'), { force: true });

  stageShell(extensionPath);

  fs.writeFileSync(cliPath(), script);
  fs.chmodSync(cliPath(), 0o755);
  // Written last: a stamp is a claim that everything above succeeded.
  fs.writeFileSync(cliStampPath(), `${fingerprint}\n`);
  log(`Wrote the gemdb command to ${cliPath()}`);
}
