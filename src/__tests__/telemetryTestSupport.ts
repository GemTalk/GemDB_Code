import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type * as vscode from 'vscode';
import { ExtensionMode, __telemetry, type FakeTelemetryEvent } from '../__mocks__/vscode';
import type { EventName } from '../telemetry';

// Shared by the suites that assert on telemetry. Not a `.test.ts` file, so
// vitest's `include` never runs it as a suite of its own.

/** Every event of one name the fake telemetry logger has recorded, in order. */
export function eventsNamed(name: EventName): FakeTelemetryEvent[] {
  return __telemetry.filter((e) => e.name === name);
}

/**
 * The slice of `ExtensionContext` that `activate()` and `initTelemetry` read,
 * with a fresh global storage directory unless the test brings its own.
 */
export function fakeExtensionContext(
  options: { globalStoragePath?: string } = {},
): vscode.ExtensionContext {
  const globalStoragePath = options.globalStoragePath ?? mkdtempSync(join(tmpdir(), 'gemdb-ctx-'));
  // One reviewed cast rather than one per suite: a hand-built fake cannot
  // satisfy the whole interface without stubbing dozens of members nothing
  // here reads, and callers get a typed context back instead of `any`.
  return {
    extensionPath: '/ext',
    extension: { packageJSON: { version: '0.0.0-test' } },
    extensionMode: ExtensionMode.Production,
    globalStorageUri: { fsPath: globalStoragePath },
    subscriptions: [],
    environmentVariableCollection: {
      description: '',
      clear: () => {},
      prepend: () => {},
    },
  } as unknown as vscode.ExtensionContext;
}
