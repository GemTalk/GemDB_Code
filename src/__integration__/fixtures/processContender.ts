import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { NETLDI_NAME } from '../../config';
import { databaseLogPath } from '../../paths';
import { engineEnvironment, ensureProcesses } from '../../processes';

/**
 * One process starting the database, run as a process of its own.
 *
 * processes.test.ts bundles this with the same `vscode` alias the shell bundle
 * uses and starts two at once, because the race it covers is between
 * processes: two windows, or a window and a GemDB Shell, that both find the
 * database down. The root path arrives as GEMDB_ROOT_PATH, as it does for the
 * real wrapper.
 *
 *   argv: <ensure|raw-netldi> <ready file> <go file> <report file> [rival log]
 *
 * `ensure` is what every start does today. `raw-netldi` is what GemDB 1.6.0
 * did: `startnetldi` with no lock and no look first (#89).
 *
 * It says it is ready, waits for the go file so both start at the same
 * moment, then appends one line saying what happened to the report.
 *
 * Released together, the raw `startnetldi` finishes before the other process
 * has taken the lock and looked, so that one finds the listener up and the
 * two never collide. Given a rival's log, the raw one waits after the go file
 * until the rival logs its own `startnetldi`, so both commands run at once.
 */
const [mode, readyFile, goFile, reportFile, rivalLog] = process.argv.slice(2);
const me = process.pid;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const report = (line: string): void => fs.appendFileSync(reportFile, `${line}\n`);

/** `startnetldi` exactly as 1.6.0 ran it; resolves with its exit code and output. */
function rawStartNetldi(): Promise<{ code: number | null; output: string }> {
  const env = engineEnvironment();
  return new Promise((resolve, reject) => {
    const child = spawn(
      path.join(env.GEMSTONE, 'bin', 'startnetldi'),
      [
        '-a',
        os.userInfo().username,
        '-g',
        '-l',
        path.join(databaseLogPath(), `${NETLDI_NAME}.log`),
        NETLDI_NAME,
      ],
      { env: { ...process.env, ...env } },
    );
    let output = '';
    child.stdout.on('data', (data: Buffer) => (output += data.toString()));
    child.stderr.on('data', (data: Buffer) => (output += data.toString()));
    child.on('close', (code) => resolve({ code, output }));
    child.on('error', reject);
  });
}

/** Wait until the rival logs that it is running `startnetldi`, or give up after a while. */
async function rivalStartsNetldi(log: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('$ startnetldi')) return;
    await sleep(2);
  }
}

async function main(): Promise<void> {
  fs.appendFileSync(readyFile, `${me}\n`);
  while (!fs.existsSync(goFile)) await sleep(2);
  if (rivalLog) await rivalStartsNetldi(rivalLog);

  if (mode === 'ensure') {
    const started = await ensureProcesses();
    report(JSON.stringify({ mode, pid: me, ...started }));
  } else {
    const { code, output } = await rawStartNetldi();
    report(JSON.stringify({ mode, pid: me, code, output: output.trim() }));
  }
}

main().catch((e: unknown) => {
  report(JSON.stringify({ mode, pid: me, error: String(e) }));
  process.exitCode = 1;
});
