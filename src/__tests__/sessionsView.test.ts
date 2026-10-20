import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import type { DatabaseSession, PublishedSession } from '../maintenance';
import type { SessionOwner } from '../session';
import {
  HeldSession,
  SessionsSnapshot,
  SessionsWorld,
  describePublished,
  rowsFromDescribed,
  rowsFromPublished,
  sessionsPage,
  showSessions,
  takeSnapshot,
} from '../sessionsView';

/**
 * The Sessions tab: what it makes of DataCurator's listing and of the shared
 * cache, what it says when it can read neither, and what the page's messages
 * ask of GemDB. The database is a stand-in, as the rows a measured 4.0.0.a5
 * stone answered: its two gems, this window's own session, a notebook, topaz
 * and the MCP router.
 */

const extension: SessionOwner = { key: '__extension__', kind: 'extension', label: 'GemDB' };
const notebook: SessionOwner = { key: 'file:///a.ipynb', kind: 'notebook', label: 'a.ipynb' };

function session(id: number, name: string, more: Partial<DatabaseSession> = {}): DatabaseSession {
  return {
    id,
    user: 'gemdb',
    name,
    viewAgeSeconds: 40,
    holdsOldest: false,
    behind: 0,
    system: false,
    pid: 19000 + id,
    host: 'localhost',
    ...more,
  };
}

const described: DatabaseSession[] = [
  session(6, 'McpRouter:50390'),
  session(2, 'GcReclaim', { user: 'GcUser', system: true, holdsOldest: true }),
  session(3, 'SymbolGem', { user: 'SymbolUser', system: true }),
  session(4, 'GemDB Code'),
  session(5, 'TopazL', {
    user: 'DataCurator',
    holdsOldest: true,
    behind: 12,
    viewAgeSeconds: 7200,
  }),
  session(7, 'GemDB nb a'),
];

const published: PublishedSession[] = described.map((s) => ({
  id: s.id,
  name: s.name,
  pid: s.pid,
}));

const held: HeldSession[] = [
  { serial: 4, owner: extension },
  { serial: 7, owner: notebook },
];

describe('the rows DataCurator can read', () => {
  const rows = rowsFromDescribed(described, held);
  const row = (id: number) => rows.find((r) => r.id === id);

  it('lists every session by id', () => {
    expect(rows.map((r) => r.id)).toEqual([2, 3, 4, 5, 6, 7]);
  });

  it("calls this window's sessions what this window calls them", () => {
    expect(row(7)).toMatchObject({ name: 'a.ipynb', kind: 'Notebook', mine: true });
    expect(row(4)).toMatchObject({ mine: true, kind: 'GemDB Code’s own, for status queries' });
  });

  it('says what anyone else’s session is, from the name it published', () => {
    expect(row(2)?.kind).toBe('The database’s own');
    expect(row(5)?.kind).toBe('Topaz');
    expect(row(6)?.kind).toBe('MCP server');
  });

  it('offers to stop neither the database’s own gems nor this window’s own session', () => {
    expect(rows.filter((r) => r.stoppable).map((r) => r.id)).toEqual([5, 6, 7]);
  });

  it('flags only a session that is behind as holding back garbage collection', () => {
    expect(rows.filter((r) => r.holdingBack).map((r) => r.id)).toEqual([5]);
    expect(row(5)).toMatchObject({ user: 'DataCurator', viewAge: '2 h', behind: 12 });
    expect(row(5)?.process).toBe('19005 on localhost');
  });
});

describe('the rows the shared cache publishes', () => {
  const rows = rowsFromPublished(published, held);

  it('names every session and claims nothing it cannot read', () => {
    expect(rows.map((r) => r.id)).toEqual([2, 3, 4, 5, 6, 7]);
    expect(rows.every((r) => r.user === undefined && r.viewAge === undefined)).toBe(true);
    expect(rows.find((r) => r.id === 7)).toMatchObject({ name: 'a.ipynb', mine: true });
  });

  it("offers to stop only this window's own notebooks, which need no other login", () => {
    expect(rows.filter((r) => r.stoppable).map((r) => r.id)).toEqual([7]);
  });
});

describe('what a published name says', () => {
  it.each([
    ['GemDB nb analysis', 'Notebook in another window'],
    ['GemDB Shell 41234', 'GemDB Shell'],
    ['GemDB run backfill', 'The gemdb command'],
    ['GemDB Code', 'Another GemDB Code window'],
    ['McpServer:5:a1b2c3d4', 'MCP server, for one agent'],
    ['TopazR', 'Topaz'],
    ['Reporting', ''],
  ])('%s is %s', (name, kind) => {
    expect(describePublished(name, false)).toBe(kind);
  });
});

/** A stand-in for GemDB and VS Code, and the page VS Code would have shown. */
interface Fake {
  world: SessionsWorld;
  running: boolean;
  /** DataCurator's listing, or the error its login fails with. */
  listing: DatabaseSession[] | Error;
  cache: PublishedSession[] | undefined;
  panels: number;
  revealed: number;
  html: string;
  posted: unknown[];
  stopped: { id: number; label: string }[];
  stopAnswer: boolean;
  say(message: unknown): Promise<void>;
  dispose(): void;
}

function fake(): Fake {
  let receive: (message: unknown) => void = () => {};
  let disposed: () => void = () => {};
  const f: Fake = {
    running: true,
    listing: described,
    cache: published,
    panels: 0,
    revealed: 0,
    html: '',
    posted: [],
    stopped: [],
    stopAnswer: true,
    world: {
      running: () => Promise.resolve(f.running),
      described: () => {
        if (f.listing instanceof Error) throw f.listing;
        return f.listing;
      },
      published: () => f.cache,
      held: () => held,
      stop: (id, label) => {
        f.stopped.push({ id, label });
        return Promise.resolve(f.stopAnswer);
      },
      createPanel: () => {
        f.panels++;
        const webview = {
          cspSource: 'vscode-resource:',
          set html(value: string) {
            f.html = value;
          },
          onDidReceiveMessage: (listener: (message: unknown) => void) => {
            receive = listener;
          },
          postMessage: (message: unknown) => {
            f.posted.push(message);
            return Promise.resolve(true);
          },
        };
        return {
          webview,
          reveal: () => {
            f.revealed++;
          },
          onDidDispose: (listener: () => void) => {
            disposed = listener;
          },
        } as unknown as vscode.WebviewPanel;
      },
      now: () => new Date(2026, 9, 19, 10, 42, 13),
    },
    say: async (message) => {
      receive(message);
      // Let the read the message started finish.
      for (let i = 0; i < 5; i++) await Promise.resolve();
    },
    dispose: () => disposed(),
  };
  return f;
}

const snapshots = (f: Fake) =>
  f.posted.filter((m): m is SessionsSnapshot => (m as { type?: string }).type === 'sessions');

describe('reading the table', () => {
  it('says the database is not running rather than trying to log in', async () => {
    const f = fake();
    f.running = false;

    const snapshot = await takeSnapshot(f.world);

    expect(snapshot).toMatchObject({ rows: [], detailed: false });
    expect(snapshot.note).toMatch(/not running/);
  });

  it('falls back to the shared cache when DataCurator cannot log in, and says why', async () => {
    const f = fake();
    f.listing = new Error('The database has no session to spare');

    const snapshot = await takeSnapshot(f.world);

    expect(snapshot.detailed).toBe(false);
    expect(snapshot.rows).toHaveLength(6);
    expect(snapshot.note).toMatch(/no session to spare/);
  });

  it('says it could read nothing when this window holds no session to ask either', async () => {
    const f = fake();
    f.listing = new Error('refused');
    f.cache = undefined;

    const snapshot = await takeSnapshot(f.world);

    expect(snapshot.rows).toEqual([]);
    expect(snapshot.note).toMatch(/Could not list .* refused/);
  });
});

describe('the tab', () => {
  let f: Fake;

  beforeEach(() => {
    f = fake();
  });

  afterEach(() => {
    f.dispose();
  });

  it('reads when the page says it is ready, and again on Refresh', async () => {
    showSessions(f.world);
    await f.say({ type: 'ready' });
    await f.say({ type: 'refresh' });

    expect(snapshots(f)).toHaveLength(2);
    expect(snapshots(f)[0]).toMatchObject({ detailed: true, takenAt: expect.any(String) });
  });

  it('is one tab: opening it again brings it forward and reads again', async () => {
    showSessions(f.world);
    await f.say({ type: 'ready' });
    showSessions(f.world);
    await f.say({});

    expect(f.panels).toBe(1);
    expect(f.revealed).toBe(1);
    expect(snapshots(f)).toHaveLength(2);
  });

  it('asks before stopping, names the session, and reads again once it is stopped', async () => {
    showSessions(f.world);
    await f.say({ type: 'ready' });
    await f.say({ type: 'stop', id: 5 });

    expect(f.stopped).toEqual([{ id: 5, label: 'TopazL (session 5)' }]);
    expect(snapshots(f)).toHaveLength(2);
  });

  it('reads nothing again when the stop was declined', async () => {
    f.stopAnswer = false;
    showSessions(f.world);
    await f.say({ type: 'ready' });
    await f.say({ type: 'stop', id: 5 });

    expect(snapshots(f)).toHaveLength(1);
  });

  it('will not stop a session it did not offer, whatever the page sends', async () => {
    showSessions(f.world);
    await f.say({ type: 'ready' });
    await f.say({ type: 'stop', id: 2 });
    await f.say({ type: 'stop', id: 4 });
    await f.say({ type: 'stop', id: '5' });

    expect(f.stopped).toEqual([]);
  });
});

describe('the page', () => {
  const page = sessionsPage('abc123', 'vscode-resource:');

  it('runs only its own script', () => {
    expect(page).toContain("script-src 'nonce-abc123'");
    expect(page).toContain('<script nonce="abc123">');
    expect(page).not.toMatch(/\son[a-z]+="/);
  });

  it('sets what sessions published as text, never as markup', () => {
    expect(page).not.toContain('innerHTML');
    expect(page).toContain('textContent');
  });
});
