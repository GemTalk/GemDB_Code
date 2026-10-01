import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { DEBUG_TYPE } from '../debugger';

/**
 * What package.json promises VS Code about trust, held to it.
 *
 * Both halves are one decision. GemDB declares `limited` Restricted Mode
 * support, which is safe only because nothing a folder can supply steers it:
 * VS Code gates most of what runs that folder's code (it asks before a
 * notebook cell executes and before a terminal starts, whoever's kernel or
 * terminal it is), Debug Python File, which VS Code cannot see, checks trust
 * itself (`debugFile.ts`), and every setting is
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
    debuggers?: Array<{ type: string; hiddenWhen?: string }>;
    commands: Array<{ command: string; title: string }>;
    views: Record<string, Array<{ id: string; name: string; when?: string; visibility?: string }>>;
    menus: Record<string, Array<{ command: string; when?: string; group?: string }>>;
    viewsWelcome: Array<{ view: string; contents: string; when?: string }>;
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

describe('Debug Python File', () => {
  const { commands, menus } = manifest.contributes;

  it('sits beside Run Python File in a Python editor’s run menu and the Command Palette', () => {
    const run = menus['editor/title/run'].filter((e) => e.when === 'resourceLangId == python');

    expect(run.map((e) => e.command)).toEqual(['gemdb.runFile', 'gemdb.debugFile']);
    expect(commands.find((c) => c.command === 'gemdb.debugFile')?.title).toBe(
      'Debug Python File in GemDB',
    );
    expect(menus.commandPalette.find((e) => e.command === 'gemdb.debugFile')?.when).toBe(
      'resourceLangId == python',
    );
  });
});

describe('the saved-stack contributions', () => {
  const { commands, menus } = manifest.contributes;
  const title = (command: string) => commands.find((c) => c.command === command)?.title;

  it('names adding a stack the way adding a variable is named', () => {
    expect(title('gemdb.saveVariable')).toBe('Add to Persisted Objects…');
    expect(title('gemdb.saveStack')).toBe('Add Stack to Persisted Objects…');
  });

  it('puts Add Stack on the Call Stack’s session and thread rows, and in every row’s menu', () => {
    const entries = menus['debug/callstack/context'].filter((e) => e.command === 'gemdb.saveStack');

    const inline = entries.find((e) => e.group?.startsWith('inline'));
    expect(inline?.when).toMatch(
      /callStackItemType == 'session' \|\| callStackItemType == 'thread'/,
    );
    expect(entries.some((e) => !e.group?.startsWith('inline'))).toBe(true);
    // Not on an opened saved stack: there is nothing more to add.
    expect(entries.every((e) => e.when?.includes('!gemdb.savedStackOpen'))).toBe(true);
  });

  it('opens a saved stack from its row, by icon and from the top of its right-click menu', () => {
    const entries = menus['view/item/context'].filter(
      (e) => e.command === 'gemdb.savedObjects.openStack',
    );

    expect(entries.every((e) => e.when?.includes('viewItem == gemdbSavedStack'))).toBe(true);
    // The icon can be crowded out of a narrow view; the menu item can't.
    expect(entries.map((e) => e.group?.startsWith('inline'))).toEqual([true, false]);
  });
});

describe('restoring a saved stack', () => {
  const { menus, viewsWelcome } = manifest.contributes;

  it('puts a blue Restore button in Run and Debug only while there is a saved stack to restore', () => {
    const welcome = viewsWelcome.find((w) => w.view === 'workbench.debug.welcome');

    expect(welcome?.contents).toContain('[Restore a Saved Stack…](command:gemdb.restoreStack)');
    expect(welcome?.when).toBe('gemdb.running && gemdb.hasSavedStacks');
  });

  it('offers Restore in the GemDB panel’s title bar too', () => {
    const entry = menus['view/title'].find((e) => e.command === 'gemdb.restoreStack');

    expect(entry?.when).toBe('view == gemdbStatus && gemdb.running && gemdb.hasSavedStacks');
  });
});
