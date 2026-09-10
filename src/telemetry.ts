import * as vscode from 'vscode';
import { TelemetryReporter } from '@vscode/extension-telemetry';

/**
 * GemDB's telemetry: one named function per thing worth counting.
 *
 * Two rules a future edit can break, neither visible from a call site:
 *
 * 1. **Only `src/extension.ts` may import this module.** `out/gemdb-shell.js`
 *    is bundled from the same sources with `vscode` aliased to
 *    `cliVscode.ts`; there is no extension host there, so nothing would
 *    enforce the user's telemetry setting. ESLint enforces the boundary.
 * 2. **Never `sendDangerousTelemetryEvent`** or its siblings. They bypass the
 *    user's preference by design, for CI. Shipping one is a Marketplace
 *    violation.
 */

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
} as const;
type EventName = (typeof EVENT)[keyof typeof EVENT];

let reporter: TelemetryReporter | undefined;

/**
 * Properties stamped on every event, established once at activation.
 *
 * Only `extensionMode` for now. VS Code's own `common.*` properties are
 * mixed in by the extension host and are not repeated here.
 */
let baseProperties: Record<string, string> = {};

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

export function initTelemetry(context: vscode.ExtensionContext): void {
  // Nothing VS Code sends distinguishes an F5 debug session from a real
  // install — `common.extversion` is the same in both — so say which one
  // this is. Every query that reports on users has to exclude anything but
  // 'production'.
  baseProperties = { extensionMode: extensionModeName(context.extensionMode) };
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
 */
export function reportActivation(durationMs: number): void {
  send(EVENT.activated, undefined, { activationMs: durationMs });
}
