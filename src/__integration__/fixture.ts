import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { __setSetting } from '../__mocks__/vscode';
import { createDatabase } from '../database';
import { ensureRootPath, expectedEnginePath, extentPath } from '../paths';

/**
 * A database of GemDB's own making, in a directory of its own, on the real
 * engine.
 *
 * Isolation is not a courtesy here — these tests start and stop processes that
 * outlive the test runner, and the developer running them almost certainly has
 * their own GemDB, and probably Jasper's databases, running at the same time.
 * Two things keep them apart:
 *
 *   `gemdb.rootPath` points at a temporary directory, which is read through
 *   the same mocked setting the unit tests use. Everything derived from it —
 *   the database, the logs, the lock directory — follows.
 *
 *   `engineEnvironment` sets GEMSTONE_GLOBAL_DIR to that root path, and that
 *   is the directory the engine keeps its lock files in and `gslist` reads.
 *   So a stone started here is invisible to a `gslist` run anywhere else, and
 *   every other stone on the machine is invisible to this one. The fixed names
 *   in config.ts cannot collide with a real GemDB for the same reason.
 *
 * The engine itself is not copied. It is 700 MB and read-only, and download and
 * extraction are deliberately outside what these tests cover, so the fixture
 * symlinks whatever engine is already installed. Removing the fixture unlinks
 * the symlink without touching what it points at.
 */

/** Where to borrow an engine from, overridable for a machine that keeps it elsewhere. */
function sourceEngine(engineDirName: string): string {
  return process.env.GEMDB_TEST_ENGINE ?? path.join(os.homedir(), 'GemDB', engineDirName);
}

export interface Fixture {
  root: string;
  engine: string;
  remove: () => void;
}

/**
 * Point GemDB at a fresh root path with the engine linked in.
 *
 * Returns undefined when there is no engine to borrow, which is the one
 * condition these tests cannot work around — the caller skips rather than
 * fails, so a checkout without a local install still has a green suite.
 */
export function makeFixture(): Fixture | undefined {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdb-it-'));

  // Set the root path first: every path below is derived from it.
  __setSetting('gemdb.rootPath', root);

  const target = expectedEnginePath();
  const source = sourceEngine(path.basename(target));
  if (!fs.existsSync(path.join(source, 'sys', 'stoned'))) {
    fs.rmSync(root, { recursive: true, force: true });
    return undefined;
  }

  fs.symlinkSync(source, target);
  ensureRootPath();

  return {
    root,
    engine: target,
    // rmSync does not follow symlinks, so this unlinks the engine rather than
    // deleting the 700 MB it points at. Worth stating, because getting it wrong
    // would delete the developer's engine.
    remove: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * The extent the suite starts from when a test needs Python but is not testing
 * the file-in.
 *
 * Built by `npm run test:extent`, which creates a scratch database, files
 * Grail into it and leaves the result at `.test-extent/gemdb.dbf`. It is a
 * TEST artifact and nothing else: GemDB ships no extent, because every user's
 * database is theirs and keeps whatever they put in it — Grail and the MCP
 * server are installed INTO it and upgraded in place, which is the only way an
 * update can reach a database that already holds data. What that costs is
 * several minutes of topaz per file-in, and paying it once per suite rather
 * than once per test file is what this is for.
 *
 * `grail.test.ts` deliberately does not use it: filing Grail into a stock
 * extent is exactly what that file tests, and it is the path every real
 * install takes.
 */
export function testExtentPath(): string {
  return path.join(process.cwd(), '.test-extent', 'gemdb.dbf');
}

/** True when `npm run test:extent` has been run in this checkout. */
export function haveTestExtent(): boolean {
  return fs.existsSync(testExtentPath());
}

/**
 * Create the fixture's database from the prepared extent, so Python is there
 * without a file-in. Mirrors what `createDatabase` does for a user, then
 * swaps the stock extent for the prepared one.
 */
export function createDatabaseWithPython(fixture: Fixture): void {
  createDatabase(fixture.engine);
  fs.copyFileSync(testExtentPath(), extentPath());
  fs.chmodSync(extentPath(), 0o644);
}
