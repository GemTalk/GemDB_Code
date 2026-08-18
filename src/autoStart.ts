import * as fs from 'fs';
import * as path from 'path';
import { log } from './log';

/**
 * Whether GemDB may start the database without being asked.
 *
 * GemDB starts the database on activation, so that a new developer who installs
 * the extension and opens a notebook finds it already running. That is a
 * deliberate exception to the rule the rest of `lifecycle.ts` follows — these
 * processes detach from the editor and outlive it — and the exception is only
 * defensible because of what is here: the moment a user stops the database
 * themselves, GemDB takes that as an instruction and stops starting it.
 *
 * "Themselves" means the Stop command or the status bar, and nothing else. A
 * database that stopped for any other reason — a reboot, a crash, `stopstone`
 * in a terminal — is not a decision, and is started again.
 *
 * The flag lives beside the setup marker in global storage rather than in
 * `globalState`, for the same reason: Settings Sync would carry it to another
 * machine, where stopping a database here would silently stop one starting
 * there. It is per-machine because the database is.
 */

let flagPath: string | undefined;

/** Called once at activation, with the extension's global storage directory. */
export function initAutoStart(storageDir: string): void {
  flagPath = path.join(storageDir, 'stopped-by-user');
}

/** True when the user has stopped the database and not started it since. */
export function autoStartSuppressed(): boolean {
  return flagPath !== undefined && fs.existsSync(flagPath);
}

/** Record that the user stopped the database on purpose. */
export function suppressAutoStart(): void {
  if (!flagPath) return;
  try {
    fs.mkdirSync(path.dirname(flagPath), { recursive: true });
    fs.writeFileSync(flagPath, new Date().toISOString());
    log('GemDB will stay stopped until you start it or run some Python.');
  } catch {
    /* worst case it starts itself again next time */
  }
}

/**
 * Take back the suppression.
 *
 * Called wherever the user asks for a running database — pressing Start, or
 * running Python, which `ensureRunning` treats as the same request. Asking for
 * the database is the clearest possible statement that they want it back.
 */
export function allowAutoStart(): void {
  if (!flagPath) return;
  try {
    fs.rmSync(flagPath, { force: true });
  } catch {
    /* it will simply not auto-start, which is the safe direction */
  }
}
