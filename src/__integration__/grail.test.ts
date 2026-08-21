import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { __log } from '../__mocks__/vscode';
import { createDatabase } from '../database';
import { bundledGrailStamp, installGrail, recordGrailInstalled, stageGrail } from '../grail';
import { isSharedMemoryConfigured } from '../osConfig';
import { grailInstalled, grailStagedOnDisk } from '../paths';
import { isRunning, startNetldi, startStone, stopNetldi, stopStone } from '../processes';
import {
  isErrorResult,
  isGrailInstalled,
  runPython,
  runPythonInSession,
  runPythonOnce,
} from '../pythonQueries';
import { GciSession, logout } from '../session';
import { Fixture, makeFixture } from './fixture';

/**
 * Grail, filed into a database that was created moments earlier.
 *
 * This is the most fragile thing GemDB does. The CPython shim is compiled
 * against one engine version and links `gciualib.o` from it, so moving
 * `PINNED_ENGINE_VERSION` without rebuilding the payload produces something
 * that installs cleanly and then fails at `import`. Nothing cheaper than a real
 * file-in catches that.
 *
 * The generous timeout below is headroom, not a measurement: the whole file
 * takes about seven seconds on an M-series Mac, but it files in several hundred
 * `.gs` files and has no reason to be that quick on slower disks.
 *
 * Separate file from database.test.ts so the fast database checks stay fast:
 * with `fileParallelism: false` these run one after the other, each against its
 * own temporary root path.
 */

const extensionPath = process.cwd();

// Not a source file — `grail/` is a build artifact from `npm run bundle:grail`,
// gitignored, and absent in a fresh checkout. No payload, nothing to test.
const havePayload = bundledGrailStamp(extensionPath) !== undefined;

let fixture: Fixture | undefined;

beforeAll(async () => {
  if (!havePayload) return;
  fixture = makeFixture();
  if (!fixture) return;

  if (!(await isSharedMemoryConfigured())) {
    throw new Error(
      'Shared memory is below what the engine needs. Run "GemDB: Configure Shared Memory" ' +
        'in the editor, or resources/setSharedMemoryDarwin.sh, before running these tests.',
    );
  }

  createDatabase(fixture.engine);
  await startStone();
  await startNetldi();
});

afterAll(async () => {
  if (!fixture) return;
  logout();
  try {
    await stopNetldi();
    if (isRunning()) await stopStone(true);
  } finally {
    fixture.remove();
  }
});

describe.skipIf(!havePayload || !canMakeFixture())('Grail in a real database', () => {
  it('stages the payload out of the extension', () => {
    stageGrail(extensionPath);
    expect(grailStagedOnDisk()).toBe(true);
    // Staged is not installed. The stamp is what says Grail is in the database,
    // and nothing has put it there yet.
    expect(grailInstalled()).toBe(false);
  });

  it('files Grail into the database', async () => {
    expect(isGrailInstalled()).toBe(false);

    await installGrail(extensionPath, { report: () => {} });
    recordGrailInstalled(extensionPath);

    // The installer streams to the log rather than throwing on a failed
    // file-in, so a bare "expected true to be false" here would say nothing
    // about why. Hand the tail to whoever has to read the failure.
    expect(isGrailInstalled(), installLog()).toBe(true);
    expect(grailInstalled()).toBe(true);
  }, 600_000);

  it('runs Python through the shim', async () => {
    // The assertion that matters is not the arithmetic. Evaluating any Python
    // at all means the CPython shim loaded and linked against this engine —
    // the failure mode a version bump without a payload rebuild produces.
    const result = await runPythonOnce('1 + 1');
    expect(isErrorResult(result.value)).toBe(false);
    expect(result.value).toBe('2');
  });

  it('keeps globals within a scope, and apart between scopes', async () => {
    // What a notebook depends on: one cell's assignment visible to the next,
    // and two notebooks not seeing each other's variables.
    await runPython('x = 41', 'notebook-a');
    expect((await runPython('x + 1', 'notebook-a')).value).toBe('42');
    expect(isErrorResult((await runPython('x', 'notebook-b')).value)).toBe(true);
  });

  it('reports a Python error as an error rather than a result', async () => {
    const result = await runPython('1 / 0', 'notebook-a');
    expect(isErrorResult(result.value)).toBe(true);
  });

  it('returns what print() wrote — the output that vanished over RPC before', async () => {
    // Grail routes print() through Transcript; over an RPC session that went to
    // the gem's log until the query layer began capturing it per evaluation.
    // (Grail's print writes a space after every argument, hence '7 '.)
    const result = await runPythonOnce('print(7)');
    expect(result.output).toBe('7 \n');
    expect(result.value).toBe('');
  });

  it('delivers output printed before an error, alongside the error', async () => {
    const result = await runPython('print("before")\n1 / 0', 'notebook-a');
    expect(result.output).toContain('before');
    expect(isErrorResult(result.value)).toBe(true);
  });

  it('suppresses None, the way a REPL and a notebook both should', async () => {
    expect((await runPythonOnce('None')).value).toBe('');
  });

  it('runs two sessions concurrently, and an interrupt ends one of them', async () => {
    // Two logins, like two REPL terminals. Session A grinds through a loop big
    // enough to outlast this test; session B computes while A is still busy.
    // Then a break — the Ctrl+C path — ends A early with an error, not a hang.
    const a = GciSession.login('it-repl-a');
    const b = GciSession.login('it-repl-b');
    try {
      const slow = runPythonInSession(a, 'i = 0\nwhile i < 10**9:\n    i = i + 1', 'ra');
      let slowSettled = false;
      void slow.finally(() => {
        slowSettled = true;
      });

      const quick = await runPythonInSession(b, '6 * 7', 'rb');
      expect(quick.value).toBe('42');
      expect(slowSettled).toBe(false); // B finished while A was still running

      a.interrupt();
      const ended = await slow;
      expect(isErrorResult(ended.value)).toBe(true);
    } finally {
      a.logout();
      b.logout();
    }
  }, 120_000);
});

/** The last of what the installer printed, for a failure that needs explaining. */
function installLog(): string {
  return `Grail install log, last 40 lines:\n${__log.slice(-40).join('\n')}`;
}

/** Whether a fixture can be built, answered during collection. See database.test.ts. */
function canMakeFixture(): boolean {
  const probe = makeFixture();
  probe?.remove();
  return probe !== undefined;
}
