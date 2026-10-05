import * as fs from 'fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stageGrail } from '../grail';
import { adminAccount } from '../config';
import { collectGarbage, parseSpaceReading } from '../maintenance';
import { extentPath } from '../paths';
import { isRunning, startNetldi, startStone, stopNetldi, stopStone } from '../processes';
import { runPython } from '../pythonQueries';
import { GciSession, SessionOwner, execute, logoutAll } from '../session';
import {
  createDatabaseWithPython,
  Fixture,
  haveTestExtent,
  limitTestDatabase,
  makeFixture,
} from './fixture';

/**
 * A database that has run below its free-space threshold, and the way back.
 *
 * Below the threshold the stone suspends reclaim (measured, and the reason
 * maintenance collects long before it), so a collection there finds garbage
 * and frees none of it — unless the threshold is lowered for the duration,
 * which is what `collectGarbage` does as SystemUser. This file gets there the
 * honest way, by filling a database, so the cap is shrunk to a few hundred
 * megabytes rather than filling ten gigabytes. `gemdb.conf` is read after
 * `system.conf`, so these values override the license-sized ones GemDB wrote.
 */

const ext = process.cwd();
const haveExtent = haveTestExtent();

const THRESHOLD_MB = 64;
const M: SessionOwner = {
  key: 'file:///space-full-new.ipynb',
  kind: 'notebook',
  label: 'space-full-new.ipynb',
};
const N: SessionOwner = {
  key: 'file:///space-full.ipynb',
  kind: 'notebook',
  label: 'space-full.ipynb',
};
const hooks = { changed: () => {}, committedOrAborted: () => {} };

const SPACE =
  "(SystemRepository freeSpace // 1048576) printString, ' ', " +
  '(SystemRepository fileSize // 1048576) printString';

/**
 * Commit random bytes until free space is under half the threshold. Random,
 * because zero-filled objects were measured to take almost no room. Error
 * 2338, the stone's notice that it is below its threshold, arrives in the
 * middle of whatever runs, and is resumed past.
 */
const FILL = `| junk rnd proto |
[junk := UserGlobals at: #ItJunk put: Array new.
 rnd := Random new.
 proto := ByteArray new: 100000.
 1 to: proto size do: [:k | proto at: k put: (rnd integerBetween: 0 and: 255)].
 [(SystemRepository freeSpace // 1048576) >= ${THRESHOLD_MB / 2}] whileTrue: [
   1 to: 40 do: [:j | | b | b := proto copy. b at: 1 put: j \\\\ 256. junk add: b].
   System commitTransaction]]
  on: Error do: [:e | e number = 2338 ifTrue: [e resume: nil] ifFalse: [e pass]].
'filled'`;

let fixture: Fixture | undefined;

beforeAll(async () => {
  if (!haveExtent) return;
  fixture = makeFixture();
  if (!fixture) return;
  createDatabaseWithPython(fixture);
  const extentMb = fs.statSync(extentPath()).size / 1048576;
  limitTestDatabase(Math.ceil((extentMb + 192) / 16) * 16, THRESHOLD_MB);
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

describe.skipIf(!haveExtent || !canMakeFixture())('below the free-space threshold', () => {
  it('fills to below the threshold', async () => {
    // Logged in before the crossing, as an open window's sessions are: below
    // the threshold the gemdb account gets no new ones.
    await runPython('waiting = True', N);
    execute("'GemDB is logged in'");
    // As DataCurator, in a session of its own: only an administrator can keep
    // committing past the threshold. A gemdb session that needs space there is
    // stopped instead (measured), which is the account doing its job.
    const filler = GciSession.login(
      { key: 'filler', kind: 'extension', label: 'filler' },
      adminAccount(),
    );

    filler.execute(FILL);
    filler.execute("UserGlobals removeKey: #ItJunk. System commitTransaction. 'removed'");
    filler.logout();

    expect(parseSpaceReading(execute(SPACE))?.freeMb).toBeLessThan(THRESHOLD_MB);
  });

  it('lets an open notebook carry on, so its work can be committed', async () => {
    // The gemdb account gets no notice of the crossing (measured): the
    // warning is GemDB's to give (maintenance.ts).
    expect((await runPython('ran = 1 + 1\nran', N)).value).toBe('2');
  });

  it('refuses a new notebook, saying the database is full', async () => {
    await expect(runPython('1', M)).rejects.toThrow(/database is full.*not opening new sessions/);
  });

  it('collects garbage there by lowering the threshold, and puts it back', async () => {
    const before = parseSpaceReading(execute(SPACE));

    const outcome = await collectGarbage('command', hooks);

    expect(outcome.kind === 'failed' ? outcome.message : 'done').toBe('done');
    const after = parseSpaceReading(execute(SPACE));
    expect(after?.freeMb).toBeGreaterThan((before?.freeMb ?? 0) + THRESHOLD_MB);
    expect(execute('(System stoneConfigurationAt: #StnFreeSpaceThreshold) printString')).toBe(
      String(THRESHOLD_MB),
    );
  });

  it('opens new notebooks again once there is room', async () => {
    // The stone re-checks the threshold on its own clock: seconds, measured.
    const deadline = Date.now() + 30_000;
    let answer: string | undefined;
    while (answer === undefined && Date.now() < deadline) {
      answer = await runPython('1 + 1', M).then(
        (result) => result.value,
        () => undefined,
      );
      if (answer === undefined) await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    expect(answer).toBe('2');
  });
});
