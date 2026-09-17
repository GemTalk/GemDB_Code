import { vi } from 'vitest';

// Several modules under test here (osConfig.ts, lifecycle.ts) now import
// telemetry.ts at runtime, which imports the real @vscode/extension-telemetry
// package — whose compiled entry point calls Node's own `require('vscode')`
// at evaluation time. That fails outside a real extension host no matter how
// `vscode` itself is stubbed; see __mocks__/@vscode/extension-telemetry.ts at
// the repo root for the same fix applied to `npm test`. Applied globally here
// via `setupFiles` rather than per test file, since which integration file
// happens to reach telemetry.ts is an implementation detail, not something
// each test should have to know.
vi.mock('@vscode/extension-telemetry');
