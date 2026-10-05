import * as fs from 'fs';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STONE_NAME } from '../config';
import { FREE_SPACE_THRESHOLD_MB, REPOSITORY_LIMIT_MB } from '../database';
import { stageGrail } from '../grail';
import {
  collectGarbage,
  databaseSessions,
  parseSpaceReading,
  setFreeSpaceThreshold,
  stopDatabaseSession,
} from '../maintenance';
import { databaseLogPath, extentPath } from '../paths';
import { isRunning, startNetldi, startStone, stopNetldi, stopStone } from '../processes';
import { isErrorResult, runPython } from '../pythonQueries';
import { SessionOwner, closeSessionFor, execute, logoutAll, sessionForIfOpen } from '../session';
import {
  createDatabaseWithPython,
  Fixture,
  haveTestExtent,
  makeFixture,
  TEST_CAP_MB,
} from './fixture';

/**
 * The space limits and the maintenance that keeps the database inside them,
 * against a real stone.
 *
 * What the unit suite cannot say: that the stone takes the limits from the
 * configuration GemDB writes, that aborting an idle notebook really loses
 * nothing, and — the one the whole design rests on — that a collection's
 * garbage is reclaimed only once idle sessions are aborted, so a collection
 * that did not sweep them would wait forever.
 */

const ext = process.cwd();
const haveExtent = haveTestExtent();

const notebook = (name: string): SessionOwner => ({
  key: `file:///${name}.ipynb`,
  kind: 'notebook',
  label: `${name}.ipynb`,
});

const A = notebook('space-a');
const B = notebook('space-b');
const C = notebook('space-c');
const J = notebook('space-junk');

const hooks = { changed: () => {}, committedOrAborted: () => {} };

const SPACE =
  "(SystemRepository freeSpace // 1048576) printString, ' ', " +
  '(SystemRepository fileSize // 1048576) printString';

let fixture: Fixture | undefined;

beforeAll(async () => {
  if (!haveExtent) return;
  fixture = makeFixture();
  if (!fixture) return;
  createDatabaseWithPython(fixture);
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

/** Whether a session has left the stone's list within half a minute. */
async function gone(id: number): Promise<boolean> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (!databaseSessions().some((s) => s.id === id)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

/** See database.test.ts — skipIf is evaluated during collection. */
function canMakeFixture(): boolean {
  const probe = makeFixture();
  if (!probe) return false;
  probe.remove();
  return true;
}

describe.skipIf(!haveExtent || !canMakeFixture())('the space limits', () => {
  it('caps the extent, and reserves the cap on disk', async () => {
    const log = fs.readFileSync(path.join(databaseLogPath(), `${STONE_NAME}.log`), 'utf-8');
    // The pregrow runs after the stone has started.
    const deadline = Date.now() + 30_000;
    while (fs.statSync(extentPath()).size < TEST_CAP_MB * 1048576 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    expect(log).toContain(`to ${TEST_CAP_MB} MB for extent`);
    expect(fs.statSync(extentPath()).size).toBe(TEST_CAP_MB * 1048576);
  });

  it("caps a user's database at exactly what the license allows", () => {
    // The suite runs on a smaller cap to save disk, so the 10 GB figure is
    // held to the key instead: a new engine whose key changes the limit fails
    // here rather than at a user's 8 or 12 GB.
    const key = fs.readFileSync(
      path.join(fixture!.engine, 'sys', 'community.starter.key'),
      'utf-8',
    );

    expect(key).toMatch(new RegExp(`Repository size limit:\\s*${REPOSITORY_LIMIT_MB} MB`));
  });

  it('leaves collecting garbage to DataCurator: the gemdb account may not', () => {
    expect(() => execute("SystemRepository markForCollection. 'marked'")).toThrow(
      /2151|privilege/i,
    );
  });

  it('keeps the threshold free from the start, by growing the extent', () => {
    const reading = parseSpaceReading(execute(SPACE));

    expect(reading?.freeMb).toBeGreaterThanOrEqual(FREE_SPACE_THRESHOLD_MB);
    expect(
      Number(execute('(System stoneConfigurationAt: #StnFreeSpaceThreshold) printString')),
    ).toBe(FREE_SPACE_THRESHOLD_MB);
  });

  it('lets SystemUser change the threshold, and change it back', () => {
    setFreeSpaceThreshold(400);
    const lowered = execute('(System stoneConfigurationAt: #StnFreeSpaceThreshold) printString');
    setFreeSpaceThreshold(FREE_SPACE_THRESHOLD_MB);

    expect(lowered).toBe('400');
    expect(execute('(System stoneConfigurationAt: #StnFreeSpaceThreshold) printString')).toBe(
      String(FREE_SPACE_THRESHOLD_MB),
    );
  });
});

describe.skipIf(!haveExtent || !canMakeFixture())('idle sessions', () => {
  it('aborts an idle notebook with nothing to commit, keeping its variables', async () => {
    await runPython('kept = 41', A);
    const session = sessionForIfOpen(A.key);

    const outcome = session?.abortIfClean();

    expect(outcome).toBe('aborted');
    expect((await runPython('kept + 1', A)).value).toBe('42');
  });

  it('does not count the abort as using the notebook', async () => {
    await runPython('1', A);
    const session = sessionForIfOpen(A.key);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const before = session?.idleMs ?? 0;

    session?.abortIfClean();

    expect(session?.idleMs).toBeGreaterThanOrEqual(before);
  });

  it('leaves a notebook with uncommitted changes alone', async () => {
    await runPython('import gemdb\ngemdb.root["it_space_dirty"] = 1', A);
    const session = sessionForIfOpen(A.key);

    const outcome = session?.abortIfClean();

    expect(outcome).toBe('dirty');
    expect((await runPython('gemdb.needs_commit()', A)).value).toBe('True');
    await runPython('gemdb.abort()', A);
  });
});

describe.skipIf(!haveExtent || !canMakeFixture())('collecting garbage', () => {
  it('reclaims what a collection finds, though another notebook sits idle', async () => {
    // B takes its view before the garbage exists and then does nothing: in
    // autoBegin it holds that view until it commits or aborts, and the
    // garbage waits on its vote. The collection's sweep is what lets it go.
    //
    // The garbage comes from a notebook that is then closed, the usual way
    // data a notebook built stops mattering.
    await runPython('1', B);
    await runPython(
      'import gemdb\ngemdb.root["it_space_junk"] = [str(i) * 100 for i in range(50000)]\ngemdb.commit()',
      J,
    );
    await runPython('del gemdb.root["it_space_junk"]\ngemdb.commit()', J);
    closeSessionFor(J.key);

    const outcome = await collectGarbage('command', hooks);

    // The mark's object count is exact, so it can say the collection found
    // this garbage: 50,000 strings and the list that held them. ('done'
    // itself says the vote finished, idle notebook and all.)
    expect(outcome.kind).toBe('done');
    expect(outcome.kind === 'done' && (outcome.record.dead ?? 0)).toBeGreaterThanOrEqual(50_001);
    expect(outcome.kind === 'done' && (outcome.record.freedMb ?? 0)).toBeGreaterThan(0);
    // Up to a minute of that is the SymbolGem's view moving past the reclaim.
  }, 240_000);

  it('logs its own session out afterwards', async () => {
    await collectGarbage('command', hooks);

    expect(sessionForIfOpen('__garbage_collection__')).toBeUndefined();
  });
});

describe.skipIf(!haveExtent || !canMakeFixture())('the sessions on the stone', () => {
  it("names GemDB's sessions and tells the stone's own gems apart", async () => {
    await runPython('1', C);

    const sessions = databaseSessions();

    expect(sessions.find((s) => s.name === 'GemDB nb space-c')?.system).toBe(false);
    expect(sessions.filter((s) => s.system).map((s) => s.user)).toEqual(
      expect.arrayContaining(['GcUser', 'SymbolUser']),
    );
  });

  it('stops a session from another, and the notebook logs in afresh after saying so', async () => {
    await runPython('lost = 1', C);
    const serial = sessionForIfOpen(C.key)?.serial ?? -1;

    stopDatabaseSession(serial);

    // The stone takes a moment to end it: two seconds, measured.
    expect(await gone(serial)).toBe(true);
    await expect(runPython('1', C)).rejects.toThrow(/forcibly terminated/);
    expect(isErrorResult((await runPython('lost', C)).value)).toBe(true);
  });
});
