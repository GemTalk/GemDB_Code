import { describe, expect, it } from 'vitest';
import * as path from 'path';
import { BRAIN_FREEZE_DIR, BRAIN_FREEZE_URL, CloneWorld, runCloneDemo } from '../demo';

/**
 * A stand-in editor and git that record what was asked of them.
 *
 * What is under test is the order and the refusals — that nothing is cloned
 * over a directory that already exists, that a cancelled clone is not reported
 * as a failure, and that a partial clone is always removed — so the fake keeps
 * a transcript rather than a set of spies.
 */
function makeWorld(options: {
  parent?: string;
  /** Paths that already exist before the command runs. */
  existing?: string[];
  clone?: 'cloned' | 'cancelled' | Error;
  /** What the user presses on the notification, if anything. */
  answer?: string;
}): { calls: string[]; world: CloneWorld; errors: string[] } {
  const calls: string[] = [];
  const errors: string[] = [];
  const existing = new Set(options.existing ?? []);

  const world: CloneWorld = {
    pickParent: () => {
      calls.push('pickParent');
      return Promise.resolve(options.parent);
    },
    exists: (target) => existing.has(target),
    clone: (url, target) => {
      calls.push(`clone(${url} -> ${target})`);
      const outcome = options.clone ?? 'cloned';
      if (outcome instanceof Error) return Promise.reject(outcome);
      return Promise.resolve(outcome);
    },
    discard: (target) => calls.push(`discard(${target})`),
    ask: (message, ...choices) => {
      calls.push(`ask(${message} [${choices.join('|')}])`);
      return Promise.resolve(options.answer);
    },
    reportError: (message) => {
      calls.push('reportError');
      errors.push(message);
    },
    openFolder: (target, newWindow) => {
      calls.push(`openFolder(${target}, newWindow=${String(newWindow)})`);
      return Promise.resolve();
    },
    log: () => {},
  };
  return { calls, world, errors };
}

const parent = '/home/dev/code';
const target = path.join(parent, BRAIN_FREEZE_DIR);

describe('the Brain Freeze clone command', () => {
  it('clones nothing when the folder dialog is dismissed', async () => {
    // The dialog is where the user consents to a write outside the root path,
    // so dismissing it has to mean nothing happened at all.
    const { calls, world } = makeWorld({ parent: undefined });
    await runCloneDemo(world);
    expect(calls).toEqual(['pickParent']);
  });

  it('clones into brain-freeze under the chosen folder', async () => {
    const { calls, world } = makeWorld({ parent, answer: undefined });
    await runCloneDemo(world);
    expect(calls).toContain(`clone(${BRAIN_FREEZE_URL} -> ${target})`);
    // Dismissing the "cloned" notification leaves the clone on disk and opens
    // nothing: the work is done, and where to look at it is a second question.
    expect(calls.filter((c) => c.startsWith('openFolder'))).toEqual([]);
  });

  it('opens what is already there rather than cloning over it', async () => {
    // A second run is most likely someone who wants the demo they already
    // have, and that directory may hold their own commits.
    const { calls, world } = makeWorld({ parent, existing: [target], answer: 'Open' });
    await runCloneDemo(world);
    expect(calls.some((c) => c.startsWith('clone('))).toBe(false);
    expect(calls.some((c) => c.startsWith('discard('))).toBe(false);
    expect(calls).toContain(`openFolder(${target}, newWindow=false)`);
  });

  it('opens in a new window when that is the button pressed', async () => {
    const { calls, world } = makeWorld({ parent, answer: 'Open in New Window' });
    await runCloneDemo(world);
    expect(calls).toContain(`openFolder(${target}, newWindow=true)`);
  });

  it('names git in the error and removes the partial clone', async () => {
    // A missing git arrives as a spawn error, not a non-zero exit, and the
    // message has to say what GemDB was trying to run.
    const { calls, world, errors } = makeWorld({
      parent,
      clone: new Error('spawn git ENOENT'),
    });
    await runCloneDemo(world);
    expect(calls).toContain(`discard(${target})`);
    expect(calls).toContain('reportError');
    expect(errors[0]).toContain('git');
    expect(calls.some((c) => c.startsWith('openFolder'))).toBe(false);
  });

  it('treats a cancelled clone as a cancellation, not a failure', async () => {
    // A killed git leaves its half-written directory behind, and that leftover
    // would meet the "already exists" branch on the next run — which offers to
    // open it as though it were a working checkout.
    const { calls, world, errors } = makeWorld({ parent, clone: 'cancelled' });
    await runCloneDemo(world);
    expect(calls).toContain(`discard(${target})`);
    expect(errors).toEqual([]);
    expect(calls.some((c) => c.startsWith('openFolder'))).toBe(false);
  });
});
