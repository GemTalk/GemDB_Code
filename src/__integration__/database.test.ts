import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../database';
import { isSharedMemoryConfigured } from '../osConfig';
import { databaseExists } from '../paths';
import {
  findNetldi,
  findStone,
  isListening,
  isRunning,
  listProcesses,
  startNetldi,
  startStone,
  stopNetldi,
  stopStone,
} from '../processes';
import { execute, isConnected, logout } from '../session';
import { Fixture, makeFixture } from './fixture';

/**
 * The parts of GemDB that are only interesting against a real database.
 *
 * These do not run with `npm test`. They start processes that detach from the
 * runner and outlive it, they take seconds rather than milliseconds, and they
 * need an engine on disk — so they are their own command, `npm run
 * test:integration`, and they skip themselves when there is no engine to
 * borrow.
 *
 * The tests are one sequence rather than independent cases, because a database
 * is a sequence: it is created, started, logged into, and stopped, and each
 * step is the setup for the next. Vitest runs a file's tests in order, and this
 * file depends on that.
 */

let fixture: Fixture | undefined;

beforeAll(async () => {
  fixture = makeFixture();
  if (!fixture) return;

  // Not something the fixture can arrange for itself: it needs root, and asking
  // for a password from a test runner is not on. Fail loudly rather than let
  // startstone fail with a message about segment allocation.
  if (!(await isSharedMemoryConfigured())) {
    throw new Error(
      'Shared memory is below what the engine needs. Run "GemDB: Configure Shared Memory" ' +
        'in the editor, or resources/setSharedMemoryDarwin.sh, before running these tests.',
    );
  }
});

afterAll(async () => {
  if (!fixture) return;
  // Force, because a test that failed part way through may have left a session
  // logged in — and a leaked stone would sit on this machine's shared memory
  // until someone noticed.
  logout();
  try {
    if (isListening()) await stopNetldi();
    if (isRunning()) await stopStone(true);
  } finally {
    fixture.remove();
  }
});

describe.skipIf(!makeFixtureIsPossible())('a real database', () => {
  it('creates a database from the engine, and says what it did', () => {
    // What it did, not what the extension ships: whether Grail may be recorded
    // as filed in turns on this call having made the database from the shipped
    // extent. Passing no extension path here means the engine's own extent, so
    // Grail is not in it and `preloaded` must say so.
    const made = createDatabase(fixture!.engine);
    expect(databaseExists()).toBe(true);
    expect(made).toEqual({ created: true, preloaded: false });

    // Second call finds it already there and creates nothing — the state an
    // upgrade arrives in, where stamping the bundled Grail would be a lie
    // about a database that was filed in by some earlier version.
    expect(createDatabase(fixture!.engine)).toEqual({ created: false, preloaded: false });
  });

  it('starts, and reports itself through gslist', async () => {
    await startStone();
    await startNetldi();

    const processes = listProcesses();
    expect(findStone(processes)?.name).toBe('gemdb');
    expect(findNetldi(processes)?.name).toBe('gemdbldi');
    expect(isRunning(processes)).toBe(true);
    expect(isListening(processes)).toBe(true);

    // The listener takes whatever port it is given, and the session builds its
    // NRS string from what gslist reports. A missing port here is the failure
    // that would otherwise surface as an unexplained login error.
    expect(findNetldi(processes)?.port).toBeGreaterThan(0);
  });

  it('runs Smalltalk through a GCI session', () => {
    // Deliberately not Python: this asserts the login path — the GCI library,
    // the NRS string, the account in config.ts — without also depending on
    // Grail having been filed in.
    //
    // `printString`, not `3 + 4`: the result is fetched with `encodeAsUTF8`,
    // which a SmallInteger does not understand. Everything sent through this
    // path has to evaluate to a String.
    expect(execute('(3 + 4) printString')).toBe('7');
    expect(isConnected()).toBe(true);
  });

  it('refuses an unforced stop while a session is logged in', async () => {
    expect(isConnected()).toBe(true);
    await expect(stopStone(false)).rejects.toThrow();
    expect(isRunning()).toBe(true);
  });

  it('stops when forced, disconnecting the session', async () => {
    await stopStone(true);
    expect(isRunning()).toBe(false);
  });

  it('stops cleanly once nothing is logged in', async () => {
    logout();
    await startStone();
    expect(isRunning()).toBe(true);

    await stopStone(false);
    expect(isRunning()).toBe(false);
  });
});

/**
 * Whether the suite can run at all, answered before the fixture is built.
 *
 * `describe.skipIf` is evaluated while tests are being collected, which is
 * before `beforeAll` has run — so this makes and discards a fixture purely to
 * find out whether an engine is there.
 */
function makeFixtureIsPossible(): boolean {
  const probe = makeFixture();
  probe?.remove();
  return probe !== undefined;
}
