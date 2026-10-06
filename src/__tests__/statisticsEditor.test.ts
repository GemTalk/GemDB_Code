import { beforeEach, describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { __commands, __customEditors, __resetSettings } from '../__mocks__/vscode';
import {
  OpenMessage,
  STATISTICS_VIEW_TYPE,
  StatisticsEditorProvider,
  StatisticsWorld,
  registerStatistics,
} from '../statistics';

/**
 * GemDB Stats' editor tabs: what each page is told, what it may read, and
 * what opening a file — from the explorer, the Command Palette, or inside a
 * tab — asks VS Code to do. VS Code is a stand-in here: tabs are a set of
 * file paths, and the open dialog answers from a queue, so the messages
 * GemDB Stats' docs/embedding.md specifies can be played without an editor.
 */

/** A file as GemDB Stats sees one: a path and the string it compares by. */
function file(filePath: string): vscode.Uri {
  return { path: filePath, toString: () => `file://${filePath}` } as unknown as vscode.Uri;
}

/** A tab's page: what it was given, and a way to speak as GemDB Stats would. */
interface FakePage {
  html: string;
  options: vscode.WebviewOptions | undefined;
  posted: OpenMessage[];
  say(type: string): Promise<void>;
}

let tabs: Set<string>;
let opened: { file: string; column: number | undefined }[];
let closed: string[];
let picks: (vscode.Uri | undefined)[];
let pickedNear: (string | undefined)[];
let template: string | undefined;

const world: StatisticsWorld = {
  build: () => file('/ext/stats'),
  hostTemplate: () => {
    if (template === undefined) throw new Error('ENOENT: host.html');
    return template;
  },
  roots: (shown) => [file('/ext/stats'), file(shown.path.replace(/\/[^/]*$/, ''))],
  pickFile: (near) => {
    pickedNear.push(near?.path);
    return Promise.resolve(picks.shift());
  },
  openEditor: (shown, column) => {
    opened.push({ file: shown.path, column });
    tabs.add(shown.path);
    return Promise.resolve();
  },
  isOpen: (shown) => tabs.has(shown.path),
  closeEditor: (shown) => {
    closed.push(shown.path);
    tabs.delete(shown.path);
    return Promise.resolve();
  },
};

/** Open `shown` in a GemDB Stats tab as VS Code would: resolve the editor on a page. */
function showTab(shown: vscode.Uri, column = 2): FakePage {
  const provider = __customEditors.get(STATISTICS_VIEW_TYPE)?.provider as StatisticsEditorProvider;
  const heard: ((message: unknown) => void)[] = [];
  const page: FakePage = {
    html: '',
    options: undefined,
    posted: [],
    say: async (type) => {
      heard.forEach((listener) => listener({ type }));
      await settle();
    },
  };
  const webview = {
    cspSource: 'https://resource.example',
    asWebviewUri: (uri: vscode.Uri) => ({ toString: () => `https://resource.example${uri.path}` }),
    postMessage: (message: OpenMessage) => {
      page.posted.push(message);
      return Promise.resolve(true);
    },
    onDidReceiveMessage: (listener: (message: unknown) => void) => heard.push(listener),
    set html(value: string) {
      page.html = value;
    },
    set options(value: vscode.WebviewOptions) {
      page.options = value;
    },
  };
  const panel = { viewColumn: column, webview } as unknown as vscode.WebviewPanel;
  provider.resolveCustomEditor(provider.openCustomDocument(shown), panel);
  tabs.add(shown.path);
  return page;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Run a registered command as VS Code would, and let what it started settle. */
async function run(command: string, ...args: unknown[]): Promise<void> {
  await __commands.get(command)?.(...args);
  await settle();
}

beforeEach(() => {
  __resetSettings();
  tabs = new Set();
  opened = [];
  closed = [];
  picks = [];
  pickedNear = [];
  template = '<base href="{{GEMDB_BASE}}"><script nonce="{{GEMDB_NONCE}}"></script>';
  registerStatistics(file('/ext'), world);
});

describe('a GemDB Stats tab', () => {
  it('tells its page its file each time the page says it is ready', async () => {
    const page = showTab(file('/data/statmon.out.gz'));

    await page.say('ready');
    await page.say('ready');

    expect(page.posted).toEqual([
      { type: 'open', url: 'https://resource.example/data/statmon.out.gz', name: 'statmon.out.gz' },
      { type: 'open', url: 'https://resource.example/data/statmon.out.gz', name: 'statmon.out.gz' },
    ]);
  });

  it('sends nothing before its page is ready', () => {
    const page = showTab(file('/data/statmon.out'));

    expect(page.posted).toEqual([]);
  });

  it('lets its page read the build and the file’s folder, and run scripts', () => {
    const page = showTab(file('/data/statmon.out'));

    expect(page.options?.enableScripts).toBe(true);
    expect(page.options?.localResourceRoots?.map((root) => root.path)).toEqual([
      '/ext/stats',
      '/data',
    ]);
  });

  it('points its page at the bundled build', () => {
    const page = showTab(file('/data/statmon.out'));

    expect(page.html).toContain('<base href="https://resource.example/ext/stats/">');
    expect(page.html).not.toContain('{{GEMDB_');
  });

  it('says so when this build of GemDB Code has no GemDB Stats', () => {
    template = undefined;

    const page = showTab(file('/data/statmon.out'));

    expect(page.html).toContain('does not include GemDB Stats');
  });
});

describe('opening files', () => {
  it('opens every file selected in the explorer, each in a tab of its own', async () => {
    const selected = [file('/data/a.out'), file('/data/b.out.gz')];

    await run('gemdb.openInStats', selected[0], selected);

    expect(opened.map((open) => open.file)).toEqual(['/data/a.out', '/data/b.out.gz']);
  });

  it('opens the right-clicked file when nothing else is selected', async () => {
    await run('gemdb.openInStats', file('/data/a.out'));

    expect(opened.map((open) => open.file)).toEqual(['/data/a.out']);
  });

  it('asks for a file when given none, as from a keybinding', async () => {
    picks = [file('/data/a.out')];

    await run('gemdb.openInStats');

    expect(opened.map((open) => open.file)).toEqual(['/data/a.out']);
  });

  it('opens nothing when the open dialog is cancelled', async () => {
    picks = [undefined];

    await run('gemdb.openStatistics');

    expect(opened).toEqual([]);
  });
});

describe('a file picked from inside a tab', () => {
  it('opens in its place: a tab where this one is, and this one closes', async () => {
    const page = showTab(file('/data/a.out'), 3);
    picks = [file('/elsewhere/b.out')];

    await page.say('pickFile');

    expect(opened).toEqual([{ file: '/elsewhere/b.out', column: 3 }]);
    expect(closed).toEqual(['/data/a.out']);
  });

  it('opens the dialog beside the file the tab is showing', async () => {
    const page = showTab(file('/data/a.out'));

    await page.say('pickFile');

    expect(pickedNear).toEqual(['/data/a.out']);
  });

  it('brings forward another tab already showing it, and leaves this tab alone', async () => {
    const page = showTab(file('/data/a.out'));
    showTab(file('/data/b.out'));
    picks = [file('/data/b.out')];

    await page.say('pickFile');

    expect(opened).toEqual([{ file: '/data/b.out', column: undefined }]);
    expect(closed).toEqual([]);
  });

  it('changes nothing when it is the file the tab already shows', async () => {
    const page = showTab(file('/data/a.out'));
    picks = [file('/data/a.out')];

    await page.say('pickFile');

    expect(opened).toEqual([]);
    expect(closed).toEqual([]);
  });

  it('changes nothing when the dialog is cancelled', async () => {
    const page = showTab(file('/data/a.out'));
    picks = [undefined];

    await page.say('pickFile');

    expect(opened).toEqual([]);
    expect(closed).toEqual([]);
  });
});
