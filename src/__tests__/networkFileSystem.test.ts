import { describe, expect, it } from 'vitest';
import { FileSystemWorld, isOnNfs } from '../networkFileSystem';

// A database on NFS is one the stone will not open (#69), and the check runs
// before setup downloads anything — so a wrong "NFS" blocks a machine that
// could run GemDB, and a wrong "local" wastes a whole setup. Both are pinned
// here against fake machines, since no CI runner has an NFS home.

/** A machine whose only directories are `existing`, answering `statfs` and commands as given. */
function machine(overrides: Partial<FileSystemWorld> & { existing?: string[] }): FileSystemWorld {
  const existing = new Set(overrides.existing ?? ['/', '/home', '/home/me']);
  return {
    platform: 'linux',
    exists: (p) => existing.has(p),
    statfsType: () => 0xef53, // ext4
    run: () => {
      throw new Error('no commands on this machine');
    },
    ...overrides,
  };
}

/** What macOS's `df -P` prints for a directory on `mountPoint`. */
function df(mountPoint: string): string {
  return (
    'Filesystem     512-blocks      Used Available Capacity  Mounted on\n' +
    `server:/home    976490568 402383960 574106608    42%    ${mountPoint}\n`
  );
}

/** A macOS machine whose `df` and `mount` say the given things. */
function mac(dfOutput: string, mountOutput: string): FileSystemWorld {
  return machine({
    platform: 'darwin',
    existing: ['/', '/Users', '/Users/me'],
    run: (command) => (command === '/bin/df' ? dfOutput : mountOutput),
  });
}

describe('isOnNfs', () => {
  describe('on Linux', () => {
    it('recognises an NFS mount', () => {
      const world = machine({ statfsType: () => 0x6969 });

      expect(isOnNfs('/home/me/GemDB', world)).toBe(true);
    });

    it('takes a local disk for what it is', () => {
      expect(isOnNfs('/home/me/GemDB', machine({}))).toBe(false);
    });

    it('answers for a directory that does not exist yet by the nearest one that does', () => {
      const asked: string[] = [];
      const world = machine({
        statfsType: (dir) => {
          asked.push(dir);
          return 0x6969;
        },
      });

      const onNfs = isOnNfs('/home/me/GemDB/db', world);

      expect(onNfs).toBe(true);
      expect(asked).toEqual(['/home/me']);
    });

    it('takes a directory it cannot read as local, rather than blocking setup', () => {
      const world = machine({
        statfsType: () => {
          throw new Error('EACCES');
        },
      });

      expect(isOnNfs('/home/me/GemDB', world)).toBe(false);
    });
  });

  describe('on macOS', () => {
    it('recognises an NFS mount from the mount table', () => {
      const world = mac(
        df('/Users/me'),
        '/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse)\n' +
          'server:/home/me on /Users/me (nfs, nodev, nosuid, mounted by me)\n',
      );

      expect(isOnNfs('/Users/me/GemDB', world)).toBe(true);
    });

    it('takes a local volume for what it is, behind the /Users firmlink', () => {
      const world = mac(
        df('/System/Volumes/Data'),
        '/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse)\n',
      );

      expect(isOnNfs('/Users/me/GemDB', world)).toBe(false);
    });

    it('finds a mount point with spaces in its name', () => {
      const world = mac(
        df('/Volumes/Team Share'),
        'server:/team on /Volumes/Team Share (nfs, nodev, nosuid, mounted by me)\n',
      );

      expect(isOnNfs('/Volumes/Team Share/GemDB', world)).toBe(true);
    });

    it('takes a mount it cannot find as local', () => {
      const world = mac(df('/Users/me'), '');

      expect(isOnNfs('/Users/me/GemDB', world)).toBe(false);
    });
  });
});
