import { describe, expect, it } from 'vitest';
import { REQUIRED_SHARED_MEMORY_GB } from '../config';
import { OsConfigWorld, runEnsureOsConfigured } from '../osConfig';

/**
 * A stand-in operating system that records what was asked of it.
 *
 * Each prerequisite is described by how it behaves across the whole run
 * rather than by a pair of booleans: `ok` was never short, `fixed` was short
 * until the script ran, and `short`/`unset` stayed that way — a cancelled
 * sudo or a mistyped password, which is the case worth defending.
 */
function makeWorld(options: {
  sharedMemory?: 'ok' | 'fixed' | 'short';
  removeIpc?: 'ok' | 'fixed' | 'unset';
  confirm?: boolean;
}): {
  calls: string[];
  reported: Array<{ outcome: string; missing: string }>;
  messages: string[];
  world: OsConfigWorld;
} {
  const sharedMemory = options.sharedMemory ?? 'ok';
  const removeIpc = options.removeIpc ?? 'ok';
  let sharedMemoryRan = false;
  let removeIpcRan = false;
  const calls: string[] = [];
  const reported: Array<{ outcome: string; missing: string }> = [];
  const messages: string[] = [];

  const world: OsConfigWorld = {
    sharedMemoryOk: () =>
      Promise.resolve(sharedMemory === 'ok' || (sharedMemory === 'fixed' && sharedMemoryRan)),
    removeIpcOk: () => removeIpc === 'ok' || (removeIpc === 'fixed' && removeIpcRan),
    confirm: (message) => {
      calls.push('confirm');
      messages.push(message);
      return Promise.resolve(options.confirm ?? true);
    },
    runSharedMemoryScript: () => {
      calls.push('runSharedMemoryScript');
      sharedMemoryRan = true;
      return Promise.resolve();
    },
    runRemoveIpcScript: () => {
      calls.push('runRemoveIpcScript');
      removeIpcRan = true;
      return Promise.resolve();
    },
    showError: (message) => {
      calls.push('showError');
      messages.push(message);
    },
    report: (outcome, missing) => {
      calls.push(`report(${outcome})`);
      reported.push({ outcome, missing });
    },
    log: () => {},
  };

  return { calls, reported, messages, world };
}

describe('runEnsureOsConfigured', () => {
  it('asks for nothing and reports nothing when both prerequisites are already met', async () => {
    const { calls, reported, world } = makeWorld({ sharedMemory: 'ok', removeIpc: 'ok' });

    expect(await runEnsureOsConfigured(world)).toBe('alreadyConfigured');
    // Silent by design: this is the path every activation after the first
    // takes, and an event here would be pure volume.
    expect(calls).toEqual([]);
    expect(reported).toEqual([]);
  });

  it('reports a declined modal and refuses the start', async () => {
    const { calls, reported, world } = makeWorld({ sharedMemory: 'short', confirm: false });

    expect(await runEnsureOsConfigured(world)).toBe('declined');
    // No script may run without an answer.
    expect(calls).toEqual(['confirm', 'report(declined)']);
    expect(reported).toEqual([{ outcome: 'declined', missing: 'sharedMemory' }]);
  });

  it('refuses the start when shared memory is still short after the script', async () => {
    const { calls, reported, world } = makeWorld({ sharedMemory: 'short' });

    expect(await runEnsureOsConfigured(world)).toBe('stillUnconfigured');
    expect(calls).toEqual([
      'confirm',
      'runSharedMemoryScript',
      'showError',
      'report(stillUnconfigured)',
    ]);
    expect(reported).toEqual([{ outcome: 'stillUnconfigured', missing: 'sharedMemory' }]);
  });

  it('reports a configured machine once both scripts have taken', async () => {
    const { reported, world } = makeWorld({ sharedMemory: 'fixed', removeIpc: 'fixed' });

    expect(await runEnsureOsConfigured(world)).toBe('configured');
    expect(reported).toEqual([{ outcome: 'configured', missing: 'both' }]);
  });

  it('reports RemoveIPC staying unset without blocking the start', async () => {
    const { calls, reported, world } = makeWorld({ sharedMemory: 'ok', removeIpc: 'unset' });

    // Advisory: the database still starts (`osConfigAllowsStart` is true) — but the
    // outcome may not say `configured`, which would claim a fix that did not
    // take and over-count the very thing this event exists to measure.
    expect(await runEnsureOsConfigured(world)).toBe('removeIpcUnset');
    expect(calls).toEqual(['confirm', 'runRemoveIpcScript', 'report(removeIpcUnset)']);
    expect(reported).toEqual([{ outcome: 'removeIpcUnset', missing: 'removeIpc' }]);
  });

  it('distinguishes a half-configured machine from one where nothing took', async () => {
    const { reported, world } = makeWorld({ sharedMemory: 'fixed', removeIpc: 'unset' });

    expect(await runEnsureOsConfigured(world)).toBe('removeIpcUnset');
    // `missing` is what was short when the modal was shown, so both of these
    // cases carry `both` and only the outcome tells them apart: here shared
    // memory took and the database started, while `stillUnconfigured` above
    // means it did not.
    expect(reported).toEqual([{ outcome: 'removeIpcUnset', missing: 'both' }]);
  });

  it('counts the steps it is about to ask for rather than hardcoding two', async () => {
    const one = makeWorld({ sharedMemory: 'short', confirm: false });
    await runEnsureOsConfigured(one.world);
    expect(one.messages[0]).toContain('needs one change');
    expect(one.messages[0]).toContain(`at least ${REQUIRED_SHARED_MEMORY_GB} GB`);
    expect(one.messages[0]).not.toContain('RemoveIPC=no');

    const two = makeWorld({ sharedMemory: 'short', removeIpc: 'unset', confirm: false });
    await runEnsureOsConfigured(two.world);
    expect(two.messages[0]).toContain('needs 2 changes');
    expect(two.messages[0]).toContain('RemoveIPC=no');
  });
});
