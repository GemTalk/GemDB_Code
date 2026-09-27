import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * What package.json promises VS Code about trust, held to it.
 *
 * Both halves are one decision. GemDB declares `limited` Restricted Mode
 * support and adds no trust checks of its own, which is safe only because
 * nothing a folder can supply steers it: VS Code gates the parts that run
 * that folder's code (it asks before a notebook cell executes and before a
 * terminal starts, whoever's kernel or terminal it is), and every setting is
 * machine-scoped, so a cloned repository's `.vscode/settings.json` cannot
 * choose the root path that uninstall deletes under. A setting added later
 * without the scope would reopen that quietly — hence a test, not a comment.
 */

interface Manifest {
  capabilities?: { untrustedWorkspaces?: { supported?: unknown } };
  contributes: { configuration: { properties: Record<string, { scope?: string }> } };
}

const manifest = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'),
) as Manifest;

describe('the manifest', () => {
  it('keeps GemDB running in Restricted Mode', () => {
    // Undeclared means disabled: the demo's README, the status bar and every
    // command would vanish in any folder the user has not trusted yet.
    expect(manifest.capabilities?.untrustedWorkspaces?.supported).toBe('limited');
  });

  it('scopes every setting to the machine', () => {
    const unscoped = Object.entries(manifest.contributes.configuration.properties)
      .filter(([, setting]) => setting.scope !== 'machine')
      .map(([id]) => id);
    expect(unscoped).toEqual([]);
  });
});
