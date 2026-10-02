import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __setSetting } from '../__mocks__/vscode';
import { createDatabase } from '../database';
import { databaseExists, databasePath, extentPath } from '../paths';

// Passes through unless a test hooks it: the extent's chmod is the last step
// before the rename, so it is where another window's database can be made to
// appear.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const chmodSync = vi.fn(actual.chmodSync);
  return { ...actual, default: { ...actual, chmodSync }, chmodSync };
});

/** Run `sideEffect` just before `createDatabase` renames its build onto db/. */
function beforeTheRename(sideEffect: () => void): void {
  const chmodSync = vi.mocked(fs.chmodSync);
  chmodSync.mockImplementationOnce((file, mode) => {
    chmodSync.getMockImplementation()?.(file, mode);
    sideEffect();
  });
}

/**
 * Creating the database, and what a crash part way through leaves behind.
 *
 * `databaseExists` asks only whether `db/` holds an extent, so a creation cut
 * short while the extent was being copied would leave a truncated one that
 * passes for a finished database. The database is therefore built in
 * `db.tmp/` and renamed onto `db/` once complete. These tests use a stand-in
 * engine carrying just the files `createDatabase` copies.
 */

let root: string;
let engine: string;

/** An engine directory with the files the database is made from. */
function makeEngine(withExtent = true): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdb-engine-'));
  fs.mkdirSync(path.join(dir, 'sys'));
  fs.mkdirSync(path.join(dir, 'data'));
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.writeFileSync(path.join(dir, 'sys', 'community.starter.key'), 'key');
  fs.writeFileSync(path.join(dir, 'data', 'system.conf'), '# defaults');
  if (withExtent) fs.writeFileSync(path.join(dir, 'bin', 'extent0.dbf'), 'extent');
  return dir;
}

const staging = (): string => `${databasePath()}.tmp`;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdb-db-'));
  __setSetting('gemdb.rootPath', root);
  engine = makeEngine();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(engine, { recursive: true, force: true });
});

describe('creating the database', () => {
  it('builds it beside db/ and renames it into place', () => {
    expect(createDatabase(engine)).toBe(true);

    expect(databaseExists()).toBe(true);
    expect(fs.readFileSync(extentPath(), 'utf8')).toBe('extent');
    expect(fs.existsSync(staging())).toBe(false);
  });

  it('writes configuration naming db/, not where it was built', () => {
    createDatabase(engine);

    const conf = path.join(databasePath(), 'conf');
    const system = fs.readFileSync(path.join(conf, 'system.conf'), 'utf8');
    const stone = fs.readFileSync(path.join(conf, 'gemdb.conf'), 'utf8');
    expect(system).toContain(`DBF_EXTENT_NAMES = "${extentPath()}";`);
    expect(system).toContain(`STN_TRAN_LOG_DIRECTORIES = "${path.join(databasePath(), 'data')}/";`);
    expect(stone).toContain(`KEYFILE = "${path.join(conf, 'gemdb.key')}";`);
    expect(system + stone).not.toContain('db.tmp');
  });

  it('leaves no database when creation stops part way through, and builds one next time', () => {
    // The engine missing its extent is a throw at the last step, after the
    // configuration is written — the same place a crash during the copy
    // would stop.
    const broken = makeEngine(false);
    try {
      expect(() => createDatabase(broken)).toThrow(/no initial extent/);
    } finally {
      fs.rmSync(broken, { recursive: true, force: true });
    }
    expect(databaseExists()).toBe(false);
    expect(fs.existsSync(databasePath())).toBe(false);

    expect(createDatabase(engine)).toBe(true);
    expect(databaseExists()).toBe(true);
    expect(fs.existsSync(staging())).toBe(false);
  });

  it('removes a leftover build even when the database already exists', () => {
    createDatabase(engine);
    fs.mkdirSync(path.join(staging(), 'data'), { recursive: true });

    expect(createDatabase(engine)).toBe(false);
    expect(fs.existsSync(staging())).toBe(false);
  });

  it('replaces an empty db/', () => {
    fs.mkdirSync(databasePath());

    expect(createDatabase(engine)).toBe(true);
    expect(databaseExists()).toBe(true);
  });

  it('refuses to merge into a db/ that holds something other than a database', () => {
    fs.mkdirSync(path.join(databasePath(), 'conf'), { recursive: true });
    fs.writeFileSync(path.join(databasePath(), 'conf', 'mine.conf'), 'keep me');

    expect(() => createDatabase(engine)).toThrow(/already exists but holds no database/);

    expect(fs.readdirSync(databasePath())).toEqual(['conf']);
    expect(fs.readdirSync(path.join(databasePath(), 'conf'))).toEqual(['mine.conf']);
    expect(fs.existsSync(staging())).toBe(false);
  });

  it('refuses before building, so nothing is copied for a db/ it cannot replace', () => {
    fs.mkdirSync(databasePath());
    fs.writeFileSync(path.join(databasePath(), 'notes.txt'), 'keep me');
    fs.mkdirSync(staging());

    expect(() => createDatabase(engine)).toThrow(/holds notes\.txt/);
    // The leftover build is cleared first, and no new one is started.
    expect(fs.existsSync(staging())).toBe(false);
  });

  it("replaces a db/ holding only GemDB's records and the OS's files, without carrying them over", () => {
    // What an external database leaves in the root's db/, plus Finder's file.
    fs.mkdirSync(databasePath());
    fs.writeFileSync(path.join(databasePath(), '.gemdb-grail-failed'), '{}\n');
    fs.writeFileSync(path.join(databasePath(), '.gemdb-grail-installed'), 'grail=x\n');
    fs.writeFileSync(path.join(databasePath(), '.DS_Store'), '');
    fs.writeFileSync(path.join(databasePath(), '._extent0.dbf'), '');

    expect(createDatabase(engine)).toBe(true);
    expect(databaseExists()).toBe(true);
    expect(fs.readdirSync(databasePath()).sort()).toEqual(['conf', 'data', 'log', 'stat']);
  });

  it("refuses a db/ holding GemDB's records alongside something else, and keeps all of it", () => {
    fs.mkdirSync(databasePath());
    fs.writeFileSync(path.join(databasePath(), '.gemdb-grail-failed'), '{}\n');
    fs.writeFileSync(path.join(databasePath(), 'notes.txt'), 'keep me');

    expect(() => createDatabase(engine)).toThrow(/holds notes\.txt\)/);
    expect(fs.readdirSync(databasePath()).sort()).toEqual(['.gemdb-grail-failed', 'notes.txt']);
  });

  it('keeps a database that appeared in db/ while this one was being built', () => {
    // Another window finishing its own database between the clear and the
    // rename.
    beforeTheRename(() => {
      fs.mkdirSync(path.dirname(extentPath()), { recursive: true });
      fs.writeFileSync(extentPath(), 'theirs');
    });

    expect(createDatabase(engine)).toBe(false);
    expect(fs.readFileSync(extentPath(), 'utf8')).toBe('theirs');
    expect(fs.existsSync(staging())).toBe(false);
  });

  it('refuses, naming what is there, when something other than a database appeared in db/', () => {
    beforeTheRename(() => {
      fs.mkdirSync(databasePath(), { recursive: true });
      fs.writeFileSync(path.join(databasePath(), 'notes.txt'), 'keep me');
    });

    expect(() => createDatabase(engine)).toThrow(/holds notes\.txt\)/);
    expect(fs.readdirSync(databasePath())).toEqual(['notes.txt']);
    expect(fs.existsSync(staging())).toBe(false);
  });
});
