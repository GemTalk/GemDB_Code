import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cliPath } from '../cli';
import { createDatabase } from '../database';
import { bundledGrailStamp, stageGrail } from '../grail';
import { bundledExtentPath } from '../paths';
import { isRunning, stopNetldi, stopStone } from '../processes';
import { Fixture, makeFixture } from './fixture';

/**
 * The GemDB Shell, run the way a user runs it: `gemdb` with no arguments, on a
 * real terminal, against a real database. The shell requires a tty — raw-mode
 * line editing only exists on one — and `execFile` cannot grant that, so the
 * session is driven by `expect(1)`, which macOS ships and which owns a real
 * pty. (BSD `script` was tried first; it refuses to run with a pipe for
 * stdin, and typing is the point here.)
 *
 * The stone is deliberately NOT started first: bringing the database up (both
 * the stone and the listener a session needs) is the shell's own first job,
 * and this is where that is proven.
 *
 * Uses the preloaded extent, like cli.test.ts, and additionally needs the
 * shell bundle — a checkout that has not run `npm run bundle` skips.
 */

const ext = process.cwd();
const ready =
  bundledGrailStamp(ext) !== undefined &&
  fs.existsSync(bundledExtentPath(ext)) &&
  fs.existsSync(path.join(ext, 'out', 'gemdb-shell.js'));

let fixture: Fixture | undefined;

interface Ran {
  code: number;
  transcript: string;
}

/**
 * One scripted shell session. Each step waits for a literal string and then
 * types; a wait that never matches ends the run with a distinct exit code and
 * the string it was waiting for on stderr, so a failure names the step.
 */
function driveShell(steps: string): Promise<Ran> {
  const script = `
set timeout 90
proc await {pattern} {
  expect {
    -ex $pattern {}
    timeout { puts stderr "TIMEOUT waiting for: $pattern"; exit 9 }
    eof { puts stderr "EOF waiting for: $pattern"; exit 8 }
  }
}
spawn ${cliPath()}
${steps}
expect eof
catch wait result
exit [lindex $result 3]
`;
  const scriptPath = path.join(fixture!.root, 'drive-shell.exp');
  fs.writeFileSync(scriptPath, script);
  return new Promise((resolve) => {
    execFile(
      '/usr/bin/expect',
      ['-f', scriptPath],
      { timeout: 115_000 },
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
}

beforeAll(() => {
  if (!ready) return;
  fixture = makeFixture();
  if (!fixture) return;
  createDatabase(fixture.engine, ext); // the preloaded extent — Python included
  stageGrail(ext); // stages Grail, the CLI, and the shell bundle
});

afterAll(async () => {
  if (!fixture) return;
  try {
    // The shell starts both processes; both would outlive the runner.
    await stopNetldi().catch(() => {});
    if (isRunning()) await stopStone(true);
  } finally {
    fixture.remove();
  }
});

describe.skipIf(!ready || !canMakeFixture())('the GemDB Shell from the command line', () => {
  it('starts the database, evaluates, prints, interrupts, and leaves', async () => {
    // The first prompt implies the whole chain: stone started, listener
    // started, session logged in, banner shown.
    const ran = await driveShell(`
await ">>> "
send "6 * 7\\r"
await "42"
send "print(\\"marco\\", \\"polo\\")\\r"
await "marco polo"

# A half-built block is abandoned by ^C, CPython-style.
send "def nope():\\r"
await "... "
send "\\x03"
await "^C"

# ^C during a runaway loop interrupts the gem and returns to the prompt as
# KeyboardInterrupt — the reason the shell exists at all.
await ">>> "
send "while True: pass\\r"
sleep 1
send "\\x03"
await "KeyboardInterrupt"

# ^C during a loop that PRINTS. Seeing "tick" before the interrupt proves the
# output streamed while the loop was still running; the interrupt landing at
# all proves the re-sent break (session.ts) — such a loop is mostly idle
# inside Transcript forwarder sends, where a single break is discarded.
await ">>> "
send "while True: print('tick')\\r"
# "tick" followed by a carriage return only exists in the loop's own output —
# in the echoed command the word is followed by a quote — so matching it
# guarantees the loop is genuinely running before ^C is sent.
await "tick\\r"
send "\\x03"
await "KeyboardInterrupt"

# input() rides the session's stdin provider: the gem suspends, the shell
# reads this same tty, and the answer resumes the evaluation.
await ">>> "
send "x = input('NAME? ')\\r"
await "NAME? "
send "Fred\\r"
await ">>> "
send "x\\r"
await "'Fred'"

# ^C while input() waits cancels the read: KeyboardInterrupt at the call.
await ">>> "
send "input('AGE? ')\\r"
await "AGE? "
sleep 1
send "\\x03"
await "KeyboardInterrupt"

send "exit()\\r"
`);

    if (ran.code !== 0) console.log(`--- shell transcript ---\n${ran.transcript}\n---`);
    expect(ran.transcript).toContain('GemDB Shell');
    expect(ran.transcript).toContain('42');
    expect(ran.transcript).toContain('marco polo');
    expect(ran.transcript).toContain('KeyboardInterrupt');
    expect(ran.code).toBe(0);
    expect(isRunning()).toBe(true); // the shell brought the stone up itself
  });
});

/** See database.test.ts — skipIf is evaluated during collection. */
function canMakeFixture(): boolean {
  const probe = makeFixture();
  probe?.remove();
  return probe !== undefined;
}
