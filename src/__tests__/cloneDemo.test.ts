import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  BRAIN_FREEZE_DIR,
  BRAIN_FREEZE_URL,
  CloneWorld,
  README_PROMISE_MS,
  brainFreezePath,
  initPendingReadme,
  runCloneDemo,
  takePromisedReadme,
} from '../demo';

/**
 * A stand-in editor and git that record what was asked of them.
 *
 * What is under test is the order and the refusals — that nothing is cloned
 * over a directory that already exists, that a cancelled clone is not reported
 * as a failure, that a partial clone is always removed, and that the window
 * the demo opens in is chosen rather than asked about — so the fake keeps a
 * transcript rather than a set of spies.
 */
function makeWorld(options: {
  /** Paths that already exist before the command runs. */
  existing?: string[];
  clone?: 'cloned' | 'cancelled' | Error;
  /** The folders open in the window the command runs in. */
  folders?: string[];
}): { calls: string[]; world: CloneWorld; errors: string[] } {
  const calls: string[] = [];
  const errors: string[] = [];
  const existing = new Set(options.existing ?? []);

  const world: CloneWorld = {
    target,
    exists: (t) => existing.has(t),
    clone: (url, t) => {
      calls.push(`clone(${url} -> ${t})`);
      const outcome = options.clone ?? 'cloned';
      if (outcome instanceof Error) return Promise.reject(outcome);
      return Promise.resolve(outcome);
    },
    discard: (t) => calls.push(`discard(${t})`),
    reportError: (message) => {
      calls.push('reportError');
      errors.push(message);
    },
    openFolders: () => options.folders ?? [],
    showReadme: (t) => {
      calls.push(`showReadme(${t})`);
      return Promise.resolve();
    },
    promiseReadme: (t) => calls.push(`promiseReadme(${t})`),
    openFolder: (t, newWindow) => {
      calls.push(`openFolder(${t}, newWindow=${String(newWindow)})`);
      return Promise.resolve();
    },
    log: () => {},
  };
  return { calls, world, errors };
}

const root = '/home/dev/GemDB';
const target = brainFreezePath(root);

describe('installing the Brain Freeze demo', () => {
  it('clones into brain-freeze under the root path', () => {
    // Under the root path is what puts the clone on the automated side of the
    // line: it is undone by deleting the directory GemDB already owns.
    expect(target).toBe(path.join(root, BRAIN_FREEZE_DIR));
  });

  it('clones, then opens the demo in an empty window without asking', async () => {
    // An empty window has nothing to lose to a workspace change, so reusing it
    // is not a question. The README is promised before the folder opens,
    // because nothing after `openFolder` runs in the window that shows it.
    const { calls, world } = makeWorld({});
    await runCloneDemo(world);
    expect(calls).toEqual([
      `clone(${BRAIN_FREEZE_URL} -> ${target})`,
      `promiseReadme(${target})`,
      `openFolder(${target}, newWindow=false)`,
    ]);
  });

  it('leaves a window with a folder open alone and opens a new one', async () => {
    const { calls, world } = makeWorld({ folders: ['/home/dev/work'] });
    await runCloneDemo(world);
    expect(calls).toContain(`openFolder(${target}, newWindow=true)`);
  });

  it('shows the README in place when the demo is already open here', async () => {
    // Opening a folder that is already open would do nothing visible, and the
    // README would be promised to a window that is never coming.
    const { calls, world } = makeWorld({
      existing: [target],
      folders: ['/home/dev/work', `${target}/`],
    });
    await runCloneDemo(world);
    expect(calls).toEqual([`showReadme(${target})`]);
  });

  it('opens what is already there rather than cloning over it', async () => {
    // A second run is most likely someone who wants the demo they already
    // have, and that directory may hold their own commits.
    const { calls, world } = makeWorld({ existing: [target] });
    await runCloneDemo(world);
    expect(calls.some((c) => c.startsWith('clone('))).toBe(false);
    expect(calls.some((c) => c.startsWith('discard('))).toBe(false);
    expect(calls).toContain(`openFolder(${target}, newWindow=false)`);
  });

  it('names git in the error and removes the partial clone', async () => {
    // A missing git arrives as a spawn error, not a non-zero exit, and the
    // message has to say what GemDB was trying to run.
    const { calls, world, errors } = makeWorld({ clone: new Error('spawn git ENOENT') });
    await runCloneDemo(world);
    expect(calls).toContain(`discard(${target})`);
    expect(calls).toContain('reportError');
    expect(errors[0]).toContain('git');
    expect(calls.some((c) => c.startsWith('openFolder'))).toBe(false);
    expect(calls.some((c) => c.startsWith('promiseReadme'))).toBe(false);
  });

  it('treats a cancelled clone as a cancellation, not a failure', async () => {
    // A killed git leaves its half-written directory behind, and that leftover
    // would meet the "already exists" branch on the next run — which opens it
    // as though it were a working checkout.
    const { calls, world, errors } = makeWorld({ clone: 'cancelled' });
    await runCloneDemo(world);
    expect(calls).toContain(`discard(${target})`);
    expect(errors).toEqual([]);
    expect(calls.some((c) => c.startsWith('openFolder'))).toBe(false);
  });
});

describe('the README promised to the window that opens the demo', () => {
  let storage: string;
  let note: string;

  beforeEach(() => {
    storage = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdb-readme-'));
    note = path.join(storage, 'pending-demo-readme');
    initPendingReadme(storage);
  });

  afterEach(() => fs.rmSync(storage, { recursive: true, force: true }));

  it('is kept once, by the window that has the demo open', () => {
    fs.writeFileSync(note, target);
    expect(takePromisedReadme([target])).toBe(target);
    // Once: reopening the folder later is a visit, not an install.
    expect(takePromisedReadme([target])).toBeUndefined();
  });

  it('is left for its window by any other window that activates first', () => {
    // The demo's window may still be starting; an unrelated window taking the
    // note would leave it with nothing.
    fs.writeFileSync(note, target);
    expect(takePromisedReadme(['/home/dev/work'])).toBeUndefined();
    expect(takePromisedReadme([target])).toBe(target);
  });

  it('expires rather than surprising a visit to the folder next week', () => {
    fs.writeFileSync(note, target);
    const writtenAt = fs.statSync(note).mtimeMs;
    expect(takePromisedReadme([target], writtenAt + README_PROMISE_MS + 1)).toBeUndefined();
    expect(fs.existsSync(note)).toBe(false);
  });

  it('is nothing when no note was left', () => {
    expect(takePromisedReadme([target])).toBeUndefined();
  });
});
