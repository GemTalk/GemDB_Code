import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __setSetting } from '../__mocks__/vscode';
import { grailNeedsUpdate, stageGrail } from '../grail';
import {
  databasePath,
  expectedEnginePath,
  grailPath,
  grailStampPath,
  installedGrailStamp,
  legacyGrailStampPath,
} from '../paths';

/**
 * Getting Grail onto disk, and saying so afterwards.
 *
 * This is the first-run path, and it is the one place the integration suite
 * cannot speak for: those tests call `stageGrail` against a fixture that
 * already has a root path. What broke in the field was staging on a machine
 * where nothing had been installed before — so these tests start from a root
 * path that does not exist, which is the condition that matters.
 *
 * Staging never stamps. The stamp means "this Grail is filed into the
 * database", which copying files is not: it is written by
 * `recordGrailInstalled` after the install succeeds, and nowhere else. There
 * used to be one exception — a database made from a shipped, preloaded extent
 * arrived with Grail already in it — and the ordering of those two steps was
 * subtle enough to break twice. GemDB no longer ships an extent (every
 * database is made from the engine's own `extent0.dbf` and has Grail filed
 * into it here), so the exception, and the ordering question with it, is gone.
 */

let root: string;
let ext: string;

const BUNDLED = 'grail=0.1-2172-gabc\ncommit=abc\nengine=4.0.0.a4\n';

/** A stand-in extension directory carrying a Grail payload. */
function makeExtensionDir(stamp: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdb-ext-'));
  fs.mkdirSync(path.join(dir, 'grail', 'src', 'python'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'grail', 'GRAIL_VERSION'), stamp);
  fs.writeFileSync(path.join(dir, 'grail', 'src', 'python', 'marker.py'), '# staged\n');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '1.6.0' }));
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
  it('creates the staged copy under a root path that does not exist yet', () => {
    expect(fs.existsSync(grailPath())).toBe(false);

    expect(() => stageGrail(ext)).not.toThrow();

    expect(fs.existsSync(path.join(grailPath(), 'src', 'python', 'marker.py'))).toBe(true);
  });

  it('leaves no stamp, because nothing has been filed into a database yet', () => {
    // `ensureRunning` files Grail in and stamps it afterwards. Claiming it
    // here would offer Python against a database that has none.
    stageGrail(ext);

    expect(fs.existsSync(grailStampPath())).toBe(false);
    expect(installedGrailStamp()).toBeUndefined();
  });
});

describe('staging Grail over a previous version', () => {
  beforeEach(() => {
    // What an upgrade from a GemDB that kept its stamp inside grail/ finds: a
    // complete older Grail, stamped there as filed in.
    fs.mkdirSync(path.join(grailPath(), 'src', 'python'), { recursive: true });
    fs.writeFileSync(path.join(grailPath(), 'GRAIL_VERSION'), 'grail=0.1-1570-gold\n');
    fs.writeFileSync(path.join(grailPath(), 'src', 'python', 'old-only.py'), '# stale\n');
    fs.writeFileSync(legacyGrailStampPath(), 'grail=0.1-1570-gold\n');
  });

  it('replaces the old payload rather than declaring it current', () => {
    expect(grailNeedsUpdate(ext)).toBe(true);

    stageGrail(ext);

    expect(fs.existsSync(path.join(grailPath(), 'src', 'python', 'marker.py'))).toBe(true);
    expect(fs.existsSync(path.join(grailPath(), 'src', 'python', 'old-only.py'))).toBe(false);
    expect(fs.readFileSync(path.join(grailPath(), 'GRAIL_VERSION'), 'utf8')).toBe(BUNDLED);
  });

  it('keeps the record of what the database holds, since staging changes nothing in it', () => {
    // Staging replaces grail/ wholesale, and every GemDB on this root path
    // stages. A stamp kept there was forgotten each time, so the next start
    // filed Grail in again whether or not the database already had it.
    fs.mkdirSync(databasePath(), { recursive: true });
    fs.writeFileSync(grailStampPath(), `${BUNDLED}extension=1.6.0\n`);

    stageGrail(ext);

    expect(installedGrailStamp()).toBe(`${BUNDLED}extension=1.6.0`);
    expect(grailNeedsUpdate(ext)).toBe(false);
  });
});
