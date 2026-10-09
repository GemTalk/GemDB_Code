import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __log, __resetSettings, __setSetting } from '../__mocks__/vscode';

/**
 * Starting the stone and the listener when another process may be doing the
 * same, with the engine's commands faked: `gslist` answers from `listed`, and
 * every other command exits with the code `exitCodes` gives it.
 */

let listed = '';
const exitCodes: Record<string, number> = {};
const spawned: string[] = [];

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
    [promisify.custom]: async () => ({ stdout: listed, stderr: '' }),
  });
  return {
    ...actual,
    execFile,
    execFileSync: () => listed,
    spawn: (command: string) => fakeChild(command),
  };
});

const { expectedEnginePath } = await import('../paths');
const { startNetldi } = await import('../processes');

function row(status: string, type: 'Stone' | 'Netldi', name: string): string {
  return `${status.padEnd(12)} 4.0.0.a4  me      79386 51475 Sep 28 19:31 ${type.padEnd(7)} ${name}`;
}

let root: string;

beforeEach(() => {
  __resetSettings();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdb-start-'));
  __setSetting('gemdb.rootPath', root);
  fs.mkdirSync(path.join(expectedEnginePath(), 'bin'), { recursive: true });
  fs.writeFileSync(path.join(expectedEnginePath(), 'bin', 'gslist'), '');
  listed = '';
  spawned.length = 0;
  for (const key of Object.keys(exitCodes)) delete exitCodes[key];
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('startNetldi', () => {
  it('counts a listener another process started first as up, not as a failure (#89)', async () => {
    // Both saw no listener; the other one won, so startnetldi refuses with
    // "already running" and the re-list shows the listener answering.
    exitCodes.startnetldi = 1;
    listed = [row('OK', 'Stone', 'gemdb'), row('OK', 'Netldi', 'gemdbldi')].join('\n');

    await expect(startNetldi()).resolves.toBe(false);
    expect(__log).toContain('Another process started the session listener.');
  });

  it('still fails when the listener is not up afterwards', async () => {
    exitCodes.startnetldi = 1;
    listed = row('OK', 'Stone', 'gemdb');

    await expect(startNetldi()).rejects.toThrow(/Start session listener failed \(exit code 1\)/);
  });

  it('still fails when the listener is listed but not answering', async () => {
    exitCodes.startnetldi = 1;
    listed = [row('OK', 'Stone', 'gemdb'), row('exe deleted', 'Netldi', 'gemdbldi')].join('\n');

    await expect(startNetldi()).rejects.toThrow(/Start session listener failed/);
  });

  it('reports a listener it started itself as started', async () => {
    await expect(startNetldi()).resolves.toBe(true);
    expect(spawned).toEqual(['startnetldi']);
  });
});
