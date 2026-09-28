import * as fs from 'fs';
import * as path from 'path';
import type { SetupOutcome, SkipReason } from './telemetry';
import { SKIP_REASON } from './telemetry';

/**
 * The `setup-attempted` marker: how the last unattended setup ended, or that
 * GemDB was removed.
 *
 * It lives in `globalStorageUri` rather than `globalState`, because
 * `globalState` is synced across machines by Settings Sync — a marker that
 * followed the user there would look like "already handled" on a second
 * machine and silently skip setup, or worse, let one machine's decision
 * speak for another's. It is per-machine because setup is.
 */

export type UnattendedSetupMarker = SetupOutcome | 'uninstalled' | 'attempted';

export const MARKER_REASON: Record<UnattendedSetupMarker, SkipReason> = {
  cancelled: SKIP_REASON.cancelledBefore,
  failed: SKIP_REASON.failedBefore,
  completed: SKIP_REASON.installedBefore,
  uninstalled: SKIP_REASON.uninstalled,
  // Releases through 1.5.1 wrote a timestamp however setup ended: it was
  // offered, but the outcome was not recorded. Never written, only read.
  attempted: SKIP_REASON.attemptedBefore,
};

let markerPath: string | undefined;

/** Called once at activation, with the extension's global storage directory. */
export function initUnattendedSetupMarker(storageDir: string): void {
  markerPath = path.join(storageDir, 'setup-attempted');
}

/**
 * What the marker records, or `'none'` when there is no marker (or before
 * `initUnattendedSetupMarker` has run). A marker that does not say how setup ended
 * still says it was offered, so it reads as `'attempted'` and setup is not
 * offered again: that covers every marker written before outcomes were
 * recorded, and a truncated write fails safe.
 */
export function readUnattendedSetupMarker(): UnattendedSetupMarker | 'none' {
  if (!markerPath) return 'none';
  let value: string;
  try {
    value = fs.readFileSync(markerPath, 'utf8').trim();
  } catch {
    return 'none';
  }
  return Object.hasOwn(MARKER_REASON, value) ? (value as UnattendedSetupMarker) : 'attempted';
}

export function writeUnattendedSetupMarker(value: UnattendedSetupMarker): void {
  if (!markerPath) return;
  try {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, value);
  } catch {
    /* worst case it is offered once more */
  }
}
