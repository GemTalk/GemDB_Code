import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __setSetting } from '../__mocks__/vscode';
import { ensurePasswordFile } from '../database';
import {
  fileInGrail,
  grailInstallFailure,
  grailNeedsUpdate,
  onDidAttemptGrailInstall,
  recordGrailInstalled,
} from '../grail';
import {
  databasePath,
  expectedEnginePath,
  grailInstalled,
  grailPath,
  grailStagedByPath,
  grailStampPath,
  installedGrailStamp,
  legacyGrailStampPath,
} from '../paths';

/**
 * Remembering that filing Grail in failed, so the status view can say so.
 *
 * The installer here is a stand-in script that exits with whatever status the
 * test asks for: what is under test is the bookkeeping around it, not Grail's
 * install, which the integration suite runs for real.
 */

let root: string;
let ext: string;

const BUNDLED = 'grail=0.1-2200-gnew\ncommit=new\nengine=4.0.0.a3\n';
/** What this GemDB records once BUNDLED is filed in. */
const RECORDED = `${BUNDLED}extension=1.6.0`;
const noProgress = { report: () => {} };

/** A stand-in extension directory: a Grail payload and an installer that exits `status`. */
function makeExtensionDir(stamp: string | undefined, status: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdb-ext-'));
  if (stamp !== undefined) {
    fs.mkdirSync(path.join(dir, 'grail'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'grail', 'GRAIL_VERSION'), stamp);
  }
  fs.mkdirSync(path.join(dir, 'resources'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'resources', 'install-grail.sh'),
    `echo "filing in"\nexit ${status}\n`,
  );
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '1.6.0' }));
  fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
  return dir;
}

beforeEach(() => {
  root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gemdb-run-')), 'GemDB');
  __setSetting('gemdb.rootPath', root);
  // The installer logs in as the database's account, whose password lives
  // beside the database.
  ensurePasswordFile();
  // writeCliScripts, which staging calls, refuses without an engine; and the
  // record lives beside a database, which an install only runs against.
  fs.mkdirSync(expectedEnginePath(), { recursive: true });
  fs.mkdirSync(databasePath(), { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  if (ext) fs.rmSync(ext, { recursive: true, force: true });
});

describe('filing Grail into the database', () => {
  it('records a failed install against the build that failed', async () => {
    ext = makeExtensionDir(BUNDLED, 1);

    await expect(fileInGrail(ext, noProgress)).rejects.toThrow('exit code 1');

    expect(grailInstallFailure(ext)?.message).toContain('exit code 1');
    expect(installedGrailStamp()).toBeUndefined();
  });

  it('clears the record once an install succeeds', async () => {
    ext = makeExtensionDir(BUNDLED, 1);
    await fileInGrail(ext, noProgress).catch(() => {});
    fs.writeFileSync(path.join(ext, 'resources', 'install-grail.sh'), 'exit 0\n');

    await fileInGrail(ext, noProgress);

    expect(grailInstallFailure(ext)).toBeUndefined();
    expect(installedGrailStamp()).toBe(RECORDED);
  });

  it('keeps the record when staging runs again before a retry', async () => {
    // First-run preparation stages at activation. A record kept beside the
    // stamp would be deleted by it, and the failure forgotten before the
    // status view was ever painted.
    ext = makeExtensionDir(BUNDLED, 1);
    await fileInGrail(ext, noProgress).catch(() => {});

    fs.rmSync(path.join(root, 'grail'), { recursive: true, force: true });

    expect(grailInstallFailure(ext)).toBeDefined();
  });

  it('ignores a failure recorded for a different build', async () => {
    // An update that ships a fixed payload has not failed yet.
    ext = makeExtensionDir(BUNDLED, 1);
    await fileInGrail(ext, noProgress).catch(() => {});

    fs.writeFileSync(path.join(ext, 'grail', 'GRAIL_VERSION'), 'grail=0.1-2300-gfixed\n');

    expect(grailInstallFailure(ext)).toBeUndefined();
  });

  it('records a build that carries no Python payload as a failure too', async () => {
    ext = makeExtensionDir(undefined, 0);

    await expect(fileInGrail(ext, noProgress)).rejects.toThrow('ships no Python payload');

    expect(grailInstallFailure(ext)?.message).toContain('ships no Python payload');
  });

  it('announces every attempt, whichever way it went', async () => {
    ext = makeExtensionDir(BUNDLED, 1);
    let attempts = 0;
    const listening = onDidAttemptGrailInstall(() => attempts++);

    await fileInGrail(ext, noProgress).catch(() => {});
    fs.writeFileSync(path.join(ext, 'resources', 'install-grail.sh'), 'exit 0\n');
    await fileInGrail(ext, noProgress);
    listening.dispose();

    expect(attempts).toBe(2);
  });
});

describe('the record of which Grail is filed in', () => {
  /** Write a stamp, dated `ageSeconds` ago so the two locations can be ordered. */
  function writeStamp(file: string, text: string, ageSeconds: number): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${text}\n`);
    const when = new Date(Date.now() - ageSeconds * 1000);
    fs.utimesSync(file, when, when);
  }

  it('lives beside the database', async () => {
    ext = makeExtensionDir(BUNDLED, 0);

    await fileInGrail(ext, noProgress);

    expect(fs.readFileSync(grailStampPath(), 'utf8').trim()).toBe(RECORDED);
    expect(path.dirname(grailStampPath())).toBe(databasePath());
  });

  it('creates the database directory for an external database, which has none here', () => {
    ext = makeExtensionDir(BUNDLED, 0);
    fs.rmSync(databasePath(), { recursive: true, force: true });

    recordGrailInstalled(ext);

    expect(installedGrailStamp()).toBe(RECORDED);
  });

  it('still counts as filed in when only an older GemDB has recorded it', () => {
    // An update from a release that kept the stamp inside grail/. Reading it
    // as never installed would treat the user's database as a first install.
    ext = makeExtensionDir(BUNDLED, 0);
    writeStamp(legacyGrailStampPath(), BUNDLED.trim(), 0);

    expect(grailInstalled()).toBe(true);
    expect(installedGrailStamp()).toBe(BUNDLED.trim());
  });

  it('needs an update when an older GemDB has filed its Grail in since', () => {
    // Another editor on the same root path, on a release that writes only
    // the old location, filed in over this one's.
    ext = makeExtensionDir(BUNDLED, 0);
    writeStamp(grailStampPath(), RECORDED, 60);
    writeStamp(legacyGrailStampPath(), 'grail=0.1-2100-gold', 0);

    expect(grailNeedsUpdate(ext)).toBe(true);
  });

  it('ignores an old-location stamp written before the current one', () => {
    ext = makeExtensionDir(BUNDLED, 0);
    writeStamp(legacyGrailStampPath(), 'grail=0.1-2100-gold', 60);
    writeStamp(grailStampPath(), RECORDED, 0);

    expect(grailNeedsUpdate(ext)).toBe(false);
  });

  it('leaves Grail a newer GemDB filed in where it is', () => {
    ext = makeExtensionDir(BUNDLED, 0);
    writeStamp(grailStampPath(), 'grail=0.1-2300-gnewer\nextension=1.7.0', 0);

    expect(grailNeedsUpdate(ext)).toBe(false);
  });

  it('is cleared from both locations before a file-in, so a failed one reads as not filed in', async () => {
    ext = makeExtensionDir(BUNDLED, 1);
    writeStamp(grailStampPath(), 'grail=0.1-2100-gold\nextension=1.5.9', 60);
    writeStamp(legacyGrailStampPath(), 'grail=0.1-2100-gold', 0);

    await fileInGrail(ext, noProgress).catch(() => {});

    expect(grailInstalled()).toBe(false);
    expect(installedGrailStamp()).toBeUndefined();
  });

  it('is never written where an older GemDB keeps it', async () => {
    ext = makeExtensionDir(BUNDLED, 0);

    await fileInGrail(ext, noProgress);

    expect(fs.existsSync(legacyGrailStampPath())).toBe(false);
    expect(fs.existsSync(grailPath())).toBe(true);
  });
});

describe('filing Grail in beside a newer GemDB', () => {
  const NEWER = 'grail=0.1-2300-gnewer\nextension=1.7.0';

  it('leaves a Grail a newer GemDB staged for it to file in', async () => {
    // The installer would fail if it ran; it must not run at all.
    ext = makeExtensionDir(BUNDLED, 1);
    fs.mkdirSync(grailPath(), { recursive: true });
    fs.writeFileSync(grailStagedByPath(), `${NEWER}\n`);
    fs.writeFileSync(grailStampPath(), `${BUNDLED}extension=1.5.4\n`);

    expect(await fileInGrail(ext, noProgress)).toBe(false);

    expect(grailInstallFailure(ext)).toBeUndefined();
    expect(installedGrailStamp()).toBe(`${BUNDLED}extension=1.5.4`);
  });

  it('leaves a Grail a newer GemDB filed in', async () => {
    ext = makeExtensionDir(BUNDLED, 1);
    fs.writeFileSync(grailStampPath(), `${NEWER}\n`);

    expect(await fileInGrail(ext, noProgress)).toBe(false);

    expect(installedGrailStamp()).toBe(NEWER);
  });
});
