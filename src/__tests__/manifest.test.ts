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

interface WalkthroughStep {
  id: string;
  when?: string;
  media: { markdown?: string };
}

interface Manifest {
  capabilities?: { untrustedWorkspaces?: { supported?: unknown } };
  contributes: {
    configuration: { properties: Record<string, { scope?: string }> };
    walkthroughs: { steps: WalkthroughStep[] }[];
  };
}

const root = path.resolve(__dirname, '../..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as Manifest;
const steps = manifest.contributes.walkthroughs.flatMap((walkthrough) => walkthrough.steps);

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

  // An external database is the administrator's: setup downloads nothing and
  // creates nothing, and Stop is refused. The walkthrough must not say otherwise.
  it('walks an external database through its own setup, and not through stopping', () => {
    const shownFor = (external: boolean): string[] =>
      steps
        .filter(
          (step) =>
            step.when === undefined ||
            step.when === (external ? 'gemdb.externalDatabase' : '!gemdb.externalDatabase'),
        )
        .map((step) => step.id);
    expect(shownFor(false)).toEqual(['install', 'repl', 'notebook', 'demo', 'stopping']);
    expect(shownFor(true)).toEqual(['installExternal', 'repl', 'notebook', 'demo']);
  });

  it('ships the page every walkthrough step shows', () => {
    const missing = steps
      .map((step) => step.media.markdown)
      .filter((page): page is string => page !== undefined)
      .filter((page) => !fs.existsSync(path.join(root, page)));
    expect(missing).toEqual([]);
  });
});
