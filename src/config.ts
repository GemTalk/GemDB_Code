import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * The database engine version this release of GemDB was built and tested
 * against.
 *
 * Unlike Jasper — which lists the whole download catalog and lets the user
 * choose — GemDB pins one version on purpose. A new developer should not have
 * to know which GemStone releases Grail supports; they should get a
 * combination we have actually run. `gemdb.engineVersion` exists as an escape
 * hatch for our own development against unreleased builds.
 *
 * A 4.0 alpha is what Grail supports: upstream removed 3.7.x outright, and its
 * installers now refuse anything below 4.0. The build matters as well as the
 * version — Grail requires a 4.0 of 2026-07-29 or later, which is what makes
 * an alpha the pin rather than a released 3.7.
 *
 * The version string is the whole of it, the `a3` suffix included: it names the
 * product directory, the download, and the GCI library GemDB loads
 * (`libgcits-4.0.0.a3-64.dylib`).
 *
 * **Do not count on an old alpha staying downloadable.** 4.0.0.Alpha1 was the
 * pin until 2026-09-16, when 4.0.0.a2 replaced it and the Alpha1 directory
 * started answering 404 the same day — so a stale pin here can stop being
 * downloadable on any platform, not merely be old. a2 was still listed beside
 * a3 when a3 arrived on 2026-09-24, so the catalog does not always drop the
 * previous alpha at once, but nothing promises it keeps one either. Note the
 * spelling changed at a2: `Alpha1` to a lowercase `a2`. That is upstream's to
 * choose and nothing here should try to normalise it, but it does mean a
 * version cannot be derived by incrementing the last one.
 */
export const PINNED_ENGINE_VERSION = '4.0.0.a3';

/**
 * GemDB manages exactly one database, with fixed names. Hiding the naming is
 * most of what separates this extension from Jasper: there is no database
 * list, no stone picker, and nothing to name.
 *
 * The NetLDI is deliberately NOT called `gs64ldi`, the conventional name that
 * `/etc/services` maps to port 50377. A developer who also runs Jasper very
 * likely has a `gs64ldi` already, and two NetLDIs cannot share a name. Ours
 * takes whatever port it is given; callers that need the port read it back
 * from `gslist` (see processes.ts).
 */
export const STONE_NAME = 'gemdb';
export const NETLDI_NAME = 'gemdbldi';
export const DB_DIR_NAME = 'db';

/** The stock account on a fresh extent. GemDB never asks the user for it. */
export const DB_USER = 'DataCurator';
export const DB_PASSWORD = 'swordfish';

/** Minimum shared memory the engine needs, in GB, for both shmmax and shmall. */
export const REQUIRED_SHARED_MEMORY_GB = 1;

/**
 * How long `stopstone` waits for the stone to go down and release its shared
 * memory. Its own default is -1 — wait forever — which turns a stone that
 * accepts a stop but cannot finish it into a progress notification that never
 * ends. A bounded wait makes that a failure GemDB can report and offer to
 * override instead.
 */
export const STOP_TIMEOUT_SECONDS = 10;

/** Resolved engine version: the user's override if set, otherwise the pin. */
export function engineVersion(): string {
  const override = vscode.workspace
    .getConfiguration('gemdb')
    .get<string>('engineVersion', '')
    .trim();
  return override || PINNED_ENGINE_VERSION;
}

/** True when the user has overridden the pinned version. */
export function isEngineVersionOverridden(): boolean {
  return engineVersion() !== PINNED_ENGINE_VERSION;
}

/**
 * Everything GemDB creates lives under one directory.
 *
 * The default is `~/GemDB`, not `~/Documents/GemDB`: on macOS `~/Documents` is
 * commonly synced to iCloud Drive, and letting a sync daemon copy a live
 * database extent out from under the engine corrupts it.
 *
 * Every `gemdb.*` setting is `"scope": "machine"` in package.json, because each
 * one configures the machine's one database or its one MCP router, not a
 * folder. Three things follow. A repository's `.vscode/settings.json` cannot
 * set them — which matters most here, since uninstall deletes under this path
 * and a cloned repository must not get to choose where that is. Settings Sync
 * does not carry them to another machine, whose database is another database.
 * And in a remote window they are read from the remote's settings, where the
 * database is, rather than from the laptop's.
 */
export function rootPath(): string {
  const raw = vscode.workspace.getConfiguration('gemdb').get<string>('rootPath', '~/GemDB');
  return path.resolve(raw.replace(/^~(?=$|\/)/, os.homedir()));
}

export function reinstallPythonOnUpdate(): boolean {
  return vscode.workspace.getConfiguration('gemdb').get<boolean>('reinstallPythonOnUpdate', true);
}

/**
 * The port the bundled MCP server listens on, and why it is not 8000.
 *
 * The MCP server's own `run-server.sh` defaults to 8000, which is the right
 * default for a script a developer runs deliberately and the wrong one for
 * something GemDB starts on its own: 8000 is what Django, `python -m
 * http.server` and half of every developer's side projects bind, and the
 * router refuses a port that is already served. A port nobody else defaults to
 * costs nothing and never collides. 50390 sits just past the range the engine
 * uses for its own listeners (the conventional NetLDI port is 50377), so it
 * reads as "this belongs to the database" to anyone looking at `lsof`.
 *
 * Fixed rather than auto-selected on purpose. Every client outside VS Code is
 * registered by writing a literal URL into a configuration file the user owns,
 * so a port that moved between runs would silently break every one of them.
 */
export const DEFAULT_MCP_PORT = 50390;

/**
 * Whether GemDB installs and runs the MCP server at all.
 *
 * **Off by default, and that is a retreat from a measured failure rather than
 * caution.** The MCP server gives each connected client its own worker gem,
 * and nothing releases one when a client goes away without saying so: only a
 * `DELETE /mcp`, the router's thirty-minute idle reaper, or the router ending.
 * Reconnecting counts as a new client, so reloading a window or restarting an
 * agent leaves a gem behind each time — and against the Community Edition's
 * ten sessions, eight of those inside half an hour locks the user out of
 * their own database with GemStone error 4039. Measured on 2026-09-07: nine
 * `initialize` calls exhausted a real database and plain `topaz` could not
 * log in either.
 *
 * The fix belongs in the router, which is the only component that knows how
 * many gems it has opened: a cap on concurrent workers, and an idle timeout a
 * ten-session database can turn down. Until that exists, a user who asks for
 * this gets it and everyone else is left alone — the cost of the default being
 * wrong in this direction is a setting to flip, and in the other direction it
 * is losing access to your own data.
 *
 * See `docs/mcp-server.md`, "The session leak, found by running it".
 */
export function mcpEnabled(): boolean {
  return vscode.workspace.getConfiguration('gemdb').get<boolean>('mcp.enabled', false);
}

export function mcpPort(): number {
  const port = vscode.workspace.getConfiguration('gemdb').get<number>('mcp.port', DEFAULT_MCP_PORT);
  // A setting is whatever the user typed into settings.json, including 0, -1 or
  // 99999. Fall back rather than fork a router that cannot bind.
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_MCP_PORT;
}

/**
 * Whether the server hides and refuses every state-changing tool.
 *
 * Off by default. The tools that matter here run Python and Smalltalk in the
 * database and commit the result, which is the entire reason to point an agent
 * at GemDB; a read-only server can browse and search a database the user could
 * already browse in a notebook. It is the user's own local database on their
 * own machine, and the switch is here for whoever wants the narrower surface.
 */
export function mcpReadOnly(): boolean {
  return vscode.workspace.getConfiguration('gemdb').get<boolean>('mcp.readOnly', false);
}
