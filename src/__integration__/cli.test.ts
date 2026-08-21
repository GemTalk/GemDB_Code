import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cliPath } from '../cli';
import { createDatabase } from '../database';
import { bundledGrailStamp, stageGrail } from '../grail';
import { bundledExtentPath } from '../paths';
import { isRunning, startStone, stopStone } from '../processes';
import { Fixture, makeFixture } from './fixture';

/**
 * The `gemdb` shell command, run the way a user runs it: bash, a file
 * argument, and nothing set up in the environment. The wrapper is generated
 * with the fixture's own root path baked in, so everything it starts stays
 * inside the fixture — including the stone it starts for itself.
 *
 * Uses the preloaded extent: the CLI needs Python already in the database, and
 * copying the shipped extent is seconds where a file-in is not.
 */

const ext = process.cwd();
const ready = bundledGrailStamp(ext) !== undefined && fs.existsSync(bundledExtentPath(ext));

let fixture: Fixture | undefined;
let workDir: string;

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the generated wrapper as a user would, never throwing on exit codes. */
function run(args: string[], stdin?: string): Promise<Ran> {
  return new Promise((resolve) => {
    const child = execFile(
      'bash',
      [cliPath(), ...args],
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

  createDatabase(fixture.engine, ext); // the preloaded extent — Python included
  stageGrail(ext); // stages Grail and generates the CLI
  await startStone();

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

  it('keeps stdout, reports the error on stderr, and exits nonzero', async () => {
    const ran = await gemdb('both.py');
    expect(ran.stdout).toContain('partial');
    expect(ran.stderr).toContain('division by zero');
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
