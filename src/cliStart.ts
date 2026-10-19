import { externalDatabase } from './config';
import { assertSafeToStart } from './database';
import { assertExternalDatabaseUp, ensureProcesses } from './processes';

/**
 * Bring the database up for the `gemdb` command: what the GemDB Shell does at
 * startup, and what the wrapper's `--ensure-stone` does for a file, `-c` or
 * `-m` run that finds the stone down.
 *
 * Its own module, rather than a function in `cliMain.ts`, because that file
 * runs `main()` as it is imported and cannot be loaded by a test.
 *
 * Own database: the same `ensureProcesses` the window uses, with the stone's
 * pre-start guards (engine version, NFS, space, room for the extent) run
 * before any start. `listener` says whether the caller opens sessions through
 * NetLDI. The Shell does; a file run is a linked topaz and never does, so it
 * starts the stone alone.
 *
 * External database: only checked, waiting for a stone that is still
 * starting, since GemDB starts none of it.
 *
 * Throws with a sentence for the user; `report` hears each step as it begins.
 */
export async function bringUp(opts: {
  listener: boolean;
  report: (message: string) => void;
  skipQuickCheck?: boolean;
}): Promise<void> {
  if (externalDatabase()) {
    await assertExternalDatabaseUp(opts);
    return;
  }
  await ensureProcesses({
    beforeStoneStart: assertSafeToStart,
    report: opts.report,
    listener: opts.listener,
    skipQuickCheck: opts.skipQuickCheck,
  });
}
