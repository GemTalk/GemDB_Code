import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import * as vscode from 'vscode';
import { REQUIRED_SHARED_MEMORY_GB } from './config';
import { log } from './log';
import { OsConfigMissing, OsConfigOutcome, Trigger, reportOsConfigPrompted } from './telemetry';

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
 * Everything `ensureOsConfigured` decides, with the world passed in.
 *
 * Both ends of this function are root-owned — a `sysctl`, a systemd config, a
 * terminal running `sudo` — so its branches are unreachable from a test
 * otherwise, and two of them are worth defending: shared memory is a hard
 * gate and must refuse the start when the script did not take, while
 * RemoveIPC is advisory and so the same failure has to be reported *and*
 * stepped over. Taking the collaborators as an argument is what makes those
 * testable without an editor (the same reason `runStop` takes a `StopWorld`).
 */
export interface OsConfigWorld {
  sharedMemoryOk: () => Promise<boolean>;
  removeIpcOk: () => boolean;
  /** Show the modal, already worded. True if the user chose to configure. */
  confirm: (message: string) => Promise<boolean>;
  runSharedMemoryScript: () => Promise<void>;
  runRemoveIpcScript: () => Promise<void>;
  showError: (message: string) => void;
  report: (outcome: OsConfigOutcome, missing: OsConfigMissing) => void;
  log: (message: string) => void;
}

export async function runEnsureOsConfigured(
  world: OsConfigWorld,
): Promise<{ ok: boolean; prompted: boolean }> {
  const sharedMemoryOk = await world.sharedMemoryOk();
  const removeIpcOk = world.removeIpcOk();
  if (sharedMemoryOk && removeIpcOk) return { ok: true, prompted: false };

  const missing: OsConfigMissing =
    !sharedMemoryOk && !removeIpcOk ? 'both' : !sharedMemoryOk ? 'sharedMemory' : 'removeIpc';

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

  const confirmed = await world.confirm(
    `${heading}\n\n${steps.join('\n')}\n\n` +
      'A terminal will open and run a setup script with sudo, so you will be asked for your ' +
      'password. GemDB never sees it.\n\n' +
      'This is the only permission GemDB asks for, and only once for this machine.',
  );
  if (!confirmed) {
    world.report('declined', missing);
    return { ok: false, prompted: true };
  }

  if (!sharedMemoryOk) {
    await world.runSharedMemoryScript();
    if (!(await world.sharedMemoryOk())) {
      world.showError(
        `Shared memory is still below ${REQUIRED_SHARED_MEMORY_GB} GB, so GemDB did not start. ` +
          'Run "GemDB: Configure Shared Memory" and try again.',
      );
      world.report('stillUnconfigured', missing);
      return { ok: false, prompted: true };
    }
    world.log('Shared memory configured');
  }

  // Advisory: a database that cannot survive logout is still a database that
  // starts, so a failure here is reported and stepped over — under an outcome
  // of its own, because `configured` would claim the fix took and
  // `stillUnconfigured` would claim the database never started.
  if (!removeIpcOk) {
    await world.runRemoveIpcScript();
    if (!world.removeIpcOk()) {
      world.log(
        'RemoveIPC is still unset — the database will stop when you log out of this machine.',
      );
      world.report('removeIpcUnset', missing);
      return { ok: true, prompted: true };
    }
  }

  world.report('configured', missing);
  return { ok: true, prompted: true };
}

/**
 * Bring the operating system up to what the engine needs, asking first.
 *
 * Returns true if the database may start. Shared memory is the gate: if it is
 * still short after the setup script ran — a mistyped password, a cancelled
 * `sudo` — we refuse rather than let the start fail with an error about
 * segment allocation that means nothing to a new developer.
 */
export function ensureOsConfigured(
  extensionPath: string,
  trigger: Trigger,
): Promise<{ ok: boolean; prompted: boolean }> {
  return runEnsureOsConfigured({
    sharedMemoryOk: isSharedMemoryConfigured,
    removeIpcOk: isRemoveIpcConfigured,
    confirm: async (message) =>
      (await vscode.window.showWarningMessage(message, { modal: true }, 'Configure')) ===
      'Configure',
    runSharedMemoryScript: () =>
      runSetupScript(
        SHARED_MEMORY_TERMINAL,
        path.join(
          extensionPath,
          'resources',
          process.platform === 'linux' ? 'setSharedMemoryLinux.sh' : 'setSharedMemoryDarwin.sh',
        ),
      ),
    runRemoveIpcScript: () =>
      runSetupScript(REMOVE_IPC_TERMINAL, path.join(extensionPath, 'resources', 'setRemoveIPC.sh')),
    showError: (message) => void vscode.window.showErrorMessage(message),
    report: (outcome, missing) => reportOsConfigPrompted(trigger, outcome, missing),
    log,
  });
}

/**
 * Open the shared-memory setup on its own, from the command palette.
 *
 * Re-probes afterwards, unlike the script run alone: run this way, nothing
 * else tells the user whether it worked.
 */
export async function configureSharedMemory(extensionPath: string): Promise<void> {
  await runSetupScript(
    SHARED_MEMORY_TERMINAL,
    path.join(
      extensionPath,
      'resources',
      process.platform === 'linux' ? 'setSharedMemoryLinux.sh' : 'setSharedMemoryDarwin.sh',
    ),
  );
  if (await isSharedMemoryConfigured()) {
    void vscode.window.showInformationMessage('Shared memory configured.');
  } else {
    void vscode.window.showErrorMessage(
      `Shared memory is still below ${REQUIRED_SHARED_MEMORY_GB} GB.`,
    );
  }
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
