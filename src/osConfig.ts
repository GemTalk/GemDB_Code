import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import * as vscode from 'vscode';
import { REQUIRED_SHARED_MEMORY_GB } from './config';
import { log } from './log';

/**
 * Operating-system prerequisites for running the database engine.
 *
 * There are two, and only the first is a hard requirement:
 *
 *   Shared memory — the engine maps its page cache into a System V shared
 *   memory segment, and both stock macOS and stock Linux cap that far below
 *   the 1 GB the engine asks for. Without it the database will not start.
 *
 *   RemoveIPC (Linux only) — systemd's default is to destroy a user's IPC
 *   objects when their last login session ends, which silently kills a
 *   running database. It is advisory here: it does not block a start, it just
 *   means the database will not survive a logout.
 *
 * Both fixes need root, so GemDB does what Jasper does: open a terminal and
 * run a script with `sudo`, where the user can see the prompt and type their
 * own password. The extension never handles the password itself.
 */

const SHARED_MEMORY_TERMINAL = 'GemDB: Shared Memory Setup';
const REMOVE_IPC_TERMINAL = 'GemDB: RemoveIPC Setup';

export interface SharedMemory {
  /** Largest allowed segment, in bytes. */
  shmmax: number;
  /** Total shared memory allowed, in 4 KiB pages. */
  shmall: number;
}

/** Read the current shared-memory limits, or undefined if sysctl fails. */
export function getSharedMemory(): Promise<SharedMemory | undefined> {
  const isLinux = process.platform === 'linux';
  const keys = isLinux
    ? ['kernel.shmmax', 'kernel.shmall']
    : ['kern.sysv.shmmax', 'kern.sysv.shmall'];

  return new Promise((resolve) => {
    execFile('sysctl', keys, { encoding: 'utf-8' }, (error, stdout) => {
      if (error) {
        resolve(undefined);
        return;
      }
      // Linux prints `key = value`; macOS prints `key: value`.
      const read = (key: string): number | undefined => {
        const match = stdout.match(new RegExp(`${key.replace(/\./g, '\\.')}\\s*[:=]\\s*(\\d+)`));
        return match ? parseInt(match[1], 10) : undefined;
      };
      const shmmax = read(keys[0]);
      const shmall = read(keys[1]);
      if (shmmax === undefined || shmall === undefined) {
        resolve(undefined);
        return;
      }
      resolve({ shmmax, shmall });
    });
  });
}

/** Both limits expressed in GB: shmmax is bytes, shmall is 4 KiB pages. */
export function sharedMemoryGb(mem: SharedMemory): { shmmaxGb: number; shmallGb: number } {
  return { shmmaxGb: mem.shmmax / 2 ** 30, shmallGb: (mem.shmall * 4096) / 2 ** 30 };
}

/** Is shared memory at or above what the engine needs? */
export async function isSharedMemoryConfigured(): Promise<boolean> {
  const mem = await getSharedMemory();
  if (!mem) return false;
  const { shmmaxGb, shmallGb } = sharedMemoryGb(mem);
  return shmmaxGb >= REQUIRED_SHARED_MEMORY_GB && shmallGb >= REQUIRED_SHARED_MEMORY_GB;
}

/** A short label for the status view, e.g. "1 GB" or "0.004 GB". */
export async function sharedMemoryLabel(): Promise<string> {
  const mem = await getSharedMemory();
  if (!mem) return 'unknown';
  const { shmmaxGb, shmallGb } = sharedMemoryGb(mem);
  const smallest = Math.min(shmmaxGb, shmallGb);
  return smallest >= 1024 ? '≥ 1 TB' : `${Math.round(smallest * 1000) / 1000} GB`;
}

/**
 * Does systemd's logind config set `RemoveIPC=no`?
 *
 * Drop-ins under `logind.conf.d` are applied in alphabetical order after the
 * main file, and the last assignment wins — so read them in that order and
 * keep the final value rather than stopping at the first hit.
 */
export function isRemoveIpcConfigured(): boolean {
  if (process.platform !== 'linux') return true;

  const dropInDir = '/etc/systemd/logind.conf.d';
  let dropIns: string[] = [];
  try {
    dropIns = fs
      .readdirSync(dropInDir)
      .filter((f) => f.endsWith('.conf'))
      .sort()
      .map((f) => path.join(dropInDir, f));
  } catch {
    /* no drop-in directory */
  }

  let removeIpc: boolean | undefined;
  for (const file of ['/etc/systemd/logind.conf', ...dropIns]) {
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    for (const line of content.split('\n')) {
      const match = line.match(/^\s*RemoveIPC\s*=\s*(\w+)\s*$/i);
      if (match) removeIpc = match[1].toLowerCase() === 'no';
    }
  }
  return removeIpc === true;
}

/**
 * Bring the operating system up to what the engine needs, asking first.
 *
 * Returns true if the database may start. Shared memory is the gate: if it is
 * still short after the setup script ran — a mistyped password, a cancelled
 * `sudo` — we refuse rather than let the start fail with an error about
 * segment allocation that means nothing to a new developer.
 */
export async function ensureOsConfigured(extensionPath: string): Promise<boolean> {
  const sharedMemoryOk = await isSharedMemoryConfigured();
  const removeIpcOk = isRemoveIpcConfigured();
  if (sharedMemoryOk && removeIpcOk) return true;

  const steps: string[] = [];
  if (!sharedMemoryOk) {
    steps.push(`  • raise shared memory to at least ${REQUIRED_SHARED_MEMORY_GB} GB`);
  }
  if (!removeIpcOk) {
    steps.push('  • keep shared memory alive after you log out (RemoveIPC=no)');
  }

  // Counted, not hardcoded: on macOS only the shared-memory step ever applies,
  // and a dialog that says "two settings" above a list of one reads as a bug.
  const heading =
    steps.length === 1
      ? 'GemDB needs one change to your operating system before the database can run:'
      : `GemDB needs ${steps.length} changes to your operating system before the database can run:`;

  const choice = await vscode.window.showWarningMessage(
    `${heading}\n\n${steps.join('\n')}\n\n` +
      'A terminal will open and run a setup script with sudo, so you will be asked for your ' +
      'password. GemDB never sees it.\n\n' +
      'This is the only permission GemDB asks for, and only once for this machine.',
    { modal: true },
    'Configure',
  );
  if (choice !== 'Configure') return false;

  if (!sharedMemoryOk) {
    await runSetupScript(
      SHARED_MEMORY_TERMINAL,
      path.join(
        extensionPath,
        'resources',
        process.platform === 'linux' ? 'setSharedMemoryLinux.sh' : 'setSharedMemoryDarwin.sh',
      ),
    );
    if (!(await isSharedMemoryConfigured())) {
      void vscode.window.showErrorMessage(
        `Shared memory is still below ${REQUIRED_SHARED_MEMORY_GB} GB, so GemDB did not start. ` +
          'Run "GemDB: Configure Shared Memory" and try again.',
      );
      return false;
    }
    log('Shared memory configured');
  }

  // Advisory: a database that cannot survive logout is still a database that
  // starts, so a failure here is reported and stepped over.
  if (!removeIpcOk) {
    await runSetupScript(
      REMOVE_IPC_TERMINAL,
      path.join(extensionPath, 'resources', 'setRemoveIPC.sh'),
    );
    if (!isRemoveIpcConfigured()) {
      log('RemoveIPC is still unset — the database will stop when you log out of this machine.');
    }
  }

  return true;
}

/** Open the shared-memory setup on its own, from the command palette. */
export async function configureSharedMemory(extensionPath: string): Promise<void> {
  await runSetupScript(
    SHARED_MEMORY_TERMINAL,
    path.join(
      extensionPath,
      'resources',
      process.platform === 'linux' ? 'setSharedMemoryLinux.sh' : 'setSharedMemoryDarwin.sh',
    ),
  );
}

/**
 * Run a script under `sudo` in a visible terminal and resolve once the
 * terminal closes. The script ends with `exit`, so a successful run closes
 * itself; a failing one leaves the terminal open with the error on screen.
 */
function runSetupScript(name: string, scriptPath: string): Promise<void> {
  return new Promise((resolve) => {
    const terminal = vscode.window.createTerminal(name);
    terminal.show();
    terminal.sendText(`sudo ${shellQuote(scriptPath)} && exit`);
    const subscription = vscode.window.onDidCloseTerminal((closed) => {
      if (closed === terminal) {
        subscription.dispose();
        resolve();
      }
    });
  });
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
