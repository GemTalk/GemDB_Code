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
 * 3.7.5 is the newest version published in the public download catalog.
 * Grail installs onto it through its `install_base37.gs` path.
 */
export const PINNED_ENGINE_VERSION = '3.7.5';

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
 */
export function rootPath(): string {
  const raw = vscode.workspace.getConfiguration('gemdb').get<string>('rootPath', '~/GemDB');
  return path.resolve(raw.replace(/^~(?=$|\/)/, os.homedir()));
}

export function reinstallPythonOnUpdate(): boolean {
  return vscode.workspace.getConfiguration('gemdb').get<boolean>('reinstallPythonOnUpdate', true);
}
