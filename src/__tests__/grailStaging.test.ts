import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __setSetting } from '../__mocks__/vscode';
import { grailNeedsUpdate, stageAndRecordGrail } from '../grail';
import { expectedEnginePath, grailPath, grailStampPath, installedGrailStamp } from '../paths';

/**
 * Getting Grail onto disk, and saying so afterwards.
 *
 * This is the first-run path, and it is the one place the integration suite
 * cannot speak for: those tests call `stageGrail` themselves against a fixture
 * that already has a root path. What broke in the field was the *order* of two
 * calls on a machine where nothing had been installed before — so these tests
 * start from a root path that does not exist, which is the condition that
 * matters.
 */

let root: string;
let ext: string;

const BUNDLED = 'grail=0.1-2172-gabc\ncommit=abc\nengine=3.7.5\n';

/** A stand-in extension directory carrying a Grail payload. */
function makeExtensionDir(stamp: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdb-ext-'));
  fs.mkdirSync(path.join(dir, 'grail', 'src', 'python'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'grail', 'GRAIL_VERSION'), stamp);
  fs.writeFileSync(path.join(dir, 'grail', 'src', 'python', 'marker.py'), '# staged\n');
  fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
  return dir;
}

beforeEach(() => {
  root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gemdb-run-')), 'GemDB');
  ext = makeExtensionDir(BUNDLED);
  __setSetting('gemdb.rootPath', root);
  // writeCliScripts, which staging calls, refuses without an engine.
  fs.mkdirSync(expectedEnginePath(), { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(ext, { recursive: true, force: true });
});

describe('staging Grail on a machine that has never had it', () => {
  it('does not fail trying to stamp a directory that is not there yet', () => {
    // The reported failure: "ENOENT ... open '<root>/grail/.gemdb-grail-stamp'"
    // arrived immediately after "Database created", because the stamp was
    // written before anything created <root>/grail.
    expect(fs.existsSync(grailPath())).toBe(false);

    expect(() => stageAndRecordGrail(ext, true)).not.toThrow();

    expect(fs.existsSync(path.join(grailPath(), 'src', 'python', 'marker.py'))).toBe(true);
    expect(installedGrailStamp()).toBe(BUNDLED.trim());
  });

  it('leaves no stamp when the database was not made from the shipped extent', () => {
    // Then `ensureRunning` files Grail in, which is the work the stamp exists
    // to skip; claiming it was done would offer Python against a database
    // without any.
    stageAndRecordGrail(ext, false);

    expect(fs.existsSync(path.join(grailPath(), 'src', 'python', 'marker.py'))).toBe(true);
    expect(fs.existsSync(grailStampPath())).toBe(false);
  });
});

describe('staging Grail over a previous version', () => {
  beforeEach(() => {
    // What an upgrade finds: a complete older Grail, stamped as filed in.
    fs.mkdirSync(path.join(grailPath(), 'src', 'python'), { recursive: true });
    fs.writeFileSync(path.join(grailPath(), 'GRAIL_VERSION'), 'grail=0.1-1570-gold\n');
    fs.writeFileSync(path.join(grailPath(), 'src', 'python', 'old-only.py'), '# stale\n');
    fs.writeFileSync(grailStampPath(), 'grail=0.1-1570-gold\n');
  });

  it('replaces the old payload rather than declaring it current', () => {
    // The subtler half of the same bug: stamping first made grailNeedsUpdate
    // compare the bundled stamp against itself, so staging was skipped and the
    // old Grail stayed on disk wearing the new version's label.
    expect(grailNeedsUpdate(ext)).toBe(true);

    stageAndRecordGrail(ext, false);

    expect(fs.existsSync(path.join(grailPath(), 'src', 'python', 'marker.py'))).toBe(true);
    expect(fs.existsSync(path.join(grailPath(), 'src', 'python', 'old-only.py'))).toBe(false);
    expect(fs.readFileSync(path.join(grailPath(), 'GRAIL_VERSION'), 'utf8')).toBe(BUNDLED);
  });

  it('stages before stamping even when the stamp is warranted', () => {
    // The ordering guard. With the calls reversed this passes silently on an
    // upgrade — the stamp lands in the old directory, grailNeedsUpdate then
    // finds the bundled stamp already installed, and staging never runs, so
    // the previous Grail stays on disk labelled as the current one.
    stageAndRecordGrail(ext, true);

    expect(fs.existsSync(path.join(grailPath(), 'src', 'python', 'marker.py'))).toBe(true);
    expect(fs.existsSync(path.join(grailPath(), 'src', 'python', 'old-only.py'))).toBe(false);
    expect(installedGrailStamp()).toBe(BUNDLED.trim());
  });

  it('drops the old stamp, so the new Grail gets filed into the old database', () => {
    // Staging replaces the directory wholesale, stamp included. That is what
    // makes isInstalled() false and sends ensureRunning to install the new
    // Grail — the upgrade path the stamp is for.
    stageAndRecordGrail(ext, false);

    expect(fs.existsSync(grailStampPath())).toBe(false);
  });
});
