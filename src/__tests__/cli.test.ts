import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __resetSettings, __setSetting } from '../__mocks__/vscode';
import { cliPath, ensureCliCurrent, putCliOnPath, writeCliScripts } from '../cli';
import { STONE_LOCK_NAME } from '../lock';
import { GRAIL_NOT_INSTALLED } from '../grailMessages';
import { cliStampPath, expectedEnginePath, grailStampPath } from '../paths';

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
  __resetSettings();
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
    // The console sink is a GsFile, which takes bytes; the second slot of
    // the #GrailConsole box is what tells Grail to encode. Without it,
    // non-ASCII print() output is UTF-16 code units on the terminal.
    expect(run).toContain("put: (Array with: GsFile stdout with: #'utf8')");
    // A file run is linked topaz, so it never reaches session.ts and would
    // otherwise sit in the shared cache as the stock 'TopazL'. The truncation
    // is not optional: 32 characters raises OutOfRange, at login.
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

  it("keeps topaz's own output off the terminal, and shows it when a run never finished", () => {
    writeCliScripts(ext);

    const script = fs.readFileSync(cliPath(), 'utf8');
    const init = fs.readFileSync(path.join(root, 'bin', 'gemdb-run-init.tpz'), 'utf8');

    // Only -P honours OUTPUT PUSH ... ONLY for stdout, and only an -I file is
    // not echoed before the push takes effect.
    expect(init).toBe('output push $GEMDB_TOPAZ_LOG only\n');
    expect(script).toContain(
      'topaz -L -q -I "$ROOT/bin/gemdb-run-init.tpz" -P "$ROOT/bin/gemdb-run.tpz"',
    );
    expect(script).toContain('GEMDB_TOPAZ_LOG="$(mktemp');
    expect(script).toMatch(/if \[ -z "\$RUN_STATUS" \]; then\n\s+sed .* "\$GEMDB_TOPAZ_LOG" >&2\n/);
  });

  it('tidies up after the run however it ends, topaz included', () => {
    writeCliScripts(ext);

    const script = fs.readFileSync(cliPath(), 'utf8');

    // Armed before the first file is made, so no exit path — a hangup
    // included — can skip it, and nothing after the run removes them itself.
    expect(script.indexOf('trap end_run EXIT')).toBeGreaterThan(-1);
    expect(script.indexOf('trap end_run EXIT')).toBeLessThan(script.indexOf('mktemp'));
    expect(script).not.toMatch(/^rm -f "\$GEMDB_STATUS_FILE"/m);
    // topaz ignores SIGHUP, so a wrapper ending first sends it Ctrl-C — but
    // only while topaz is running, so a finished run looks for nothing.
    expect(script).toMatch(/TOPAZ_RUNNING=yes\ntopaz -L /);
    expect(script).toMatch(/\nRC=\$\?\nTOPAZ_RUNNING=""\n/);
    expect(script).toContain('kill -INT "$pid"');
    // A terminal tab hangs the wrapper up twice, and bash 5 dies of the
    // second unless the trap ignores it first.
    expect(script).toMatch(/\nend_run\(\) \{\n {2}trap '' HUP\n/);
  });

  it('never leaves topaz reading commands from stdin', () => {
    writeCliScripts(ext);

    const lines = fs
      .readFileSync(path.join(root, 'bin', 'gemdb-run.tpz'), 'utf8')
      .trimEnd()
      .split('\n');

    // Under -P, topaz reads stdin once the script ends — a terminal, or
    // whatever was piped to the user's program.
    expect(lines[lines.length - 1]).toBe('exit');
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

    // A run against a database that is already up does not need the bundle, so
    // the wrapper is written regardless; a cold start and the Shell report the
    // gap at run time instead.
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
 * What the wrapper decides about starting the database, with stand-ins for
 * everything it calls. It only recognises a stone that answers (`ok`) and runs
 * against it; every other case is handed to the shell program's
 * `--ensure-stone`, which is where the lock, the guards and the waiting live
 * (and are tested, in processes.test.ts and cliStart.test.ts).
 *
 * `gslist` reports a stone with the status in `stone.up`; the shell program is
 * a script that records how it was called and, when it exits 0, leaves the
 * stone `OK` as a real start would; `topaz` records that the run began and
 * reports exit status 0.
 */
describe('starting the database', () => {
  const callsLog = (name: string): string => path.join(root, `${name}.log`);

  function readCalls(name: string): string[] {
    return fs.existsSync(callsLog(name))
      ? fs.readFileSync(callsLog(name), 'utf8').split('\n').filter(Boolean)
      : [];
  }

  function installStubs(): void {
    const bin = path.join(expectedEnginePath(), 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const marker = path.join(root, 'stone.up');
    fs.writeFileSync(
      path.join(bin, 'gslist'),
      [
        '#!/bin/sh',
        `echo "$*" >> '${callsLog('gslist')}'`,
        // The shape of a real -cvl row: status, version, owner, pid, port, date, type, name.
        `[ -f '${marker}' ] && echo "$(cat '${marker}')  4.0.0.a4  me  1 1 Oct 13 15:57 Stone   gemdb"`,
        'exit 0',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(bin, 'topaz'),
      `#!/bin/sh\necho "$*" >> '${callsLog('topaz')}'\necho "\${ELECTRON_RUN_AS_NODE:-unset}" >> '${callsLog('topazenv')}'\necho 0 > "$GEMDB_STATUS_FILE"\nexit 0\n`,
    );
    fs.chmodSync(path.join(bin, 'gslist'), 0o755);
    fs.chmodSync(path.join(bin, 'topaz'), 0o755);
    // Run by the real node the wrapper recorded; records its arguments and
    // what its stdin is, and starts the stone unless told to fail.
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'bin', 'gemdb-shell.js'),
      [
        "const fs = require('fs');",
        'const stdin = fs.fstatSync(0);',
        `const terminal = require('tty').isatty(0);`,
        `fs.appendFileSync('${callsLog('shell')}', process.argv.slice(2).join(' ') + (terminal ? ' tty' : stdin.isCharacterDevice() ? ' null' : ' other') + '\\n');`,
        `const fail = fs.existsSync('${path.join(root, 'ensure.fails')}');`,
        "if (fail) { process.stderr.write('gemdb: the database could not be started.\\n'); process.exit(1); }",
        `fs.writeFileSync('${marker}', 'OK');`,
        '',
      ].join('\n'),
    );
  }

  function stoneIs(status: string): void {
    fs.writeFileSync(path.join(root, 'stone.up'), status);
  }

  function run(args: string[]): Promise<{ code: number; stderr: string }> {
    return new Promise((resolve) => {
      // The editor's own environment may carry the variable under test.
      const { ELECTRON_RUN_AS_NODE: _unused, ...env } = process.env;
      execFile(cliPath(), args, { env }, (error, _stdout, stderr) =>
        resolve({ code: error ? Number(error.code) : 0, stderr }),
      );
    });
  }

  /** A script file to run: arguments that exist, so only the start is under test. */
  function aProgram(): string {
    const file = path.join(root, 'program.py');
    fs.writeFileSync(file, 'print(1)\n');
    return file;
  }

  function stampGrail(): void {
    fs.mkdirSync(path.dirname(grailStampPath()), { recursive: true });
    fs.writeFileSync(grailStampPath(), 'grail=test\n');
  }

  beforeEach(() => {
    writeCliScripts(ext);
    installStubs();
    stampGrail();
  });

  it('runs against a stone that answers without calling the shell program', async () => {
    stoneIs('OK');

    const { code } = await run([aProgram()]);

    expect(code).toBe(0);
    expect(readCalls('gslist')).toHaveLength(1);
    expect(readCalls('shell')).toEqual([]);
    expect(readCalls('topaz')).toHaveLength(1);
  });

  it('hands a stone that is not running to the shell program, once, with no terminal on its stdin', async () => {
    const { code } = await run([aProgram()]);

    expect(code).toBe(0);
    expect(readCalls('shell')).toEqual(['--ensure-stone null']);
    expect(readCalls('topaz')).toHaveLength(1);
  });

  it('leaves the shell program’s environment out of the program it then runs', async () => {
    await run([aProgram()]);

    expect(readCalls('shell')).toHaveLength(1);
    expect(readCalls('topazenv')).toEqual(['unset']);
  });

  it('hands -c and -m runs over the same way', async () => {
    await run(['-c', 'print(1)']);
    fs.rmSync(path.join(root, 'stone.up'));
    await run(['-m', 'json.tool']);

    expect(readCalls('shell')).toEqual(['--ensure-stone null', '--ensure-stone null']);
  });

  // Whatever is not plain `ok` is the shell program's to judge: waiting for a
  // stone that is starting, refusing one that is stopping, letting a stone
  // that reads "exe deleted" go on to its login.
  for (const status of ['Startup', 'Recovery', 'Shutdown', 'exe deleted', 'frozen']) {
    it(`hands a stone that reads "${status}" to the shell program`, async () => {
      stoneIs(status);

      await run([aProgram()]);

      expect(readCalls('shell')).toEqual(['--ensure-stone null']);
    });
  }

  it('stops where the shell program fails, showing what it said, and runs nothing', async () => {
    fs.writeFileSync(path.join(root, 'ensure.fails'), '');

    const { code, stderr } = await run([aProgram()]);

    expect(code).toBe(1);
    expect(stderr).toContain('gemdb: the database could not be started.');
    expect(readCalls('topaz')).toEqual([]);
  });

  it('hands an external database to the shell program too, when it is not answering', async () => {
    __setSetting('gemdb.externalDatabase.gemstone', expectedEnginePath());
    __setSetting('gemdb.externalDatabase.globalDirectory', root);
    __setSetting('gemdb.externalDatabase.stone', 'gemdb');
    writeCliScripts(ext);
    // Staging put the extension's own bundle over the stand-in.
    installStubs();
    stoneIs('Startup');

    await run([aProgram()]);

    expect(readCalls('shell')).toEqual(['--ensure-stone null']);
  });

  it('refuses without a shell program rather than starting the database itself', async () => {
    fs.rmSync(path.join(root, 'bin', 'gemdb-shell.js'));

    const { code, stderr } = await run([aProgram()]);

    expect(code).toBe(1);
    expect(stderr).toContain('this installation has no shell program');
    expect(readCalls('topaz')).toEqual([]);
  });

  it('refuses without a Node runtime to run the shell program', async () => {
    const wrapper = fs.readFileSync(cliPath(), 'utf8');
    fs.writeFileSync(
      cliPath(),
      wrapper
        .replace(`NODE="${process.execPath}"`, 'NODE="/nowhere/node"')
        .replace('command -v node', 'command -v no-such-node-anywhere'),
    );

    const { code, stderr } = await run([aProgram()]);

    expect(code).toBe(1);
    expect(stderr).toContain('no Node runtime found');
    expect(readCalls('topaz')).toEqual([]);
  });

  it('fails a file that is not there without looking for the stone or starting it', async () => {
    const { code, stderr } = await run([path.join(root, 'nothing-here.py')]);

    expect(code).toBe(2);
    expect(stderr).toContain("can't open file");
    expect(readCalls('gslist')).toEqual([]);
    expect(readCalls('shell')).toEqual([]);
  });

  it('fails -c with no code without looking for the stone or starting it', async () => {
    const { code, stderr } = await run(['-c']);

    expect(code).toBe(2);
    expect(stderr).toContain('-c requires an argument');
    expect(readCalls('gslist')).toEqual([]);
    expect(readCalls('shell')).toEqual([]);
  });

  describe('in a database Python has not been filed into', () => {
    beforeEach(() => {
      fs.rmSync(grailStampPath());
    });

    // Exact, quotes and all: the message holds double quotes, and one pasted
    // unescaped into the script would end its echo early.
    const refusal = `gemdb: ${GRAIL_NOT_INSTALLED}\n`;

    for (const mode of ['a file', '-c', '-m']) {
      it(`refuses ${mode}, whatever the stone is doing, without calling anything`, async () => {
        stoneIs('OK');
        const args =
          mode === 'a file'
            ? [aProgram()]
            : mode === '-c'
              ? ['-c', 'print(1)']
              : ['-m', 'json.tool'];

        const { code, stderr } = await run(args);

        expect(code).toBe(1);
        expect(stderr).toBe(refusal);
        expect(readCalls('gslist')).toEqual([]);
        expect(readCalls('shell')).toEqual([]);
        expect(readCalls('topaz')).toEqual([]);
      });
    }

    it('still answers --version and --help', async () => {
      const { code } = await run(['--version']);

      expect(code).toBe(0);
    });

    it('still reports a bad argument as one, before the missing Python', async () => {
      const { code, stderr } = await run([path.join(root, 'nothing-here.py')]);

      expect(code).toBe(2);
      expect(stderr).toContain("can't open file");
    });

    it('is not asked of an external database, whose Python someone else filed in', async () => {
      __setSetting('gemdb.externalDatabase.gemstone', expectedEnginePath());
      __setSetting('gemdb.externalDatabase.globalDirectory', root);
      __setSetting('gemdb.externalDatabase.stone', 'gemdb');
      writeCliScripts(ext);
      installStubs();
      stoneIs('OK');

      const { code } = await run([aProgram()]);

      expect(code).toBe(0);
      expect(readCalls('topaz')).toHaveLength(1);
    });
  });

  it('carries nothing of its own that starts a stone or takes the lock', () => {
    const wrapper = fs.readFileSync(cliPath(), 'utf8');

    // Every start goes through the shell program, so there is one lock
    // mechanism and one set of guards, not a bash copy that drifts.
    expect(wrapper).not.toContain('startstone');
    expect(wrapper).not.toContain(STONE_LOCK_NAME);
  });
});
