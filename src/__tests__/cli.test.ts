import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __setSetting } from '../__mocks__/vscode';
import { cliPath, ensureCliCurrent, putCliOnPath, writeCliScripts } from '../cli';
import { STONE_LOCK_NAME } from '../lock';
import { cliStampPath, expectedEnginePath } from '../paths';

/**
 * The generator, not the command: what the files say and where they land.
 * The command itself — exit codes, streams, auto-start — runs against a real
 * database in src/__integration__/cli.test.ts.
 */

let root: string;
let ext: string;

/** A stand-in extension directory: the shell bundle and koffi, nothing else. */
function makeExtensionDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdb-ext-'));
  fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'out', 'gemdb-shell.js'), '// the shell bundle\n');
  const koffi = path.join(dir, 'node_modules', 'koffi');
  const machine = `${process.platform}_${process.arch}`;
  fs.mkdirSync(path.join(koffi, 'build', 'koffi', machine), { recursive: true });
  fs.mkdirSync(path.join(koffi, 'build', 'koffi', 'linux_ia32'), { recursive: true });
  fs.mkdirSync(path.join(koffi, 'doc'), { recursive: true });
  fs.writeFileSync(path.join(koffi, 'package.json'), '{"name":"koffi"}\n');
  fs.writeFileSync(path.join(koffi, 'build', 'koffi', machine, 'koffi.node'), 'native\n');
  fs.writeFileSync(path.join(koffi, 'build', 'koffi', 'linux_ia32', 'koffi.node'), 'native\n');
  fs.writeFileSync(path.join(koffi, 'doc', 'manual.md'), 'docs\n');
  return dir;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdb-cli-'));
  ext = makeExtensionDir();
  __setSetting('gemdb.rootPath', root);
  fs.mkdirSync(expectedEnginePath(), { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(ext, { recursive: true, force: true });
});

describe('writeCliScripts', () => {
  it('writes an executable wrapper with this installation baked in', () => {
    writeCliScripts(ext);

    const stat = fs.statSync(cliPath());
    expect(stat.mode & 0o111).not.toBe(0); // executable
    const script = fs.readFileSync(cliPath(), 'utf8');
    expect(script.startsWith('#!/bin/bash')).toBe(true);
    // Self-contained: the wrapper carries its own paths rather than assuming
    // any environment. These are the two everything else derives from.
    expect(script).toContain(`ROOT="${root}"`);
    expect(script).toContain(`GEMSTONE="${expectedEnginePath()}"`);
  });

  it('writes the topaz driver beside it', () => {
    writeCliScripts(ext);

    const run = fs.readFileSync(path.join(root, 'bin', 'gemdb-run.tpz'), 'utf8');
    // The two hard-won mechanics: status through the environment-named file,
    // and errors caught as AbstractException (Python errors are not Error).
    expect(run).toContain('GEMDB_STATUS_FILE');
    expect(run).toContain('on: AbstractException');
    expect(run).toContain('set gemstone gemdb');
    // sys.exit(n) is decoded in the driver: the status lives only in the
    // SystemExit's Python args tuple, and CPython truncates an int to n % 256.
    expect(run).toContain("objectNamed: #'SystemExit'");
    expect(run).toContain('\\\\ 256');
    // Grail retired the canonical-modules flag when warm binding became its
    // only path. Sending it is now a doesNotUnderstand that kills the run at
    // that line, so the driver must not carry it.
    expect(run).not.toContain('___canonicalClassesEnabled___');
    // A file run is linked topaz, so it never reaches session.ts and would
    // otherwise sit in the shared cache as the stock 'TopazL'. The truncation
    // is not optional: 32 characters raises OutOfRange, at login.
    // No `exit` command: with -S, topaz exits when the script completes and
    // ignores exit outright — quietly on a pipe, but on a tty it prints four
    // lines about ignoring it and a spurious "Logging out session 1.". A test
    // here because a pipe is what both suites use, so nothing else would
    // notice it coming back.
    expect(run.split('\n').some((line) => /^\s*(exit|quit)\b/.test(line))).toBe(false);
    // The console sink is a GsFile, which takes bytes; the second slot of
    // the #GrailConsole box is what tells Grail to encode. Without it,
    // non-ASCII print() output is UTF-16 code units on the terminal.
    expect(run).toContain("put: (Array with: GsFile stdout with: #'utf8')");
    expect(run).toContain('System cacheName: label');
    expect(run).toContain("label := 'GemDB run ', label");
    expect(run).toContain('label size > 31 ifTrue:');
  });

  it('ends the run on Ctrl-C rather than leaving topaz at its prompt', () => {
    writeCliScripts(ext);

    const run = fs.readFileSync(path.join(root, 'bin', 'gemdb-run.tpz'), 'utf8');

    // The soft break is reported as CPython reports Ctrl-C, with the status
    // a shell gives a process SIGINT ended...
    expect(run).toContain('(ex isKindOf: Break)');
    expect(run).toContain("nextPutAll: 'KeyboardInterrupt'");
    expect(run).toContain('status := 130');
    // ...and only an ExitClientError, after the status file is written,
    // gets topaz to exit: it has stopped reading the script by then.
    expect(run).toContain('interrupted ifTrue: [ExitClientError new status: status; signal].');
    expect(run.indexOf('interrupted ifTrue:')).toBeGreaterThan(
      run.indexOf('GsFile openWrite: statusFile'),
    );
  });

  it('reports an uncaught exception only after the stack has unwound', () => {
    writeCliScripts(ext);

    const run = fs.readFileSync(path.join(root, 'bin', 'gemdb-run.tpz'), 'utf8');

    // The handler runs at the signal point, where a RecursionError leaves only
    // the stack's reserve; anything more than handing the exception back can
    // overflow it. So the handler must stay exactly this, and the traceback
    // is rendered from what it returns.
    expect(run).toContain('] on: AbstractException do: [:ex | ex return: ex].');
    expect(run).toContain('uncaught ifNotNil: [:ex |');
    expect(run.indexOf('pythonTracebackString')).toBeGreaterThan(run.indexOf('ex return: ex'));
  });

  it('makes no arguments the GemDB Shell, run by the recorded Node runtime', () => {
    writeCliScripts(ext);

    const script = fs.readFileSync(cliPath(), 'utf8');
    // The shell branch: the staged bundle, under the editor's own runtime,
    // with the setting the environment cannot otherwise carry.
    expect(script).toContain('gemdb-shell.js');
    expect(script).toContain(`NODE="${process.execPath}"`);
    expect(script).toContain('ELECTRON_RUN_AS_NODE=1');
    expect(script).toContain('GEMDB_ENGINE_VERSION');
    // The old handoff to Grail's topaz REPL is gone entirely.
    expect(script).not.toContain('gemdb-repl.tpz');
  });

  it('stages the shell bundle with only this platform of koffi', () => {
    writeCliScripts(ext);

    expect(fs.existsSync(path.join(root, 'bin', 'gemdb-shell.js'))).toBe(true);
    const koffi = path.join(root, 'bin', 'node_modules', 'koffi');
    const machine = `${process.platform}_${process.arch}`;
    expect(fs.existsSync(path.join(koffi, 'package.json'))).toBe(true);
    expect(fs.existsSync(path.join(koffi, 'build', 'koffi', machine, 'koffi.node'))).toBe(true);
    // The same pruning .vscodeignore applies to the extension's own copy:
    // other platforms' binaries and the documentation stay behind.
    expect(fs.existsSync(path.join(koffi, 'build', 'koffi', 'linux_ia32'))).toBe(false);
    expect(fs.existsSync(path.join(koffi, 'doc'))).toBe(false);
  });

  it('still writes the wrapper when the build carries no shell bundle', () => {
    fs.rmSync(path.join(ext, 'out', 'gemdb-shell.js'));

    writeCliScripts(ext);

    // File and module mode do not need the bundle, so the wrapper is written
    // regardless; its shell branch reports the gap at run time instead.
    expect(fs.existsSync(cliPath())).toBe(true);
    expect(fs.existsSync(path.join(root, 'bin', 'gemdb-shell.js'))).toBe(false);
    expect(fs.readFileSync(cliPath(), 'utf8')).toContain('has no shell program');
  });

  it('removes the retired topaz REPL driver a previous release wrote', () => {
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(root, 'bin', 'gemdb-repl.tpz'), 'input grail.tpz\n');

    writeCliScripts(ext);

    expect(fs.existsSync(path.join(root, 'bin', 'gemdb-repl.tpz'))).toBe(false);
  });

  it('restages when the shell bundle changed, even though nothing else did', () => {
    // The bug this guards: staging used to run only when the Grail payload
    // changed, so an update carrying only code left the previous bundle in
    // place. A fix to the shell reached the editor and not the terminal it
    // opens — which is exactly how a stale `gcits login:` line survived a
    // release that had silenced it.
    writeCliScripts(ext);
    const staged = path.join(root, 'bin', 'gemdb-shell.js');
    expect(fs.readFileSync(staged, 'utf8')).toBe('// the shell bundle\n');

    fs.writeFileSync(path.join(ext, 'out', 'gemdb-shell.js'), '// rebuilt\n');
    writeCliScripts(ext);

    expect(fs.readFileSync(staged, 'utf8')).toBe('// rebuilt\n');
  });

  it('writes nothing when it would write the same bytes', () => {
    // Called on every path to a running database, so the common case has to
    // be cheap: no rewrite, and above all no rm/copy of koffi.
    writeCliScripts(ext);
    const before = fs.statSync(cliPath()).mtimeMs;
    const stamp = fs.readFileSync(cliStampPath(), 'utf8');

    writeCliScripts(ext);

    expect(fs.statSync(cliPath()).mtimeMs).toBe(before);
    expect(fs.readFileSync(cliStampPath(), 'utf8')).toBe(stamp);
  });

  it('restages when the wrapper itself would differ', () => {
    // The wrapper bakes in paths and the editor's own Node runtime, so it goes
    // stale for reasons that have nothing to do with the bundle.
    writeCliScripts(ext);
    fs.writeFileSync(cliPath(), '#!/bin/bash\n# tampered\n');
    fs.writeFileSync(cliStampPath(), 'not-the-fingerprint\n');

    writeCliScripts(ext);

    expect(fs.readFileSync(cliPath(), 'utf8')).toContain(`ROOT="${root}"`);
  });

  it('leaves no stamp claiming success when generation failed', () => {
    // The stamp is a claim that everything above it was written.
    fs.rmSync(expectedEnginePath(), { recursive: true, force: true });
    expect(() => writeCliScripts(ext)).toThrow(/not installed/);
    expect(fs.existsSync(cliStampPath())).toBe(false);
  });

  it('reports whether the command a terminal is about to launch is really there', () => {
    // openRepl hands this path to VS Code as a terminal's shell program, so a
    // false here is the difference between an explanation and
    // "The terminal process failed to launch".
    expect(ensureCliCurrent(ext)).toBe(true);
    expect(fs.existsSync(cliPath())).toBe(true);

    // Generation impossible: it must say so rather than throw, and must not
    // claim a wrapper that is not there.
    fs.rmSync(cliPath());
    fs.rmSync(expectedEnginePath(), { recursive: true, force: true });
    expect(ensureCliCurrent(ext)).toBe(false);
  });

  it('refuses to generate against a missing engine', () => {
    fs.rmSync(expectedEnginePath(), { recursive: true, force: true });
    expect(() => writeCliScripts(ext)).toThrow(/not installed/);
  });
});

describe('putCliOnPath', () => {
  /** A stand-in for the collection VS Code applies to its own terminals. */
  function fakeEnvironment(): { cleared: number; prepended: [string, string][] } & {
    clear(): void;
    prepend(variable: string, value: string): void;
  } {
    return {
      cleared: 0,
      prepended: [],
      clear() {
        this.cleared += 1;
      },
      prepend(variable: string, value: string) {
        this.prepended.push([variable, value]);
      },
    };
  }

  it('prepends the directory the command is generated into', () => {
    const env = fakeEnvironment();

    putCliOnPath(env);

    // Prepended, not appended: a `gemdb` of GemDB's own is the one this
    // installation generated. And the trailing delimiter is the whole
    // mechanism — without it the entry runs into the rest of the PATH.
    expect(env.prepended).toEqual([['PATH', `${path.join(root, 'bin')}${path.delimiter}`]]);
  });

  it('clears first, because the collection outlives the window', () => {
    // VS Code persists it across reloads and re-applies it before activation.
    // Re-applying without clearing would stack an entry per reload, and a
    // changed root path would leave the old one in front of the new.
    const env = fakeEnvironment();

    putCliOnPath(env);
    __setSetting('gemdb.rootPath', path.join(root, 'elsewhere'));
    putCliOnPath(env);

    expect(env.cleared).toBe(2);
    expect(env.prepended[1]).toEqual([
      'PATH',
      `${path.join(root, 'elsewhere', 'bin')}${path.delimiter}`,
    ]);
  });

  it('contributes the directory even before the command is written', () => {
    // First run: the PATH is set at activation and setup writes bin/gemdb
    // minutes later. A terminal opened in between must not need reopening.
    fs.rmSync(path.join(root, 'bin'), { recursive: true, force: true });
    const env = fakeEnvironment();

    putCliOnPath(env);

    expect(env.prepended).toHaveLength(1);
  });
});

/**
 * Starting the stone is a check-then-act with nothing between the check and
 * the start, and every `gemdb` command runs it -- so two ordinary commands
 * close together are enough to start two stones on one extent. That happened:
 * two stoned processes held the same extent0.dbf read-write for a week, and
 * `gslist` showed one row for them because it keys Stone rows by name.
 *
 * The stubs stand in for the engine binaries the wrapper calls by absolute
 * path. `startstone` records that it ran and leaves a marker holding the
 * stone's status; `gslist` reports a stone, with that status, only once the
 * marker exists, so a wrapper that re-checks after taking the lock sees what
 * a real one would.
 */
describe('starting the database', () => {
  function installEngineStubs(): { starts: string } {
    const bin = path.join(expectedEnginePath(), 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const marker = path.join(root, 'stone.up');
    const starts = path.join(root, 'starts.log');
    const countdown = path.join(root, 'stone.countdown');
    const next = path.join(root, 'stone.next');

    fs.writeFileSync(
      path.join(bin, 'gslist'),
      [
        '#!/bin/sh',
        // A stone that changes state on its own: see stoneBecomes.
        `if [ -f '${countdown}' ]; then`,
        `  n=$(cat '${countdown}')`,
        `  if [ "$n" -le 0 ]; then`,
        `    rm -f '${countdown}'`,
        `    if [ -f '${next}' ]; then mv '${next}' '${marker}'; else rm -f '${marker}'; fi`,
        `  else echo $((n - 1)) > '${countdown}'; fi`,
        'fi',
        `[ -f '${marker}' ] && echo "$(cat '${marker}') 4.0.0 me 1 1 x Stone gemdb"`,
        'exit 0',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(bin, 'startstone'),
      `#!/bin/sh\nsleep 0.2\necho started >> '${starts}'\necho OK > '${marker}'\nexit 0\n`,
    );
    fs.chmodSync(path.join(bin, 'gslist'), 0o755);
    fs.chmodSync(path.join(bin, 'startstone'), 0o755);
    return { starts };
  }

  /**
   * Leave a stone at `status` that becomes `then` (or disappears, when
   * undefined) after `calls` gslist calls — the wrapper's own pace rather than
   * the clock's, since how long it takes to reach its stone checks varies.
   */
  function stoneBecomes(status: string, then: string | undefined, calls: number): void {
    fs.writeFileSync(path.join(root, 'stone.up'), status);
    if (then !== undefined) fs.writeFileSync(path.join(root, 'stone.next'), then);
    fs.writeFileSync(path.join(root, 'stone.countdown'), String(calls));
  }

  /** Run the wrapper on a path that does not exist: it exits after the
   *  stone-start block and before topaz, which is the part under test. */
  function runWrapper(): Promise<string> {
    return new Promise((resolve) => {
      execFile(cliPath(), [path.join(root, 'nothing-here.py')], (_error, _stdout, stderr) =>
        resolve(stderr),
      );
    });
  }

  it('locks on the same name the extension does', () => {
    // Two doors start this stone: the extension on activation and this wrapper
    // on any command. A lock each would not be a lock -- so if one side is
    // renamed, this fails rather than quietly reopening the race.
    writeCliScripts(ext);
    expect(fs.readFileSync(cliPath(), 'utf8')).toContain(STONE_LOCK_NAME);
  });

  it('takes over a lock whose owner is gone, rather than blocking for ever', async () => {
    writeCliScripts(ext);
    const { starts } = installEngineStubs();
    // Debris from a crash: a held lock naming a pid that is not running.
    const lock = path.join(root, '.gemdb-stone.lock');
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'pid'), '999999\n');

    await runWrapper();

    expect(fs.existsSync(starts)).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
  });

  /** Make a path look ten seconds old, past the grace given to a half-written lock. */
  function backdate(target: string): void {
    const then = new Date(Date.now() - 10_000);
    fs.utimesSync(target, then, then);
  }

  it('leaves alone a lock whose pid is not written yet', async () => {
    // mkdir and the pid write are two steps, so a fresh empty lock is another
    // process mid-claim. Removing it would start a second stone beside theirs.
    writeCliScripts(ext);
    const { starts } = installEngineStubs();
    const lock = path.join(root, '.gemdb-stone.lock');
    fs.mkdirSync(lock);
    // The "other process" finishes: the stone comes up while the wrapper waits.
    setTimeout(() => fs.writeFileSync(path.join(root, 'stone.up'), 'OK'), 300);

    await runWrapper();

    expect(fs.existsSync(lock)).toBe(true);
    expect(fs.existsSync(starts)).toBe(false);
  });

  it('takes over a lock that has had no pid for longer than any claim takes', async () => {
    writeCliScripts(ext);
    const { starts } = installEngineStubs();
    const lock = path.join(root, '.gemdb-stone.lock');
    fs.mkdirSync(lock);
    backdate(lock);

    await runWrapper();

    expect(fs.existsSync(starts)).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('does not remove a lock that someone else took over while it was starting', async () => {
    // If ours was judged stale and stolen mid-start, the lock is the thief's now.
    writeCliScripts(ext);
    const bin = path.join(expectedEnginePath(), 'bin');
    installEngineStubs();
    const lock = path.join(root, '.gemdb-stone.lock');
    fs.writeFileSync(
      path.join(bin, 'startstone'),
      `#!/bin/sh\necho ${process.pid} > '${lock}/pid'\necho OK > '${path.join(root, 'stone.up')}'\nexit 0\n`,
    );

    await runWrapper();

    expect(fs.readFileSync(path.join(lock, 'pid'), 'utf8').trim()).toBe(String(process.pid));
  });

  /** The stone lock and steal guard a stealer left when it died inside the guard. */
  function leaveDeadStealersDebris(): void {
    const lock = path.join(root, '.gemdb-stone.lock');
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'pid'), '999999\n');
    fs.mkdirSync(`${lock}.steal`);
    backdate(`${lock}.steal`);
  }

  /** What is left beside the stone lock: the guard, or a tomb it was moved to. */
  function guardLeftovers(): string[] {
    return fs.readdirSync(root).filter((name) => name.startsWith('.gemdb-stone.lock.steal'));
  }

  it('takes over the steal guard of a stealer that died inside it', async () => {
    writeCliScripts(ext);
    const { starts } = installEngineStubs();
    leaveDeadStealersDebris();

    await runWrapper();

    expect(fs.existsSync(starts)).toBe(true);
    expect(guardLeftovers()).toEqual([]);
  });

  it('starts the stone once when several commands race over a dead stealer’s guard', async () => {
    // A smoke test of the takeover under contention, not a reproduction of the
    // race it closes: that window is too narrow to hit with natural timing,
    // and this passes against delete-in-place too. No assertion on leftovers:
    // a guard put back in the rare three-stealer case can outlive the run.
    writeCliScripts(ext);
    const { starts } = installEngineStubs();
    leaveDeadStealersDebris();

    await Promise.all([runWrapper(), runWrapper(), runWrapper(), runWrapper()]);

    expect(fs.readFileSync(starts, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('starts the stone once when several commands race', async () => {
    writeCliScripts(ext);
    const { starts } = installEngineStubs();

    await Promise.all([runWrapper(), runWrapper(), runWrapper(), runWrapper()]);

    const started = fs.existsSync(starts)
      ? fs.readFileSync(starts, 'utf8').trim().split('\n').filter(Boolean).length
      : 0;
    expect(started).toBe(1);
  });
  it('waits for a stone that is still starting instead of starting a second one', async () => {
    // Listed at Startup with nobody holding the lock: a crash being recovered,
    // or a start by a GemDB that does not wait for OK.
    writeCliScripts(ext);
    const { starts } = installEngineStubs();
    // Still starting for the first check, the re-check in the lock, and the
    // first wait for it.
    stoneBecomes('Startup', 'OK', 3);

    const stderr = await runWrapper();

    expect(fs.existsSync(starts)).toBe(false);
    expect(stderr).toContain('waiting for the database to finish starting');
    expect(stderr).toContain("can't open file");
  });

  it('names the stone log when a stone that was starting disappears', async () => {
    writeCliScripts(ext);
    const { starts } = installEngineStubs();
    stoneBecomes('Startup', undefined, 3);

    const stderr = await runWrapper();

    expect(fs.existsSync(starts)).toBe(false);
    expect(stderr).toMatch(/stopped while it was starting\. See .*gemdb\.log/);
  });
});
