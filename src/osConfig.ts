import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import * as vscode from 'vscode';
import { REQUIRED_SHARED_MEMORY_GB } from './config';
import { log } from './log';
import {
  OS_CONFIG_MISSING,
  OS_CONFIG_OUTCOME,
  OsConfigMissing,
  OsConfigOutcome,
  TRIGGER,
  Trigger,
  reportOsConfigPrompted,
} from './telemetry';

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
 *   means the database will not survive a logout. So it never raises the
 *   modal on its own — it rides along when shared memory is being fixed
 *   anyway, and is otherwise offered from the status view.
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

/**
 * Read the current shared-memory limits, or undefined if they cannot be read.
 *
 * On Linux the limits are read straight from `/proc`, not through `sysctl`:
 * Debian leaves `/usr/sbin` off an ordinary user's PATH, so `sysctl` is not
 * found there, and a probe that fails reads as "short" — which put the sudo
 * prompt in front of a machine whose limits were already far above what the
 * engine needs. macOS has no `/proc`, so `sysctl` is called by its full path
 * for the same reason.
 */
export async function getSharedMemory(): Promise<SharedMemory | undefined> {
  if (process.platform === 'linux') {
    try {
      const [shmmax, shmall] = await Promise.all(
        ['shmmax', 'shmall'].map(async (key) =>
          parseInt(await fs.promises.readFile(`/proc/sys/kernel/${key}`, 'utf-8'), 10),
        ),
      );
      return Number.isNaN(shmmax) || Number.isNaN(shmall) ? undefined : { shmmax, shmall };
    } catch {
      return undefined;
    }
  }

  const keys = ['kern.sysv.shmmax', 'kern.sysv.shmall'];
  return new Promise((resolve) => {
    execFile('/usr/sbin/sysctl', keys, { encoding: 'utf-8' }, (error, stdout) => {
      if (error) {
        resolve(undefined);
        return;
      }
      const read = (key: string): number | undefined => {
        const match = stdout.match(new RegExp(`${key.replace(/\./g, '\\.')}:\\s*(\\d+)`));
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

/**
 * What `runEnsureOsConfigured` returns: how the modal ended, or
 * `alreadyConfigured` when there was nothing to ask — which includes RemoveIPC
 * being unset while shared memory is fine. Kept apart from
 * `OS_CONFIG_OUTCOME` on purpose: that is `osConfigPrompted`'s vocabulary, sent
 * only when the modal was shown, and the fast path is silent by design, so
 * `alreadyConfigured` must be something `reportOsConfigPrompted` cannot accept.
 */
export const OS_CONFIG_RESULT = {
  ...OS_CONFIG_OUTCOME,
  alreadyConfigured: 'alreadyConfigured',
} as const;
export type OsConfigResult = (typeof OS_CONFIG_RESULT)[keyof typeof OS_CONFIG_RESULT];

/** Whether the database may start. RemoveIPC is advisory, so `removeIpcUnset` starts too. */
export function osConfigAllowsStart(result: OsConfigResult): boolean {
  return result !== OS_CONFIG_RESULT.declined && result !== OS_CONFIG_RESULT.stillUnconfigured;
}

export async function runEnsureOsConfigured(world: OsConfigWorld): Promise<OsConfigResult> {
  // Shared memory alone decides whether to ask. Stock Linux kernels already
  // allow far more than the engine needs, so gating on RemoveIPC as well put a
  // sudo modal in front of every Linux user for a setting that does not stop
  // the database starting — and with sudo's credentials cached, the terminal
  // it opened ran and closed before anyone saw it.
  const sharedMemoryOk = await world.sharedMemoryOk();
  if (sharedMemoryOk) return OS_CONFIG_RESULT.alreadyConfigured;
  const removeIpcOk = world.removeIpcOk();

  const missing: OsConfigMissing = removeIpcOk
    ? OS_CONFIG_MISSING.sharedMemory
    : OS_CONFIG_MISSING.both;

  // RemoveIPC is listed apart from shared memory, as recommended rather than
  // needed: the database starts without it, and a heading that claimed both
  // were required "before the database can run" would be untrue of one.
  const recommended = removeIpcOk
    ? ''
    : 'The same setup will also make one recommended change:\n\n' +
      '  • keep the database running after you log out (RemoveIPC=no)\n\n';

  const confirmed = await world.confirm(
    'GemDB needs one change to your operating system before the database can run:\n\n' +
      `  • raise shared memory to at least ${REQUIRED_SHARED_MEMORY_GB} GB\n\n` +
      recommended +
      'A terminal will open and run a setup script with sudo, so you will be asked for your ' +
      'password. GemDB never sees it.\n\n' +
      'You only need to do this once on this machine.',
  );
  if (!confirmed) {
    world.report(OS_CONFIG_OUTCOME.declined, missing);
    return OS_CONFIG_RESULT.declined;
  }

  await world.runSharedMemoryScript();
  if (!(await world.sharedMemoryOk())) {
    world.showError(
      `Shared memory is still below ${REQUIRED_SHARED_MEMORY_GB} GB, so GemDB did not start. ` +
        'Run "GemDB: Configure Shared Memory" and try again.',
    );
    world.report(OS_CONFIG_OUTCOME.stillUnconfigured, missing);
    return OS_CONFIG_RESULT.stillUnconfigured;
  }
  world.log('Shared memory configured');

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
      world.report(OS_CONFIG_OUTCOME.removeIpcUnset, missing);
      return OS_CONFIG_RESULT.removeIpcUnset;
    }
  }

  world.report(OS_CONFIG_OUTCOME.configured, missing);
  return OS_CONFIG_RESULT.configured;
}

/**
 * Bring the operating system up to what the engine needs, asking first.
 *
 * Returns how it went (see `OsConfigResult`); `osConfigAllowsStart` says whether
 * the database may start. Shared memory is the gate: if it is
 * still short after the setup script ran — a mistyped password, a cancelled
 * `sudo` — we refuse rather than let the start fail with an error about
 * segment allocation that means nothing to a new developer.
 */
export function ensureOsConfigured(
  extensionPath: string,
  trigger: Trigger,
): Promise<OsConfigResult> {
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
 * else tells the user whether it worked. Reported as `osConfigPrompted` when
 * shared memory was actually short, because this is the path back after
 * declining the modal, and without it that recovery is invisible.
 */
export async function configureSharedMemory(extensionPath: string): Promise<void> {
  const wasShort = !(await isSharedMemoryConfigured());
  await runSetupScript(
    SHARED_MEMORY_TERMINAL,
    path.join(
      extensionPath,
      'resources',
      process.platform === 'linux' ? 'setSharedMemoryLinux.sh' : 'setSharedMemoryDarwin.sh',
    ),
  );
  const configured = await isSharedMemoryConfigured();
  if (wasShort) {
    reportOsConfigPrompted(
      TRIGGER.sharedMemoryCommand,
      configured ? OS_CONFIG_OUTCOME.configured : OS_CONFIG_OUTCOME.stillUnconfigured,
      OS_CONFIG_MISSING.sharedMemory,
    );
  }
  if (configured) {
    void vscode.window.showInformationMessage('Shared memory configured.');
  } else {
    void vscode.window.showErrorMessage(
      `Shared memory is still below ${REQUIRED_SHARED_MEMORY_GB} GB.`,
    );
  }
}

/**
 * Open the RemoveIPC setup on its own, from the status view's "Survives
 * logout" row.
 *
 * This is where RemoveIPC is offered now that it no longer raises the modal
 * by itself. Reported like `configureSharedMemory`, and for the same reason:
 * it is the only route to the fix on a machine whose shared memory was never
 * short, which on Linux is nearly every machine.
 */
export async function configureRemoveIpc(extensionPath: string): Promise<void> {
  const wasUnset = !isRemoveIpcConfigured();
  await runSetupScript(
    REMOVE_IPC_TERMINAL,
    path.join(extensionPath, 'resources', 'setRemoveIPC.sh'),
  );
  const configured = isRemoveIpcConfigured();
  if (wasUnset) {
    reportOsConfigPrompted(
      TRIGGER.removeIpcCommand,
      configured ? OS_CONFIG_OUTCOME.configured : OS_CONFIG_OUTCOME.removeIpcUnset,
      OS_CONFIG_MISSING.removeIpc,
    );
  }
  if (configured) {
    void vscode.window.showInformationMessage(
      'The database will now keep running when you log out. ' +
        'This takes effect after you restart your computer.',
    );
  } else {
    void vscode.window.showErrorMessage(
      'RemoveIPC is still unset, so the database will stop when you log out.',
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
