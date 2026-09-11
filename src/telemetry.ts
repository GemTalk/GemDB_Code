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

export function initTelemetry(context: vscode.ExtensionContext): void {
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
 */
function send(
  name: EventName,
  properties?: Record<string, string>,
  measures?: Record<string, number>,
): void {
  reporter?.sendTelemetryEvent(name, properties, measures);
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
