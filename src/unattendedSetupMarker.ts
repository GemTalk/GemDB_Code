import * as fs from 'fs';
import * as path from 'path';
import type { SetupOutcome, SkipReason } from './telemetry';
import { SKIP_REASON } from './telemetry';

/**
 * The unattended setup marker: whether the automatic first-run setup has had
 * its turn, and why it is off. Its presence means "do not run the unattended
 * setup again"; its value says why, and becomes the `skipReason` of
 * `unattendedSetupSkipped`:
 *
 *   `cancelled`, `failed` — the unattended first run ended that way, and no
 *   setup has completed since.
 *   `completed` — a setup completed, whether it was the first run or a later
 *   Start, Install or notebook cell.
 *   `uninstalled` — the user ran Uninstall, and no setup has completed since.
 *   `attempted` — content this version does not recognise: releases through
 *   1.5.1 wrote a timestamp however setup ended. Never written, only read.
 *
 * It is not a log of every setup. An explicit setup that fails or is
 * cancelled leaves the marker alone; `setupFinished` records those.
 *
 * The file is named `setup-attempted` on disk and must stay that way: renaming
 * it would make every existing machine look markerless and run the unattended
 * setup a second time.
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
  // Never written, only read: see the module comment.
  attempted: SKIP_REASON.attemptedBefore,
};

let markerPath: string | undefined;

/** Called once at activation, with the extension's global storage directory. */
export function initUnattendedSetupMarker(storageDir: string): void {
  markerPath = path.join(storageDir, 'setup-attempted');
}

/**
 * `markerPath`, or throws if `initUnattendedSetupMarker` has not run yet. A silent
 * `'none'` would read as "offer setup unattended" — the most consequential
 * answer this module can give — so using the marker too early fails loudly
 * instead. `activate()` calls `initUnattendedSetupMarker` before anything else can
 * reach the marker; a test that reaches it must call it too.
 */
function requireMarkerPath(): string {
  if (!markerPath) {
    throw new Error('unattendedSetupMarker used before initUnattendedSetupMarker() was called');
  }
  return markerPath;
}

/**
 * What the marker records, or `'none'` when there is no marker. A marker
 * that does not say how setup ended still says it was offered, so it reads
 * as `'attempted'` and setup is not offered again: that covers every marker
 * written before outcomes were recorded, and a truncated write fails safe.
 */
export function readUnattendedSetupMarker(): UnattendedSetupMarker | 'none' {
  const marker = requireMarkerPath();
  let value: string;
  try {
    value = fs.readFileSync(marker, 'utf8').trim();
  } catch {
    return 'none';
  }
  return Object.hasOwn(MARKER_REASON, value) ? (value as UnattendedSetupMarker) : 'attempted';
}

export function writeUnattendedSetupMarker(value: UnattendedSetupMarker): void {
  const marker = requireMarkerPath();
  try {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, value);
  } catch {
    /* worst case it is offered once more */
  }
}
