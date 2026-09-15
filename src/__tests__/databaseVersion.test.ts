import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __setSetting } from '../__mocks__/vscode';
import {
  DatabaseVersionError,
  assertDatabaseMatchesEngine,
  parseRepositoryVersion,
  repositoryVersion,
} from '../database';
import { databasePath, extentPath } from '../paths';

/**
 * Refusing a database an older engine wrote.
 *
 * Worth testing rather than trusting, because the failure it replaces looks
 * like success for a while: measured moving 3.7.5 → 4.0.0.Alpha1, the new
 * stone starts on the old repository and `gslist` reports it OK, so the status
 * bar says the database is running and only the first login fails — with
 * GemStone error 4045, which names neither the cause nor the cure.
 *
 * `copydbf` is stubbed with a script that prints what the real one prints. The
 * parsing and the decision are what can be wrong here; that the engine ships
 * `bin/copydbf` is not.
 */

let root: string;
let engine: string;

/** Verbatim `copydbf -i` output, captured on 2026-09-11. */
function copydbfOutput(version: string): string {
  return [
    `Source file: ${extentPath()}`,
    '   File type: extent  fileId: 0 in a repository with 1 files',
    '   File size: 134217728 bytes (128 MB), 8192 records',
    '   ByteOrder: LSB first  compatibilityLevel: 855 ',
    '   Extent was shutdown cleanly; no recovery needed.',
    `   GemStone Version: ${version}, Wed Mar 11 17:17:05 2026 (branch 3.7.5), cf61017e7c0c`,
    '   Encryption: NONE',
    '',
  ].join('\n');
}

/** An engine directory whose only real content is a `copydbf` that answers. */
function fakeEngine(reply: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdb-engine-'));
  fs.mkdirSync(path.join(dir, 'bin'));
  const script = path.join(dir, 'bin', 'copydbf');
  fs.writeFileSync(script, `#!/bin/sh\ncat <<'OUT'\n${reply}OUT\n`);
  fs.chmodSync(script, 0o755);
  return dir;
}

function makeExtent(): void {
  fs.mkdirSync(path.join(databasePath(), 'data'), { recursive: true });
  fs.writeFileSync(extentPath(), 'not really an extent');
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdb-dbver-'));
  __setSetting('gemdb.rootPath', root);
  engine = '';
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  if (engine) fs.rmSync(engine, { recursive: true, force: true });
});

describe('reading the version out of copydbf', () => {
  it('takes the release and stops at the comma', () => {
    expect(parseRepositoryVersion(copydbfOutput('4.0.0.Alpha1'))).toBe('4.0.0.Alpha1');
    expect(parseRepositoryVersion(copydbfOutput('3.7.5'))).toBe('3.7.5');
  });

  it('answers undefined for output with no version line', () => {
    expect(parseRepositoryVersion('')).toBeUndefined();
    expect(parseRepositoryVersion('copydbf: cannot open the file')).toBeUndefined();
  });
});

describe('the guard in front of a database', () => {
  it('says nothing when there is no database yet', () => {
    engine = fakeEngine(copydbfOutput('3.7.5'));
    // Nothing to be wrong about: a first install creates the database from
    // this engine's own extent moments later.
    expect(repositoryVersion(engine)).toBeUndefined();
    expect(() => assertDatabaseMatchesEngine(engine, '4.0.0.Alpha1')).not.toThrow();
  });

  it('says nothing when the database matches the engine', () => {
    makeExtent();
    engine = fakeEngine(copydbfOutput('4.0.0.Alpha1'));
    expect(() => assertDatabaseMatchesEngine(engine, '4.0.0.Alpha1')).not.toThrow();
  });

  it('refuses a database an older engine wrote, and says what to do', () => {
    makeExtent();
    engine = fakeEngine(copydbfOutput('3.7.5'));

    expect(() => assertDatabaseMatchesEngine(engine, '4.0.0.Alpha1')).toThrow(DatabaseVersionError);
    try {
      assertDatabaseMatchesEngine(engine, '4.0.0.Alpha1');
    } catch (e) {
      const message = (e as Error).message;
      // Both versions, the path to delete, and a warning: everything the user
      // needs is in the message, because there is no upgrade to offer.
      expect(message).toContain('3.7.5');
      expect(message).toContain('4.0.0.Alpha1');
      expect(message).toContain(databasePath());
      expect(message).toMatch(/delete/i);
    }
  });

  it('stays out of the way when copydbf cannot answer', () => {
    // An unreadable extent is the engine's to report when it opens the file.
    // Refusing to start on the strength of a failed probe would turn a
    // question into an outage.
    makeExtent();
    engine = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdb-engine-'));
    expect(repositoryVersion(engine)).toBeUndefined();
    expect(() => assertDatabaseMatchesEngine(engine, '4.0.0.Alpha1')).not.toThrow();
    fs.rmSync(engine, { recursive: true, force: true });
    engine = '';
  });
});
