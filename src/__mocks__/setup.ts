import { vi } from 'vitest';

// Replaces the real @vscode/extension-telemetry with the root-level
// __mocks__/@vscode/extension-telemetry.ts in both suites. This is about
// loadability, not about suppressing events: the package's compiled entry
// point calls Node's own `require('vscode')` at evaluation time, which the
// `vscode` alias cannot reach, so any module graph that reaches telemetry.ts
// fails to load without it. Applied here via `setupFiles` rather than per
// test file, since which files happen to reach telemetry.ts is an
// implementation detail, not something each test should have to know.
vi.mock('@vscode/extension-telemetry');

// Replaces the one module that sends to Scarf with a recorder, in both
// suites. Unlike the line above, this one is about suppressing events:
// the suites that call `initTelemetry` pass a Production context, and
// without it each would send a real request to Scarf. Mocking this module
// rather than `https` keeps the rest of Node's network available to a test
// that needs it; getting the real transport takes a deliberate
// `vi.importActual`, as `scarfTransport.test.ts` does.
vi.mock('../scarfTransport');
