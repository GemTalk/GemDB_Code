import { describe, expect, it } from 'vitest';
import { SessionInfo, SessionOwner, cacheNameFor, sessionLimitMessage } from '../session';

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

/**
 * The name a session takes in the shared cache.
 *
 * The 31-character limit is the whole difficulty: 32 raises OutOfRange, and it
 * would raise it at login, on the notebook the user just opened. So the rule
 * that keeps names short is worth testing without a database — the same reason
 * `sessionLimitMessage` takes its sessions as an argument.
 */
describe('the name a session publishes to the shared cache', () => {
  const nb = (label: string): SessionOwner => ({
    key: `file:///${label}`,
    kind: 'notebook',
    label,
  });

  it('names a notebook, without repeating what the tag already said', () => {
    expect(cacheNameFor(nb('analysis.ipynb'))).toBe('GemDB nb analysis');
  });

  it('spells out the shell, which is a product name and has room', () => {
    // "GemDB Shell" is what a user is told this thing is called, and an
    // administrator reading a session list is a user. The pid is fixed-width,
    // so spelling out the tag costs a notebook name nothing.
    expect(cacheNameFor({ key: 'shell', kind: 'shell', label: 'shell' }, 41234)).toBe(
      'GemDB Shell 41234',
    );
  });

  it('names the extension’s own session after the extension', () => {
    expect(cacheNameFor({ key: 'gemdb.extension', kind: 'extension', label: 'GemDB' })).toBe(
      'GemDB Code',
    );
  });

  it('never exceeds what the cache will take', () => {
    const long = nb('a-notebook-with-a-really-quite-long-name.ipynb');
    expect(cacheNameFor(long).length).toBeLessThanOrEqual(31);
    expect(cacheNameFor(long)).toBe('GemDB nb a-notebook-with-a-real');
  });

  it('leaves the notebook’s own capitalisation alone', () => {
    // The tag is ours to style; the title is the user's, and altering its case
    // would make the label harder to match against the file they can see.
    expect(cacheNameFor(nb('Q3-Revenue.ipynb'))).toBe('GemDB nb Q3-Revenue');
  });

  it('drops what the cache cannot store', () => {
    // The cache holds 8-bit code points, so an emoji or a CJK title would be
    // meaningless there at best; strip rather than let login fail over it.
    expect(cacheNameFor(nb('sales–📈.ipynb'))).toBe('GemDB nb sales');
  });

  it('falls back to the tag when nothing usable is left', () => {
    expect(cacheNameFor(nb('📈.ipynb'))).toBe('GemDB nb');
  });
});
