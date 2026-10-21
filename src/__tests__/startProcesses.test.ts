import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __log, __resetSettings, __setSetting } from '../__mocks__/vscode';

/**
 * Starting the stone and the listener when another process may be doing the
 * same, with the engine's commands faked: `gslist` answers with the next of
 * `listings` (the last one for good once they run out), and every other
 * command exits with the code `exitCodes` gives it.
 */

let listings: string[] = [];
let gslistCalls = 0;
/** When set, what gslist lists at a given time, instead of `listings`. */
let listingAt: ((now: number) => string) | undefined;
const exitCodes: Record<string, number> = {};
const spawned: string[] = [];

function gslist(): string {
  gslistCalls++;
  if (listingAt) return listingAt(Date.now());
  return listings.length > 1 ? (listings.shift() ?? '') : (listings[0] ?? '');
}

function fakeChild(command: string): EventEmitter {
  const name = path.basename(command);
  spawned.push(name);
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
  setImmediate(() => child.emit('close', exitCodes[name] ?? 0));
  return child;
}

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const execFile = Object.assign(() => {}, {
    [promisify.custom]: async () => ({ stdout: gslist(), stderr: '' }),
  });
  return {
    ...actual,
    execFile,
    execFileSync: () => gslist(),
    spawn: (command: string) => fakeChild(command),
  };
});

// The real lock, with what it is asked to wait for kept where a test can ask it.
let satisfied: (() => boolean | Promise<boolean>) | undefined;
vi.mock('../lock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lock')>();
  return {
    ...actual,
    withStoneLock: <T>(
      work: () => Promise<T>,
      wait: { satisfied?: () => boolean | Promise<boolean> } = {},
    ) => {
      satisfied = wait.satisfied;
      return actual.withStoneLock(work, wait);
    },
  };
});

const { expectedEnginePath } = await import('../paths');
const { STONE_LOCK_NAME } = await import('../lock');
const {
  EXTERNAL_SHUTTING_DOWN_MESSAGE,
  assertExternalDatabaseUp,
  ensureListener,
  ensureProcesses,
  stoneReady,
  stoneState,
  waitForStoneReady,
} = await import('../processes');
const { parseGslist } = await import('../gslist');

function row(status: string, type: 'Stone' | 'Netldi', name: string): string {
  return `${status.padEnd(12)} 4.0.0.a4  me      79386 51475 Sep 28 19:31 ${type.padEnd(7)} ${name}`;
}

const STONE_UP = row('OK', 'Stone', 'gemdb');
const LISTENER_UP = row('OK', 'Netldi', 'gemdbldi');
const STONE_STARTING = row('Startup', 'Stone', 'gemdb');
const BOTH_UP = [STONE_UP, LISTENER_UP].join('\n');

let root: string;

beforeEach(() => {
  __resetSettings();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdb-start-'));
  __setSetting('gemdb.rootPath', root);
  fs.mkdirSync(path.join(expectedEnginePath(), 'bin'), { recursive: true });
  fs.writeFileSync(path.join(expectedEnginePath(), 'bin', 'gslist'), '');
  listings = [];
  gslistCalls = 0;
  listingAt = undefined;
  spawned.length = 0;
  satisfied = undefined;
  for (const key of Object.keys(exitCodes)) delete exitCodes[key];
});

/**
 * Run fake time forward in steps, letting the faked commands — which exit on a
 * real `setImmediate` — finish between them.
 */
async function runFakeTime(ms: number): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += 100) {
    await new Promise((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(100);
  }
}

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('ensureProcesses', () => {
  it('starts nothing, and says so, when both are already up', async () => {
    listings = [BOTH_UP];
    const beforeStoneStart = vi.fn();

    const started = await ensureProcesses({ beforeStoneStart });

    expect(started).toEqual({ startedStone: false, startedNetldi: false });
    expect(spawned).toEqual([]);
    expect(beforeStoneStart).not.toHaveBeenCalled();
  });

  it('asks gslist once and takes no lock when both are up, as every cell finds them', async () => {
    listings = [BOTH_UP];

    await ensureProcesses();

    expect(gslistCalls).toBe(1);
    expect(satisfied).toBeUndefined();
  });

  it('takes the lock and waits for a stone that is starting, even with a listener up', async () => {
    const starting = [STONE_STARTING, LISTENER_UP].join('\n');
    listings = [starting, starting, starting, BOTH_UP];
    const report = vi.fn();

    const started = await ensureProcesses({ report });

    expect(started).toEqual({ startedStone: false, startedNetldi: false });
    expect(satisfied).toBeDefined();
    expect(report).toHaveBeenCalledWith('Waiting for the database to finish starting…');
  });

  it('takes the lock for a stone that is shutting down, even with a listener up', async () => {
    listings = [[row('Shutdown', 'Stone', 'gemdb'), LISTENER_UP].join('\n')];

    await expect(ensureProcesses()).rejects.toThrow('The database is shutting down');
    expect(spawned).toEqual([]);
  });

  it('asks gslist no more often than before the fast path on a cold start', async () => {
    // Before the lock, inside it, and once the stone is up; the listener is
    // judged from that last one.
    listings = ['', '', STONE_UP];

    await ensureProcesses();

    expect(gslistCalls).toBe(3);
  });

  it('asks gslist one time fewer on a cold start when the caller just looked', async () => {
    listings = ['', STONE_UP];

    const started = await ensureProcesses({ listener: false, skipQuickCheck: true });

    expect(started).toEqual({ startedStone: true, startedNetldi: false });
    expect(gslistCalls).toBe(2);
  });

  it('still takes the lock and starts nothing when the stone turns out to be up', async () => {
    listings = [STONE_UP];

    const started = await ensureProcesses({ listener: false, skipQuickCheck: true });

    expect(started).toEqual({ startedStone: false, startedNetldi: false });
    expect(spawned).toEqual([]);
  });

  it('starts both, guards first, when neither is up', async () => {
    // Before the lock, inside it, then the stone after starting it.
    listings = ['', '', STONE_UP];
    const beforeStoneStart = vi.fn(() => {
      expect(spawned).toEqual([]);
    });

    const started = await ensureProcesses({ beforeStoneStart });

    expect(started).toEqual({ startedStone: true, startedNetldi: true });
    expect(spawned).toEqual(['startstone', 'startnetldi']);
    expect(beforeStoneStart).toHaveBeenCalledOnce();
  });

  it('starts only the listener when the stone is up, without the stone’s guards', async () => {
    listings = [STONE_UP];
    const beforeStoneStart = vi.fn();

    const started = await ensureProcesses({ beforeStoneStart });

    expect(started).toEqual({ startedStone: false, startedNetldi: true });
    expect(spawned).toEqual(['startnetldi']);
    expect(beforeStoneStart).not.toHaveBeenCalled();
  });

  it('starts no stone when a guard refuses it', async () => {
    listings = [''];

    const start = ensureProcesses({
      beforeStoneStart: () => {
        throw new Error('the database is on NFS');
      },
    });

    await expect(start).rejects.toThrow('the database is on NFS');
    expect(spawned).toEqual([]);
  });

  it('looks for the listener again after starting the stone, not at a list from before', async () => {
    // Another process started the listener while this one started the stone.
    listings = ['', '', BOTH_UP];

    const started = await ensureProcesses();

    expect(started).toEqual({ startedStone: true, startedNetldi: false });
    expect(spawned).toEqual(['startstone']);
  });

  it('counts a listener another process started first as up, not as a failure (#89)', async () => {
    // Both saw no listener; the other one won, so startnetldi refuses with
    // "already running" and the re-list shows the listener answering.
    exitCodes.startnetldi = 1;
    listings = [STONE_UP, STONE_UP, BOTH_UP];

    const started = await ensureProcesses();

    expect(started).toEqual({ startedStone: false, startedNetldi: false });
    expect(__log).toContain('Another process started the session listener.');
  });

  it('waits for a listener another process is still starting when the two overlap', async () => {
    // startnetldi gives up over the other's lock file before that one answers.
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    exitCodes.startnetldi = 3;
    listings = [STONE_UP, STONE_UP, STONE_UP, STONE_UP, BOTH_UP];

    const start = ensureProcesses();
    await runFakeTime(1_000);

    await expect(start).resolves.toEqual({ startedStone: false, startedNetldi: false });
  });

  it('still fails a listener start that leaves no listener up', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    exitCodes.startnetldi = 1;
    listings = [STONE_UP];

    const failed = expect(ensureProcesses()).rejects.toThrow(
      /Start session listener failed \(exit code 1\)/,
    );
    await runFakeTime(6_000);

    await failed;
  });

  it('still fails a listener start that leaves a listener that is not answering', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    exitCodes.startnetldi = 1;
    listings = [
      STONE_UP,
      STONE_UP,
      [STONE_UP, row('exe deleted', 'Netldi', 'gemdbldi')].join('\n'),
    ];

    const failed = expect(ensureProcesses()).rejects.toThrow(/Start session listener failed/);
    await runFakeTime(6_000);

    await failed;
  });

  it('asks gslist once inside the lock when only the listener is missing', async () => {
    listings = [STONE_UP];

    await ensureProcesses();

    expect(gslistCalls).toBe(2);
  });

  it('stops waiting for the lock only once both are up and answering', async () => {
    // Anything short of both up takes the lock, which is what records the wait.
    listings = [STONE_UP];
    await ensureProcesses();
    const check = async (listing: string): Promise<boolean | undefined> => {
      listings = [listing];
      return satisfied?.();
    };

    expect(await check(BOTH_UP)).toBe(true);
    expect(await check(STONE_UP)).toBe(false);
    expect(await check(LISTENER_UP)).toBe(false);
    expect(await check([STONE_STARTING, LISTENER_UP].join('\n'))).toBe(false);
  });
});

describe('starting the stone alone', () => {
  it('starts the stone, guards first, and never the listener', async () => {
    listings = ['', '', STONE_UP];
    const beforeStoneStart = vi.fn(() => {
      expect(spawned).toEqual([]);
    });

    const started = await ensureProcesses({ beforeStoneStart, listener: false });

    expect(started).toEqual({ startedStone: true, startedNetldi: false });
    expect(beforeStoneStart).toHaveBeenCalledTimes(1);
    expect(spawned).toEqual(['startstone']);
  });

  it('takes no lock for a stone that is up with no listener', async () => {
    listings = [STONE_UP];

    const started = await ensureProcesses({ listener: false });

    expect(started).toEqual({ startedStone: false, startedNetldi: false });
    expect(gslistCalls).toBe(1);
    expect(satisfied).toBeUndefined();
    expect(spawned).toEqual([]);
  });

  it('still waits for a stone that is starting, and starts no listener beside it', async () => {
    listings = [STONE_STARTING, STONE_STARTING, STONE_UP];

    const started = await ensureProcesses({ listener: false });

    expect(started).toEqual({ startedStone: false, startedNetldi: false });
    expect(spawned).toEqual([]);
  });

  it('stops waiting for the lock once the stone is up, listener or not', async () => {
    listings = [STONE_STARTING];
    const done = ensureProcesses({ listener: false });
    await new Promise((resolve) => setImmediate(resolve));
    listings = [STONE_UP];

    expect(await satisfied?.()).toBe(true);
    await done;
  });
});

describe('a stone that is still starting', () => {
  it('is listed, but not ready for a login', () => {
    const processes = parseGslist(STONE_STARTING);

    expect(processes).toHaveLength(1);
    expect(stoneReady(processes)).toBe(false);
  });

  it('is waited for until it reports OK', async () => {
    listings = [STONE_STARTING, STONE_STARTING, STONE_UP];
    const report = vi.fn();

    await waitForStoneReady(report, { pollMs: 1 });

    expect(report).toHaveBeenCalledWith('Waiting for the database to finish starting…');
    expect(listings).toEqual([STONE_UP]);
  });

  it('is given up on after the timeout, naming the stone’s log', async () => {
    listings = [STONE_STARTING];

    const wait = waitForStoneReady(undefined, { pollMs: 1, timeoutMs: 20 });

    await expect(wait).rejects.toThrow(/starting for over a minute\. See .*gemdb\.log/);
  });

  it('is an error when it disappears instead of finishing', async () => {
    listings = [STONE_STARTING, ''];

    const wait = waitForStoneReady(undefined, { pollMs: 1 });

    await expect(wait).rejects.toThrow(/stopped while it was starting/);
  });

  it('holds back the listener until it is ready', async () => {
    listings = [STONE_STARTING, STONE_STARTING, STONE_STARTING, STONE_UP];
    const report = vi.fn();

    const started = await ensureProcesses({ report });

    expect(started).toEqual({ startedStone: false, startedNetldi: true });
    expect(report.mock.calls.map(([message]) => message)).toEqual([
      'Waiting for the database to finish starting…',
      'Starting the session listener…',
    ]);
  });
});

describe('what the stone’s status means', () => {
  const stateOf = (status: string): string =>
    stoneState(parseGslist(row(status, 'Stone', 'gemdb')));

  it('reads the statuses the engine prints, whatever their case', () => {
    expect(stateOf('OK')).toBe('ready');
    expect(stateOf('Startup')).toBe('starting');
    expect(stateOf('recovery')).toBe('starting');
    expect(stateOf('Shutdown')).toBe('stopping');
    expect(stoneState([])).toBe('absent');
  });

  it('leaves every other listed status to the login, as before GemDB waited for OK', () => {
    for (const status of ['exe deleted', 'frozen', 'full', 'killed', 'exists', 'restoreBkup']) {
      expect(stateOf(status)).toBe('other');
    }
  });

  it('does not wait on a stone that is listed but neither OK nor starting', async () => {
    listings = [row('exe deleted', 'Stone', 'gemdb')];

    await waitForStoneReady(undefined, { pollMs: 1, timeoutMs: 20 });
  });

  it('says a stone at Shutdown is shutting down, without waiting on it', async () => {
    listings = [row('Shutdown', 'Stone', 'gemdb')];

    await expect(waitForStoneReady(undefined, { pollMs: 1, timeoutMs: 1000 })).rejects.toThrow(
      'The database is shutting down',
    );
  });

  it('starts nothing beside a stone that is shutting down', async () => {
    listings = [row('Shutdown', 'Stone', 'gemdb')];

    await expect(ensureProcesses()).rejects.toThrow('The database is shutting down');
    expect(spawned).toEqual([]);
  });

  it('brings the listener up beside a stone in any other listed state', async () => {
    listings = [row('exe deleted', 'Stone', 'gemdb')];
    const beforeStoneStart = vi.fn();

    const started = await ensureProcesses({ beforeStoneStart });

    expect(started).toEqual({ startedStone: false, startedNetldi: true });
    expect(spawned).toEqual(['startnetldi']);
    expect(beforeStoneStart).not.toHaveBeenCalled();
  });
});

describe('putting the listener back after a declined force-stop', () => {
  it('starts the listener beside a stone that is still up', async () => {
    listings = [STONE_UP];

    expect(await ensureListener()).toBe(true);
    expect(spawned).toEqual(['startnetldi']);
  });

  it('starts nothing when the stone went away while the user was deciding', async () => {
    listings = [''];

    expect(await ensureListener()).toBe(false);
    expect(spawned).toEqual([]);
  });

  it('starts nothing beside a stone that is shutting down', async () => {
    listings = [row('Shutdown', 'Stone', 'gemdb')];

    expect(await ensureListener()).toBe(false);
    expect(spawned).toEqual([]);
  });

  it('starts nothing when the listener is already back', async () => {
    listings = [BOTH_UP];

    expect(await ensureListener()).toBe(false);
    expect(spawned).toEqual([]);
  });
});

/**
 * Queued behind a start that holds the stone lock for longer than a minute,
 * which the holder can: guards, startstone, a minute's wait for the stone and
 * startnetldi, all inside the lock. The holder here is another live process.
 */
describe('waiting for the stone lock', () => {
  /** Hold the lock as `pid` would, from now until `releaseAfterMs`, if given. */
  function holdLock(pid: number, releaseAfterMs?: number): void {
    const lock = path.join(root, STONE_LOCK_NAME);
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'pid'), `${pid}\n`);
    if (releaseAfterMs !== undefined) {
      setTimeout(() => fs.rmSync(lock, { recursive: true, force: true }), releaseAfterMs);
    }
  }

  /** Settle `promise` while fake time runs `ms`, so a rejection is never left unhandled. */
  async function after<T>(
    promise: Promise<T>,
    ms: number,
  ): Promise<{ value?: T; error?: Error; settled: boolean }> {
    const outcome: { value?: T; error?: Error; settled: boolean } = { settled: false };
    promise.then(
      (value) => Object.assign(outcome, { value, settled: true }),
      (error: Error) => Object.assign(outcome, { error, settled: true }),
    );
    await vi.advanceTimersByTimeAsync(ms);
    return outcome;
  }

  it('outlasts a minute while the holder is visibly starting the stone', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    const t0 = Date.now();
    // startstone for 20 s, then 50 s at Startup, then both up.
    listingAt = (now) => (now - t0 < 20_000 ? '' : now - t0 < 70_000 ? STONE_STARTING : BOTH_UP);
    holdLock(process.ppid, 70_000);

    const outcome = await after(ensureProcesses(), 75_000);

    expect(outcome.error).toBeUndefined();
    expect(outcome.value).toEqual({ startedStone: false, startedNetldi: false });
    expect(spawned).toEqual([]);
  });

  it('still gives up after a minute on a holder that shows nothing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    listingAt = () => '';
    holdLock(process.ppid);

    const start = ensureProcesses();
    expect((await after(start, 59_000)).settled).toBe(false);
    const outcome = await after(start, 2_000);

    expect(outcome.error?.message).toMatch(/Another process has been starting the database/);
  });

  it('gives up on a stone that never finishes starting, past the holder’s worst case', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    listingAt = () => STONE_STARTING;
    holdLock(process.ppid);

    const start = ensureProcesses();
    expect((await after(start, 140_000)).settled).toBe(false);
    const outcome = await after(start, 15_000);

    expect(outcome.error?.message).toMatch(/Another process has been starting the database/);
  });

  it('says it is this window that is starting the database when it is', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    listingAt = () => '';
    holdLock(process.pid);

    const outcome = await after(ensureProcesses(), 65_000);

    expect(outcome.error?.message).toMatch(/^This window has been starting the database/);
    expect(outcome.error?.message).toContain(STONE_LOCK_NAME);
  });
});

describe('checking an external database', () => {
  const EXTERNAL_STONE = row('OK', 'Stone', 'gs64stone');
  const EXTERNAL_LISTENER = row('OK', 'Netldi', 'gs64ldi');

  beforeEach(() => {
    const gemstone = path.join(root, 'external');
    fs.mkdirSync(path.join(gemstone, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(gemstone, 'bin', 'gslist'), '');
    __setSetting('gemdb.externalDatabase.gemstone', gemstone);
  });

  it('passes when the stone and the listener are up', async () => {
    listings = [[EXTERNAL_STONE, EXTERNAL_LISTENER].join('\n')];

    await expect(assertExternalDatabaseUp({ listener: true })).resolves.toBeUndefined();
  });

  it('says the administrator runs it when there is no stone, without waiting', async () => {
    listings = [''];

    await expect(assertExternalDatabaseUp({ listener: false })).rejects.toThrow(
      /administrator runs\. Ask them to start it/,
    );
    expect(gslistCalls).toBe(1);
  });

  it('waits for a stone that is still starting', async () => {
    const starting = row('Startup', 'Stone', 'gs64stone');
    listings = [starting, starting, [EXTERNAL_STONE, EXTERNAL_LISTENER].join('\n')];
    const report = vi.fn();

    await assertExternalDatabaseUp({ listener: true, report });

    expect(report).toHaveBeenCalledWith('Waiting for the database to finish starting…');
  });

  it('names no log of ours when a stone is still starting after a minute', async () => {
    listings = [row('Startup', 'Stone', 'gs64stone')];

    const failure = await waitForStoneReady(undefined, { pollMs: 1, timeoutMs: 20 }).catch(
      (e: Error) => e,
    );

    expect((failure as Error).message).toBe('The database has been starting for over a minute.');
  });

  it('says the administrator runs it for a stone at Shutdown, even after it was starting', async () => {
    listings = [row('Startup', 'Stone', 'gs64stone'), row('Shutdown', 'Stone', 'gs64stone')];

    await expect(assertExternalDatabaseUp({ listener: true })).rejects.toThrow(
      EXTERNAL_SHUTTING_DOWN_MESSAGE,
    );
  });

  it('names no log of ours when a stone that was starting disappears', async () => {
    listings = [row('Startup', 'Stone', 'gs64stone'), ''];

    const failure = await assertExternalDatabaseUp({ listener: false }).catch((e: Error) => e);

    expect((failure as Error).message).toBe('The database stopped while it was starting.');
  });

  it('requires a listener only when asked to', async () => {
    listings = [EXTERNAL_STONE];

    await expect(assertExternalDatabaseUp({ listener: false })).resolves.toBeUndefined();
    await expect(assertExternalDatabaseUp({ listener: true })).rejects.toThrow(
      /NetLDI gs64ldi.*administrator runs/,
    );
  });
});
