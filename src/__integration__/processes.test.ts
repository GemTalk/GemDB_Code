import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { createDatabase } from '../database';
import { isSharedMemoryConfigured } from '../osConfig';
import {
  isListening,
  isRunning,
  listProcesses,
  startStone,
  stopNetldi,
  stopStone,
} from '../processes';
import { Fixture, limitTestDatabase, makeFixture } from './fixture';

/**
 * Two processes starting one database at the same moment.
 *
 * Two windows opened together, or a window and a GemDB Shell, both find the
 * database down and both start it. Checked and started outside a lock, both
 * ran `startnetldi`, and the loser reported a failure over a database that was
 * up (#89). The lock that closes that race keeps separate processes apart, so
 * an in-process test cannot exercise it: these bundle processContender.ts the
 * way lock.test.ts bundles its contender, and race real node processes against
 * a real engine.
 *
 * No Python is needed, so the database is the engine's own extent and the
 * file skips on a missing engine alone.
 */

interface Report {
  mode: 'ensure' | 'raw-netldi';
  pid: number;
  startedStone?: boolean;
  startedNetldi?: boolean;
  code?: number | null;
  output?: string;
  error?: string;
}

let fixture: Fixture | undefined;
let bundleDir: string | undefined;
let bundle = '';

beforeAll(async () => {
  fixture = makeFixture();
  if (!fixture) return;
  if (!(await isSharedMemoryConfigured())) {
    throw new Error(
      'Shared memory is below what the engine needs. Run "GemDB: Configure Shared Memory" ' +
        'in the editor, or resources/setSharedMemoryDarwin.sh, before running these tests.',
    );
  }
  createDatabase(fixture.engine);
  limitTestDatabase();

  bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdb-contender-'));
  bundle = path.join(bundleDir, 'processContender.cjs');
  await esbuild.build({
    entryPoints: [path.join(__dirname, 'fixtures', 'processContender.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle,
    logLevel: 'silent',
    alias: { vscode: path.join(__dirname, '..', 'cliVscode.ts') },
  });
});

afterAll(async () => {
  if (bundleDir) fs.rmSync(bundleDir, { recursive: true, force: true });
  if (!fixture) return;
  try {
    if (isListening()) await stopNetldi();
    if (isRunning()) await stopStone(true);
  } finally {
    fixture.remove();
  }
});

/** See database.test.ts — skipIf is evaluated during collection. */
function canMakeFixture(): boolean {
  const probe = makeFixture();
  if (!probe) return false;
  probe.remove();
  return true;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Start one contender per mode, release them together, and return what each
 * reported. A contender's log goes to a file beside the report, and a
 * contender that exits non-zero rejects with that log, which is the only
 * account of what it did.
 */
async function race(
  modes: Report['mode'][],
  opts: { rawWaitsForRival?: boolean } = {},
): Promise<Report[]> {
  const root = fixture!.root;
  const dir = fs.mkdtempSync(path.join(root, 'race-'));
  const ready = path.join(dir, 'ready');
  const go = path.join(dir, 'go');
  const reportFile = path.join(dir, 'report');
  fs.writeFileSync(ready, '');
  const logFile = (i: number): string => path.join(dir, `contender-${i}.log`);
  const rivalLog = logFile(modes.indexOf('ensure'));
  const exits = modes.map(
    (mode, i) =>
      new Promise<void>((resolve, reject) => {
        const log = logFile(i);
        const waitFor = mode === 'raw-netldi' && opts.rawWaitsForRival ? [rivalLog] : [];
        const child = execFile(
          process.execPath,
          [bundle, mode, ready, go, reportFile, ...waitFor],
          { env: { ...process.env, GEMDB_ROOT_PATH: root, GEMDB_SHELL_LOG: log } },
          (error, _stdout, stderr) => {
            if (!error) return resolve();
            const logged = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
            reject(new Error(`${mode} contender failed: ${stderr || String(error)}\n${logged}`));
          },
        );
        child.on('error', reject);
      }),
  );

  // Release only once both are parked at the starting line, or the first
  // would be done before the second had started.
  const deadline = Date.now() + 20_000;
  while (fs.readFileSync(ready, 'utf8').split('\n').filter(Boolean).length < modes.length) {
    if (Date.now() > deadline) throw new Error('contenders never got ready');
    await sleep(10);
  }
  fs.writeFileSync(go, '');
  await Promise.all(exits);

  return fs
    .readFileSync(reportFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Report);
}

/** What `gslist` lists, reduced to what the end state is judged on. */
function listed(): { type: string; status: string }[] {
  return listProcesses().map((p) => ({ type: p.type, status: p.status }));
}

describe.skipIf(!canMakeFixture())('starting the database from two processes at once', () => {
  it('starts one stone and one session listener, and neither process fails', async () => {
    const reports = await race(['ensure', 'ensure']);

    expect(reports.filter((r) => r.error)).toEqual([]);
    expect(reports).toHaveLength(2);
    expect(reports.filter((r) => r.startedStone)).toHaveLength(1);
    expect(listed()).toEqual(
      expect.arrayContaining([
        { type: 'stone', status: 'OK' },
        { type: 'netldi', status: 'OK' },
      ]),
    );
    expect(listed()).toHaveLength(2);
  });

  it('does not fail when a release that takes no lock starts the session listener alongside', async () => {
    if (isListening()) await stopNetldi();
    await startStone();
    expect(isListening()).toBe(false);

    const reports = await race(['raw-netldi', 'ensure'], { rawWaitsForRival: true });

    const ensured = reports.find((r) => r.mode === 'ensure');
    expect(ensured).toBeDefined();
    expect(ensured?.error).toBeUndefined();
    expect(ensured?.startedStone).toBe(false);
    expect(reports.find((r) => r.mode === 'raw-netldi')?.error).toBeUndefined();
    expect(listed()).toEqual(
      expect.arrayContaining([
        { type: 'stone', status: 'OK' },
        { type: 'netldi', status: 'OK' },
      ]),
    );
    expect(listed()).toHaveLength(2);
  });
});
