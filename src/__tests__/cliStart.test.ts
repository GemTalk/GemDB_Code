import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What `gemdb` does to bring the database up, with the engine's side faked:
 * which checks run before a start, and whether the listener is asked for.
 */

let external: object | undefined;
let grailInstalled = true;
const ensureProcesses = vi.fn(async (_opts: unknown) => ({
  startedStone: true,
  startedNetldi: false,
}));
const assertExternalDatabaseUp = vi.fn(async (_opts: unknown) => {});
const assertSafeToStart = vi.fn();

vi.mock('../config', () => ({ externalDatabase: () => external }));
vi.mock('../paths', () => ({ grailInstalled: () => grailInstalled }));
vi.mock('../database', () => ({ assertSafeToStart: () => assertSafeToStart() }));
vi.mock('../processes', () => ({
  ensureProcesses: (opts: unknown) => ensureProcesses(opts),
  assertExternalDatabaseUp: (opts: unknown) => assertExternalDatabaseUp(opts),
}));

const { bringUp } = await import('../cliStart');
const { GRAIL_NOT_INSTALLED } = await import('../grailMessages');

beforeEach(() => {
  external = undefined;
  grailInstalled = true;
  ensureProcesses.mockClear();
  assertExternalDatabaseUp.mockClear();
  assertSafeToStart.mockClear();
});

describe('bringing the database up for the gemdb command', () => {
  it('runs the same guards before a start that the editor does', async () => {
    const report = vi.fn();

    await bringUp({ listener: false, report });

    const opts = ensureProcesses.mock.calls[0]?.[0] as {
      beforeStoneStart: () => void;
      report: unknown;
    };
    opts.beforeStoneStart();
    expect(assertSafeToStart).toHaveBeenCalledTimes(1);
    expect(opts.report).toBe(report);
  });

  it('passes on that the caller already looked', async () => {
    await bringUp({ listener: false, report: () => {}, skipQuickCheck: true });

    expect(ensureProcesses.mock.calls[0]?.[0]).toMatchObject({ skipQuickCheck: true });
  });

  it('starts the stone alone for a file run, and the listener too for the Shell', async () => {
    await bringUp({ listener: false, report: () => {} });
    await bringUp({ listener: true, report: () => {} });

    expect(
      ensureProcesses.mock.calls.map(([opts]) => (opts as { listener: boolean }).listener),
    ).toEqual([false, true]);
  });

  it('only checks an external database, whichever way it is asked', async () => {
    external = { stone: 'gs64stone' };
    const report = vi.fn();

    await bringUp({ listener: false, report });

    expect(ensureProcesses).not.toHaveBeenCalled();
    expect(assertExternalDatabaseUp).toHaveBeenCalledWith({ listener: false, report });
  });

  it('says why an external database that is down cannot be used', async () => {
    external = { stone: 'gs64stone' };
    assertExternalDatabaseUp.mockRejectedValueOnce(new Error('The database is not running'));

    await expect(bringUp({ listener: true, report: () => {} })).rejects.toThrow(
      'The database is not running',
    );
  });

  it('lets a refused start through to the caller, which says it', async () => {
    ensureProcesses.mockRejectedValueOnce(new Error('delete this directory'));

    await expect(bringUp({ listener: false, report: () => {} })).rejects.toThrow(
      'delete this directory',
    );
  });

  it('refuses an own database that has no Python in it, before starting anything', async () => {
    grailInstalled = false;

    await expect(bringUp({ listener: false, report: () => {} })).rejects.toThrow(
      GRAIL_NOT_INSTALLED,
    );
    expect(ensureProcesses).not.toHaveBeenCalled();
  });

  it('does not ask an external database for Python', async () => {
    external = { stone: 'gs64stone' };
    grailInstalled = false;

    await bringUp({ listener: true, report: () => {} });

    expect(assertExternalDatabaseUp).toHaveBeenCalled();
  });
});
