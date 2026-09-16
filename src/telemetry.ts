import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { TelemetryReporter } from '@vscode/extension-telemetry';
import type { GemDbState } from './statusView';

/**
 * GemDB's telemetry: one named function per thing worth counting.
 *
 * Two rules a future edit can break, neither visible from a call site:
 *
 * 1. **This module must never reach `out/gemdb-shell.js`.** That bundle is
 *    built from the same sources with `vscode` aliased to `cliVscode.ts`;
 *    there is no extension host there, so nothing would enforce the user's
 *    telemetry setting. ESLint's shell-graph denylist catches a direct
 *    import at save time; esbuild's metafile check catches everything else.
 * 2. **Never `sendDangerousTelemetryEvent`** or its siblings. They bypass the
 *    user's preference by design, for CI. Shipping one is a Marketplace
 *    violation.
 * 3. **No event may be emitted per cell, per print, or per keystroke.** A user
 *    exploring data runs hundreds of cells. The shape instead is a
 *    once-per-window `first*` event for funnel membership plus one aggregated
 *    `sessionSummary` carrying counts as measures. There is no
 *    `sessionSummary` event yet, so do not build the counter machinery ahead
 *    of it; when it lands, this module should expose `count*()` functions
 *    that mutate in-memory state while only `reportSessionSummary()` sends,
 *    so this rule holds by construction rather than by discipline.
 *
 *    `deactivate()` is best-effort — VS Code allows it limited time and it
 *    never runs on a crash — so a `sessionSummary` event must be sent
 *    *before* `context.subscriptions` are disposed, since disposing the
 *    reporter is what flushes queued events.
 */

/**
 * What caused a lifecycle step to happen, shared by every event that needs one.
 *
 * Values name what the user did — a command id or a surface — never a
 * function, so a series survives a refactor.
 */
export type Trigger =
  | 'firstRun' // the unattended pass at activation
  | 'autoStart' // the database coming up unasked
  | 'installCommand' // gemdb.install
  | 'startCommand' // gemdb.start
  | 'sharedMemoryCommand' // gemdb.configureSharedMemory
  | 'notebook' // a notebook cell batch
  | 'shell' // Open GemDB Shell
  | 'runFile' // Run Python File
  | 'mcp'; // an agent, through the MCP provider

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
} as const;
type EventName = (typeof EVENT)[keyof typeof EVENT];

let reporter: TelemetryReporter | undefined;

/**
 * Properties stamped on every event, established once at activation.
 *
 * `extensionMode`, plus `installDay` and `installDaySource` (see
 * `resolveInstallDay`). VS Code's own `common.*` properties are mixed in by
 * the extension host and are not repeated here.
 */
let baseProperties: Record<string, string> = {};

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
    return { installDay: utcDateOnly(contents), installDaySource: 'firstSeen' };
  } catch {
    /* no first-seen file yet — resolve it below and record one */
  }

  const today = utcDateOnly(new Date().toISOString());
  const installDay: InstallDay = {
    installDay: today,
    installDaySource: databaseExists ? 'reinstall' : 'firstSeen',
  };

  // Matches setup-attempted's own posture: worst case, this is offered once
  // more next activation. A failure here must never fail activation.
  try {
    fs.mkdirSync(storageDir, { recursive: true });
    fs.writeFileSync(firstSeenPath, new Date().toISOString());
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
  const { installDay, installDaySource } = resolveInstallDay(
    context.globalStorageUri.fsPath,
    databaseExists,
  );
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
 * The extension host finished activating.
 *
 * @param durationMs wall-clock time since the first statement of `activate()`,
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
export type SkipReason =
  'alreadyInstalled' | 'remoteWindow' | 'markerPresent' | 'lockHeld' | 'installedByOtherWindow';

/**
 * The unattended pass at activation bailed out before setup ran.
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
export type OsConfigOutcome = 'configured' | 'declined' | 'stillUnconfigured' | 'removeIpcUnset';

/** What was short when the modal was shown — not what is still short after it. */
export type OsConfigMissing = 'sharedMemory' | 'removeIpc' | 'both';

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
