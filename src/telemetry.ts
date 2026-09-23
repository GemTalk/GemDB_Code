import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { TelemetryReporter } from '@vscode/extension-telemetry';
import type { GemDbState } from './statusView';

/**
 * GemDB's telemetry: one named function per thing worth counting.
 *
 * Four rules a future edit can break, none visible from a call site:
 *
 * 1. **This module must never reach `out/gemdb-shell.js`** — no extension host
 *    there enforces the user's telemetry setting (CLAUDE.md, "`gemdb` with no
 *    arguments IS the GemDB Shell"). `no-restricted-imports` in
 *    `eslint.config.mjs` denies it to every shell-graph file, `session.ts` and
 *    `pythonQueries.ts` permanently (they get an injected sink instead);
 *    `assertNoTelemetryInShellBundle` in `esbuild.mjs` checks the built graph
 *    and is the guard that actually holds.
 * 2. **Never `sendDangerousTelemetryEvent`** or its siblings: they bypass the
 *    user's setting by design, and shipping one violates Marketplace policy.
 * 3. **Events are facts, not funnels: no `first*` events.** First-ness is
 *    `min(timestamp) by machineId` at query time. Volume is bounded by each
 *    event's cadence, stated on its `report*` function — never per cell, per
 *    print or per keystroke.
 * 4. **Property values name what the user did** — a command id or a surface,
 *    as `TRIGGER` and `SURFACE` spell them — never a function, so a rename
 *    cannot silently split a series.
 */

/**
 * What caused a lifecycle step to happen, shared by every event that needs one.
 *
 * Values name what the user did — a command id or a surface — never a
 * function, so a series survives a refactor.
 */
export const TRIGGER = {
  firstRun: 'firstRun', // the unattended pass at activation
  autoStart: 'autoStart', // the database coming up unasked
  installCommand: 'installCommand', // gemdb.install
  startCommand: 'startCommand', // gemdb.start
  sharedMemoryCommand: 'sharedMemoryCommand', // gemdb.configureSharedMemory
  notebook: 'notebook', // a notebook cell batch
  shell: 'shell', // Open GemDB Shell
  runFile: 'runFile', // Run Python File
  mcp: 'mcp', // an agent, through the MCP provider
} as const;
export type Trigger = (typeof TRIGGER)[keyof typeof TRIGGER];

// Not a secret — a connection string only says where events land.
const CONNECTION_STRING =
  'InstrumentationKey=933fff8d-f71d-4f13-b7dd-7fe6b5cceade;' +
  'IngestionEndpoint=https://westus2-2.in.applicationinsights.azure.com/;' +
  'LiveEndpoint=https://westus2.livediagnostics.monitor.azure.com/;' +
  'ApplicationId=0459d5a4-2436-4702-9979-c274a9da9b37';

/**
 * Every event GemDB can emit. Private, and `send` is typed to it, so a name
 * cannot be typo'd and no event can exist without a `report*` function below
 * that says what it means.
 */
const EVENT = {
  activated: 'activated',
  unattendedSetupSkipped: 'unattendedSetupSkipped',
  setupStarted: 'setupStarted',
  setupFinished: 'setupFinished',
  osConfigPrompted: 'osConfigPrompted',
  databaseStarted: 'databaseStarted',
  pythonUsed: 'pythonUsed',
} as const;
export type EventName = (typeof EVENT)[keyof typeof EVENT];

let reporter: TelemetryReporter | undefined;

/**
 * Properties stamped on every event, established once at activation.
 *
 * `extensionMode`, plus `installDay` and `installDaySource` (see
 * `resolveInstallDay`). VS Code's own `common.*` properties are mixed in by
 * the extension host and are not repeated here.
 */
let baseProperties: Record<string, string> = {};

/** When this machine was first seen, for `pythonUsed`'s `minutesSinceFirstSeen`. */
let firstSeenAtMs: number | undefined;

const FIRST_SEEN_FILE = 'first-seen';

/**
 * How `installDay` was determined, for anyone querying the funnel:
 *
 * - `firstSeen` — GemDB was first seen on `installDay`. The ordinary case.
 * - `reinstall` — global storage was wiped (e.g. the "Keep my database"
 *   uninstall path) while `~/GemDB` survived, so this is not a new install at
 *   all. Without this, such a user would reach first Python in seconds and
 *   inflate conversion as a phantom new install.
 */
type InstallDaySource = 'firstSeen' | 'reinstall';

interface InstallDay {
  /** UTC date only (`YYYY-MM-DD`) — no timestamp, no path. */
  installDay: string;
  installDaySource: InstallDaySource;
  /**
   * The raw ISO timestamp behind `installDay`, kept only in memory —
   * `minutesSinceFirstSeen` needs sub-day precision, and `installDay` itself
   * is deliberately date-only so it never carries one.
   */
  firstSeenAt: string;
}

function utcDateOnly(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * Work out this machine's install day and make sure `first-seen` exists
 * afterwards.
 *
 * `databaseExists` is taken as an argument rather than this module importing
 * `isInstalled` from `lifecycle.ts`, which keeps this function pure enough to
 * test directly and keeps `extension.ts` as the place the wiring lives.
 *
 * Storage is a file in `storageDir` (`context.globalStorageUri`), not
 * `globalState`: Settings Sync would let one machine's install date speak for
 * another's, the same reasoning already documented at `setup-attempted`'s own
 * use of `globalStorageUri`. And it is a *new* file, not `setup-attempted`
 * itself — that marker means "setup was offered" rather than "GemDB was first
 * seen", and an install-day key needs exactly one job.
 */
export function resolveInstallDay(storageDir: string, databaseExists: boolean): InstallDay {
  const firstSeenPath = path.join(storageDir, FIRST_SEEN_FILE);
  try {
    const contents = fs.readFileSync(firstSeenPath, 'utf8');
    return {
      installDay: utcDateOnly(contents),
      installDaySource: 'firstSeen',
      firstSeenAt: contents,
    };
  } catch {
    /* no first-seen file yet — resolve it below and record one */
  }

  const now = new Date().toISOString();
  const installDay: InstallDay = {
    installDay: utcDateOnly(now),
    installDaySource: databaseExists ? 'reinstall' : 'firstSeen',
    firstSeenAt: now,
  };

  // Matches setup-attempted's own posture: worst case, this is offered once
  // more next activation. A failure here must never fail activation.
  try {
    fs.mkdirSync(storageDir, { recursive: true });
    fs.writeFileSync(firstSeenPath, now);
  } catch {
    /* worst case it is resolved again next activation */
  }

  return installDay;
}

/** What `vscode.ExtensionMode` means, spelled for a telemetry property. */
function extensionModeName(mode: vscode.ExtensionMode): string {
  switch (mode) {
    case vscode.ExtensionMode.Production:
      return 'production';
    case vscode.ExtensionMode.Development:
      return 'development';
    case vscode.ExtensionMode.Test:
      return 'test';
    default:
      return 'unknown';
  }
}

/**
 * @param databaseExists whether a database is already on disk, so an install
 *   day resolved with no `first-seen` file can tell a reinstall from a first
 *   install. Callers pass `isInstalled()`.
 */
export function initTelemetry(context: vscode.ExtensionContext, databaseExists: boolean): void {
  // Nothing VS Code sends distinguishes an F5 debug session from a real
  // install — `common.extversion` is the same in both — so say which one
  // this is. Every query that reports on users has to exclude anything but
  // 'production'.
  const { installDay, installDaySource, firstSeenAt } = resolveInstallDay(
    context.globalStorageUri.fsPath,
    databaseExists,
  );
  // The write in resolveInstallDay is not atomic, so a crash or a full disk
  // during first activation can leave a zero-byte or truncated first-seen
  // file; `new Date(...).getTime()` on that is NaN, and NaN !== undefined
  // would slide past reportPythonUsed's guard and send NaN as a measure. Every
  // reader gets `undefined` instead by validating once, here, rather than at
  // each call site.
  const parsedFirstSeenAtMs = new Date(firstSeenAt).getTime();
  firstSeenAtMs = Number.isFinite(parsedFirstSeenAtMs) ? parsedFirstSeenAtMs : undefined;
  // `daysSinceInstall` is deliberately not sent: it is derivable at query time
  // from `installDay` and the event's own timestamp, and a dimension repeated
  // on every event forever is not free. `installDay` itself is not optional
  // the same way: retention is 90 days, so once a user's `activated` event is
  // deleted there is no other way to know how old they are. Stamping the date
  // on every event is what lets retention analysis outlive the retention
  // window.
  baseProperties = {
    extensionMode: extensionModeName(context.extensionMode),
    installDay,
    installDaySource,
  };
  // Disposal flushes queued events, so the subscription is load-bearing.
  reporter = new TelemetryReporter(CONNECTION_STRING);
  context.subscriptions.push(reporter);
}

/**
 * The single send site.
 *
 * **Not exported, and not to be called inline from new code.** Every event
 * gets its own named `report*` function beside this one instead. That is what
 * keeps `EVENT` the complete list of what GemDB emits, gives each event one
 * documented shape and one place to change it.
 *
 * No consent check here, deliberately: `sendTelemetryEvent` goes through
 * `vscode.env.createTelemetryLogger`, and VS Code checks `isTelemetryEnabled`
 * before it reaches any sender. Do not add one, and in particular do not read
 * `telemetry.telemetryLevel` — VS Code's own guide says it can disagree.
 *
 * **The properties object must never be undefined**, which is why this
 * always passes one. VS Code's `TelemetryLogger` mixes its `common.*`
 * properties into `data.properties` only when that field is already truthy;
 * when it is not, it merges them into the top level of `data` instead, where
 * `@vscode/extension-telemetry`'s App Insights client — which reads only
 * `data.properties` — silently drops every one of them. Measured
 * 2026-09-15: `activated` events sent with `undefined` properties arrived
 * with their measurements intact and `customDimensions` empty.
 */
function send(
  name: EventName,
  properties?: Record<string, string>,
  measures?: Record<string, number>,
): void {
  reporter?.sendTelemetryEvent(name, { ...baseProperties, ...properties }, measures);
}

/**
 * Elapsed time on the monotonic clock, for every `durationMs` sent here.
 *
 * Not `Date.now()` deltas: setup and `ensureRunning` can take minutes, long
 * enough for an NTP step or a manual clock change to skew one or make it
 * negative. The clock is hidden so no caller can subtract a `Date.now()` from
 * a `performance.now()`. It does not advance while the machine sleeps, so a
 * download spanning a laptop nap reports the time GemDB was actually running.
 */
export class Stopwatch {
  private readonly startedAt = performance.now();

  static start(): Stopwatch {
    return new Stopwatch();
  }

  elapsedMs(): number {
    return Math.round(performance.now() - this.startedAt);
  }
}

/**
 * The extension host finished activating — once per window activation.
 *
 * @param durationMs time since the first statement of `activate()`,
 *   measured before the detached `prepareOnFirstRun` tail, which can run for
 *   minutes and is not activation.
 * @param state what `activate()` found on the way in — reusing
 *   `GemDbState`, the same vocabulary the status view publishes as
 *   `gemdb.state`, so this and the view can never drift apart. Doubles every
 *   activation as a health sample and gives the funnel its denominator.
 */
export function reportActivation(durationMs: number, state: GemDbState): void {
  send(EVENT.activated, { state }, { activationMs: durationMs });
}

/** Why the unattended first-run setup at activation did not run. */
export const SKIP_REASON = {
  remoteWindow: 'remoteWindow',
  markerPresent: 'markerPresent',
  lockHeld: 'lockHeld',
  installedByOtherWindow: 'installedByOtherWindow',
} as const;
export type SkipReason = (typeof SKIP_REASON)[keyof typeof SKIP_REASON];

/**
 * The unattended pass at activation bailed out before setup ran.
 *
 * Cadence: at most once per window activation, and only while GemDB is not
 * installed — an installed machine returns before reaching any of these, and
 * `activated{state}` already says so. `markerPresent` repeats on every
 * activation until the user resumes setup; that repetition is the signal
 * (how long they stay stuck), and it ends when they install.
 *
 * Emitted only when it skips — the case where it runs instead is
 * `setupStarted{trigger: firstRun}`, and emitting both would double-count the
 * same activation. `markerPresent` is the highest-value reason here: it is
 * exactly "this user is stuck behind their own earlier cancel", and it is
 * invisible today.
 */
export function reportUnattendedSetupSkipped(skipReason: SkipReason): void {
  send(EVENT.unattendedSetupSkipped, { skipReason });
}

/**
 * Mirrors `lifecycle.ts`'s own `SetupOutcome`, kept as a separate type rather
 * than imported so this module stays a leaf: nothing it imports can create a
 * cycle back through a caller.
 */
type SetupOutcome = 'completed' | 'cancelled' | 'failed';

/**
 * `runSetup` started — a user choosing to download, every time. Repeats
 * freely and is meant to: cancelling and later pressing Resume is two
 * attempts, both visible, not a special case.
 */
export function reportSetupStarted(trigger: Trigger): void {
  send(EVENT.setupStarted, { trigger });
}

/**
 * `runSetup` finished, paired with the `setupStarted` for the same attempt.
 *
 * A start with no matching finish — the user quit VS Code mid-download — is
 * the drop-out this pair exists to measure, so never collapse this into a
 * single event. Never pass `errorMessage(e)` here: GemStone errors embed
 * paths, and a classified failure reason is phase 3's `stepFailed`, not this.
 */
export function reportSetupFinished(
  trigger: Trigger,
  outcome: SetupOutcome,
  durationMs: number,
): void {
  send(EVENT.setupFinished, { trigger, outcome }, { durationMs });
}

/**
 * How the modal ended.
 *
 * `removeIpcUnset` is not a softer `stillUnconfigured`, and the two must not
 * be merged: shared memory is a hard gate, so `stillUnconfigured` means the
 * database did not start, while RemoveIPC is advisory, so `removeIpcUnset`
 * means it started and will not survive a logout. Reusing one name for both
 * would also make them indistinguishable in the case that produces each —
 * `missing: 'both'`, where the pair is the only thing that says which half
 * failed.
 */
export const OS_CONFIG_OUTCOME = {
  configured: 'configured',
  declined: 'declined',
  stillUnconfigured: 'stillUnconfigured',
  removeIpcUnset: 'removeIpcUnset',
} as const;
export type OsConfigOutcome = (typeof OS_CONFIG_OUTCOME)[keyof typeof OS_CONFIG_OUTCOME];

/** What was short when the modal was shown — not what is still short after it. */
export const OS_CONFIG_MISSING = {
  sharedMemory: 'sharedMemory',
  removeIpc: 'removeIpc',
  both: 'both',
} as const;
export type OsConfigMissing = (typeof OS_CONFIG_MISSING)[keyof typeof OS_CONFIG_MISSING];

/**
 * The shared-memory/RemoveIPC modal was shown, and how it went.
 *
 * Emitted only when the modal actually appeared, or when "Configure Shared
 * Memory" ran while shared memory was short (`sharedMemoryCommand`, the path
 * back after a decline) — never on the already-configured fast path, which is
 * silent by design and would just be volume. `trigger` is what earns this event: CLAUDE.md spends three
 * paragraphs on *where* to ask for shared memory and names two rejected
 * placements, and nobody has measured whether the current one works.
 */
export function reportOsConfigPrompted(
  trigger: Trigger,
  outcome: OsConfigOutcome,
  missing: OsConfigMissing,
): void {
  send(EVENT.osConfigPrompted, { trigger, outcome, missing });
}

export const DATABASE_OUTCOME = {
  started: 'started',
  unsupportedPlatform: 'unsupportedPlatform',
  missingPayload: 'missingPayload',
  setupCancelled: 'setupCancelled',
  setupFailed: 'setupFailed',
  osConfigDeclined: 'osConfigDeclined',
  startFailed: 'startFailed',
} as const;
export type DatabaseOutcome = (typeof DATABASE_OUTCOME)[keyof typeof DATABASE_OUTCOME];

/** The last failure `reportDatabaseStarted` sent, so a repeat is silent. */
let lastReportedFailure: DatabaseOutcome | undefined;

/**
 * The database came up, or didn't, on `ensureRunning` — the one path
 * everything that needs one goes through.
 *
 * Bounded twice over, both load-bearing:
 *
 * - Sent only when `didWork` is true or the outcome is a failure. Most
 *   `ensureRunning` calls are no-ops — every notebook cell after the first
 *   goes through it again, with nothing left to do — and those send nothing.
 * - A failure is sent only when it differs from the last one reported,
 *   cleared on a successful start. Without this, a user stuck at the sudo
 *   prompt would emit one event per cell batch — the same unbounded volume
 *   `didWork` guards against, from the other direction.
 */
export function reportDatabaseStarted(
  trigger: Trigger,
  outcome: DatabaseOutcome,
  filedGrail: 'no' | 'firstTime' | 'update',
  durationMs: number,
  didWork: boolean,
): void {
  if (outcome === DATABASE_OUTCOME.started) {
    lastReportedFailure = undefined;
    if (!didWork) return;
  } else {
    if (outcome === lastReportedFailure) return;
    lastReportedFailure = outcome;
  }
  send(EVENT.databaseStarted, { trigger, outcome, filedGrail }, { durationMs });
}

export const SURFACE = {
  notebook: 'notebook',
  shell: 'shell',
  runFile: 'runFile',
} as const;
export type Surface = (typeof SURFACE)[keyof typeof SURFACE];

/** How sure a `pythonUsed` event is that Python genuinely ran; see `reportPythonUsed`. */
export const EVIDENCE = {
  executed: 'executed',
  launched: 'launched',
} as const;
export type Evidence = (typeof EVIDENCE)[keyof typeof EVIDENCE];

/** Surfaces `pythonUsed` has already reported this window. */
const seenSurfaces = new Set<Surface>();

/**
 * Python ran, or a surface that runs it was opened — once per window per
 * surface, at most three events total.
 *
 * This is the shape the design settles on deliberately, in place of a
 * once-ever `firstPythonRun`: the funnel terminus falls out of
 * `min(timestamp) by machineId`, retention falls out of
 * `count(distinct day)`, and repeat usage is never discarded. No persisted
 * marker means no gap or duplicate if global storage is lost.
 *
 * `evidence` says how sure this is a genuine run: `executed` means source
 * was sent to the database and a result came back (including a Python-level
 * error returned in band — that is still a real run); `launched` means only
 * that a terminal was opened, which the host cannot confirm was ever typed
 * into.
 */
export function reportPythonUsed(surface: Surface, evidence: Evidence): void {
  if (seenSurfaces.has(surface)) return;
  seenSurfaces.add(surface);
  // Wall-clock on purpose, unlike `Stopwatch`: first-seen is persisted and
  // this spans restarts, which no monotonic clock can. Clamped because a clock
  // set back since first-seen was recorded would otherwise send a negative
  // age; rounded to whole minutes, the same coarsening `installDay` applies.
  const minutesSinceFirstSeen =
    firstSeenAtMs !== undefined
      ? Math.max(0, Math.round((Date.now() - firstSeenAtMs) / 60_000))
      : undefined;
  send(
    EVENT.pythonUsed,
    { surface, evidence },
    minutesSinceFirstSeen !== undefined ? { minutesSinceFirstSeen } : undefined,
  );
}
