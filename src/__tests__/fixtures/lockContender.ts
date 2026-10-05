import * as fs from 'fs';
import * as path from 'path';
import { STONE_LOCK_NAME, withSetupLock, withStoneLock } from '../../lock';

/**
 * One contender for a lock, run as a process of its own.
 *
 * lock.test.ts bundles this with the same `vscode` alias the shell bundle uses
 * and starts several at once: the locks exist to keep separate processes apart,
 * and an in-process test cannot tell a lock from a flag in memory. The root
 * path arrives as GEMDB_ROOT_PATH, as it does for the real wrapper.
 *
 *   argv: <setup|stone> <ready file> <go file> <report file> <hold ms>
 *
 * It says it is ready, waits for the go file so every contender starts at the
 * same moment, then takes the lock and appends what happened to the report.
 */
const [mode, readyFile, goFile, reportFile, holdArg] = process.argv.slice(2);
const holdMs = Number(holdArg);
const me = process.pid;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const report = (line: string): void => fs.appendFileSync(reportFile, `${line}\n`);

async function main(): Promise<void> {
  fs.appendFileSync(readyFile, `${me}\n`);
  while (!fs.existsSync(goFile)) await sleep(2);

  const root = process.env.GEMDB_ROOT_PATH ?? '';
  if (mode === 'setup') {
    const lock = path.join(root, '.gemdb-setup.lock');
    const result = await withSetupLock(async () => {
      const inode = fs.statSync(lock).ino;
      await sleep(holdMs);
      // A loser that deleted this lock would show up here as a changed pid or
      // inode, or no file at all.
      const intact =
        fs.readFileSync(lock, 'utf8').trim() === String(me) && fs.statSync(lock).ino === inode;
      report(`won ${me} ${intact ? 'intact' : 'broken'}`);
      return true;
    });
    if (result === undefined) report(`lost ${me}`);
  } else {
    const lock = path.join(root, STONE_LOCK_NAME);
    await withStoneLock(
      async () => {
        report(`start ${me}`);
        await sleep(holdMs);
        const intact = fs.readFileSync(path.join(lock, 'pid'), 'utf8').trim() === String(me);
        report(`end ${me} ${intact ? 'intact' : 'broken'}`);
      },
      { pollMs: 10, timeoutMs: 20_000 },
    );
  }
}

main().catch((e: unknown) => {
  report(`error ${me} ${String(e)}`);
  process.exitCode = 1;
});
