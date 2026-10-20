import { describe, expect, it, vi } from 'vitest';

/**
 * How Persisted Objects and the Inspector run a query in a notebook's session
 * (`inNotebook`): through its pause, with the options the caller gave, or
 * directly, one at a time, since a session runs one call at a time and a
 * second one sent while the first runs fails as busy.
 */

const NB = 'file:///demo.ipynb';
let pauseQuery: ((code: string, options?: unknown) => Promise<string>) | undefined;
let inFlight = 0;
const ran: string[] = [];
const directOptions: unknown[] = [];

vi.mock('../debugger', () => ({
  pauseForOwner: () => (pauseQuery ? { query: pauseQuery } : undefined),
  pauseForDebugSession: () => undefined,
  openPause: () => Promise.resolve(true),
}));

vi.mock('../session', async (importOriginal) => {
  const real = await importOriginal<typeof import('../session')>();
  return {
    ...real,
    sessionForIfOpen: (key: string) =>
      key === NB
        ? {
            executeAsync: async (code: string, _out?: unknown, options?: unknown) => {
              directOptions.push(options);
              if (inFlight > 0) throw new Error('This session is busy running something else.');
              inFlight++;
              await new Promise((resolve) => setTimeout(resolve, 5));
              inFlight--;
              ran.push(code);
              return `ran ${code}`;
            },
          }
        : undefined,
    interruptSessionFor: () => {},
  };
});

const { inNotebook } = await import('../savedObjects');

describe('inNotebook', () => {
  it('runs two direct queries on an idle notebook one after the other, so neither is busy', async () => {
    pauseQuery = undefined;
    const [a, b] = await Promise.all([inNotebook(NB, 'first'), inNotebook(NB, 'second')]);
    expect([a, b]).toEqual(['ran first', 'ran second']);
    expect(ran).toEqual(['first', 'second']);
  });

  it('keeps the chain going after a query fails', async () => {
    pauseQuery = undefined;
    await expect(inNotebook('file:///gone.ipynb', 'x')).rejects.toThrow('no database session');
    await expect(inNotebook(NB, 'after')).resolves.toBe('ran after');
  });

  it("hands a paused query the caller's options, and none when the caller gave none", async () => {
    const seen: unknown[] = [];
    pauseQuery = (code, options) => {
      seen.push(options);
      return Promise.resolve(code);
    };
    await inNotebook(NB, 'console line', { budget: false, passHalts: true });
    await inNotebook(NB, 'a read', { budget: true });
    await inNotebook(NB, 'a commit');
    expect(seen).toEqual([
      { budget: false, passHalts: true },
      { budget: true, passHalts: false },
      undefined,
    ]);
  });

  it('runs past a breakpoint() on an idle notebook too, when the caller asks', async () => {
    pauseQuery = undefined;
    directOptions.length = 0;
    await inNotebook(NB, 'evaluate', { budget: false, passHalts: true });
    await inNotebook(NB, 'a read', { budget: true });
    expect(directOptions).toEqual([{ passHalts: true }, {}]);
  });
});
