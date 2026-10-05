import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  SYSTEM_USER_PASSWORD,
  abortIdleSessionsAfterMinutes,
  adminAccount,
  garbageCollectionIntervalHours,
  isExternalDatabase,
} from './config';
import { REPOSITORY_LIMIT_MB } from './database';
import { errorMessage, log, showLog } from './log';
import { abortQuery, commitQuery } from './pauseVariables';
import { databaseExists, databasePath } from './paths';
import { isRunningAsync } from './processes';
import {
  GciSession,
  SessionOwner,
  closeSessionFor,
  humanDuration,
  isFreeSpaceNotice,
  sessionForIfOpen,
  windowSessions,
} from './session';

/**
 * Keeping the database from filling up with garbage it can no longer collect.
 *
 * The stone is capped at the license's 10 GB and defends 500 MB of free space
 * below that (`withSpaceLimits` in database.ts). What it does at that line is
 * the reason this module exists: measured on 4.0.0.a4, once free space drops
 * below the threshold the reclaim gem logs "Suspending reclaims" — a
 * collection still finds the garbage, and none of it is freed. So collecting
 * has to happen before the line, and when it has not, getting back means
 * lowering the threshold, which only SystemUser may do. The measurements are
 * in docs/repository-space.md.
 *
 * Four things, in the order a tick does them:
 *
 *   Sessions this window left idle are aborted, when that loses nothing
 *   (`GciSession.abortIfClean`). An idle session in `autoBegin` never votes,
 *   and garbage waits for every session's vote. One holding uncommitted
 *   changes is the user's to decide about, so it is asked about — and only
 *   once it is actually holding something back.
 *
 *   Space is read, for the status view and for the next decision.
 *
 *   Below the threshold, the user is told at once to commit, and again two
 *   minutes in: at three the stone ends the `gemdb` sessions holding the
 *   oldest commit record (measured; the account is not exempt, by design —
 *   see `DB_USER`). A collection starts the moment it is noticed.
 *
 *   A collection runs when room is short, or on a schedule once this window
 *   has been quiet for a few minutes. It runs in a session of its own, so the
 *   extension host is never blocked on it.
 *
 * Only for a database GemDB manages: an external database's administrator
 * decides when it collects garbage. Sessions this window holds are swept
 * either way — they are this window's. Reading space and sweeping use the
 * window's own `gemdb` sessions, which may do both; collecting garbage,
 * checkpoints and listing or stopping sessions log in as DataCurator, on a
 * session of their own, logged out afterwards.
 */

/**
 * How often maintenance looks: once a minute, and every fifteen seconds once
 * room is short or the threshold crossed — the stone's three minutes start at
 * the crossing, and a warning given late is a warning not given. A look is one
 * short query on a session that is already open.
 */
const TICK_MS = 60_000;
const LOW_TICK_MS = 15_000;
/** The first look, a minute after activation: not on the activation path. */
const FIRST_TICK_MS = 60_000;

/**
 * When GemDB makes its last call after the threshold is crossed. The stone
 * starts ending sessions at three minutes (`STN_DISKFULL_TERMINATION_INTERVAL`,
 * left at its default on purpose).
 */
export const LAST_CALL_MS = 2 * 60_000;

/**
 * Collect when less than this much room is left, in MB. Four times the
 * stone's threshold, so a collection — and the reclaim after it, which needs
 * free pages to copy live objects into — finishes well before the stone stops
 * reclaiming.
 */
export const GC_HEADROOM_MB = 2048;

/** A scheduled collection waits until nothing in this window has run for this long. */
export const QUIET_MS = 5 * 60_000;

/**
 * A collection forced by space is not repeated sooner than this. When the
 * data is genuinely live, collecting again every five minutes frees nothing
 * and costs a full traversal each time.
 */
export const SPACE_GC_SPACING_MS = 60 * 60_000;

/**
 * How many commits a dirty idle session must be behind before it is worth
 * interrupting its owner. The stone's own default for when a session outside
 * a transaction is asked to abort (`STN_SIGNAL_ABORT_CR_BACKLOG`).
 */
export const BACKLOG_WORTH_ASKING = 20;

/** How long a collection waits for the vote and the reclaim after it. */
const RECLAIM_WAIT_MS = 10 * 60_000;
const POLL_MS = 5_000;

// ---------------------------------------------------------------------------
// The decisions, kept free of the database so they can be tested without one.
// ---------------------------------------------------------------------------

/** What the repository says about its size, in MB. */
export interface SpaceReading {
  /** Free space inside the extent. */
  freeMb: number;
  /** The extent's size on disk. */
  fileMb: number;
  /** The stone's free-space threshold, when the reading asked for it. */
  thresholdMb?: number;
}

/** Room left before the license's limit: what the extent may still grow into, plus what is free in it. */
export function roomLeftMb(reading: SpaceReading): number {
  return Math.max(0, REPOSITORY_LIMIT_MB - reading.fileMb + reading.freeMb);
}

/** What the database holds, garbage included until it is reclaimed. */
export function usedMb(reading: SpaceReading): number {
  return Math.max(0, reading.fileMb - reading.freeMb);
}

/** "1.4 GB", "320 MB". */
export function formatMb(mb: number): string {
  return mb >= 1024 ? `${Math.round(mb / 102.4) / 10} GB` : `${Math.round(mb)} MB`;
}

/** The answer to `SPACE_QUERY`, or undefined if it is not one. */
export function parseSpaceReading(answer: string): SpaceReading | undefined {
  const match = answer.trim().match(/^(\d+) (\d+)(?: (\d+))?$/);
  if (!match) return undefined;
  const reading: SpaceReading = { freeMb: Number(match[1]), fileMb: Number(match[2]) };
  if (match[3] !== undefined) reading.thresholdMb = Number(match[3]);
  return reading;
}

/**
 * Whether the stone is below its free-space threshold — its own test, so it
 * holds at any cap: the stone grows the extent to stay above the threshold
 * while it can, so free space under it means it cannot. A threshold of 0 is
 * the stone's default, a tenth of a percent of the repository with a 5 MB
 * floor.
 */
export function isBelowThreshold(reading: SpaceReading): boolean {
  if (reading.thresholdMb === undefined) return false;
  return reading.freeMb < effectiveThresholdMb(reading);
}

function effectiveThresholdMb(reading: SpaceReading): number {
  const threshold = reading.thresholdMb ?? 0;
  return threshold > 0 ? threshold : Math.max(5, reading.fileMb / 1000);
}

/**
 * Whether to treat the database as full, given whether it was.
 *
 * With hysteresis, because the stone has none: a session still writing near
 * the threshold is let through a commit at a time, and free space flickers
 * just above and below it every ten to forty seconds (measured). Without a
 * margin that would be a "full" and a "room again" notice each time. So the
 * database is full from the crossing until free space is a quarter of the
 * threshold above it, and at least 64 MB.
 */
export function isFull(reading: SpaceReading, wasFull: boolean): boolean {
  if (reading.thresholdMb === undefined) return false;
  if (!wasFull) return isBelowThreshold(reading);
  const threshold = effectiveThresholdMb(reading);
  return reading.freeMb < threshold + Math.max(64, threshold / 4);
}

/** Where the database stands against its threshold, as far as telling the user goes. */
export interface FullState {
  /** When the threshold was first seen crossed; undefined while above it. */
  since?: number;
  /** Whether the last call has been made for this crossing. */
  lastCall: boolean;
}

export type FullNotice = 'full' | 'lastCall' | 'recovered';

/**
 * The next state, and what to tell the user, given whether the database is
 * below its threshold now. One notice per change: full on crossing, the last
 * call two minutes in, recovered on the way back.
 */
export function nextFullState(
  prev: FullState,
  below: boolean,
  now: number,
): { state: FullState; notice?: FullNotice } {
  if (!below) {
    return prev.since === undefined
      ? { state: prev }
      : { state: { lastCall: false }, notice: 'recovered' };
  }
  if (prev.since === undefined) return { state: { since: now, lastCall: false }, notice: 'full' };
  if (!prev.lastCall && now - prev.since >= LAST_CALL_MS) {
    return { state: { since: prev.since, lastCall: true }, notice: 'lastCall' };
  }
  return { state: prev };
}

export type GcReason = 'space' | 'schedule';

/**
 * Whether a collection is due, and why.
 *
 * Space wins over quiet: a database running out of room collects whether or
 * not someone is typing, since a collection runs alongside other sessions and
 * running out does not wait for them. A schedule is a courtesy and waits.
 */
export function gcDue(facts: {
  reading: SpaceReading;
  lastGcAt: number | undefined;
  now: number;
  intervalHours: number;
  quietMs: number;
}): GcReason | undefined {
  const since = facts.lastGcAt === undefined ? Infinity : facts.now - facts.lastGcAt;
  if (roomLeftMb(facts.reading) < GC_HEADROOM_MB && since >= SPACE_GC_SPACING_MS) return 'space';
  if (
    facts.intervalHours > 0 &&
    since >= facts.intervalHours * 3_600_000 &&
    facts.quietMs >= QUIET_MS
  ) {
    return 'schedule';
  }
  return undefined;
}

/**
 * The threshold to set so reclaim can run again with `freeMb` free.
 *
 * The reclaim gem suspends while free space is below the threshold, so the
 * threshold has to go under what is free; half leaves room for the copies
 * reclaim makes. Never 0, which the stone reads as "a tenth of a percent of
 * the repository" rather than "none".
 */
export function thresholdToReclaimUnder(freeMb: number): number {
  return Math.max(1, Math.floor(freeMb / 2));
}

/** The counts in a markForCollection report, where it gives them. */
export function parseMfcReport(report: string): { live?: number; dead?: number } {
  const live = report.match(/(\d+) live objects/);
  const dead = report.match(/(\d+) dead objects/);
  return {
    live: live ? Number(live[1]) : undefined,
    dead: dead ? Number(dead[1]) : undefined,
  };
}

/** One session on the stone, as `SESSIONS_QUERY` describes it. */
export interface DatabaseSession {
  id: number;
  user: string;
  /** What it published with `System cacheName:` — `GemDB nb analysis` — or empty. */
  name: string;
  /** Seconds since its last begin, commit or abort: how old its view is. */
  viewAgeSeconds: number;
  /** Whether it holds the oldest commit record, which is what stops reclaim. */
  holdsOldest: boolean;
  /** Commits made since its view was taken. */
  behind: number;
  /** One of the stone's own gems (reclaim, symbol creation), never offered for stopping. */
  system: boolean;
}

/** The rows `SESSIONS_QUERY` answers, skipping any it cannot read. */
export function parseSessions(answer: string): DatabaseSession[] {
  return answer
    .split('\n')
    .map((line) => line.split('\t'))
    .filter((cells) => cells.length >= 7)
    .map(([id, user, name, age, oldest, behind, system]) => ({
      id: Number(id),
      user,
      name,
      viewAgeSeconds: Number(age),
      holdsOldest: oldest === 'true',
      behind: Number(behind),
      system: system === 'true',
    }))
    .filter((s) => Number.isInteger(s.id) && Number.isFinite(s.viewAgeSeconds));
}

/**
 * The sessions worth offering to stop, the ones holding garbage back first.
 *
 * Leaves out the stone's own gems, and `exclude` — this window's own
 * administrative sessions, which are short-lived and stopping which would
 * only fail what GemDB is doing.
 */
export function stoppableSessions(
  sessions: DatabaseSession[],
  exclude: number[],
): DatabaseSession[] {
  return sessions
    .filter((s) => !s.system && !exclude.includes(s.id))
    .sort(
      (a, b) =>
        Number(b.holdsOldest) - Number(a.holdsOldest) ||
        b.behind - a.behind ||
        b.viewAgeSeconds - a.viewAgeSeconds,
    );
}

// ---------------------------------------------------------------------------
// Smalltalk. Each answers a String, which is what `execute` and `peek` fetch.
// ---------------------------------------------------------------------------

/** Free space, extent size and threshold, in MB — all readable by `gemdb`, measured. */
const SPACE_QUERY =
  "(SystemRepository freeSpace // 1048576) printString, ' ', " +
  "(SystemRepository fileSize // 1048576) printString, ' ', " +
  '(System stoneConfigurationAt: #StnFreeSpaceThreshold) printString';

/** Commits made since this session's view was taken: slot 16 of its own description. */
const BEHIND_QUERY = '((System descriptionOfSession: System session) at: 16) printString';

/**
 * One tab-separated line per session: id, user, published name, view age,
 * holds the oldest commit record, commits behind, system gem. Slot numbers
 * are `System descriptionOfSession:`'s, measured on 4.0.0.a4: 5 is the time
 * of the last begin/commit/abort in `System timeGmt` seconds, 8 the
 * oldest-commit-record flag, 16 commits behind, 17 a system gem's kind (nil
 * for an ordinary session). The names are cache slots whose fourth field is
 * 8, a gem; their third is the session id.
 */
const SESSIONS_QUERY = `| names now w |
names := Dictionary new.
System cacheStatisticsForAllSlots do: [:row |
  ((row at: 4) = 8 and: [(row at: 3) > 0]) ifTrue: [names at: (row at: 3) put: (row at: 1)]].
now := System timeGmt.
w := WriteStream on: String new.
System currentSessions do: [:id | | d |
  d := System descriptionOfSession: id.
  w print: id; tab;
    nextPutAll: (d at: 1) userId; tab;
    nextPutAll: (names at: id ifAbsent: ['']); tab;
    print: now - (d at: 5); tab;
    print: (d at: 8) == true; tab;
    print: ((d at: 16) ifNil: [0]); tab;
    print: (d at: 17) notNil; lf].
w contents`;

/** markForCollection on 4.0 answers a Warning carrying the report; older engines signal it. */
const MFC_QUERY =
  '| r | r := [SystemRepository markForCollection] on: Warning do: [:w | w messageText]. ' +
  '(r isKindOf: Exception) ifTrue: [r messageText asString] ifFalse: [r asString]';

/**
 * One look at the vote and the reclaim behind it — vote state, then objects
 * possibly dead, dead and not reclaimed, and pages waiting for reclaim — from
 * a session that aborts first so it never holds them up itself.
 */
const RECLAIM_QUERY =
  "System abortTransaction. System voteStateString, ' ', System possibleDeadSize printString, ' ', " +
  "System deadNotReclaimedCount printString, ' ', System pagesNeedReclaimCount printString";

/** Free space as a checkpoint leaves it: pages reclaim frees are not counted free before one. */
const CHECKPOINTED_FREE_QUERY =
  'System abortTransaction. System startCheckpointSync. ' +
  '(SystemRepository freeSpace // 1048576) printString';

/**
 * How long free space must stop growing before reclaim is taken to be
 * finished, and how often to look. Pages came free anywhere from two seconds
 * to a minute after the vote, measured — longest straight after a large
 * commit, while the shared cache is still writing it out. A lowered threshold
 * gets the longer wait, because putting it back too early suspends reclaim.
 */
const SETTLED_MS = 30_000;
const SETTLED_LOWERED_MS = 90_000;
const FREE_POLL_MS = 5_000;

const THRESHOLD_QUERY = '(System stoneConfigurationAt: #StnFreeSpaceThreshold) printString';

// ---------------------------------------------------------------------------
// What maintenance remembers between ticks, and between windows.
// ---------------------------------------------------------------------------

/** The last collection, kept beside the database so every window agrees on when it was. */
export interface GcRecord {
  at: number;
  reason: GcReason | 'command';
  /** Dead objects it found. */
  dead?: number;
  /** Room it gave back, in MB, once reclaimed and checkpointed. */
  freedMb?: number;
}

function recordPath(): string {
  return path.join(databasePath(), 'maintenance.json');
}

export function readGcRecord(): GcRecord | undefined {
  try {
    const record = JSON.parse(fs.readFileSync(recordPath(), 'utf-8')) as GcRecord;
    return typeof record.at === 'number' ? record : undefined;
  } catch {
    return undefined;
  }
}

function writeGcRecord(record: GcRecord): void {
  try {
    fs.writeFileSync(recordPath(), `${JSON.stringify(record)}\n`);
  } catch (e) {
    log(`Could not record the garbage collection: ${errorMessage(e)}`);
  }
}

let lastReading: SpaceReading | undefined;
let collecting = false;
let full: FullState = { lastCall: false };

/** The most recent space reading, for the status view. Undefined until one has been taken. */
export function spaceReading(): SpaceReading | undefined {
  return lastReading;
}

/** Whether this window is collecting garbage now. */
export function isCollecting(): boolean {
  return collecting;
}

/** Which dirty sessions have been asked about, by owner, and as of which use. */
const asked = new Map<string, number>();

// ---------------------------------------------------------------------------
// The tick.
// ---------------------------------------------------------------------------

export interface MaintenanceHooks {
  /** Something the status view shows changed. */
  changed: () => void;
  /** A notebook's transaction was committed or aborted from here. */
  committedOrAborted: () => void;
}

/** A session to read through without logging one in or disturbing anyone's idle time. */
function probe(code: string): string | undefined {
  for (const session of windowSessions()) {
    const answer = session.peek(code);
    if (answer !== undefined) return answer;
  }
  return undefined;
}

/**
 * Abort what this window has left idle for `idleMs`, where that loses
 * nothing. Answers the ones holding uncommitted changes, for the caller to
 * weigh against the backlog.
 */
function sweep(idleMs: number): GciSession[] {
  const dirty: GciSession[] = [];
  for (const session of windowSessions()) {
    if (session.idleMs < idleMs) continue;
    try {
      const outcome = session.abortIfClean();
      if (outcome === 'dirty') dirty.push(session);
    } catch (e) {
      log(`Could not check ${session.label} for idle maintenance: ${errorMessage(e)}`);
    }
  }
  return dirty;
}

/** One look. Answers how long until the next. */
async function tick(hooks: MaintenanceHooks): Promise<number> {
  if (windowSessions().length === 0) return TICK_MS;
  if (!(await isRunningAsync())) {
    if (lastReading !== undefined) {
      lastReading = undefined;
      hooks.changed();
    }
    return TICK_MS;
  }

  const idleMinutes = abortIdleSessionsAfterMinutes();
  if (idleMinutes > 0 && !collecting) {
    const dirty = sweep(idleMinutes * 60_000).filter((s) => s.owner.kind === 'notebook');
    for (const session of dirty) {
      const behind = Number(session.peek(BEHIND_QUERY) ?? 0);
      if (behind >= BACKLOG_WORTH_ASKING) void askAboutDirty(session, behind, hooks);
    }
  }

  if (isExternalDatabase() || !databaseExists()) return TICK_MS;
  const reading = parseSpaceReading(probe(SPACE_QUERY) ?? '');
  if (!reading) return TICK_MS;
  lastReading = reading;
  hooks.changed();

  const { state, notice } = nextFullState(
    full,
    isFull(reading, full.since !== undefined),
    Date.now(),
  );
  full = state;
  if (notice) announce(notice);
  const next =
    full.since !== undefined || roomLeftMb(reading) < GC_HEADROOM_MB ? LOW_TICK_MS : TICK_MS;
  if (collecting) return next;

  // Crossing the threshold is the emergency the rest of this is for: collect
  // now, whatever the hour-long spacing between collections forced by space.
  if (notice === 'full') {
    void collectGarbage('space', hooks);
    return next;
  }
  const quietMs = Math.min(...windowSessions().map((s) => s.idleMs));
  const reason = gcDue({
    reading,
    lastGcAt: readGcRecord()?.at,
    now: Date.now(),
    intervalHours: garbageCollectionIntervalHours(),
    quietMs,
  });
  if (reason) void collectGarbage(reason, hooks);
  return next;
}

/** Tell the user where the database stands against its threshold. */
function announce(notice: FullNotice): void {
  log(`Space: ${notice}`);
  if (notice === 'full') {
    void vscode.window.showWarningMessage(
      'The GemDB database is full. Commit your work now: in about three minutes the database ' +
        'stops sessions that are holding back its space, and anything they have not committed ' +
        'is lost. No new notebook or GemDB Shell can open until there is room. GemDB is ' +
        'collecting garbage to make some.',
    );
  } else if (notice === 'lastCall') {
    void vscode.window.showWarningMessage(
      'The GemDB database is still full. In about a minute it starts stopping sessions that ' +
        'are holding back its space. Commit anything you want to keep now.',
    );
  } else {
    void vscode.window.showInformationMessage('The GemDB database has room again.');
  }
}

/**
 * Ask the owner of a dirty, idle notebook to commit or abort — once per
 * stretch of idleness, so a "Leave It" holds until the notebook is next used.
 */
async function askAboutDirty(
  session: GciSession,
  behind: number,
  hooks: MaintenanceHooks,
): Promise<void> {
  const key = session.owner.key;
  const lastUse = Math.round((Date.now() - session.idleMs) / 1000);
  if (asked.get(key) === lastUse) return;
  asked.set(key, lastUse);

  const label = session.owner.label;
  const commit = 'Commit';
  const abort = 'Abort…';
  const choice = await vscode.window.showWarningMessage(
    `${label} has uncommitted changes and has been idle for ${humanDuration(session.idleMs)}. ` +
      `Until it commits or aborts, the database cannot reclaim garbage from the ${behind} ` +
      'commits made since.',
    commit,
    abort,
    'Leave It',
  );
  if (choice !== commit && choice !== abort) return;
  if (sessionForIfOpen(key) !== session) return;
  try {
    if (choice === abort) {
      const discard = 'Discard Changes';
      const sure = await vscode.window.showWarningMessage(
        `Discard everything ${label} has not committed?`,
        { modal: true, detail: 'Nothing it changed since its last commit will be persisted.' },
        discard,
      );
      if (sure !== discard) return;
    }
    const answer = await askingAgain(session, choice === commit ? commitQuery() : abortQuery());
    if (answer.startsWith('Error: ')) throw new Error(answer.slice('Error: '.length));
    log(`${choice === commit ? 'Committed' : 'Aborted'} ${label} at maintenance's prompt`);
  } catch (e) {
    void vscode.window.showErrorMessage(
      `Could not ${choice === commit ? 'commit' : 'abort'} ${label}: ${errorMessage(e)}`,
    );
  }
  hooks.committedOrAborted();
}

/** Start looking after the database. The returned disposable stops it. */
export function startMaintenance(hooks: MaintenanceHooks): vscode.Disposable {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const run = (): void => {
    void tick(hooks)
      .catch((e: unknown) => {
        log(`Maintenance failed: ${errorMessage(e)}`);
        return TICK_MS;
      })
      .then((next) => {
        if (!stopped) timer = setTimeout(run, next);
      });
  };
  timer = setTimeout(run, FIRST_TICK_MS);
  return new vscode.Disposable(() => {
    stopped = true;
    clearTimeout(timer);
  });
}

// ---------------------------------------------------------------------------
// Collecting garbage.
// ---------------------------------------------------------------------------

/**
 * The collection's own session, as DataCurator, so a long traversal never
 * blocks the extension host — and `gemdb` holds no GarbageCollection or
 * SystemControl privilege. Not registered with the window's sessions, so the
 * sweep leaves it to abort itself.
 */
const GC_OWNER: SessionOwner = {
  key: '__garbage_collection__',
  kind: 'extension',
  label: 'GemDB garbage collection',
};

/** Short administrative logins: listing and stopping sessions. */
const ADMIN_OWNER: SessionOwner = {
  key: '__admin__',
  kind: 'extension',
  label: 'GemDB (DataCurator)',
};

/** Run `work` in a DataCurator session of its own, logged out afterwards. */
function asAdmin<T>(work: (session: GciSession) => T): T {
  const session = GciSession.login(ADMIN_OWNER, adminAccount());
  try {
    return work(session);
  } finally {
    session.logout();
  }
}

/** The one login GemDB makes as SystemUser: only it may change the threshold. */
const SYSTEM_USER_OWNER: SessionOwner = {
  key: '__system_user__',
  kind: 'extension',
  label: 'GemDB (SystemUser)',
};

/**
 * Set the stone's free-space threshold for as long as it runs, as SystemUser —
 * one of the two things GemDB does as SystemUser, since nobody else may.
 */
export function setFreeSpaceThreshold(mb: number): void {
  // The stock extent's SystemUser password, as install-grail.sh uses it;
  // maintenance only runs on a database GemDB created from that extent.
  const session = GciSession.login(SYSTEM_USER_OWNER, {
    user: 'SystemUser',
    password: SYSTEM_USER_PASSWORD,
  });
  try {
    session.execute(`System configurationAt: #StnFreeSpaceThreshold put: ${mb}. 'set'`);
  } finally {
    session.logout();
  }
}

/**
 * Run something in the collection's session, again if the stone's
 * free-space notice took its place — which, below the threshold, it does on
 * the first request of every session that logs in.
 */
async function askingAgain(session: GciSession, code: string): Promise<string> {
  try {
    return await session.executeAsync(code);
  } catch (e) {
    if (!isFreeSpaceNotice(e)) throw e;
    return session.executeAsync(code);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type GcOutcome =
  | { kind: 'done'; record: GcRecord; reading?: SpaceReading }
  | { kind: 'waiting'; dead: number; holders: string[] }
  | { kind: 'failed'; message: string };

/**
 * Mark, let every session vote, wait for reclaim, checkpoint.
 *
 * Each step is there because leaving it out was measured to free nothing:
 * the garbage a mark finds is reclaimed only once every session has voted,
 * which an idle `autoBegin` session never does by itself (so this window's
 * clean ones are aborted straight after the mark), and pages reclaim frees
 * count as free only after the next checkpoint.
 */
export async function collectGarbage(
  reason: GcRecord['reason'],
  hooks: MaintenanceHooks,
): Promise<GcOutcome> {
  if (collecting) return { kind: 'failed', message: 'A collection is already running.' };
  collecting = true;
  hooks.changed();
  let restoreThreshold: number | undefined;
  let session: GciSession | undefined;
  try {
    session = GciSession.login(GC_OWNER, adminAccount());
    const before = parseSpaceReading(session.execute(SPACE_QUERY));
    log(
      `Collecting garbage (${reason === 'command' ? 'asked for' : reason === 'space' ? 'running out of room' : 'scheduled'})` +
        (before
          ? `: ${formatMb(usedMb(before))} used, ${formatMb(roomLeftMb(before))} of room left.`
          : '.'),
    );

    // Below the threshold the reclaim gem has stopped, and a mark would find
    // garbage nothing then frees. Lower it under what is free for the
    // duration, and put back what was there — the user's value, if they set one.
    const threshold = Number(session.execute(THRESHOLD_QUERY));
    if (before && Number.isFinite(threshold) && before.freeMb < threshold) {
      const lowered = thresholdToReclaimUnder(before.freeMb);
      log(
        `Free space (${before.freeMb} MB) is below the stone's threshold (${threshold} MB), so ` +
          `reclaim is suspended. Lowering the threshold to ${lowered} MB while collecting.`,
      );
      setFreeSpaceThreshold(lowered);
      restoreThreshold = threshold;
    }

    const report = await askingAgain(session, MFC_QUERY);
    const { dead } = parseMfcReport(report);
    log(report);

    if (dead !== 0) {
      // The vote: this window's clean sessions now, however recently used —
      // an abort that loses nothing is invisible to them — and the
      // collection's own session on every poll.
      sweep(0);
      const deadline = Date.now() + RECLAIM_WAIT_MS;
      let state = '';
      for (;;) {
        state = await askingAgain(session, RECLAIM_QUERY);
        if (/^IDLE 0 0 0$/.test(state.trim())) break;
        if (Date.now() > deadline) {
          const own = session.serial;
          const holders = parseSessions(await askingAgain(session, SESSIONS_QUERY))
            .filter((s) => s.holdsOldest && !s.system && s.id !== own)
            .map((s) => s.name || `${s.user} (session ${s.id})`);
          log(
            `Garbage collection is waiting (${state.trim()}): the garbage it found is reclaimed ` +
              `once ${holders.join(', ') || 'every session'} commits or aborts.`,
          );
          return { kind: 'waiting', dead: dead ?? 0, holders };
        }
        await delay(POLL_MS);
      }
      // The counts above reach zero within a quarter of a second, and the
      // pages behind them come free over the following seconds — counted
      // only after a checkpoint (measured). Restoring a lowered threshold
      // before then suspends reclaim halfway, so wait until free space is
      // back above it, or has stopped growing.
      const settledMs = restoreThreshold === undefined ? SETTLED_MS : SETTLED_LOWERED_MS;
      let best = -1;
      let grewAt = Date.now();
      while (Date.now() - grewAt < settledMs && Date.now() < deadline) {
        sweep(0);
        const free = Number(await askingAgain(session, CHECKPOINTED_FREE_QUERY));
        if (free > best) {
          best = free;
          grewAt = Date.now();
        }
        if (restoreThreshold !== undefined && free > restoreThreshold) break;
        await delay(FREE_POLL_MS);
      }
    }

    const after = parseSpaceReading(session.execute(SPACE_QUERY));
    const record: GcRecord = {
      at: Date.now(),
      reason,
      dead,
      freedMb: before && after ? Math.max(0, roomLeftMb(after) - roomLeftMb(before)) : undefined,
    };
    writeGcRecord(record);
    if (after) lastReading = after;
    log(
      `Garbage collection finished: ${dead ?? 'some'} dead objects` +
        (record.freedMb !== undefined ? `, ${formatMb(record.freedMb)} given back` : '') +
        (after ? `; ${formatMb(roomLeftMb(after))} of room left.` : '.'),
    );
    if (after && roomLeftMb(after) < GC_HEADROOM_MB) warnNearlyFull(after);
    return { kind: 'done', record, reading: after };
  } catch (e) {
    log(`Garbage collection failed: ${errorMessage(e)}`);
    return { kind: 'failed', message: errorMessage(e) };
  } finally {
    if (restoreThreshold !== undefined) {
      try {
        setFreeSpaceThreshold(restoreThreshold);
      } catch (e) {
        log(`Could not restore the free-space threshold: ${errorMessage(e)}`);
      }
    }
    session?.logout();
    collecting = false;
    hooks.changed();
  }
}

let warnedAt = 0;

/** Say once a day that collecting garbage did not make enough room. */
function warnNearlyFull(reading: SpaceReading): void {
  if (Date.now() - warnedAt < 24 * 3_600_000) return;
  warnedAt = Date.now();
  void vscode.window
    .showWarningMessage(
      `Your GemDB database is nearly full: ${formatMb(roomLeftMb(reading))} left of ` +
        `${formatMb(REPOSITORY_LIMIT_MB)}, after collecting garbage. Delete data you no longer ` +
        'need and commit; the space comes back at the next collection.',
      'Show Log',
    )
    .then((choice) => {
      if (choice === 'Show Log') showLog();
    });
}

/** "Collect Garbage Now": the same collection, with progress and an answer. */
export async function collectGarbageCommand(hooks: MaintenanceHooks): Promise<void> {
  if (isExternalDatabase()) {
    void vscode.window.showInformationMessage(
      "This database is run by this machine's administrator, who decides when it collects garbage.",
    );
    return;
  }
  if (!(await isRunningAsync())) {
    void vscode.window.showInformationMessage(
      'Start GemDB first: collecting garbage needs the database running.',
    );
    return;
  }
  const outcome = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Collecting garbage in GemDB' },
    () => collectGarbage('command', hooks),
  );
  if (outcome.kind === 'done') {
    const { record, reading } = outcome;
    void vscode.window.showInformationMessage(
      `Collected garbage: ${record.dead ?? 0} dead objects` +
        (record.freedMb !== undefined ? `, ${formatMb(record.freedMb)} given back` : '') +
        (reading
          ? `. ${formatMb(usedMb(reading))} of ${formatMb(REPOSITORY_LIMIT_MB)} used.`
          : '.'),
    );
  } else if (outcome.kind === 'waiting') {
    const stop = 'Stop a Session…';
    const choice = await vscode.window.showWarningMessage(
      `Found ${outcome.dead} dead objects, but they cannot be reclaimed until ` +
        `${outcome.holders.join(', ') || 'every session'} commits or aborts.`,
      stop,
    );
    if (choice === stop) await stopSessionCommand(hooks);
  } else {
    void vscode.window.showErrorMessage(`Could not collect garbage: ${outcome.message}`);
  }
}

// ---------------------------------------------------------------------------
// Stopping a session.
// ---------------------------------------------------------------------------

/**
 * Every session on the stone, as DataCurator: describing another session
 * needs `SessionAccess`, which `gemdb` does not hold. The listing session
 * itself is left out, since it is gone by the time anyone reads the list.
 */
export function databaseSessions(): DatabaseSession[] {
  return asAdmin((session) => {
    const self = Number(session.execute('System session printString'));
    return parseSessions(session.execute(SESSIONS_QUERY)).filter((s) => s.id !== self);
  });
}

/** Stop a session by id, as DataCurator: `stopSession:` needs `SystemControl`. */
export function stopDatabaseSession(id: number): void {
  asAdmin((session) => session.execute(`System stopSession: ${id}. 'stopped'`));
}

/**
 * "Stop a Database Session…": the way out when a session holds the oldest
 * commit record and will not let go — a notebook in another window left
 * dirty, a topaz someone forgot.
 *
 * Asked, never automated, because stopping a session throws away whatever
 * it has not committed. The stone has a blunt automatic version
 * (`STN_GEM_TIMEOUT`), deliberately not set: it would end idle notebooks and
 * shells along with their variables. The stone's emergency version — ending
 * the `gemdb` sessions holding the oldest commit record once free space has
 * been below the threshold for `STN_DISKFULL_TERMINATION_INTERVAL` — is left
 * on deliberately, and is what this command is not: it acts only when the
 * database is already full.
 */
export async function stopSessionCommand(hooks: MaintenanceHooks): Promise<void> {
  if (!(await isRunningAsync())) {
    void vscode.window.showInformationMessage('GemDB is not running, so no session is open.');
    return;
  }
  let sessions: DatabaseSession[];
  try {
    sessions = databaseSessions();
  } catch (e) {
    void vscode.window.showErrorMessage(
      `Could not list the database's sessions: ${errorMessage(e)}`,
    );
    return;
  }
  const mine = new Map(windowSessions().map((s) => [s.serial, s]));
  const administrative = windowSessions()
    .filter((s) => s.owner.kind === 'extension')
    .map((s) => s.serial)
    .filter((serial): serial is number => serial !== undefined);
  const candidates = stoppableSessions(sessions, administrative);
  if (candidates.length === 0) {
    void vscode.window.showInformationMessage('No session is open apart from the database’s own.');
    return;
  }

  const picked = await vscode.window.showQuickPick(
    candidates.map((s) => {
      const owner = mine.get(s.id)?.owner;
      return {
        session: s,
        label: owner ? `${owner.label} (this window)` : s.name || s.user,
        description:
          `session ${s.id} · view ${humanDuration(s.viewAgeSeconds * 1000)} old` +
          (s.behind > 0 ? ` · ${s.behind} commits behind` : ''),
        detail: s.holdsOldest && s.behind > 0 ? 'Holding back garbage collection' : undefined,
      };
    }),
    {
      title: 'Stop a Database Session',
      placeHolder: 'Anything the session has not committed is lost',
    },
  );
  if (!picked) return;

  const owner = mine.get(picked.session.id)?.owner;
  const stop = 'Stop Session';
  const sure = await vscode.window.showWarningMessage(
    `Stop ${picked.label}?`,
    {
      modal: true,
      detail:
        'Anything it has not committed is lost.' +
        (owner?.kind === 'notebook'
          ? ' The notebook logs in again at its next cell, with no variables.'
          : ''),
    },
    stop,
  );
  if (sure !== stop) return;

  try {
    if (owner) {
      closeSessionFor(owner.key);
    } else {
      stopDatabaseSession(picked.session.id);
    }
    log(`Stopped session ${picked.session.id} (${picked.label}).`);
  } catch (e) {
    void vscode.window.showErrorMessage(`Could not stop ${picked.label}: ${errorMessage(e)}`);
  }
  hooks.changed();
}
