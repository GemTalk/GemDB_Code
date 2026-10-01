import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetSettings } from '../__mocks__/vscode';
import { RootPathWorld, chooseLocalRootPath } from '../lifecycle';
import { refusedNfs } from '../processes';

// What happens once a root path turns out to be on NFS (#69): the user is
// asked for a local folder, and if the check missed the mount, the stone's own
// refusal is recognised so the same question gets asked.

describe('chooseLocalRootPath', () => {
  function world(picked: string | undefined, nfs: string[] = []) {
    const setRootPath = vi.fn(async (_root: string) => {});
    const setUp = vi.fn(async () => {});
    const fake: RootPathWorld = {
      pickFolder: async () => picked,
      isOnNfs: (dir) => nfs.some((mount) => dir.startsWith(mount)),
      setRootPath,
      setUp,
    };
    return { fake, setRootPath, setUp };
  }

  beforeEach(() => {
    __resetSettings();
  });

  it('keeps GemDB in a folder of its own inside the one picked, and sets it up there', async () => {
    const { fake, setRootPath, setUp } = world('/scratch/me');

    await chooseLocalRootPath(fake);

    expect(setRootPath).toHaveBeenCalledWith('/scratch/me/GemDB');
    expect(setUp).toHaveBeenCalledTimes(1);
  });

  it('uses a picked folder that is already called GemDB as it is', async () => {
    const { fake, setRootPath } = world('/scratch/me/GemDB');

    await chooseLocalRootPath(fake);

    expect(setRootPath).toHaveBeenCalledWith('/scratch/me/GemDB');
  });

  it('changes nothing when the folder picked is on NFS as well', async () => {
    const { fake, setRootPath, setUp } = world('/home/me/projects', ['/home/me']);

    await chooseLocalRootPath(fake);

    expect(setRootPath).not.toHaveBeenCalled();
    expect(setUp).not.toHaveBeenCalled();
  });

  it('changes nothing when the dialog is dismissed', async () => {
    const { fake, setRootPath, setUp } = world(undefined);

    await chooseLocalRootPath(fake);

    expect(setRootPath).not.toHaveBeenCalled();
    expect(setUp).not.toHaveBeenCalled();
  });
});

describe('recognising the stone refusing NFS', () => {
  const REFUSAL =
    "   ERROR:  One or more extent files are remote files.\n   Extents may not be on file systems that are NFS-mounted on stone's machine.\n";
  let dir: string;
  let stoneLog: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdb-stone-log-'));
    stoneLog = path.join(dir, 'gemdb.log');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('finds the refusal in what startstone printed', () => {
    const failure = new Error(`Start database failed (exit code 1).\n${REFUSAL}`);

    expect(refusedNfs(failure, stoneLog, 0)).toBe(true);
  });

  it('finds the refusal in what the stone wrote to its log', () => {
    fs.writeFileSync(stoneLog, `starting\n${REFUSAL}`);

    expect(refusedNfs(new Error('Start database failed (exit code 1).'), stoneLog, 0)).toBe(true);
  });

  it('ignores a refusal from an earlier start, before the log grew', () => {
    fs.writeFileSync(stoneLog, `starting\n${REFUSAL}`);
    const before = fs.statSync(stoneLog).size;
    fs.appendFileSync(stoneLog, 'starting\nShared page cache could not be attached.\n');

    expect(refusedNfs(new Error('Start database failed.'), stoneLog, before)).toBe(false);
  });

  it('reads all of a log that was started afresh', () => {
    fs.writeFileSync(stoneLog, REFUSAL);

    expect(refusedNfs(new Error('Start database failed.'), stoneLog, 1_000_000)).toBe(true);
  });

  it('says no when there is no log to read', () => {
    expect(refusedNfs(new Error('Start database failed.'), stoneLog, 0)).toBe(false);
  });
});
