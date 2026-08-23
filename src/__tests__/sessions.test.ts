import { describe, expect, it } from 'vitest';
import { SessionInfo, SessionOwner, sessionLimitMessage } from '../session';

/**
 * Running out of sessions is a normal consequence of opening notebooks, not a
 * fault: each notebook takes one so it gets its own transaction, the database
 * allows ten at once, and its own gems spend some of that. So the message is
 * the feature — it has to say what this window is holding and which one is
 * worth closing, because the bare GemStone error is a number.
 */

const owner = (label: string): SessionOwner => ({
  key: `file:///${label}`,
  kind: 'notebook',
  label,
});

const held = (label: string, idleMs: number): SessionInfo => ({
  owner: owner(label),
  serial: 42,
  openedAt: Date.now() - idleMs,
  idleMs,
});

describe('the message when the database has no sessions left', () => {
  it('names what was refused', () => {
    const message = sessionLimitMessage(owner('new.ipynb'), []);
    expect(message).toContain('new.ipynb');
    expect(message).toContain('no free sessions');
  });

  it('lists what this window holds, and points at the idlest', () => {
    const message = sessionLimitMessage(owner('new.ipynb'), [
      held('stale.ipynb', 20 * 60_000),
      held('busy.ipynb', 5_000),
    ]);

    expect(message).toContain('holding 2');
    expect(message).toContain('stale.ipynb (idle 20 min)');
    expect(message).toContain('busy.ipynb (idle 5s)');
    // The caller passes them idlest-first; the advice must name that one.
    expect(message).toContain('Closing stale.ipynb');
  });

  it('does not claim to know about sessions it cannot see', () => {
    // Every session belongs to another window, another tool, or the database's
    // own gems. Saying "this window is holding 0" would be worse than useless.
    const message = sessionLimitMessage(owner('new.ipynb'), []);
    expect(message).not.toContain('holding');
    expect(message).toContain('Other windows');
  });

  it('scales the idle time it reports', () => {
    const message = sessionLimitMessage(owner('x'), [
      held('a', 90 * 60_000),
      held('b', 3 * 60_000),
      held('c', 2_000),
    ]);
    expect(message).toContain('a (idle 1.5 h)');
    expect(message).toContain('b (idle 3 min)');
    expect(message).toContain('c (idle 2s)');
  });
});
