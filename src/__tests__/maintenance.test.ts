import { afterEach, describe, expect, it } from 'vitest';
import { __resetSettings, __setSetting } from '../__mocks__/vscode';
import {
  DEFAULT_ABORT_IDLE_MINUTES,
  abortIdleSessionsAfterMinutes,
  garbageCollectionIntervalHours,
} from '../config';
import {
  DatabaseSession,
  GC_HEADROOM_MB,
  QUIET_MS,
  SPACE_GC_SPACING_MS,
  LAST_CALL_MS,
  describeFound,
  formatMb,
  gcDue,
  isBelowThreshold,
  isFull,
  nextFullState,
  parseMfcReport,
  parseSessions,
  parseSpaceReading,
  roomLeftMb,
  stoppableSessions,
  thresholdToReclaimUnder,
  usedMb,
  viewsNewerThanQuery,
} from '../maintenance';
import { spaceRow } from '../statusView';

/**
 * When GemDB collects garbage, and what it reads from the database to decide,
 * without a database.
 *
 * The figures are the measured ones (docs/repository-space.md): a new
 * database's extent is 560 MB with 500 MB free, because the stone grows the
 * extent ahead of demand to keep its threshold free; and below the threshold
 * the reclaim gem stops, so collecting must start well before it.
 */

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;

/** A new database: the stock extent's contents plus the 500 MB the stone keeps free. */
const fresh = { freeMb: 500, fileMb: 560 };
/** At the cap with the threshold crossed: what the stone refuses to reclaim in. */
const full = { freeMb: 300, fileMb: 10240 };

describe('the space reading', () => {
  it('counts room the extent can still grow into', () => {
    expect(roomLeftMb(fresh)).toBe(10240 - 560 + 500);
    expect(usedMb(fresh)).toBe(60);
  });

  it('counts only what is free once the extent is at the cap', () => {
    expect(roomLeftMb(full)).toBe(300);
  });

  it('reads the query’s answer, and nothing else', () => {
    expect(parseSpaceReading('500 560')).toEqual(fresh);
    expect(parseSpaceReading('300 10240 500')).toEqual({ ...full, thresholdMb: 500 });
    expect(parseSpaceReading('a MessageNotUnderstood occurred')).toBeUndefined();
  });

  it('formats sizes the way the status view shows them', () => {
    expect(formatMb(320)).toBe('320 MB');
    expect(formatMb(10240)).toBe('10 GB');
    expect(formatMb(1434)).toBe('1.4 GB');
  });
});

describe('when to collect garbage', () => {
  const due = (over: Partial<Parameters<typeof gcDue>[0]>) =>
    gcDue({
      reading: fresh,
      lastGcAt: NOW - HOUR,
      now: NOW,
      intervalHours: 24,
      quietMs: QUIET_MS,
      ...over,
    });

  it('waits for the schedule while there is room', () => {
    expect(due({})).toBeUndefined();
    expect(due({ lastGcAt: NOW - 25 * HOUR })).toBe('schedule');
  });

  it('does not collect on schedule while someone is working', () => {
    expect(due({ lastGcAt: NOW - 25 * HOUR, quietMs: 60_000 })).toBeUndefined();
  });

  it('collects when room runs short, busy or not', () => {
    const short = { freeMb: 100, fileMb: 10240 - GC_HEADROOM_MB + 500 };

    expect(due({ reading: short, quietMs: 0 })).toBe('space');
  });

  it('does not collect for space again within the hour', () => {
    // Live data does not get smaller by being traversed every five minutes.
    expect(due({ reading: full, lastGcAt: NOW - SPACE_GC_SPACING_MS + 1 })).toBeUndefined();
    expect(due({ reading: full, lastGcAt: NOW - SPACE_GC_SPACING_MS })).toBe('space');
  });

  it('collects a database that has never been collected, once quiet', () => {
    expect(due({ lastGcAt: undefined })).toBe('schedule');
  });

  it('collects only for space when the schedule is off', () => {
    expect(due({ intervalHours: 0, lastGcAt: NOW - 1000 * HOUR })).toBeUndefined();
    expect(due({ intervalHours: 0, reading: full })).toBe('space');
  });
});

describe('getting reclaim going again', () => {
  it('lowers the threshold under what is free', () => {
    expect(thresholdToReclaimUnder(300)).toBe(150);
  });

  it('never sets 0, which the stone reads as a fraction of the repository', () => {
    expect(thresholdToReclaimUnder(1)).toBe(1);
    expect(thresholdToReclaimUnder(0)).toBe(1);
  });
});

describe('waiting for reclaim to give pages back', () => {
  it('waits for every view to be newer than the reclaim, from slot 5', () => {
    const query = viewsNewerThanQuery(1791210000.7);

    // Slot 5 is when a session last began, committed or aborted; the
    // SymbolGem's moves only about once a minute, and the pages wait for it.
    expect(query).toContain('System currentSessions allSatisfy:');
    expect(query).toContain('(System descriptionOfSession: id) at: 5');
    expect(query).toContain('t > 1791210000]');
    // Its own view must not be the one that is old.
    expect(query.startsWith('System abortTransaction.')).toBe(true);
  });
});

describe('what a collection reports', () => {
  it('reads the counts from markForCollection’s report', () => {
    // Verbatim from 4.0.0.a4.
    const report =
      'markForCollection found 157318 live objects, 8002 dead objects(occupying approx 720180 bytes), 0 possibleDeadSymbols';

    expect(parseMfcReport(report)).toEqual({ live: 157318, dead: 8002 });
  });

  it('leaves out what it does not say', () => {
    expect(parseMfcReport('the repository is busy')).toEqual({
      live: undefined,
      dead: undefined,
    });
  });

  it('says what it found, in words', () => {
    expect(describeFound({ live: 157318, dead: 8002 })).toBe(
      '8,002 dead objects among 157,318 live',
    );
    expect(describeFound({})).toBe('');
  });
});

describe('the sessions on the stone', () => {
  const answer = [
    '2\tGcUser\tGcReclaim\t40\ttrue\t0\ttrue',
    '3\tSymbolUser\tSymbolGem\t40\ttrue\t0\ttrue',
    '4\tDataCurator\tGemDB nb analysis\t7200\ttrue\t34\tfalse',
    '5\tDataCurator\tGemDB Code\t5\tfalse\t0\tfalse',
    '6\tDataCurator\t\t600\tfalse\t3\tfalse',
    '',
  ].join('\n');

  it('reads every row', () => {
    const sessions = parseSessions(answer);

    expect(sessions).toHaveLength(5);
    expect(sessions[2]).toEqual<DatabaseSession>({
      id: 4,
      user: 'DataCurator',
      name: 'GemDB nb analysis',
      viewAgeSeconds: 7200,
      holdsOldest: true,
      behind: 34,
      system: false,
    });
  });

  it('skips what is not a row', () => {
    expect(parseSessions('a MessageNotUnderstood occurred')).toEqual([]);
  });

  it('never offers the stone’s own gems, or the window’s own administrative session', () => {
    const offered = stoppableSessions(parseSessions(answer), [5]).map((s) => s.id);

    expect(offered).toEqual([4, 6]);
  });

  it('puts the session holding garbage back first', () => {
    const sessions = parseSessions(answer).map((s) =>
      s.id === 4 ? { ...s, holdsOldest: false } : s,
    );
    const reordered = [...sessions, { ...sessions[4], id: 7, holdsOldest: true, behind: 1 }];

    expect(stoppableSessions(reordered, [5]).map((s) => s.id)).toEqual([7, 4, 6]);
  });
});

describe('the Space row', () => {
  it('is not shown before anything has been read', () => {
    expect(spaceRow({ reading: undefined, record: undefined, collecting: false })).toBeUndefined();
  });

  it('says how much is used of the license', () => {
    const row = spaceRow({ reading: fresh, record: undefined, collecting: false });

    expect(row?.description).toBe('60 MB of 10 GB used');
    expect(row?.tooltip).toContain('Garbage has not been collected yet.');
    expect(row?.command?.command).toBe('gemdb.collectGarbage');
  });

  it('says how much is left, and warns, once room is short', () => {
    const row = spaceRow({ reading: full, record: undefined, collecting: false });

    expect(row?.description).toBe('300 MB left of 10 GB');
    expect(row?.icon?.id).toBe('warning');
  });

  it('says when garbage was last collected, and what it gave back', () => {
    const row = spaceRow({
      reading: fresh,
      record: {
        at: NOW - 2 * HOUR,
        reason: 'schedule',
        dead: 10,
        live: 2000,
        freedMb: 64,
      },
      collecting: false,
      now: NOW,
    });

    expect(row?.tooltip).toContain(
      'last collected 2 h ago, finding 10 dead objects among 2,000 live, giving back 64 MB.',
    );
  });

  it('shows a collection in progress, and offers no second one', () => {
    const row = spaceRow({ reading: fresh, record: undefined, collecting: true });

    expect(row?.description).toBe('collecting garbage…');
    expect(row?.command).toBeUndefined();
  });
});

describe('the maintenance settings', () => {
  afterEach(() => __resetSettings());

  it('reads a number', () => {
    __setSetting('gemdb.maintenance.abortIdleSessionsAfterMinutes', 30);
    __setSetting('gemdb.maintenance.garbageCollectionIntervalHours', 0);

    expect(abortIdleSessionsAfterMinutes()).toBe(30);
    expect(garbageCollectionIntervalHours()).toBe(0);
  });

  it('reads the string the GemDB Shell gets from its environment', () => {
    __setSetting('gemdb.maintenance.abortIdleSessionsAfterMinutes', '15');

    expect(abortIdleSessionsAfterMinutes()).toBe(15);
  });

  it('falls back on a value that cannot mean anything, rather than on "always"', () => {
    for (const value of [-5, 'soon', null]) {
      __setSetting('gemdb.maintenance.abortIdleSessionsAfterMinutes', value);
      expect(abortIdleSessionsAfterMinutes()).toBe(DEFAULT_ABORT_IDLE_MINUTES);
    }
  });
});

describe('the free-space threshold', () => {
  it('is crossed when free space is under it, whatever the cap', () => {
    expect(isBelowThreshold({ freeMb: 21, fileMb: 256, thresholdMb: 64 })).toBe(true);
    expect(isBelowThreshold({ freeMb: 191, fileMb: 256, thresholdMb: 64 })).toBe(false);
  });

  it("reads 0 as the stone's default: a tenth of a percent, at least 5 MB", () => {
    expect(isBelowThreshold({ freeMb: 4, fileMb: 256, thresholdMb: 0 })).toBe(true);
    expect(isBelowThreshold({ freeMb: 9, fileMb: 10240, thresholdMb: 0 })).toBe(true);
    expect(isBelowThreshold({ freeMb: 11, fileMb: 10240, thresholdMb: 0 })).toBe(false);
  });

  it('is never taken to be crossed by a reading that did not ask', () => {
    expect(isBelowThreshold({ freeMb: 0, fileMb: 10240 })).toBe(false);
  });
});

describe('telling the user the database is full', () => {
  const above = { lastCall: false };

  it('says so the moment the threshold is crossed', () => {
    const { state, notice } = nextFullState(above, true, NOW);

    expect(notice).toBe('full');
    expect(state.since).toBe(NOW);
  });

  it('says nothing more until the last call, two minutes in', () => {
    const crossed = nextFullState(above, true, NOW).state;

    expect(nextFullState(crossed, true, NOW + LAST_CALL_MS - 1).notice).toBeUndefined();
    expect(nextFullState(crossed, true, NOW + LAST_CALL_MS).notice).toBe('lastCall');
  });

  it('makes the last call once', () => {
    const called = nextFullState(nextFullState(above, true, NOW).state, true, NOW + LAST_CALL_MS);

    expect(nextFullState(called.state, true, NOW + 10 * LAST_CALL_MS).notice).toBeUndefined();
  });

  it('says when there is room again, and starts over', () => {
    const crossed = nextFullState(above, true, NOW).state;

    const back = nextFullState(crossed, false, NOW + 1000);

    expect(back.notice).toBe('recovered');
    expect(nextFullState(back.state, true, NOW + 2000).notice).toBe('full');
  });

  it('says nothing while there is room', () => {
    expect(nextFullState(above, false, NOW)).toEqual({ state: above });
  });
});

describe('when the database counts as full', () => {
  it('starts at the crossing', () => {
    expect(isFull({ freeMb: 499, fileMb: 10240, thresholdMb: 500 }, false)).toBe(true);
    expect(isFull({ freeMb: 501, fileMb: 10240, thresholdMb: 500 }, false)).toBe(false);
  });

  it('lasts through the flicker just above the threshold', () => {
    // A session still writing is let through a commit at a time (measured).
    expect(isFull({ freeMb: 501, fileMb: 10240, thresholdMb: 500 }, true)).toBe(true);
    expect(isFull({ freeMb: 624, fileMb: 10240, thresholdMb: 500 }, true)).toBe(true);
  });

  it('ends a quarter of the threshold above it', () => {
    expect(isFull({ freeMb: 625, fileMb: 10240, thresholdMb: 500 }, true)).toBe(false);
  });

  it('needs at least 64 MB of margin under a small threshold', () => {
    expect(isFull({ freeMb: 120, fileMb: 256, thresholdMb: 64 }, true)).toBe(true);
    expect(isFull({ freeMb: 128, fileMb: 256, thresholdMb: 64 }, true)).toBe(false);
  });
});
