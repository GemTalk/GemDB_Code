import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { DEBUG_TYPE } from '../debugger';

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
  contributes: {
    configuration: { properties: Record<string, { scope?: string }> };
    debuggers?: Array<{ type: string; hiddenWhen?: string }>;
    commands: Array<{ command: string; title: string }>;
    views: Record<string, Array<{ id: string; name: string; when?: string; visibility?: string }>>;
    menus: Record<string, Array<{ command: string; when?: string; group?: string }>>;
  };
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

  it('declares the breakpoint() debugger under the type the code starts it with', () => {
    // A mismatch fails silently: startDebugging answers false, and every
    // breakpoint() stops its cell with "could not open the debugger".
    const debuggers = manifest.contributes.debuggers ?? [];
    expect(debuggers.map((d) => d.type)).toEqual([DEBUG_TYPE]);
    // Nobody launches it by hand, so it stays out of the Run and Debug picker.
    expect(debuggers[0].hiddenWhen).toBe('true');
  });

  it('scopes every setting to the machine', () => {
    const unscoped = Object.entries(manifest.contributes.configuration.properties)
      .filter(([, setting]) => setting.scope !== 'machine')
      .map(([id]) => id);
    expect(unscoped).toEqual([]);
  });
});

describe('the Persisted Objects contributions', () => {
  const { commands, views, menus } = manifest.contributes;
  const declared = new Set(commands.map((c) => c.command));
  const title = (command: string) => commands.find((c) => c.command === command)?.title;

  it('names only commands it declares in every menu', () => {
    const used = Object.values(menus).flatMap((entries) => entries.map((e) => e.command));

    expect(used.filter((command) => !declared.has(command))).toEqual([]);
  });

  it('shows the view under GemDB, and in Run and Debug during a GemDB debug session, open', () => {
    const debugView = views.debug?.find((v) => v.id === 'gemdbSavedObjectsDebug');

    expect(views.gemdb.find((v) => v.id === 'gemdbSavedObjects')?.name).toBe('Persisted Objects');
    expect(debugView).toMatchObject({
      name: 'Persisted Objects',
      when: 'debugType == gemdb',
      visibility: 'visible',
    });
  });

  it('puts Commit, Abort, Refresh and help in the title bar of both copies, always', () => {
    const forBoth = '(view == gemdbSavedObjects || view == gemdbSavedObjectsDebug)';
    const titleBar = menus['view/title'].filter((e) => e.when === forBoth).map((e) => e.command);

    expect(titleBar).toEqual(
      expect.arrayContaining([
        'gemdb.savedObjects.commitNotebook',
        'gemdb.savedObjects.abortNotebook',
        'gemdb.savedObjects.refresh',
        'gemdb.savedObjects.help',
      ]),
    );
  });

  it('offers Add to Persisted Objects on Variables rows of a GemDB debug session only', () => {
    const entry = menus['debug/variables/context']?.find((e) => e.command === 'gemdb.saveVariable');

    expect(entry?.when).toBe('debugType == gemdb');
    expect(title('gemdb.saveVariable')).toBe('Add to Persisted Objects…');
  });

  it('keeps commands that need a row or a paused variable out of the Command Palette', () => {
    const hidden = menus.commandPalette.filter((e) => e.when === 'false').map((e) => e.command);

    expect(hidden).toEqual(
      expect.arrayContaining([
        'gemdb.saveVariable',
        'gemdb.savedObjects.commit',
        'gemdb.savedObjects.abort',
        'gemdb.savedObjects.copyAccess',
        'gemdb.savedObjects.remove',
      ]),
    );
  });

  it('says in the title bar buttons’ tooltips what they do to the notebook', () => {
    expect(title('gemdb.savedObjects.commitNotebook')).toMatch(/^Commit: Persist/);
    expect(title('gemdb.savedObjects.abortNotebook')).toMatch(/^Abort: Discard/);
    expect(title('gemdb.savedObjects.help')).toMatch(/Add Under gemdb\.root, Then Commit/);
  });
});
