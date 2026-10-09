import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __log, __resetSettings, __setSetting } from '../__mocks__/vscode';

/**
 * Starting the stone and the listener when another process may be doing the
 * same, with the engine's commands faked: `gslist` answers with the next of
 * `listings` (the last one for good once they run out), and every other
 * command exits with the code `exitCodes` gives it.
 */

let listings: string[] = [];
const exitCodes: Record<string, number> = {};
const spawned: string[] = [];

function gslist(): string {
  return listings.length > 1 ? (listings.shift() ?? '') : (listings[0] ?? '');
}

function fakeChild(command: string): EventEmitter {
  const name = path.basename(command);
  spawned.push(name);
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
  setImmediate(() => child.emit('close', exitCodes[name] ?? 0));
  return child;
}

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const execFile = Object.assign(() => {}, {
    [promisify.custom]: async () => ({ stdout: gslist(), stderr: '' }),
  });
  return {
    ...actual,
    execFile,
    execFileSync: () => gslist(),
    spawn: (command: string) => fakeChild(command),
  };
});

// The real lock, with what it is asked to wait for kept where a test can ask it.
let satisfied: (() => boolean | Promise<boolean>) | undefined;
vi.mock('../lock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lock')>();
  return {
    ...actual,
    withStoneLock: <T>(
      work: () => Promise<T>,
      wait: { satisfied?: () => boolean | Promise<boolean> } = {},
    ) => {
      satisfied = wait.satisfied;
      return actual.withStoneLock(work, wait);
    },
  };
});

const { expectedEnginePath } = await import('../paths');
const { ensureProcesses } = await import('../processes');

function row(status: string, type: 'Stone' | 'Netldi', name: string): string {
  return `${status.padEnd(12)} 4.0.0.a4  me      79386 51475 Sep 28 19:31 ${type.padEnd(7)} ${name}`;
}

const STONE_UP = row('OK', 'Stone', 'gemdb');
const LISTENER_UP = row('OK', 'Netldi', 'gemdbldi');
const BOTH_UP = [STONE_UP, LISTENER_UP].join('\n');

let root: string;

beforeEach(() => {
  __resetSettings();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdb-start-'));
  __setSetting('gemdb.rootPath', root);
  fs.mkdirSync(path.join(expectedEnginePath(), 'bin'), { recursive: true });
  fs.writeFileSync(path.join(expectedEnginePath(), 'bin', 'gslist'), '');
  listings = [];
  spawned.length = 0;
  satisfied = undefined;
  for (const key of Object.keys(exitCodes)) delete exitCodes[key];
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('ensureProcesses', () => {
  it('starts nothing, and says so, when both are already up', async () => {
    listings = [BOTH_UP];
    const beforeStoneStart = vi.fn();

    const started = await ensureProcesses({ beforeStoneStart });

    expect(started).toEqual({ startedStone: false, startedNetldi: false });
    expect(spawned).toEqual([]);
    expect(beforeStoneStart).not.toHaveBeenCalled();
  });

  it('starts both, guards first, when neither is up', async () => {
    listings = ['', '', BOTH_UP];
    const beforeStoneStart = vi.fn(() => {
      expect(spawned).toEqual([]);
    });

    const started = await ensureProcesses({ beforeStoneStart });

    expect(started).toEqual({ startedStone: true, startedNetldi: true });
    expect(spawned).toEqual(['startstone', 'startnetldi']);
    expect(beforeStoneStart).toHaveBeenCalledOnce();
  });

  it('starts only the listener when the stone is up, without the stone’s guards', async () => {
    listings = [STONE_UP];
    const beforeStoneStart = vi.fn();

    const started = await ensureProcesses({ beforeStoneStart });

    expect(started).toEqual({ startedStone: false, startedNetldi: true });
    expect(spawned).toEqual(['startnetldi']);
    expect(beforeStoneStart).not.toHaveBeenCalled();
  });

  it('starts no stone when a guard refuses it', async () => {
    listings = [''];

    const start = ensureProcesses({
      beforeStoneStart: () => {
        throw new Error('the database is on NFS');
      },
    });

    await expect(start).rejects.toThrow('the database is on NFS');
    expect(spawned).toEqual([]);
  });

  it('looks for the listener again after starting the stone, not at a list from before', async () => {
    // Another process started the listener while this one started the stone.
    listings = ['', BOTH_UP];

    const started = await ensureProcesses();

    expect(started).toEqual({ startedStone: true, startedNetldi: false });
    expect(spawned).toEqual(['startstone']);
  });

  it('counts a listener another process started first as up, not as a failure (#89)', async () => {
    // Both saw no listener; the other one won, so startnetldi refuses with
    // "already running" and the re-list shows the listener answering.
    exitCodes.startnetldi = 1;
    listings = [STONE_UP, STONE_UP, BOTH_UP];

    const started = await ensureProcesses();

    expect(started).toEqual({ startedStone: false, startedNetldi: false });
    expect(__log).toContain('Another process started the session listener.');
  });

  it('still fails a listener start that leaves no listener up', async () => {
    exitCodes.startnetldi = 1;
    listings = [STONE_UP];

    await expect(ensureProcesses()).rejects.toThrow(
      /Start session listener failed \(exit code 1\)/,
    );
  });

  it('still fails a listener start that leaves a listener that is not answering', async () => {
    exitCodes.startnetldi = 1;
    listings = [
      STONE_UP,
      STONE_UP,
      [STONE_UP, row('exe deleted', 'Netldi', 'gemdbldi')].join('\n'),
    ];

    await expect(ensureProcesses()).rejects.toThrow(/Start session listener failed/);
  });

  it('stops waiting for the lock only once both are up and answering', async () => {
    listings = [BOTH_UP];
    await ensureProcesses();
    const check = async (listing: string): Promise<boolean | undefined> => {
      listings = [listing];
      return satisfied?.();
    };

    expect(await check(BOTH_UP)).toBe(true);
    expect(await check(STONE_UP)).toBe(false);
    expect(await check(LISTENER_UP)).toBe(false);
    expect(await check([row('Startup', 'Stone', 'gemdb'), LISTENER_UP].join('\n'))).toBe(false);
  });
});
