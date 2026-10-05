import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __setSetting } from '../__mocks__/vscode';
import { ensurePasswordFile } from '../database';
import { fileInGrail, grailInstallFailure, onDidAttemptGrailInstall } from '../grail';
import { databasePath, expectedEnginePath, installedGrailStamp } from '../paths';

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
    expect(installedGrailStamp()).toBe(BUNDLED.trim());
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
