import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Whether a directory is on NFS, where the stone will not open a repository.
 *
 * GemStone refuses extents and transaction logs on an NFS mount unless
 * `STN_ALLOW_NFS_EXTENTS` is set, which its own `system.conf` calls "less
 * reliable and less performant" and GemDB does not set. The 4.0.0.a4 stone
 * says "Extents may not be on file systems that are NFS-mounted on stone's
 * machine", and says it only when the database is started — after setup has
 * downloaded the engine and created the database there. Home directories are
 * NFS mounts on many shared Linux machines, which puts the default root path
 * there too (#69). Asking first is what lets setup refuse before it has spent
 * a 450 MB download on a directory the database cannot use.
 *
 * On Linux, `statfs` answers with `NFS_SUPER_MAGIC`, which nfs and nfs4 mounts
 * share. On macOS NFS is a loadable file system, so its `statfs` type number is
 * handed out when it loads and names nothing fixed — xnu's `vfs_conf.c` lists
 * only the few built in — and the mount table, which names the type, answers
 * instead.
 *
 * The directory need not exist: the root path does not before the first setup,
 * so the nearest directory that does answers for it — which is where it would
 * be created. Anything that cannot be read answers false. A wrong "NFS" blocks
 * setup on a machine that could run it; a wrong "local" costs what happened
 * before this check existed, and the stone's refusal is recognised then too
 * (see `startStone`).
 */
export function isOnNfs(dir: string, world: FileSystemWorld = realWorld): boolean {
  const existing = nearestExisting(path.resolve(dir), world);
  if (!existing) return false;
  try {
    return world.platform === 'darwin'
      ? mountTypeOn(existing, world) === 'nfs'
      : world.statfsType(existing) === NFS_SUPER_MAGIC;
  } catch {
    return false;
  }
}

/** What `isOnNfs` reads, so a test can be a machine with an NFS home. */
export interface FileSystemWorld {
  platform: NodeJS.Platform;
  exists(p: string): boolean;
  statfsType(dir: string): number;
  run(command: string, args: string[]): string;
}

const realWorld: FileSystemWorld = {
  platform: process.platform,
  exists: (p) => fs.existsSync(p),
  statfsType: (dir) => fs.statfsSync(dir).type,
  run: (command, args) => execFileSync(command, args, { encoding: 'utf8' }),
};

/** From linux/magic.h. */
const NFS_SUPER_MAGIC = 0x6969;

function nearestExisting(dir: string, world: FileSystemWorld): string | undefined {
  for (let current = dir; ; current = path.dirname(current)) {
    if (world.exists(current)) return current;
    if (path.dirname(current) === current) return undefined;
  }
}

/**
 * The file-system type of the mount holding `dir`, from macOS's `df` and
 * `mount`. `df -P` names the mount point, which matters because of firmlinks:
 * `/Users` is really `/System/Volumes/Data/Users`, and only `df` resolves that.
 */
function mountTypeOn(dir: string, world: FileSystemWorld): string | undefined {
  // The mount point is everything after the capacity column, spaces and all.
  const dfLine = world.run('/bin/df', ['-P', dir]).trim().split('\n').pop() ?? '';
  const mountPoint = /\s\d+%\s+(.+)$/.exec(dfLine)?.[1];
  if (!mountPoint) return undefined;

  // `server:/export on /Users/someone (nfs, nodev, nosuid, mounted by someone)`
  const marker = ` on ${mountPoint} (`;
  const line = world
    .run('/sbin/mount', [])
    .split('\n')
    .find((l) => l.includes(marker));
  return line ? /^([^,)]+)/.exec(line.slice(line.indexOf(marker) + marker.length))?.[1] : undefined;
}
