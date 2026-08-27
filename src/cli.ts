import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  DB_PASSWORD,
  DB_USER,
  PINNED_ENGINE_VERSION,
  STONE_NAME,
  engineVersion,
  rootPath,
} from './config';
import { log } from './log';
import { cliStampPath, enginePath, grailPath } from './paths';
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
 *   `gemdb`            the wrapper. Sets the whole engine environment itself,
 *                      so it works from any shell with no setup beyond PATH.
 *   `gemdb-run.tpz`    the topaz driver for running a file or module.
 *   `gemdb-shell.js`   the GemDB Shell, staged out of the extension's build
 *                      together with `node_modules/koffi` beside it.
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
 * Copy the shell bundle and its one native dependency beside the wrapper.
 *
 * koffi is copied whole except its per-platform binaries, of which only this
 * machine's is kept — the same pruning .vscodeignore applies to the copy the
 * extension itself ships. A build without the bundle (a fresh checkout that
 * has not run `npm run bundle`) stages nothing and says so; the wrapper then
 * reports the missing shell at run time rather than failing here, because the
 * file and module modes still work without it.
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

export function writeCliScripts(extensionPath: string): void {
  const engine = enginePath();
  if (!engine) throw new Error('The database engine is not installed.');
  const root = rootPath();
  const grail = grailPath();

  // The topaz driver for one file or module. `set` lines beat any ~/.topazini
  // (the ini runs first, these run later), so a Jasper user's defaults cannot
  // hijack the login. Errors are caught as AbstractException, not Error —
  // Grail's Python exceptions live outside the Error branch, which is why
  // grail.tpz's own file mode exits 0 on a Python error.
  //
  // sys.exit(n) is decoded here, not upstream: Grail raises its own SystemExit
  // (never ExitClientError — input()'s except SystemExit and finally blocks
  // must keep working), and the exit argument survives only in the exception's
  // Python `args` tuple (the CPython `code` attribute is absent, and the
  // `code` instVar is never assigned — measured on 4.0). The branch below is
  // CPython's contract, each case measured: None or no argument exits 0
  // silently, an int exits `n % 256` silently (-1 → 255, 256 → 0), and
  // anything else prints str(code) to stderr and exits 1.
  const driver = `! Generated by GemDB. Regenerated on every update — do not edit.
set user ${DB_USER} pass ${DB_PASSWORD}
set gemstone ${STONE_NAME}
login
run
| args ofs target status statusFile label |
"No canonical-modules flag is set here; see cli.ts. Grail retired that
flag once warm binding became its only path -- what is warm is now
decided by what has been committed, which is what the shipped extent
already provides -- and the send became a doesNotUnderstand that killed
every file run at this line."
args := System commandLineArguments.
1 to: args size do: [:j | (args at: j) = '--' ifTrue: [ofs := j]].
statusFile := System gemEnvironmentVariable: 'GEMDB_STATUS_FILE'.
status := 0.
"The console override, not Transcript := GsFile stdout: the Transcript
global is a committed association, and reassigning it dirties the
transaction -- gemdb.transaction() in the very script being run would
then refuse to start. Grail's console writes (print, input's prompt,
warnings) consult SessionTemps #GrailConsole first; that write is
transient and leaves System needsCommit untouched. Boxed in an Array
because that is the #GrailConsole protocol (see builtins.gs
___console___: SessionTemps at:put: sends to what it stores, which a
ClientForwarder cannot survive; a GsFile could, but one protocol)."
SessionTemps current at: #'GrailConsole' put: (Array with: GsFile stdout).
[
    [
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
        target = '-m'
            ifTrue: [importlib runModule: (args at: ofs + 2)]
            ifFalse: [importlib runPath: target].
    ] on: AbstractException do: [:ex |
        | sysExit |
        sysExit := System myUserProfile symbolList objectNamed: #'SystemExit'.
        (ex isKindOf: ExitClientError)
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
                    | msg |
                    msg := ex messageText ifNil: [ex description].
                    GsFile stdout flush.
                    GsFile stderr nextPutAll: msg; lf; flush.
                    status := 1]].
    ].
] ensure: [
    SessionTemps current removeKey: #'GrailConsole' ifAbsent: [].
    statusFile ifNotNil: [
        | f |
        f := GsFile openWrite: statusFile.
        f nextPutAll: status printString; close].
].
%
exit 0
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
STONE="${STONE_NAME}"

export GEMSTONE
export GEMSTONE_GLOBAL_DIR="$ROOT"
export GEMSTONE_SYS_CONF="$ROOT/db/conf"
export GEMSTONE_EXE_CONF="$ROOT/db/conf"
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

# No arguments: the GemDB Shell — the same Python prompt the editor opens,
# on this terminal. It brings the database up itself (a shell session needs
# the listener too), so it runs before the stone check below. The editor's
# own Node runtime is recorded here; PATH is the fallback for when the editor
# has moved since this file was written.
if [ "$#" -eq 0 ]; then
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
  export ELECTRON_RUN_AS_NODE=1
  exec "$NODE" "$SHELL_JS"
fi

# The database must be up — a linked gem still needs the stone. Starting it
# here is the same judgement the editor makes: running Python is the request.
if ! "$GEMSTONE/bin/gslist" 2>/dev/null | awk -v s="$STONE" '$(NF-1) == "Stone" && $NF == s { found = 1 } END { exit !found }'; then
  echo "gemdb: starting the database…" >&2
  if ! "$GEMSTONE/bin/startstone" -l "$ROOT/db/log/$STONE.log" "$STONE" >/dev/null 2>&1; then
    echo "gemdb: the database at $ROOT could not be started. See $ROOT/db/log/$STONE.log" >&2
    exit 1
  fi
fi

# -c 'code': materialise the code as a file, like CPython's -c but visibly so.
# mktemp is given an explicit template — BSD and GNU disagree about -t.
CODE_FILE=""
if [ "$1" = "-c" ]; then
  [ "$#" -ge 2 ] || { echo "gemdb: -c requires an argument" >&2; exit 2; }
  CODE_FILE="$(mktemp "\${TMPDIR:-/tmp}/gemdb-c-XXXXXX").py"
  printf '%s\\n' "$2" > "$CODE_FILE"
  shift 2
  set -- "$CODE_FILE" "$@"
fi

# A file that is not there should fail here, with a message and exit code
# shaped like CPython's, not as a Smalltalk stack.
if [ "$1" != "-m" ] && [ ! -e "$1" ]; then
  echo "gemdb: can't open file '$1': No such file or directory" >&2
  exit 2
fi

# topaz cannot carry an exit status out of a run block, so the driver writes
# it to a file and this wrapper becomes the exit code. See gemdb-run.tpz.
GEMDB_STATUS_FILE="$(mktemp "\${TMPDIR:-/tmp}/gemdb-status-XXXXXX")"
export GEMDB_STATUS_FILE
topaz -L -q -S "$ROOT/bin/gemdb-run.tpz" ${TOPAZ_TUNING} -- "$@"
RC=$?
STATUS="$(cat "$GEMDB_STATUS_FILE" 2>/dev/null || true)"
rm -f "$GEMDB_STATUS_FILE"
[ -n "$CODE_FILE" ] && rm -f "$CODE_FILE" "\${CODE_FILE%.py}"
case "$STATUS" in
  ''|*[!0-9]*) [ "$RC" -ne 0 ] && exit "$RC"; exit 1 ;;
  *) exit "$STATUS" ;;
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
  fs.writeFileSync(path.join(cliDirPath(), 'gemdb-run.tpz'), driver);

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
