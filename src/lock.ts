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

  ensureRootPath();
  const file = lockPath();

  try {
    fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;

    const owner = Number(safeRead(file));
    if (Number.isInteger(owner) && owner !== process.pid && isAlive(owner)) {
      log(`Another window (process ${owner}) is already setting GemDB up; leaving it to that one.`);
      return undefined;
    }

    // Stale: the owner is gone, the file is rubbish, or it names this process
    // while `heldHere` says otherwise — debris from a call that died.
    log('Clearing a setup lock left behind by a previous session.');
    try {
      fs.writeFileSync(file, String(process.pid));
    } catch {
      return undefined;
    }
  }

  heldHere = true;
  try {
    return await work();
  } finally {
    heldHere = false;
    try {
      // Only drop the lock if it is still ours — a stale-takeover elsewhere
      // could have reassigned it.
      if (safeRead(file) === String(process.pid)) fs.unlinkSync(file);
    } catch {
      /* a leftover lock is recovered as stale next time */
    }
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

/**
 * Run `work` while holding the stone lock, or return undefined without running
 * it if another process is starting the stone.
 *
 * A DIRECTORY rather than a file, unlike the setup lock above: `mkdir` is the
 * atomic create-or-fail primitive available to both this and the shell
 * wrapper, and `flock` is not on a stock macOS. The owning pid goes in a file
 * inside it, so a lock left by a crash can be told from one held by a live
 * process -- the same test the wrapper makes.
 */
export async function withStoneLock<T>(work: () => Promise<T>): Promise<T | undefined> {
  const lock = stoneLockPath();
  ensureRootPath();

  try {
    fs.mkdirSync(lock);
  } catch {
    const owner = Number(
      (() => {
        try {
          return fs.readFileSync(path.join(lock, 'pid'), 'utf8').trim();
        } catch {
          return '';
        }
      })(),
    );
    if (owner && isAlive(owner)) {
      log(`Another process (${owner}) is starting the database; leaving it to them.`);
      return undefined;
    }
    // Debris from a crash, or a lock we cannot read: taking it is better than
    // blocking every later start on a file nobody has heard of.
    fs.rmSync(lock, { recursive: true, force: true });
    fs.mkdirSync(lock);
  }

  try {
    fs.writeFileSync(path.join(lock, 'pid'), `${process.pid}\n`);
    return await work();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}
