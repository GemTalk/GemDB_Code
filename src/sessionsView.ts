import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { errorMessage, log } from './log';
import {
  DatabaseSession,
  MaintenanceHooks,
  PublishedSession,
  askToStopSession,
  databaseSessions,
  publishedSessions,
  stoppableSessions,
} from './maintenance';
import { isRunningAsync } from './processes';
import { SessionOwner, humanDuration, windowSessions } from './session';

/**
 * Every session on the database, in an editor tab: the answer to "which of
 * these is worth closing" when the database has none left to give, and to
 * "who is holding garbage collection back" when a collection frees nothing.
 *
 * The status view's Sessions row counts what this window holds, because that
 * is all `gemdb` can see: describing another session needs `SessionAccess`
 * (2151, measured on 4.0.0.a5), and `gemdb` deliberately does not hold it. So
 * the list is read as DataCurator, the way "Stop a Database Session…" reads
 * it, in a short login of its own.
 *
 * That login is why the tab never polls. Sessions are what is scarce, and a
 * view that spent one every few seconds would be part of the problem it
 * reports on — and would fail to log in at exactly the moment it is wanted.
 * It reads when the page loads (opening the tab, or bringing it back, since a
 * hidden page is discarded), on Refresh, after a stop, and when the database
 * starts or stops. When DataCurator cannot log in, it falls back to what the
 * shared cache publishes, read through a session this window already holds:
 * names and pids, enough to find a session to close.
 */

/** The panel's view type: what VS Code calls the tab. */
export const SESSIONS_VIEW_TYPE = 'gemdb.sessions';

/** A session this window holds, as the view needs to know it. */
export interface HeldSession {
  serial: number | undefined;
  owner: SessionOwner;
}

/** One row of the table, every field already in words. */
export interface SessionRow {
  id: number;
  /** This window's own label for a session it holds; the published name otherwise. */
  name: string;
  /** What kind of session it is, as far as its name says. */
  kind: string;
  /** This window holds it. */
  mine: boolean;
  user?: string;
  /** Its gem's pid and host. */
  process?: string;
  /** How long since its last begin, commit or abort. */
  viewAge?: string;
  /** Commits made since its view was taken. */
  behind?: number;
  /** It holds the oldest commit record and is behind: garbage collection waits for it. */
  holdingBack: boolean;
  /** Offered a Stop button. */
  stoppable: boolean;
}

/** What the page is sent: the whole table, replacing the last. */
export interface SessionsSnapshot {
  type: 'sessions';
  rows: SessionRow[];
  /** The rows carry DataCurator's detail, not only what the shared cache publishes. */
  detailed: boolean;
  /** Said above the table: why it is empty, or why it is partial. */
  note?: string;
  /** When it was read, as the user's clock says it. */
  takenAt: string;
}

/** A session this window holds, by what it does here. */
const HELD_KINDS: Record<SessionOwner['kind'], string> = {
  extension: 'GemDB Code’s own, for status queries',
  notebook: 'Notebook',
  file: 'Python file',
  shell: 'GemDB Shell',
  stack: 'Saved stack',
};

/**
 * Anyone else's session, by the name it published: GemDB's own tags
 * (`cacheNameFor` in session.ts), the MCP server's gems, and the engine's
 * stock names. First match wins, so a longer prefix goes before a shorter.
 */
const PUBLISHED_KINDS: [prefix: string, kind: string][] = [
  ['GemDB nb ', 'Notebook in another window'],
  ['GemDB py ', 'Python file in another window'],
  ['GemDB run ', 'The gemdb command'],
  ['GemDB Shell', 'GemDB Shell'],
  ['GemDB stack', 'Saved stack in another window'],
  ['GemDB Code', 'Another GemDB Code window'],
  ['McpRouter', 'MCP server'],
  ['McpServer', 'MCP server, for one agent'],
  ['Topaz', 'Topaz'],
];

/** What kind of session another client's is, from the name it published. */
export function describePublished(name: string, system: boolean): string {
  if (system) return 'The database’s own';
  return PUBLISHED_KINDS.find(([prefix]) => name.startsWith(prefix))?.[1] ?? '';
}

function byId(a: SessionRow, b: SessionRow): number {
  return a.id - b.id;
}

/** The table from DataCurator's listing. */
export function rowsFromDescribed(sessions: DatabaseSession[], held: HeldSession[]): SessionRow[] {
  const mine = new Map(held.map((h) => [h.serial, h.owner]));
  const administrative = held
    .filter((h) => h.owner.kind === 'extension')
    .map((h) => h.serial)
    .filter((serial): serial is number => serial !== undefined);
  const stoppable = new Set(stoppableSessions(sessions, administrative).map((s) => s.id));
  return sessions
    .map((s) => {
      const owner = mine.get(s.id);
      return {
        id: s.id,
        name: owner?.label ?? s.name,
        kind: owner ? HELD_KINDS[owner.kind] : describePublished(s.name, s.system),
        mine: owner !== undefined,
        user: s.user,
        process: `${s.pid} on ${s.host}`,
        viewAge: humanDuration(s.viewAgeSeconds * 1000),
        behind: s.behind,
        holdingBack: s.holdsOldest && s.behind > 0,
        stoppable: stoppable.has(s.id),
      };
    })
    .sort(byId);
}

/**
 * The table from the shared cache alone. Only this window's own notebooks and
 * files are offered for stopping: closing those needs no other login, and
 * stopping anything else needs the DataCurator login that just failed.
 */
export function rowsFromPublished(
  published: PublishedSession[],
  held: HeldSession[],
): SessionRow[] {
  const mine = new Map(held.map((h) => [h.serial, h.owner]));
  return published
    .map((s) => {
      const owner = mine.get(s.id);
      return {
        id: s.id,
        name: owner?.label ?? s.name,
        kind: owner ? HELD_KINDS[owner.kind] : describePublished(s.name, false),
        mine: owner !== undefined,
        process: String(s.pid),
        holdingBack: false,
        stoppable: owner !== undefined && owner.kind !== 'extension',
      };
    })
    .sort(byId);
}

/** What the view needs from GemDB and VS Code, passed in so the unit tests can stand in for it. */
export interface SessionsWorld {
  running(): Promise<boolean>;
  /** DataCurator's listing; throws when DataCurator cannot log in or is refused. */
  described(): DatabaseSession[];
  /** The shared cache, through a session this window holds; undefined with none free to ask. */
  published(): PublishedSession[] | undefined;
  held(): HeldSession[];
  /** Ask, then stop; answers whether it was stopped. */
  stop(id: number, label: string): Promise<boolean>;
  createPanel(): vscode.WebviewPanel;
  now(): Date;
}

/** Read the table once. */
export async function takeSnapshot(world: SessionsWorld): Promise<SessionsSnapshot> {
  const takenAt = world.now().toLocaleTimeString();
  if (!(await world.running())) {
    return {
      type: 'sessions',
      rows: [],
      detailed: false,
      note: 'GemDB is not running, so no session is open.',
      takenAt,
    };
  }
  const held = world.held();
  try {
    return {
      type: 'sessions',
      rows: rowsFromDescribed(world.described(), held),
      detailed: true,
      takenAt,
    };
  } catch (e) {
    const why = errorMessage(e);
    log(`Could not list the database's sessions as an administrator: ${why}`);
    const published = world.published();
    if (published === undefined) {
      return {
        type: 'sessions',
        rows: [],
        detailed: false,
        note: `Could not list the database’s sessions: ${why}`,
        takenAt,
      };
    }
    return {
      type: 'sessions',
      rows: rowsFromPublished(published, held),
      detailed: false,
      note:
        'Showing only what every session can see. Users, view ages and stopping other ' +
        `clients’ sessions need an administrator’s login, which failed: ${why}`,
      takenAt,
    };
  }
}

/** The one Sessions tab, while it is open. */
let current: SessionsPanel | undefined;

class SessionsPanel {
  private last: SessionsSnapshot | undefined;
  private reading = false;
  private readAgain = false;

  constructor(
    private readonly world: SessionsWorld,
    readonly panel: vscode.WebviewPanel,
  ) {
    const webview = panel.webview;
    webview.onDidReceiveMessage((message: { type?: unknown; id?: unknown }) => {
      if (message.type === 'ready' || message.type === 'refresh') {
        void this.refresh();
      } else if (message.type === 'stop' && typeof message.id === 'number') {
        void this.stop(message.id);
      }
    });
    panel.onDidDispose(() => {
      if (current === this) current = undefined;
    });
    webview.html = sessionsPage(crypto.randomBytes(16).toString('base64'), webview.cspSource);
  }

  /** Read and send the table; a request made while reading reads once more after. */
  async refresh(): Promise<void> {
    if (this.reading) {
      this.readAgain = true;
      return;
    }
    this.reading = true;
    try {
      do {
        this.readAgain = false;
        void this.panel.webview.postMessage({ type: 'reading' });
        this.last = await takeSnapshot(this.world);
        void this.panel.webview.postMessage(this.last);
      } while (this.readAgain);
    } finally {
      this.reading = false;
    }
  }

  private async stop(id: number): Promise<void> {
    const row = this.last?.rows.find((r) => r.id === id);
    if (!row?.stoppable) return;
    const label = row.name ? `${row.name} (session ${id})` : `session ${id}`;
    if (await this.world.stop(id, label)) await this.refresh();
  }
}

/** Open the Sessions tab, or bring it forward and read it again. */
export function showSessions(world: SessionsWorld): void {
  if (current) {
    current.panel.reveal();
    void current.refresh();
    return;
  }
  current = new SessionsPanel(world, world.createPanel());
}

/** Read the open tab again, if there is one: the database started or stopped. */
export function refreshSessions(): void {
  void current?.refresh();
}

export function vscodeSessionsWorld(hooks: MaintenanceHooks): SessionsWorld {
  return {
    running: isRunningAsync,
    described: databaseSessions,
    published: publishedSessions,
    held: () => windowSessions().map((s) => ({ serial: s.serial, owner: s.owner })),
    stop: (id, label) => askToStopSession(id, label, hooks),
    createPanel: () =>
      vscode.window.createWebviewPanel(
        SESSIONS_VIEW_TYPE,
        'GemDB Sessions',
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          localResourceRoots: [],
        },
      ),
    now: () => new Date(),
  };
}

/**
 * The page: a table it fills from `sessions` messages. Everything a session
 * published reaches it as data and is set as text, never as markup — a
 * notebook's title is part of its session's name.
 */
export function sessionsPage(nonce: string, cspSource: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}'">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GemDB Sessions</title>
  <style nonce="${nonce}">
    body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 0 20px 20px; }
    header { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 14px 0 10px; }
    h1 { font-size: 1.3em; font-weight: 600; margin: 0; }
    #summary { color: var(--vscode-descriptionForeground); flex: 1; }
    button { font: inherit; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: none; padding: 4px 12px; border-radius: 2px; cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); padding: 2px 10px; }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button:disabled { opacity: 0.5; cursor: default; }
    .note { padding: 8px 12px; border-left: 3px solid var(--vscode-editorWarning-foreground); background: var(--vscode-textBlockQuote-background); margin: 0 0 12px; }
    .scroll { overflow-x: auto; }
    table { border-collapse: collapse; width: 100%; }
    th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border)); vertical-align: top; white-space: nowrap; }
    th { font-weight: 600; color: var(--vscode-descriptionForeground); }
    td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
    td.name { white-space: normal; min-width: 12em; }
    .kind { color: var(--vscode-descriptionForeground); font-size: 0.92em; }
    .badge { display: inline-block; margin-left: 6px; padding: 0 6px; border-radius: 8px; font-size: 0.85em; color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); }
    .holding { color: var(--vscode-editorWarning-foreground); font-size: 0.92em; }
    .empty { color: var(--vscode-descriptionForeground); padding: 16px 10px; }
    .reading table { opacity: 0.55; }
    footer { color: var(--vscode-descriptionForeground); font-size: 0.92em; margin-top: 14px; max-width: 60em; }
  </style>
</head>
<body>
  <header>
    <h1>Sessions</h1>
    <span id="summary">Reading…</span>
    <button id="refresh">Refresh</button>
  </header>
  <p class="note" id="note" hidden></p>
  <div class="scroll">
    <table>
      <thead><tr>
        <th class="num">Session</th><th>Name</th><th>User</th><th>Process</th>
        <th class="num">View age</th><th class="num">Behind</th><th></th>
      </tr></thead>
      <tbody id="rows"></tbody>
    </table>
  </div>
  <footer>
    The database allows a limited number of sessions at once, shared by every window, tool and
    agent using it, and its own gems. Reading this list logs in briefly as an administrator, so
    it reads only when this tab opens and when you press Refresh. A session holding back garbage
    collection has an old view: it has not committed or aborted since other sessions committed.
  </footer>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const rows = document.getElementById('rows');
    const summary = document.getElementById('summary');
    const note = document.getElementById('note');
    const refresh = document.getElementById('refresh');

    refresh.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));

    function cell(text, className) {
      const td = document.createElement('td');
      if (className) td.className = className;
      td.textContent = text === undefined || text === '' ? '—' : String(text);
      return td;
    }

    function render(snapshot) {
      document.body.classList.remove('reading');
      refresh.disabled = false;
      const mine = snapshot.rows.filter((r) => r.mine).length;
      const count = snapshot.rows.length;
      summary.textContent = count === 0
        ? 'As of ' + snapshot.takenAt
        : count + (count === 1 ? ' session' : ' sessions') + ' · ' + mine + ' in this window · as of ' + snapshot.takenAt;
      note.hidden = !snapshot.note;
      note.textContent = snapshot.note || '';

      rows.replaceChildren();
      if (count === 0) {
        const tr = document.createElement('tr');
        const td = cell('No sessions to show.', 'empty');
        td.colSpan = 7;
        tr.append(td);
        rows.append(tr);
        return;
      }
      for (const r of snapshot.rows) {
        const tr = document.createElement('tr');
        tr.append(cell(r.id, 'num'));

        const name = document.createElement('td');
        name.className = 'name';
        name.append(document.createTextNode(r.name || '—'));
        if (r.mine) {
          const badge = document.createElement('span');
          badge.className = 'badge';
          badge.textContent = 'this window';
          name.append(badge);
        }
        if (r.kind) {
          const kind = document.createElement('div');
          kind.className = 'kind';
          kind.textContent = r.kind;
          name.append(kind);
        }
        if (r.holdingBack) {
          const holding = document.createElement('div');
          holding.className = 'holding';
          holding.textContent = 'Holding back garbage collection';
          name.append(holding);
        }
        tr.append(name);

        tr.append(cell(r.user));
        tr.append(cell(r.process));
        tr.append(cell(r.viewAge, 'num'));
        tr.append(cell(r.behind === undefined ? undefined : r.behind === 0 ? 'current' : r.behind + (r.behind === 1 ? ' commit' : ' commits'), 'num'));

        const action = document.createElement('td');
        if (r.stoppable) {
          const stop = document.createElement('button');
          stop.className = 'secondary';
          stop.textContent = 'Stop…';
          stop.title = 'Stop this session. Anything it has not committed is lost.';
          stop.addEventListener('click', () => vscode.postMessage({ type: 'stop', id: r.id }));
          action.append(stop);
        }
        tr.append(action);
        rows.append(tr);
      }
    }

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'reading') {
        document.body.classList.add('reading');
        refresh.disabled = true;
      } else if (message.type === 'sessions') {
        render(message);
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}
