import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __resetSettings, __setSetting } from '../__mocks__/vscode';
import { EngineProcess } from '../gslist';
import { engineDirName } from '../paths';
import { engineThatStarted, startedByAnotherEngine } from '../processes';

/**
 * Which engine's tools stop a stone that is already running.
 *
 * Stones outlive the editor, so after an update moves the pin the stone still
 * up is the previous engine's, and the new engine's stopstone cannot log in to
 * it (4044). Stopping it with the wrong engine is what left a user unable to
 * stop or upgrade their database without reinstalling the old GemDB.
 */

const PIN = '4.0.0.a8';
const PREVIOUS = '4.0.0.a5';

function stone(version: string): EngineProcess {
  return { type: 'stone', name: 'gemdb', version, pid: 101, status: 'OK', responding: true };
}

let root: string;

beforeEach(() => {
  __resetSettings();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdb-engine-'));
  __setSetting('gemdb.rootPath', root);
  __setSetting('gemdb.engineVersion', PIN);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function install(version: string): string {
  const dir = path.join(root, engineDirName(version));
  fs.mkdirSync(dir);
  return dir;
}

describe('the engine that stops a running database', () => {
  it('is the pinned one for a stone the pinned engine started', () => {
    install(PIN);

    expect(startedByAnotherEngine(stone(PIN))).toBe(false);
    expect(engineThatStarted(stone(PIN))).toBeUndefined();
  });

  it('is the previous one for a stone the previous engine started', () => {
    install(PIN);
    const previous = install(PREVIOUS);

    expect(startedByAnotherEngine(stone(PREVIOUS))).toBe(true);
    expect(engineThatStarted(stone(PREVIOUS))).toBe(previous);
  });

  it('falls back to the pinned one when the previous engine is gone', () => {
    install(PIN);

    expect(engineThatStarted(stone(PREVIOUS))).toBeUndefined();
  });

  it('takes a version the process list cut short for the pinned one', () => {
    __setSetting('gemdb.engineVersion', '4.0.0.Alpha1');

    expect(startedByAnotherEngine(stone('4.0.0.Alpha'))).toBe(false);
  });

  it('is the pinned one when nothing is running', () => {
    expect(startedByAnotherEngine(undefined)).toBe(false);
    expect(engineThatStarted(undefined)).toBeUndefined();
  });
});
