import { execFile } from 'child_process';
import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetSettings, __setSetting } from '../__mocks__/vscode';
import {
  STONE_LOCK_NAME,
  withRootLock,
  withSetupLock,
  withSetupLockWhenFree,
  withStoneLock,
} from '../lock';

// Setup runs unattended when the extension activates, and activation happens in
// every open window — so this lock is what stands between one download and two
// processes appending to the same partial file. Its failure modes are all
// concurrency-shaped and invisible in ordinary use, which is exactly why they
// are worth pinning down here.

// fs as is, but a test can run something just before a path is renamed or
// removed: a rival process acting in the window between our check and act.
const fsHooks = vi.hoisted(() => ({ beforeMove: undefined as ((p: string) => void) | undefined }));
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  return {
    ...real,
    renameSync: (from: fs.PathLike, to: fs.PathLike) => {
      fsHooks.beforeMove?.(String(from));
      real.renameSync(from, to);
    },
    rmSync: (target: fs.PathLike, options?: fs.RmOptions) => {
      fsHooks.beforeMove?.(String(target));
      real.rmSync(target, options);
    },
  };
});

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

  it('leaves alone a lock whose pid is not written yet', async () => {
    // Creating the file and writing the pid are two steps, so an empty lock is
    // a window mid-claim, not debris. Taking it over would run two setups.
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(lockFile(), '');
    let ran = false;

    const result = await withSetupLock(async () => {
      ran = true;
    });

    expect(result).toBeUndefined();
    expect(ran).toBe(false);
    expect(fs.existsSync(lockFile())).toBe(true);
  });

  it('takes over a lock that has had no pid for longer than any claim takes', async () => {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(lockFile(), '');
    const then = new Date(Date.now() - 10_000);
    fs.utimesSync(lockFile(), then, then);

    expect(await withSetupLock(async () => 'recovered')).toBe('recovered');
  });

  it('does not delete a lock that was replaced while the work ran', async () => {
    // Our pid alone does not prove the file is ours: a window that took the
    // lock over from a dead process with the same pid would match. Nor does the
    // inode: on Linux the re-created file below gets the deleted one's number
    // back unless something still holds that file open, which is how this test
    // first failed in CI. The lock is held open, so a re-created file survives
    // our release.
    await withSetupLock(async () => {
      fs.unlinkSync(lockFile());
      fs.writeFileSync(lockFile(), String(process.pid));
    });

    expect(fs.existsSync(lockFile())).toBe(true);
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

  function writeStonePid(pid: string): void {
    fs.writeFileSync(path.join(stoneLock(), 'pid'), pid);
  }

  /** Make a path look `seconds` old, past the grace given to a half-written lock. */
  function backdate(target: string, seconds = 10): void {
    const then = new Date(Date.now() - seconds * 1000);
    fs.utimesSync(target, then, then);
  }

  it('waits for a live holder and runs once it lets go', async () => {
    fs.mkdirSync(stoneLock());
    writeStonePid(`${process.ppid}\n`);
    setTimeout(() => fs.rmSync(stoneLock(), { recursive: true }), 40);

    const result = await withStoneLock(async () => 'started', { pollMs: 10 });

    expect(result).toBe('started');
  });

  it('returns without running when what it was waiting for happened meanwhile', async () => {
    // The stone came up while we queued: starting it again is exactly the
    // second start the lock exists to prevent.
    fs.mkdirSync(stoneLock());
    writeStonePid(`${process.ppid}\n`);
    let up = false;
    setTimeout(() => (up = true), 30);
    let ran = false;

    const result = await withStoneLock(
      async () => {
        ran = true;
      },
      { pollMs: 10, satisfied: () => up },
    );

    expect(result).toBeUndefined();
    expect(ran).toBe(false);
    expect(fs.existsSync(stoneLock())).toBe(true);
  });

  it('fails naming the lock when a live holder never lets go', async () => {
    fs.mkdirSync(stoneLock());
    writeStonePid(`${process.ppid}\n`);

    await expect(
      withStoneLock(async () => 'started', { pollMs: 10, timeoutMs: 60 }),
    ).rejects.toThrow(stoneLock());

    expect(fs.existsSync(stoneLock())).toBe(true);
  });

  it('leaves alone a lock whose pid is not written yet', async () => {
    // mkdir and the pid write are two steps, so a freshly made empty lock is
    // someone mid-claim, not debris. Stealing it would start a second stone.
    fs.mkdirSync(stoneLock());
    let ran = false;

    await expect(
      withStoneLock(
        async () => {
          ran = true;
        },
        { pollMs: 10, timeoutMs: 60 },
      ),
    ).rejects.toThrow(stoneLock());

    expect(ran).toBe(false);
    expect(fs.existsSync(stoneLock())).toBe(true);
  });

  it('takes over a lock that has had no pid for longer than any claim takes', async () => {
    fs.mkdirSync(stoneLock());
    backdate(stoneLock());

    const result = await withStoneLock(async () => 'started', { pollMs: 10, timeoutMs: 500 });

    expect(result).toBe('started');
  });

  it('does not delete a lock that someone else took over meanwhile', async () => {
    // If ours was judged stale and stolen while we worked, the lock now belongs
    // to the thief; removing it would let a third process in beside them.
    await withStoneLock(async () => {
      writeStonePid(`${process.ppid}\n`);
    });

    expect(fs.existsSync(stoneLock())).toBe(true);
    expect(fs.readFileSync(path.join(stoneLock(), 'pid'), 'utf8').trim()).toBe(
      String(process.ppid),
    );
  });

  it('is not blocked for ever by the debris of a dead stealer', async () => {
    // A process that died between taking the steal guard and dropping it leaves
    // the guard behind; after a few seconds it is rubbish like any other.
    fs.mkdirSync(stoneLock());
    writeStonePid('4194304\n');
    fs.mkdirSync(`${stoneLock()}.steal`);
    backdate(`${stoneLock()}.steal`);

    const result = await withStoneLock(async () => 'started', { pollMs: 10, timeoutMs: 500 });

    expect(result).toBe('started');
    // Neither the guard nor the tomb it was moved to before being cleared.
    expect(
      fs.readdirSync(path.dirname(stoneLock())).filter((name) => name.includes('.steal')),
    ).toEqual([]);
  });

  it('does not get in beside a rival that cleared a dead stealer’s guard first', async () => {
    // Both judge the dead guard stale; the rival clears it and takes a fresh
    // one just before we clear it too. Clearing by path would then remove the
    // rival's live guard, and both would steal the lock: two stones.
    fs.mkdirSync(stoneLock());
    writeStonePid('4194304\n');
    const guard = `${stoneLock()}.steal`;
    fs.mkdirSync(guard);
    backdate(guard);
    let rivalTookOver = false;
    fsHooks.beforeMove = (target) => {
      if (rivalTookOver || target !== guard) return;
      rivalTookOver = true;
      fs.rmdirSync(guard);
      fs.mkdirSync(guard);
    };

    try {
      // The rival never lets go here, so we wait out the timeout behind it.
      let ran = false;
      await expect(
        withStoneLock(
          async () => {
            ran = true;
          },
          { pollMs: 10, timeoutMs: 300 },
        ),
      ).rejects.toThrow(/starting the database/);

      expect(rivalTookOver).toBe(true);
      expect(ran).toBe(false);
      expect(fs.readFileSync(path.join(stoneLock(), 'pid'), 'utf8').trim()).toBe('4194304');
      expect(fs.existsSync(guard)).toBe(true);
    } finally {
      fsHooks.beforeMove = undefined;
    }
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

/**
 * The lock for setups and other root-wide jobs, with the in-process queue in
 * front of it. Every caller in one extension host has the same pid, so the file
 * cannot tell them apart; the queue is what does.
 */
describe('withRootLock', () => {
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  /** A lock file held by a live process that is not us: our parent. */
  function holdElsewhere(): void {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(lockFile(), String(process.ppid));
  }

  it('queues concurrent callers so their work never overlaps', async () => {
    let running = 0;
    let overlapped = false;
    let completed = 0;
    const work = async (): Promise<void> => {
      running += 1;
      if (running > 1) overlapped = true;
      await sleep(15);
      running -= 1;
      completed += 1;
    };

    await Promise.all([
      withRootLock({ contention: 'wait', pollMs: 5 }, work),
      withRootLock({ contention: 'wait', pollMs: 5 }, work),
      withRootLock({ contention: 'wait', pollMs: 5 }, work),
    ]);

    expect(overlapped).toBe(false);
    expect(completed).toBe(3);
    expect(fs.existsSync(lockFile())).toBe(false);
  });

  it('steps aside when another call in this process is working', async () => {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const first = withRootLock({ contention: 'skip' }, () => gate);
    let ran = false;

    const second = await withRootLock({ contention: 'skip' }, async () => {
      ran = true;
    });
    release();
    await first;

    expect(second).toBeUndefined();
    expect(ran).toBe(false);
  });

  it('steps aside when another process holds the lock, leaving its claim alone', async () => {
    holdElsewhere();
    let ran = false;

    const result = await withRootLock({ contention: 'skip' }, async () => {
      ran = true;
    });

    expect(result).toBeUndefined();
    expect(ran).toBe(false);
    expect(fs.readFileSync(lockFile(), 'utf8')).toBe(String(process.ppid));
    // And the in-process queue was given back, or nothing here could run again.
    fs.unlinkSync(lockFile());
    expect(await withRootLock({ contention: 'skip' }, async () => 'free')).toBe('free');
  });

  it('skips the work, and lets go of the lock, when it is no longer needed', async () => {
    // Whoever held the lock before us was probably doing the same job; the
    // check runs once we hold the lock, because only then is its answer final.
    let ran = false;

    const result = await withRootLock(
      { contention: 'wait', precondition: () => false },
      async () => {
        ran = true;
      },
    );

    expect(result).toBeUndefined();
    expect(ran).toBe(false);
    expect(fs.existsSync(lockFile())).toBe(false);
    expect(await withRootLock({ contention: 'skip' }, async () => 'free')).toBe('free');
  });

  it('asks the precondition while holding the lock', async () => {
    let heldWhenAsked = false;

    await withRootLock(
      {
        contention: 'wait',
        precondition: () => {
          heldWhenAsked = fs.existsSync(lockFile());
          return true;
        },
      },
      async () => {},
    );

    expect(heldWhenAsked).toBe(true);
  });

  it('lets go of both locks when the work throws', async () => {
    await expect(
      withRootLock({ contention: 'wait' }, async () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');

    expect(fs.existsSync(lockFile())).toBe(false);
    expect(await withRootLock({ contention: 'skip' }, async () => 'again')).toBe('again');
  });

  it('says once that it is waiting, however long the wait', async () => {
    holdElsewhere();
    const onWaiting = vi.fn();
    setTimeout(() => fs.unlinkSync(lockFile()), 40);

    const result = await withRootLock(
      { contention: 'wait', onWaiting, pollMs: 5 },
      async () => 'ran',
    );

    expect(result).toBe('ran');
    expect(onWaiting).toHaveBeenCalledTimes(1);
  });

  it('gives up waiting on the lock file when told to stop', async () => {
    holdElsewhere();
    let ran = false;

    const result = await withRootLock(
      { contention: 'wait', pollMs: 5, stopWaiting: () => true },
      async () => {
        ran = true;
      },
    );

    expect(result).toBeUndefined();
    expect(ran).toBe(false);
    expect(fs.readFileSync(lockFile(), 'utf8')).toBe(String(process.ppid));
  });

  it('gives up waiting in the queue when told to stop, without disturbing the one working', async () => {
    let release = (): void => {};
    const gate = new Promise<string>((resolve) => (release = () => resolve('first done')));
    const first = withRootLock({ contention: 'wait' }, () => gate);
    const onWaiting = vi.fn();
    let ran = false;

    const second = await withRootLock(
      { contention: 'wait', pollMs: 5, onWaiting, stopWaiting: () => true },
      async () => {
        ran = true;
      },
    );
    release();

    expect(second).toBeUndefined();
    expect(ran).toBe(false);
    expect(onWaiting).toHaveBeenCalledTimes(1);
    expect(await first).toBe('first done');
    expect(await withRootLock({ contention: 'skip' }, async () => 'free')).toBe('free');
  });
});

/**
 * The locks exist to keep separate processes apart, which an in-process test
 * can only imitate. These bundle lockContender.ts the way the shell is bundled
 * and start real node processes at once, so the race is the real one: every
 * contender sees the same stale lock and decides, independently, to take it.
 */
describe('contention between processes', () => {
  const CONTENDERS = 7;
  let bundleDir: string;
  let bundle: string;

  beforeAll(async () => {
    bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdb-contender-'));
    bundle = path.join(bundleDir, 'lockContender.cjs');
    await esbuild.build({
      entryPoints: [path.join(__dirname, 'fixtures', 'lockContender.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: bundle,
      logLevel: 'silent',
      alias: { vscode: path.join(__dirname, '..', 'cliVscode.ts') },
    });
    return () => fs.rmSync(bundleDir, { recursive: true, force: true });
  });

  /**
   * Start `count` contenders, release them together, and return what they
   * reported. Plain node: ELECTRON_RUN_AS_NODE is irrelevant outside Electron.
   */
  async function race(mode: 'setup' | 'stone', count: number, holdMs: number): Promise<string[]> {
    const ready = path.join(root, 'ready');
    const go = path.join(root, 'go');
    const reportFile = path.join(root, 'report');
    fs.writeFileSync(ready, '');
    const exits = Array.from(
      { length: count },
      () =>
        new Promise<void>((resolve, reject) => {
          const child = execFile(
            process.execPath,
            [bundle, mode, ready, go, reportFile, String(holdMs)],
            { env: { ...process.env, GEMDB_ROOT_PATH: root } },
            (error, _stdout, stderr) =>
              error ? reject(new Error(stderr || String(error))) : resolve(),
          );
          child.on('error', reject);
        }),
    );

    // Release only once every contender is parked at the starting line, or the
    // first would finish before the last had started.
    const deadline = Date.now() + 20_000;
    while (fs.readFileSync(ready, 'utf8').split('\n').filter(Boolean).length < count) {
      if (Date.now() > deadline) throw new Error('contenders never got ready');
      await sleep(10);
    }
    fs.writeFileSync(go, '');
    await Promise.all(exits);

    return fs.existsSync(reportFile)
      ? fs.readFileSync(reportFile, 'utf8').split('\n').filter(Boolean)
      : [];
  }

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  it('lets exactly one process take over a stale setup lock', async () => {
    fs.writeFileSync(lockFile(), '4194304');

    const lines = await race('setup', CONTENDERS, 400);

    expect(lines.filter((l) => l.startsWith('error'))).toEqual([]);
    const winners = lines.filter((l) => l.startsWith('won'));
    expect(winners).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith('lost'))).toHaveLength(CONTENDERS - 1);
    // The winner's lock was still its own at the end of its hold: no loser
    // removed it, and none replaced it.
    expect(winners[0]).toMatch(/ intact$/);
    expect(fs.existsSync(lockFile())).toBe(false);
  }, 30_000);

  it('runs one process at a time through a stale stone lock, and every one of them', async () => {
    fs.mkdirSync(path.join(root, STONE_LOCK_NAME));
    fs.writeFileSync(path.join(root, STONE_LOCK_NAME, 'pid'), '4194304\n');

    const lines = await race('stone', CONTENDERS, 60);

    expect(lines.filter((l) => l.startsWith('error'))).toEqual([]);
    // Each start is followed by its own end before the next start begins.
    expect(lines).toHaveLength(CONTENDERS * 2);
    for (let i = 0; i < lines.length; i += 2) {
      const [startWord, startPid] = lines[i].split(' ');
      const [endWord, endPid, verdict] = lines[i + 1].split(' ');
      expect([startWord, endWord, endPid, verdict]).toEqual(['start', 'end', startPid, 'intact']);
    }
    expect(new Set(lines.filter((l) => l.startsWith('start'))).size).toBe(CONTENDERS);
    expect(fs.existsSync(path.join(root, STONE_LOCK_NAME))).toBe(false);
  }, 30_000);
});
