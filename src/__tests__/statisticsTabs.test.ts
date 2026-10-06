import { beforeEach, describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { __commands, __resetSettings } from '../__mocks__/vscode';
import { OpenMessage, StatisticsWorld, registerStatistics } from '../statistics';

/**
 * GemDB Stats' tabs: which file each one shows, what its page is told, and
 * what a pick from inside a tab does. VS Code is a stand-in here — panels
 * that record what they were sent, and an open dialog that answers from a
 * queue — so the messages GemDB Stats' docs/embedding.md specifies can be
 * played without an editor.
 */

/** A file as the tabs see one: a path and the string it compares by. */
function file(filePath: string): vscode.Uri {
  return { path: filePath, toString: () => `file://${filePath}` } as unknown as vscode.Uri;
}

interface FakePanel {
  file: vscode.Uri;
  column: number | undefined;
  html: string;
  posted: OpenMessage[];
  reveals: number;
  disposed: boolean;
  /** A message from the page, as GemDB Stats would send it. */
  say(message: { type: string }): void;
}

let panels: FakePanel[];
let picks: (vscode.Uri | undefined)[];
let pickedNear: (vscode.Uri | undefined)[];
let template: string | undefined;

const world: StatisticsWorld = {
  build: () => file('/ext/stats'),
  hostTemplate: () => {
    if (template === undefined) throw new Error('ENOENT: host.html');
    return template;
  },
  createPanel: (shown, column) => {
    const heard: ((message: unknown) => void)[] = [];
    const closed: (() => void)[] = [];
    const fake: FakePanel = {
      file: shown,
      column,
      html: '',
      posted: [],
      reveals: 0,
      disposed: false,
      say: (message) => heard.forEach((listener) => listener(message)),
    };
    panels.push(fake);
    const panel = {
      viewColumn: column ?? 1,
      webview: {
        cspSource: 'https://resource.example',
        asWebviewUri: (uri: vscode.Uri) => ({
          toString: () => `https://resource.example${uri.path}`,
        }),
        postMessage: (message: OpenMessage) => {
          fake.posted.push(message);
          return Promise.resolve(true);
        },
        onDidReceiveMessage: (listener: (message: unknown) => void) => heard.push(listener),
        set html(value: string) {
          fake.html = value;
        },
      },
      onDidDispose: (listener: () => void) => closed.push(listener),
      reveal: () => {
        fake.reveals += 1;
      },
      dispose: () => {
        fake.disposed = true;
        closed.forEach((listener) => listener());
      },
    };
    return panel as unknown as vscode.WebviewPanel;
  },
  pickFile: (near) => {
    pickedNear.push(near);
    return Promise.resolve(picks.shift());
  },
};

/** Run a registered command as VS Code would, and let what it started settle. */
async function run(command: string, ...args: unknown[]): Promise<void> {
  await __commands.get(command)?.(...args);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** A message from a tab's page, and whatever it started. */
async function say(panel: FakePanel, type: string): Promise<void> {
  panel.say({ type });
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  __resetSettings();
  panels = [];
  picks = [];
  pickedNear = [];
  template = '<base href="{{GEMDB_BASE}}"><script nonce="{{GEMDB_NONCE}}"></script>';
  registerStatistics(file('/ext'), world);
});

describe('a GemDB Stats tab', () => {
  it('tells its page its file each time the page says it is ready', async () => {
    await run('gemdb.openInStats', file('/data/statmon.out.gz'));
    const [panel] = panels;

    await say(panel, 'ready');
    await say(panel, 'ready');

    expect(panel.posted).toEqual([
      { type: 'open', url: 'https://resource.example/data/statmon.out.gz', name: 'statmon.out.gz' },
      { type: 'open', url: 'https://resource.example/data/statmon.out.gz', name: 'statmon.out.gz' },
    ]);
  });

  it('sends nothing before its page is ready', async () => {
    await run('gemdb.openInStats', file('/data/statmon.out'));

    expect(panels[0].posted).toEqual([]);
  });

  it('points its page at the bundled build', async () => {
    await run('gemdb.openInStats', file('/data/statmon.out'));

    expect(panels[0].html).toContain('<base href="https://resource.example/ext/stats/">');
    expect(panels[0].html).not.toContain('{{GEMDB_');
  });

  it('says so when this build of GemDB Code has no GemDB Stats', async () => {
    template = undefined;

    await run('gemdb.openInStats', file('/data/statmon.out'));

    expect(panels[0].html).toContain('does not include GemDB Stats');
  });
});

describe('opening files', () => {
  it('brings forward the tab already showing a file instead of opening it again', async () => {
    await run('gemdb.openInStats', file('/data/a.out'));

    await run('gemdb.openInStats', file('/data/a.out'));

    expect(panels).toHaveLength(1);
    expect(panels[0].reveals).toBe(1);
  });

  it('opens every file selected in the explorer', async () => {
    const selected = [file('/data/a.out'), file('/data/b.out.gz')];

    await run('gemdb.openInStats', selected[0], selected);

    expect(panels.map((panel) => panel.file)).toEqual(selected);
  });

  it('asks for a file when given none, as from a keybinding', async () => {
    picks = [file('/data/a.out')];

    await run('gemdb.openInStats');

    expect(panels.map((panel) => panel.file.path)).toEqual(['/data/a.out']);
  });

  it('opens nothing when the open dialog is cancelled', async () => {
    picks = [undefined];

    await run('gemdb.openStatistics');

    expect(panels).toEqual([]);
  });
});

describe('a file picked from inside a tab', () => {
  it('replaces the tab with one for the new file, in the same place', async () => {
    await run('gemdb.openInStats', file('/data/a.out'));
    const [first] = panels;
    picks = [file('/elsewhere/b.out')];

    await say(first, 'pickFile');

    expect(first.disposed).toBe(true);
    expect(panels[1].file.path).toBe('/elsewhere/b.out');
    expect(panels[1].column).toBe(1);
  });

  it('opens the dialog beside the file the tab is showing', async () => {
    await run('gemdb.openInStats', file('/data/a.out'));

    await say(panels[0], 'pickFile');

    expect(pickedNear.map((uri) => uri?.path)).toEqual(['/data/a.out']);
  });

  it('brings forward another tab already showing it, and leaves this tab alone', async () => {
    await run('gemdb.openInStats', file('/data/a.out'));
    await run('gemdb.openInStats', file('/data/b.out'));
    const [first, second] = panels;
    picks = [file('/data/b.out')];

    await say(first, 'pickFile');

    expect(first.disposed).toBe(false);
    expect(second.reveals).toBe(1);
    expect(panels).toHaveLength(2);
  });

  it('changes nothing when it is the file the tab already shows', async () => {
    await run('gemdb.openInStats', file('/data/a.out'));
    picks = [file('/data/a.out')];

    await say(panels[0], 'pickFile');

    expect(panels).toHaveLength(1);
    expect(panels[0].disposed).toBe(false);
  });

  it('can be opened again once its tab is closed', async () => {
    await run('gemdb.openInStats', file('/data/a.out'));
    picks = [file('/data/b.out')];
    await say(panels[0], 'pickFile');

    await run('gemdb.openInStats', file('/data/a.out'));

    expect(panels.map((panel) => panel.file.path)).toEqual([
      '/data/a.out',
      '/data/b.out',
      '/data/a.out',
    ]);
  });
});
