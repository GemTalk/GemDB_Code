import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetSettings, __setSetting } from '../__mocks__/vscode';
import { STONE_LOCK_NAME, withSetupLock, withSetupLockWhenFree, withStoneLock } from '../lock';

// Setup runs unattended when the extension activates, and activation happens in
// every open window — so this lock is what stands between one download and two
// processes appending to the same partial file. Its failure modes are all
// concurrency-shaped and invisible in ordinary use, which is exactly why they
// are worth pinning down here.

let root: string;

function lockFile(): string {
  return path.join(root, '.gemdb-setup.lock');
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdb-lock-'));
  __setSetting('gemdb.rootPath', root);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  __resetSettings();
});

describe('withSetupLock', () => {
  it('runs the work and returns its result', async () => {
    expect(await withSetupLock(async () => 'done')).toBe('done');
  });

  it('releases the lock afterwards, so a later run can take it', async () => {
    await withSetupLock(async () => 'first');
    expect(fs.existsSync(lockFile())).toBe(false);
    expect(await withSetupLock(async () => 'second')).toBe('second');
  });

  it('releases the lock when the work throws', async () => {
    await expect(withSetupLock(async () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );
    expect(fs.existsSync(lockFile())).toBe(false);
  });

  it('declines when a live process already holds the lock', async () => {
    // process.pid is alive by definition, and is not this run's claim only
    // because the lock is written before the work begins — so write a
    // different, definitely-live pid: our parent.
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(lockFile(), String(process.ppid));

    let ran = false;
    const result = await withSetupLock(async () => {
      ran = true;
      return 'should not happen';
    });

    expect(result).toBeUndefined();
    expect(ran).toBe(false);
    // The other holder's claim must survive — releasing it would be worse than
    // declining, since the running download would then have no lock at all.
    expect(fs.readFileSync(lockFile(), 'utf8')).toBe(String(process.ppid));
  });

  it('takes over a lock whose owner is gone', async () => {
    fs.mkdirSync(root, { recursive: true });
    // PID 2^22 is above the maximum on both Linux and macOS, so it cannot be
    // a live process and cannot be reused between writing this and reading it.
    fs.writeFileSync(lockFile(), String(4194304));

    expect(await withSetupLock(async () => 'recovered')).toBe('recovered');
    expect(fs.existsSync(lockFile())).toBe(false);
  });

  it('takes over a lock file that is unreadable rubbish', async () => {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(lockFile(), 'not a pid');

    expect(await withSetupLock(async () => 'recovered')).toBe('recovered');
  });

  it('serializes concurrent callers rather than running both', async () => {
    // The real hazard: two windows activating together. Exactly one should do
    // the work; the other must step aside rather than wait and then repeat it.
    let running = 0;
    let overlapped = false;
    const work = async (): Promise<string> => {
      running += 1;
      if (running > 1) overlapped = true;
      await new Promise((r) => setTimeout(r, 20));
      running -= 1;
      return 'worked';
    };

    const results = await Promise.all([withSetupLock(work), withSetupLock(work)]);

    expect(overlapped).toBe(false);
    expect(results.filter((r) => r === 'worked')).toHaveLength(1);
    expect(results.filter((r) => r === undefined)).toHaveLength(1);
  });
});

/**
 * The waiting form, for a setup someone asked for. Stepping aside would leave
 * them with nothing, and going ahead is two downloads into one file (#68).
 */
describe('withSetupLockWhenFree', () => {
  const neverStop = { onWaiting: () => {}, stopWaiting: () => false, pollMs: 5 };

  it('runs at once when nothing holds the lock, and releases it afterwards', async () => {
    let waited = false;

    const result = await withSetupLockWhenFree(async () => 'done', {
      ...neverStop,
      onWaiting: () => (waited = true),
    });

    expect(result).toBe('done');
    expect(waited).toBe(false);
    expect(fs.existsSync(lockFile())).toBe(false);
  });

  it('waits for another process to release the lock, then runs', async () => {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(lockFile(), String(process.ppid));
    const onWaiting = vi.fn();
    setTimeout(() => fs.unlinkSync(lockFile()), 30);

    const result = await withSetupLockWhenFree(async () => 'ran', { ...neverStop, onWaiting });

    expect(result).toBe('ran');
    expect(onWaiting).toHaveBeenCalledTimes(1);
  });

  it('gives up without running when told to stop waiting', async () => {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(lockFile(), String(process.ppid));
    let ran = false;

    const result = await withSetupLockWhenFree(
      async () => {
        ran = true;
      },
      { ...neverStop, stopWaiting: () => true },
    );

    expect(result).toBeUndefined();
    expect(ran).toBe(false);
    expect(fs.readFileSync(lockFile(), 'utf8')).toBe(String(process.ppid));
  });

  it('runs straight through for a caller in this process that already holds the lock', async () => {
    // The first-run setup takes the lock and then reaches the setup body that
    // waits for it; waiting there would be waiting on itself.
    const result = await withSetupLock(() =>
      withSetupLockWhenFree(async () => 'nested', { ...neverStop, stopWaiting: () => true }),
    );

    expect(result).toBe('nested');
  });
});

/**
 * The stone lock is separate from the setup lock and shared with the generated
 * `gemdb` wrapper, which takes it in shell. Both doors start the same stone --
 * the editor on activation, a terminal command on any invocation -- and a lock
 * each would still race, which is how two stones came to hold one extent.
 *
 * mkdir is the primitive on both sides: it creates or fails, with no window
 * between the test and the claim.
 */
describe('withStoneLock', () => {
  function stoneLock(): string {
    return path.join(root, STONE_LOCK_NAME);
  }

  it('runs the work and releases afterwards', async () => {
    const ran = await withStoneLock(async () => 'started');
    expect(ran).toBe('started');
    expect(fs.existsSync(stoneLock())).toBe(false);
  });

  it('declines when a live process already holds it', async () => {
    fs.mkdirSync(stoneLock());
    fs.writeFileSync(path.join(stoneLock(), 'pid'), `${process.pid}\n`);
    let ran = false;
    const result = await withStoneLock(async () => {
      ran = true;
      return 'started';
    });
    expect(ran).toBe(false);
    expect(result).toBeUndefined();
  });

  it('takes over a lock whose owner is gone', async () => {
    fs.mkdirSync(stoneLock());
    fs.writeFileSync(path.join(stoneLock(), 'pid'), '999999\n');
    const result = await withStoneLock(async () => 'started');
    expect(result).toBe('started');
  });

  it('releases the lock when the work throws', async () => {
    await expect(
      withStoneLock(async () => {
        throw new Error('startstone failed');
      }),
    ).rejects.toThrow('startstone failed');
    expect(fs.existsSync(stoneLock())).toBe(false);
  });
});
