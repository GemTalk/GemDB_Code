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
