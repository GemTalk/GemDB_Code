import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cliPath } from '../cli';
import { bundledGrailStamp, stageGrail } from '../grail';
import { isRunning, stopStone } from '../processes';
import {
  createDatabaseWithPython,
  Fixture,
  haveTestExtent,
  makeFixture,
  startStoneAlone,
} from './fixture';

/**
 * The `gemdb` shell command, run the way a user runs it: bash, a file
 * argument, and nothing set up in the environment. The wrapper is generated
 * with the fixture's own root path baked in, so everything it starts stays
 * inside the fixture — including the stone it starts for itself.
 *
 * Uses the suite's prepared extent: the CLI needs Python already in the
 * database, and copying that file is seconds where a file-in is not.
 */

const ext = process.cwd();
const ready = bundledGrailStamp(ext) !== undefined && haveTestExtent();

let fixture: Fixture | undefined;
let workDir: string;

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run the generated wrapper as a user would, never throwing on exit codes.
 * `merged` sends stderr into stdout, as a terminal shows them, for a test
 * about the order of the two.
 */
function run(args: string[], stdin?: string, merged = false): Promise<Ran> {
  return new Promise((resolve) => {
    const child = execFile(
      'bash',
      merged ? ['-c', 'bash "$0" "$@" 2>&1', cliPath(), ...args] : [cliPath(), ...args],
      { cwd: workDir, timeout: 120_000 },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
            ? ((error as unknown as { code: number }).code as number)
            : error
              ? 1
              : 0;
        resolve({ code, stdout, stderr });
      },
    );
    // Closed either way: a linked gem's input() reads this pipe, and an open
    // empty pipe would park the run forever rather than raising EOFError.
    child.stdin?.end(stdin ?? '');
  });
}

function gemdb(...args: string[]): Promise<Ran> {
  return run(args);
}

beforeAll(async () => {
  if (!ready) return;
  fixture = makeFixture();
  if (!fixture) return;
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdb-cli-work-'));

  createDatabaseWithPython(fixture); // Python already filed in — see testExtentPath
  stageGrail(ext); // stages Grail and generates the CLI
  await startStoneAlone();

  fs.writeFileSync(path.join(workDir, 'hello.py'), 'print("hello from", 6 * 7)\n');
  fs.writeFileSync(path.join(workDir, 'both.py'), 'print("partial")\n1 / 0\n');
  fs.writeFileSync(path.join(workDir, 'leaves.py'), 'import sys\nsys.exit(3)\n');
});

afterAll(async () => {
  if (!fixture) return;
  try {
    if (isRunning()) await stopStone(true);
  } finally {
    fixture.remove();
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
  }
});

describe.skipIf(!ready || !canMakeFixture())('the gemdb command', () => {
  it('runs a file like python3 does', async () => {
    const ran = await gemdb('hello.py');
    expect(ran.stdout).toContain('hello from 42');
    expect(ran.code).toBe(0);
  });

  it('says where a breakpoint() was and carries on, rather than stranding at a topaz prompt', async () => {
    fs.writeFileSync(
      path.join(workDir, 'paused.py'),
      'def f():\n    breakpoint()\n    return "went on"\nprint(f())\n',
    );
    // Merged, as a terminal shows it: the notice is written to sys.stderr,
    // which file mode currently routes to stdout along with print().
    const ran = await run(['paused.py'], undefined, true);
    expect(ran.stdout).toBe(
      'breakpoint() at paused.py:2: the debugger opens in notebooks and Debug Python File in GemDB; continuing.\n' +
        'went on\n',
    );
    expect(ran.code).toBe(0);
  });

  it('keeps stdout, reports the error on stderr, and exits nonzero', async () => {
    const ran = await gemdb('both.py');
    expect(ran.stdout).toContain('partial');
    expect(ran.stderr).toContain('division by zero');
    expect(ran.code).toBe(1);
  });

  it('reports an uncaught exception with its traceback and type, as CPython does', async () => {
    const ran = await gemdb('-c', 'def f():\n    return 1 / 0\nf()');

    expect(ran.stderr).toContain('Traceback (most recent call last):');
    expect(ran.stderr).toContain(', in f');
    expect(ran.stderr.trim().split('\n').at(-1)).toBe('ZeroDivisionError: division by zero');
    expect(ran.code).toBe(1);
  });

  it('names an exception by its module-qualified type', async () => {
    const ran = await gemdb('-c', 'import json\njson.loads("{bad")');

    expect(ran.stderr.trim().split('\n').at(-1)).toMatch(/^json\.decoder\.JSONDecodeError: /);
    expect(ran.code).toBe(1);
  });

  it('reports runaway recursion without overflowing the stack', async () => {
    // The report runs after the stack unwinds. Made from inside the handler,
    // it has only the stack's reserve to work in, and a RecursionError's
    // traceback overflows that (GemTalk/Grail#1261).
    const ran = await gemdb('-c', 'def f():\n    return f()\nf()');

    expect(ran.stderr).toContain('RecursionError: maximum recursion depth exceeded');
    expect(ran.code).toBe(1);
  });

  it('runs finally blocks before the traceback prints', async () => {
    const ran = await run(
      ['-c', 'try:\n    1 / 0\nfinally:\n    print("cleanup")'],
      undefined,
      true,
    );

    expect(ran.stdout).toContain('cleanup');
    expect(ran.stdout.indexOf('cleanup')).toBeLessThan(ran.stdout.indexOf('Traceback'));
    expect(ran.code).toBe(1);
  });

  it('carries sys.exit(n) out as the real exit code', async () => {
    // The driver decodes Grail's SystemExit itself — the status survives only
    // in the exception's Python args tuple. See the note in cli.ts.
    const ran = await gemdb('leaves.py');
    expect(ran.stderr.trim()).toBe(''); // CPython is silent about an int status
    expect(ran.code).toBe(3);
  });

  it('treats sys.exit() and sys.exit(None) as success, silently', async () => {
    const ran = await gemdb('-c', 'import sys\nsys.exit()');
    expect(ran.stderr.trim()).toBe('');
    expect(ran.code).toBe(0);
  });

  it('prints a non-integer sys.exit argument to stderr and exits 1', async () => {
    const ran = await gemdb('-c', 'import sys\nsys.exit("boom")');
    expect(ran.stderr).toContain('boom');
    expect(ran.code).toBe(1);
  });

  it('truncates an out-of-range sys.exit status the way CPython does', async () => {
    const ran = await gemdb('-c', 'import sys\nsys.exit(-1)');
    expect(ran.code).toBe(255);
  });

  it('fails a missing file the way CPython words it', async () => {
    const ran = await gemdb('nope.py');
    expect(ran.stderr).toContain("can't open file");
    expect(ran.code).toBe(2);
  });

  it('runs -c one-liners', async () => {
    const ran = await gemdb('-c', 'print(sum(range(10)))');
    expect(ran.stdout).toContain('45');
    expect(ran.code).toBe(0);
  });

  it('feeds input() from stdin, like python3 does', async () => {
    // The linked gem's GsFile stdin IS this pipe, so no forwarders are
    // involved: the prompt goes where print() goes, the line comes straight
    // from the pipe with its newline stripped.
    const ran = await run(['-c', 'print("Hello, " + input("NAME? "))'], 'World\n');
    expect(ran.stdout).toContain('NAME? ');
    expect(ran.stdout).toContain('Hello, World');
    expect(ran.code).toBe(0);
  });

  it('writes non-ASCII output as UTF-8, not UTF-16 code units', async () => {
    // The console this mode installs is a GsFile, which takes BYTES: writing
    // a Unicode string to it straight put a NUL between every ASCII character
    // and truncated anything above U+00FF to its low byte, so an ASCII-art
    // rabbit with a bullet in it came out as binary. Grail encodes because
    // the driver's #GrailConsole box declares the sink takes utf8.
    const ran = await gemdb('-c', 'print("caf\u00e9 \u2022 \u4e2d")');
    expect(ran.stdout).toContain('caf\u00e9 \u2022 \u4e2d');
    expect(ran.stdout).not.toContain('\u0000');
    expect(ran.code).toBe(0);
  });

  it('reads non-ASCII input as characters, not bytes', async () => {
    // The other half of the same seam: GsFile stdin answers bytes, so a
    // terminal's UTF-8 arrived one Character per byte — 'w\u00f6rld' as
    // 'w\u00c3\u00b6rld', six characters long, and mojibake on the way back
    // out.
    const ran = await run(['-c', 'n = input()\nprint(n, len(n))'], 'w\u00f6rld\n');
    expect(ran.stdout).toContain('w\u00f6rld 5');
    expect(ran.code).toBe(0);
  });

  it('stops on Ctrl-C as python3 does, after finally blocks, with nothing from topaz', async () => {
    // A real Ctrl-C needs a real terminal: the line discipline turns ^C into
    // SIGINT for topaz, which sends the gem a soft break. expect(1) owns the
    // pty, as in repl.test.ts. The script blocks in a primitive, where a web
    // server spends its life, rather than spinning in Python.
    fs.writeFileSync(
      path.join(workDir, 'serve.py'),
      'import time\nprint("serving", flush=True)\ntry:\n    while True:\n        time.sleep(0.2)\n' +
        'finally:\n    print("cleaned up", flush=True)\n',
    );
    const scriptPath = path.join(workDir, 'interrupt.exp');
    fs.writeFileSync(
      scriptPath,
      `set timeout 90
spawn ${cliPath()} serve.py
expect {
  -ex "serving" {}
  timeout { puts stderr "TIMEOUT waiting to serve"; exit 9 }
}
sleep 1
send "\\003"
expect {
  -ex "topaz 1>" { puts stderr "STRANDED at a topaz prompt"; exit 7 }
  timeout { puts stderr "TIMEOUT: still running after Ctrl-C"; exit 9 }
  eof {}
}
catch wait result
exit [lindex $result 3]
`,
    );
    const ran = await new Promise<{ code: number; transcript: string }>((resolve) => {
      execFile(
        '/usr/bin/expect',
        ['-f', scriptPath],
        { cwd: workDir, timeout: 115_000 },
        (error, stdout, stderr) => {
          const code =
            error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
              ? ((error as unknown as { code: number }).code as number)
              : error
                ? 1
                : 0;
          resolve({ code, transcript: stdout + stderr });
        },
      );
    });
    // Everything the terminal showed after expect's own spawn line, less the
    // ^C the line discipline echoes. Topaz used to add a soft-break notice,
    // the driver line it stopped at, ERROR 3004 and a logout (#131).
    const shown = ran.transcript
      .replaceAll('^C', '')
      .split(/\r?\n/)
      .slice(1)
      .map((line) => line.trim())
      .filter((line) => line !== '');

    expect(shown).toEqual(['serving', 'cleaned up', 'KeyboardInterrupt']);
    expect(ran.code).toBe(130);
  });

  it('says why when the database refuses the login, and runs nothing piped to it', async () => {
    const driver = path.join(path.dirname(cliPath()), 'gemdb-run.tpz');
    const good = fs.readFileSync(driver, 'utf8');
    fs.writeFileSync(driver, good.replace(/^(set user \S+ pass )\S*$/m, '$1not-the-password'));
    let ran: Ran;
    try {
      ran = await run(['hello.py'], 'shell echo LEAKED\n');
    } finally {
      fs.writeFileSync(driver, good);
    }

    // Exactly GemStone's report of the refusal: none of the driver, which
    // topaz echoes into the log and the wrapper strips, nothing about the run
    // block topaz goes on through with no session, and not the piped line.
    // stdout is not pinned: the gem sometimes writes a line of its own there
    // about the failed login, which is not topaz's to keep quiet.
    expect(ran.stderr.trimEnd().split('\n')).toEqual([
      expect.stringMatching(/^-+$/),
      'GemStone: Error         Fatal',
      'Login failed:  the userId/password combination is invalid or expired.',
      expect.stringContaining('Number: 4051'),
      'Arg 1: nil',
    ]);
    expect(ran.stdout).not.toContain('LEAKED');
    expect(ran.stdout).not.toContain('hello from');
    // topaz's own status, which the wrapper passes on when there is no other.
    expect(ran.code).toBe(1);
  });

  it('ends the program, finally blocks and all, when its terminal closes', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdb-cli-tmp-'));
    const env = { ...process.env, TMPDIR: tmp };
    fs.rmSync(path.join(workDir, 'hung-up.txt'), { force: true });
    fs.writeFileSync(
      path.join(workDir, 'quiet.py'),
      'import time\nprint("serving", flush=True)\ntry:\n    while True:\n        time.sleep(0.2)\n' +
        'finally:\n    open("hung-up.txt", "w").write("finally ran")\n',
    );
    await new Promise((resolve) =>
      execFile('bash', [cliPath(), '-c', 'print(1)'], { cwd: workDir, env }, resolve),
    );
    // Closing expect's side of the pty is what closing a terminal tab does.
    // The wrapper runs as a job of an interactive shell that owns the pty, as
    // in a tab, and not as the pty's own process: then the shell passes the
    // hangup on and the kernel sends one too, and on Linux the second ended
    // the wrapper before its trap could stop topaz. Spawned directly, it was
    // hung up once, and this passed against that wrapper.
    const scriptPath = path.join(workDir, 'hangup.exp');
    fs.writeFileSync(
      scriptPath,
      `set timeout 90
set env(PS1) "ready> "
spawn bash --norc --noprofile -i
expect {
  -ex "ready> " {}
  timeout { puts stderr "TIMEOUT waiting for the shell"; exit 9 }
}
send "bash ${cliPath()} quiet.py\\r"
expect {
  -ex "serving" {}
  timeout { puts stderr "TIMEOUT waiting to serve"; exit 9 }
}
set wrapper [exec pgrep -P [exp_pid] -x bash]
puts "WRAPPER=$wrapper TOPAZ=[exec pgrep -P $wrapper -x topaz]"
close
`,
    );
    // On 'exit', not when its output closes: a topaz left running would hold
    // expect's pipes open, and the test would time out instead of failing.
    const expectRun = spawn('/usr/bin/expect', ['-f', scriptPath], { cwd: workDir, env });
    let transcript = '';
    expectRun.stdout.on('data', (chunk: Buffer) => (transcript += chunk.toString()));
    await new Promise((resolve) => expectRun.on('exit', resolve));
    const topaz = Number(/TOPAZ=(\d+)/.exec(transcript)?.[1]);
    const wrapper = Number(/WRAPPER=(\d+)/.exec(transcript)?.[1]);

    // topaz ignores SIGHUP, so this is the wrapper's doing: what Ctrl-C sends.
    // The wrapper goes last, once it has seen topaz go and removed its files.
    const ended = await waitForProcessToEnd(topaz, 15_000);
    await waitForProcessToEnd(wrapper, 15_000);
    const left = fs.readdirSync(tmp);
    if (!ended) process.kill(topaz, 'SIGTERM');
    fs.rmSync(tmp, { recursive: true, force: true });

    expect(topaz).toBeGreaterThan(0);
    expect(ended).toBe(true);
    expect(fs.readFileSync(path.join(workDir, 'hung-up.txt'), 'utf8')).toBe('finally ran');
    expect(left).toEqual([]);
  });

  it('raises EOFError when stdin runs dry', async () => {
    const ran = await run(['-c', 'input()'], '');
    expect(ran.stderr).toContain('EOF');
    expect(ran.code).toBe(1);
  });

  // The shell proper needs a tty, which execFile cannot grant — so what is
  // pinned here is the seam: the wrapper finds its Node runtime, the staged
  // bundle loads, and the refusal a pipe gets is the shell's own message.
  it.skipIf(!fs.existsSync(path.join(ext, 'out', 'gemdb-shell.js')))(
    'refuses the shell without a terminal, and says so',
    async () => {
      const ran = await gemdb();
      expect(ran.stderr).toContain('needs a terminal');
      expect(ran.code).toBe(1);
    },
  );

  it('answers --version without needing the database', async () => {
    const ran = await gemdb('--version');
    expect(ran.stdout).toContain('GemDB Python');
    expect(ran.code).toBe(0);
  });

  it('starts the database itself when it is down', async () => {
    await stopStone(false);
    expect(isRunning()).toBe(false);

    const ran = await gemdb('-c', 'print("back")');
    expect(ran.stderr).toContain('starting the database');
    expect(ran.stdout).toContain('back');
    expect(ran.code).toBe(0);
    expect(isRunning()).toBe(true);
  });
});

/** See database.test.ts — skipIf is evaluated during collection. */
function canMakeFixture(): boolean {
  const probe = makeFixture();
  probe?.remove();
  return probe !== undefined;
}

/** Whether `pid` has exited within `ms`, polling as `kill -0` does. */
async function waitForProcessToEnd(pid: number, ms: number): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += 100) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}
