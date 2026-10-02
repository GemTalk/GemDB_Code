import * as fs from 'fs';
import * as path from 'path';
import { rootPath } from './config';
import { log } from './log';
import { ensureRootPath } from './paths';

/**
 * A lock shared by every VS Code window on this machine.
 *
 * Setup runs unattended when the extension activates, and activation happens in
 * every window — so opening two projects at once would otherwise have two
 * downloads appending to the same partial file and corrupting it. The lock is a
 * file whose existence is the claim, created with the exclusive flag so the
 * check and the claim cannot interleave.
 *
 * It records the owning process so a lock left behind by a crash can be told
 * from one held by a window that is still running, rather than blocking setup
 * until someone deletes a file they have never heard of.
 */
function lockPath(): string {
  return path.join(rootPath(), '.gemdb-setup.lock');
}

/** True when `pid` is a live process belonging to this user. */
function isAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission and existence checks without delivering
    // anything, which is exactly the question being asked.
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means it exists but belongs to someone else — still alive.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Whether this process already holds the lock.
 *
 * The file alone cannot answer that. A lock file naming *our own* pid is
 * ambiguous — it could be a call already in flight, or debris from one that
 * died earlier in this same process — and the two need opposite responses.
 * This flag disambiguates, and it also closes the window between two calls in
 * one process checking the file and writing it.
 *
 * It is set synchronously on acquisition, before the first `await`, so a second
 * caller entering while the first is running always sees it.
 */
let heldHere = false;

/**
 * Run `work` while holding the setup lock, or return undefined without running
 * it if the lock is held elsewhere.
 */
export async function withSetupLock<T>(work: () => Promise<T>): Promise<T | undefined> {
  if (heldHere) return undefined;

  const claim = claimSetupLock();
  if (typeof claim !== 'object') {
    if (claim !== false) {
      log(`${anotherWindow(claim)} is already setting GemDB up; leaving it to that one.`);
    }
    return undefined;
  }
  return holdingSetupLock(claim, work);
}

/**
 * Run `work` while holding the setup lock, waiting for another window to
 * release it first.
 *
 * For a setup someone asked for — Set Up GemDB, Start, a notebook cell — where
 * stepping aside as `withSetupLock` does would leave them with nothing, and
 * going ahead regardless is two windows downloading into one partial file
 * (#68). `onWaiting` is called once, when it turns out there is a wait, so the
 * caller can say so; `stopWaiting` is asked between polls, and returning true
 * ends the wait with undefined and `work` not run.
 *
 * A caller in this process that already holds the lock runs straight through.
 * Within one process the lock is not what keeps setups apart — `runSetup`
 * allows one at a time — and the first-run setup takes the lock before it
 * reaches `runSetup`, so waiting here would be waiting on itself.
 */
export async function withSetupLockWhenFree<T>(
  work: () => Promise<T>,
  wait: { onWaiting: () => void; stopWaiting: () => boolean; pollMs?: number },
): Promise<T | undefined> {
  if (heldHere) return work();

  let waiting = false;
  for (;;) {
    const claim = claimSetupLock();
    if (typeof claim === 'object') return holdingSetupLock(claim, work);
    if (!waiting) {
      waiting = true;
      if (claim !== false) {
        log(`${anotherWindow(claim)} is setting GemDB up; waiting for it to finish.`);
      }
      wait.onWaiting();
    }
    await new Promise((resolve) => setTimeout(resolve, wait.pollMs ?? 1000));
    if (wait.stopWaiting()) return undefined;
  }
}

/**
 * A claim on the setup lock: the lock file this process created, held open.
 *
 * Held open because that is what makes the file's identity a proof of
 * ownership. An inode number alone is not: ext4 hands a freed number to the
 * next file created, and a lock deleted and re-created while we worked came
 * back with ours — and with the same change time, to the nanosecond — in CI.
 * A file that is still open cannot be freed, so a replacement must get a
 * different number, and the open file reports no links once it is deleted.
 * The same check FreeBSD's flopen(3) and Python's filelock make.
 */
interface SetupLockClaim {
  fd: number;
}

/**
 * Try to take the setup lock: a claim when this process now holds it, the
 * holder's pid when a live process does, false when a stale lock could not be
 * taken over.
 */
function claimSetupLock(): SetupLockClaim | number | false {
  ensureRootPath();
  const file = lockPath();

  const created = createSetupLock(file);
  if (created) return created;

  const owner = setupLockOwner(file);
  if (owner !== undefined) return owner;

  // Stale: the owner is gone, the file is rubbish, or it names this process
  // while `heldHere` says otherwise — debris from a call that died. Taking it
  // over is unlink-then-create, which two windows that both judged it stale
  // could otherwise each do in turn, both "winning" (H5). The guard makes
  // stealing one at a time, and the re-check inside it is what stops the
  // second stealer deleting the first one's fresh, live lock.
  const stolen = withStealGuard(file, () => {
    const stillHeld = setupLockOwner(file);
    if (stillHeld !== undefined) return stillHeld;
    log('Clearing a setup lock left behind by a previous session.');
    fs.rmSync(file, { force: true });
    return createSetupLock(file) ?? false;
  });
  return stolen ?? false;
}

/**
 * Create the lock file exclusively and keep it open, or undefined when it
 * already exists. Still a bare pid inside, so an older GemDB Code reading it
 * sees the lock it always did.
 */
function createSetupLock(file: string): SetupLockClaim | undefined {
  let fd: number;
  try {
    fd = fs.openSync(file, 'wx');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return undefined;
    throw e;
  }
  try {
    fs.writeSync(fd, String(process.pid));
  } catch (e) {
    fs.closeSync(fd);
    throw e;
  }
  return { fd };
}

/**
 * The pid of a live process holding the setup lock, or undefined when the
 * lock is stale (or gone). This process counts as a holder only while
 * `heldHere` says it is one.
 *
 * An empty lock is one being taken right now — the create and the pid write
 * are two steps — so it is held, by a pid not known yet (0), until it is older
 * than {@link STALE_AFTER_MS}. Judging it stale at once would let a second
 * window delete it from under the first and both run setup (H5).
 */
function setupLockOwner(file: string): number | undefined {
  const text = safeRead(file);
  if (text === '') return olderThan(file, STALE_AFTER_MS) ? undefined : 0;
  const owner = Number(text);
  if (!Number.isInteger(owner) || owner <= 0) return undefined;
  if (owner === process.pid) return heldHere ? owner : undefined;
  return isAlive(owner) ? owner : undefined;
}

/** "Another window", naming its process when the lock says which. */
function anotherWindow(owner: number): string {
  return owner > 0 ? `Another window (process ${owner})` : 'Another window';
}

/**
 * Who holds the setup lock, for `withRootLock`'s messages: unlike the
 * `withSetupLock*` paths it does not check `heldHere` first, so the holder can
 * be a legacy `withSetupLock` call in this very window.
 */
function setupLockHolder(owner: number): string {
  return owner === process.pid ? 'This window' : anotherWindow(owner);
}

/** Run `work` under a lock `claimSetupLock` just took, and release it after. */
async function holdingSetupLock<T>(claim: SetupLockClaim, work: () => Promise<T>): Promise<T> {
  const file = lockPath();
  heldHere = true;
  try {
    return await work();
  } finally {
    heldHere = false;
    await releaseSetupLock(file, claim);
  }
}

/**
 * Delete the lock file if it is still the one `claim` created, then close it.
 *
 * Under the steal guard, because nothing in POSIX deletes a path only if it is
 * still a given file: between the check and the unlink, a stealer could swap
 * in a lock of its own and we would delete that. The guard is held for
 * microseconds, so waiting a little for it is fine; one older than
 * {@link STALE_AFTER_MS} is cleared by `withStealGuard` itself.
 */
async function releaseSetupLock(file: string, claim: SetupLockClaim): Promise<void> {
  const giveUpAt = Date.now() + STALE_AFTER_MS + 1000;
  try {
    while (
      withStealGuard(file, () => {
        if (stillOurs(file, claim)) fs.unlinkSync(file);
        return true;
      }) === undefined
    ) {
      if (Date.now() > giveUpAt) {
        log(`Could not release ${file}; it is recovered as stale once this window closes.`);
        return;
      }
      await sleep(20);
    }
  } catch {
    /* a leftover lock is recovered as stale next time */
  } finally {
    fs.closeSync(claim.fd);
  }
}

/**
 * Whether the file at `file` is still the one `claim` holds open. The pid
 * alone cannot say so — a window that took the lock over from a dead process
 * with this pid would match — so the open file's identity is the proof.
 */
function stillOurs(file: string, claim: SetupLockClaim): boolean {
  const held = fs.fstatSync(claim.fd);
  if (held.nlink === 0) return false;
  let atPath: fs.Stats;
  try {
    atPath = fs.statSync(file);
  } catch {
    return false;
  }
  return (
    atPath.dev === held.dev && atPath.ino === held.ino && safeRead(file) === String(process.pid)
  );
}

/** How old a steal guard, or a lock with no pid written, must be to be debris. */
const STALE_AFTER_MS = 5000;

/**
 * Run `steal` holding `<lock>.steal`, or return undefined without running it
 * when another process holds the guard.
 *
 * A guard is held for the microseconds an unlink and a create take, so one
 * older than {@link STALE_AFTER_MS} belongs to a process that died inside it
 * and is cleared. `mkdir` is the primitive because the generated wrapper's
 * bash takes the same guard on the stone lock.
 */
function withStealGuard<T>(lock: string, steal: () => T): T | undefined {
  const guard = `${lock}.steal`;
  if (!makeDirectory(guard) && !takeStaleGuard(guard)) return undefined;
  try {
    return steal();
  } finally {
    fs.rmSync(guard, { recursive: true, force: true });
  }
}

let tombs = 0;

/**
 * Clear a guard older than {@link STALE_AFTER_MS} and take a fresh one; false
 * when it is not stale or someone else got there first.
 *
 * Not delete-then-mkdir: two processes that both saw the dead guard would
 * each delete in turn, the second removing the first one's fresh guard, and
 * both be inside (H5 one level up). Renaming it to a name of our own instead
 * puts it where only we look, so we can check it is the guard we judged
 * stale: same inode and same mtime, the mtime catching an inode the
 * filesystem reused for a fresh guard. If it is not — someone cleared the
 * dead one and took a live one since — we moved a live guard, and put one
 * back with `mkdir`: its holder's release goes by path, so any guard there
 * will do. Never by renaming the tomb back, which would silently replace a
 * third process's empty guard.
 *
 * That closes the two-stealer race, not every one. A path cannot be
 * compared-and-swapped, so while a live guard we moved by mistake is away, a
 * third process's plain `mkdir` can get in beside its holder; and if the
 * holder releases in that gap, the guard we put back has no holder and blocks
 * stealing until it is stale. Both need a guard left by a dead stealer and
 * three stealers at once. Locks the kernel releases (flock) close it: Step 5.
 */
function takeStaleGuard(guard: string): boolean {
  let seen: fs.Stats;
  try {
    seen = fs.statSync(guard);
  } catch {
    return false;
  }
  if (Date.now() - seen.mtimeMs <= STALE_AFTER_MS) return false;
  const tomb = `${guard}.${process.pid}.${++tombs}.${Math.random().toString(36).slice(2)}`;
  try {
    fs.renameSync(guard, tomb);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
  try {
    const moved = fs.statSync(tomb);
    if (moved.dev !== seen.dev || moved.ino !== seen.ino || moved.mtimeMs !== seen.mtimeMs) {
      makeDirectory(guard);
      return false;
    }
    return makeDirectory(guard);
  } finally {
    fs.rmSync(tomb, { recursive: true, force: true });
  }
}

/** `mkdir`, answering false where the directory already exists. */
function makeDirectory(dir: string): boolean {
  try {
    fs.mkdirSync(dir);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
}

/** True when `file` exists and was last modified more than `ms` ago. */
function olderThan(file: string, ms: number): boolean {
  try {
    return Date.now() - fs.statSync(file).mtimeMs > ms;
  } catch {
    return false;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One holder at a time within this process, for {@link withRootLock}.
 *
 * The file lock cannot do this on its own: every caller in one extension host
 * has the same pid, so the file answers "this process holds it" and not
 * "this call does". Taken before the file lock, so callers in one window
 * queue here rather than polling the file against each other.
 */
let mutexHeld = false;
const mutexQueue: Array<() => void> = [];

function tryTakeMutex(): boolean {
  if (mutexHeld) return false;
  mutexHeld = true;
  return true;
}

/**
 * Wait for the mutex, asking `stopWaiting` every `pollMs`. True once it is
 * held, false when the wait was abandoned.
 */
async function takeMutex(stopWaiting: () => boolean, pollMs: number): Promise<boolean> {
  if (tryTakeMutex()) return true;
  let granted = false;
  let wake = (): void => {};
  const handedOver = new Promise<void>((resolve) => (wake = resolve));
  const grant = (): void => {
    granted = true;
    wake();
  };
  mutexQueue.push(grant);
  for (;;) {
    await Promise.race([handedOver, sleep(pollMs)]);
    if (granted) return true;
    if (stopWaiting()) {
      mutexQueue.splice(mutexQueue.indexOf(grant), 1);
      return false;
    }
  }
}

/** Hand the mutex to the next caller in the queue, or free it. */
function releaseMutex(): void {
  const next = mutexQueue.shift();
  if (next) next();
  else mutexHeld = false;
}

export interface RootLockOptions {
  /** `skip` returns undefined at once when the lock is held; `wait` waits. */
  contention: 'skip' | 'wait';
  /**
   * Asked once both locks are held; false returns undefined with `work` not
   * run. The place for "is this still needed?", since the answer can change
   * while waiting — whoever held the lock was most likely doing the same job.
   */
  precondition?: () => boolean | Promise<boolean>;
  /** Called once, when it turns out there is a wait. */
  onWaiting?: () => void;
  /** Asked between polls; true ends the wait with undefined. */
  stopWaiting?: () => boolean;
  pollMs?: number;
}

/**
 * Run `work` holding the in-process mutex and then the setup lock, or return
 * undefined without running it — when `contention` is `skip` and either is
 * held, when a wait is stopped, or when `precondition` says no.
 */
export async function withRootLock<T>(
  options: RootLockOptions,
  work: () => Promise<T>,
): Promise<T | undefined> {
  const pollMs = options.pollMs ?? 1000;
  const stopWaiting = options.stopWaiting ?? (() => false);
  let waiting = false;
  const announceWait = (): void => {
    if (waiting) return;
    waiting = true;
    options.onWaiting?.();
  };

  if (!tryTakeMutex()) {
    if (options.contention === 'skip') return undefined;
    announceWait();
    if (!(await takeMutex(stopWaiting, pollMs))) return undefined;
  }
  try {
    for (;;) {
      const claim = claimSetupLock();
      if (typeof claim === 'object') {
        return await holdingSetupLock(claim, async () =>
          (await (options.precondition?.() ?? true)) ? work() : undefined,
        );
      }
      if (options.contention === 'skip') {
        if (claim !== false) log(`${setupLockHolder(claim)} holds the setup lock.`);
        return undefined;
      }
      if (!waiting && claim !== false) {
        log(`${setupLockHolder(claim)} holds the setup lock; waiting for it.`);
      }
      announceWait();
      await sleep(pollMs);
      if (stopWaiting()) return undefined;
    }
  } finally {
    releaseMutex();
  }
}

function safeRead(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return undefined;
  }
}

/**
 * The name of the stone lock, shared with the generated `gemdb` wrapper.
 *
 * Exported because the wrapper takes the same lock in shell, and a lock each
 * would not be a lock at all: both doors start the same stone -- the editor on
 * activation, a terminal command on any invocation -- and two commands close
 * together is all it takes. Two stoned processes held one extent0.dbf
 * read-write for a week on a developer machine before anyone noticed, because
 * gslist keys Stone rows by name and shows one row for two stones.
 */
export const STONE_LOCK_NAME = '.gemdb-stone.lock';

function stoneLockPath(): string {
  return path.join(rootPath(), STONE_LOCK_NAME);
}

/** How often, and for how long, {@link withStoneLock} waits for the lock. */
const STONE_LOCK_POLL_MS = 200;
const STONE_LOCK_TIMEOUT_MS = 60_000;

/**
 * Run `work` while holding the stone lock, waiting for another process to
 * release it first.
 *
 * A DIRECTORY rather than a file, unlike the setup lock above: `mkdir` is the
 * atomic create-or-fail primitive available to both this and the shell
 * wrapper, and `flock` is not on a stock macOS. The owning pid goes in a file
 * inside it, so a lock left by a crash can be told from one held by a live
 * process -- the same test the wrapper makes.
 *
 * Waiting is the point: a caller that stepped aside used to carry on as if
 * the stone were up — to the listener and the Grail file-in — while the
 * wrapper was still starting it. `satisfied` is asked between polls, and true
 * ends the wait with undefined and `work` not run: for `startStone`, the stone
 * came up while we waited, which is what we were waiting for. A lock still
 * held after a minute is an error naming it, since only a person can say
 * whether whatever holds it is really still working.
 */
export async function withStoneLock<T>(
  work: () => Promise<T>,
  wait: { satisfied?: () => boolean | Promise<boolean>; pollMs?: number; timeoutMs?: number } = {},
): Promise<T | undefined> {
  const lock = stoneLockPath();
  ensureRootPath();
  const deadline = Date.now() + (wait.timeoutMs ?? STONE_LOCK_TIMEOUT_MS);
  let logged = false;

  while (!claimStoneLock(lock)) {
    if (!logged) {
      logged = true;
      log('Another process is starting the database; waiting for it.');
    }
    await sleep(wait.pollMs ?? STONE_LOCK_POLL_MS);
    if (await wait.satisfied?.()) return undefined;
    if (Date.now() > deadline) {
      throw new Error(
        `Another process has been starting the database for over a minute. ` +
          `If nothing is, remove ${lock} and try again.`,
      );
    }
  }

  try {
    return await work();
  } finally {
    // Only our own lock: one taken over as stale while we worked belongs to
    // whoever took it, and deleting it would let a third process in beside them.
    if (readStoneLockPid(lock) === String(process.pid)) {
      fs.rmSync(lock, { recursive: true, force: true });
    }
  }
}

/** Take the stone lock, stealing it if stale; false when someone holds it. */
function claimStoneLock(lock: string): boolean {
  if (createStoneLock(lock)) return true;
  if (!stoneLockIsStale(lock)) return false;
  // Debris from a crash, or a lock we cannot read: taking it is better than
  // blocking every later start on a file nobody has heard of. Under the guard,
  // and re-checked inside it, so two stealers cannot both win.
  return (
    withStealGuard(lock, () => {
      if (!stoneLockIsStale(lock)) return false;
      log('Clearing a stone lock left behind by a previous session.');
      fs.rmSync(lock, { recursive: true, force: true });
      return createStoneLock(lock);
    }) ?? false
  );
}

/**
 * `mkdir` the lock and write our pid into it. The pid goes to a temporary
 * name first and is renamed in, so a reader sees the whole pid or none.
 */
function createStoneLock(lock: string): boolean {
  if (!makeDirectory(lock)) return false;
  const pidFile = path.join(lock, 'pid');
  fs.writeFileSync(`${pidFile}.tmp`, `${process.pid}\n`);
  fs.renameSync(`${pidFile}.tmp`, pidFile);
  return true;
}

/**
 * Whether the stone lock is debris. A lock with no pid yet is one being taken
 * right now — `mkdir` and the pid write are two steps on both sides — so it is
 * stale only once it is older than {@link STALE_AFTER_MS}. A lock that is gone
 * is not stale: the next `mkdir` takes it.
 */
function stoneLockIsStale(lock: string): boolean {
  if (!fs.existsSync(lock)) return false;
  const text = readStoneLockPid(lock);
  const owner = Number(text);
  if (!text || !Number.isInteger(owner) || owner <= 0) return olderThan(lock, STALE_AFTER_MS);
  return !isAlive(owner);
}

function readStoneLockPid(lock: string): string | undefined {
  return safeRead(path.join(lock, 'pid'));
}
