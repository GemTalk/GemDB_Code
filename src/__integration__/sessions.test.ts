import * as fs from 'fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../database';
import { stageGrail } from '../grail';
import { bundledExtentPath } from '../paths';
import { isRunning, startNetldi, startStone, stopNetldi, stopStone } from '../processes';
import { isErrorResult, runPython } from '../pythonQueries';
import { SessionOwner, logoutAll, sessionRegistry } from '../session';
import { Fixture, makeFixture } from './fixture';

/**
 * A session per notebook, and what that buys.
 *
 * Every other notebook tool works this way — VS Code's Jupyter extension
 * starts a kernel per notebook — but here the reason is stronger than
 * convention: a session is a unit of work. Sharing one would mean a commit in
 * one notebook commits another's half-finished changes, and
 * `gemdb.transaction()` refusing to start because a notebook the user is not
 * looking at left the session dirty. These tests are what says that is not
 * happening, against a real database rather than a mock.
 */

const ext = process.cwd();
const havePreloaded = fs.existsSync(bundledExtentPath(ext));

const notebook = (name: string): SessionOwner => ({
  key: `file:///${name}.ipynb`,
  kind: 'notebook',
  label: `${name}.ipynb`,
});

const A = notebook('one');
const B = notebook('two');

let fixture: Fixture | undefined;

beforeAll(async () => {
  if (!havePreloaded) return;
  fixture = makeFixture();
  if (!fixture) return;
  createDatabase(fixture.engine, ext);
  stageGrail(ext);
  await startStone();
  await startNetldi();
});

afterAll(async () => {
  if (!fixture) return;
  logoutAll();
  try {
    await stopNetldi();
  } finally {
    if (isRunning()) await stopStone(true);
    fixture.remove();
  }
});

/** See database.test.ts — skipIf is evaluated during collection. */
function canMakeFixture(): boolean {
  const probe = makeFixture();
  if (!probe) return false;
  probe.remove();
  return true;
}

describe.skipIf(!havePreloaded || !canMakeFixture())('a session per notebook', () => {
  it('logs in a separate session for each notebook', async () => {
    await runPython('1', A);
    await runPython('1', B);

    const held = sessionRegistry();
    const byKey = new Map(held.map((s) => [s.owner.key, s]));
    expect(byKey.has(A.key)).toBe(true);
    expect(byKey.has(B.key)).toBe(true);

    // The serials are what makes a session findable from the database side —
    // `gemdb.sessions.all()` reports the same numbers — so they must be there
    // and they must differ.
    const a = byKey.get(A.key)?.serial;
    const b = byKey.get(B.key)?.serial;
    expect(typeof a).toBe('number');
    expect(typeof b).toBe('number');
    expect(a).not.toBe(b);
  });

  it('reports which session each notebook owns, and how long it has been idle', async () => {
    await runPython('1', A);
    const held = sessionRegistry();

    expect(held.map((s) => s.owner.label).sort()).toContain('one.ipynb');
    // Sorted idlest-first: that ordering is what the limit message and the
    // status view both rely on to name the session worth closing.
    for (let i = 1; i < held.length; i++) {
      expect(held[i - 1].idleMs).toBeGreaterThanOrEqual(held[i].idleMs);
    }
    // The one just used is the least idle.
    expect(held[held.length - 1].owner.key).toBe(A.key);
  });

  it('keeps one notebook’s variables out of another', async () => {
    await runPython('x = 41', A);
    expect((await runPython('x + 1', A)).value).toBe('42');

    const seen = await runPython('x', B);
    expect(isErrorResult(seen.value)).toBe(true);
    expect(seen.value).toContain('NameError');
  });

  it('gives each notebook its own transaction', async () => {
    // A writes without committing. Under one shared session B would see it,
    // and — worse — B's own transaction() would refuse to start.
    await runPython('import gemdb\ngemdb.root["it_sessions"] = 1', A);
    expect((await runPython('import gemdb\ngemdb.needs_commit()', A)).value).toBe('True');

    expect((await runPython('import gemdb\ngemdb.needs_commit()', B)).value).toBe('False');
    expect((await runPython('"it_sessions" in gemdb.root', B)).value).toBe('False');

    // A commits; B still holds its own view until it refreshes, which is
    // ordinary database behaviour and worth pinning.
    await runPython('gemdb.commit()', A);
    expect((await runPython('"it_sessions" in gemdb.root', B)).value).toBe('False');
    expect((await runPython('gemdb.refresh()\n"it_sessions" in gemdb.root', B)).value).toBe('True');

    await runPython('gemdb.root.pop("it_sessions")\ngemdb.commit()', A);
  });

  it('lets a notebook run a transaction block while another is dirty', async () => {
    // The case that shared sessions made impossible: B's entry check asks
    // whether *its* session has pending changes, and A's do not count.
    await runPython('import gemdb\ngemdb.root["it_dirty"] = 1', A);

    const inB = await runPython(
      'import gemdb\n' +
        'with gemdb.transaction():\n' +
        '    gemdb.root["it_txn"] = 7\n' +
        'v = gemdb.root.pop("it_txn")\n' +
        'gemdb.commit()\n' +
        'v',
      B,
    );
    expect(isErrorResult(inB.value)).toBe(false);
    expect(inB.value).toBe('7');

    await runPython('gemdb.abort()', A);
  });
});
