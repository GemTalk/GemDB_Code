import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  allowAutoStart,
  autoStartSuppressed,
  initAutoStart,
  suppressAutoStart,
} from '../autoStart';

let storage: string;

beforeEach(() => {
  storage = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdb-auto-'));
  initAutoStart(storage);
});

afterEach(() => fs.rmSync(storage, { recursive: true, force: true }));

describe('auto-start suppression', () => {
  it('lets GemDB start the database until told otherwise', () => {
    expect(autoStartSuppressed()).toBe(false);
  });

  it('remembers a deliberate stop', () => {
    suppressAutoStart();
    expect(autoStartSuppressed()).toBe(true);
  });

  it('forgets it the moment a database is asked for again', () => {
    suppressAutoStart();
    allowAutoStart();
    expect(autoStartSuppressed()).toBe(false);
  });

  it('survives a restart, because it is a file and not a variable', () => {
    suppressAutoStart();
    initAutoStart(storage); // a fresh activation, same machine
    expect(autoStartSuppressed()).toBe(true);
  });

  it('is stored outside Settings Sync, per machine', () => {
    suppressAutoStart();
    // The path matters: globalState would carry this to another machine, where
    // stopping a database here would stop one starting there.
    expect(fs.existsSync(path.join(storage, 'stopped-by-user'))).toBe(true);
  });

  it('creates the storage directory if the extension has never written there', () => {
    const fresh = path.join(storage, 'never-used');
    initAutoStart(fresh);
    suppressAutoStart();
    expect(autoStartSuppressed()).toBe(true);
  });
});
