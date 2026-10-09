import { abortIdleSessionsAfterMinutes, externalDatabase } from './config';
import { assertSafeToStart } from './database';
import { errorMessage } from './log';
import {
  ensureProcesses,
  externalDatabaseDownError,
  findNetldi,
  findStone,
  listProcesses,
} from './processes';
import { PyRepl, ReplSession } from './pyRepl';
import { runPythonInSession } from './pythonQueries';
import { GciSession, setInputHandler } from './session';

/**
 * The GemDB Shell as a process: what `gemdb` with no arguments runs.
 *
 * Bundled by esbuild to `out/gemdb-shell.js` (with the `vscode` module
 * replaced by `cliVscode.ts` — settings from the environment instead of the
 * editor), staged to `<rootPath>/bin` beside the wrapper, and started by the
 * wrapper under the editor's own Node runtime. The editor's "Open GemDB Shell"
 * opens a terminal running the wrapper, so this file is the shell everywhere.
 *
 * Everything interesting lives in `PyRepl`; this file is only the plumbing a
 * real process needs — a raw-mode tty wired to `handleInput`, and a database
 * brought up before the first prompt. Raw mode also means Ctrl+C arrives as a
 * byte on stdin rather than as SIGINT, which is the point: the byte interrupts
 * the running Python instead of killing the shell.
 */

/**
 * Bring the database up, the same judgement the wrapper makes for a file run:
 * asking for the shell is asking for a running database. Unlike the wrapper's
 * file mode — a linked gem, needing only the stone — a shell session arrives
 * through the listener, so both are ensured. Both go through
 * `ensureProcesses`, the same locked path the window takes, so a Shell opened while a window is
 * starting the database waits for it rather than racing it. The stone gets the
 * window's pre-start guards too, all but statmonitor, whose configuration
 * comes from editor settings the Shell does not have: `system.conf` keeps
 * whatever the window's last start wrote.
 *
 * An external database is only checked, as the window checks it: GemDB starts
 * none of it. Errors are reported rather than thrown: the shell prompt (or the
 * exit code) is the caller's answer.
 */
async function ensureDatabase(): Promise<boolean> {
  try {
    const external = externalDatabase();
    if (external) {
      const running = listProcesses();
      if (!findStone(running) || !findNetldi(running)) throw externalDatabaseDownError(external);
    } else {
      await ensureProcesses({
        beforeStoneStart: assertSafeToStart,
        report: (message) =>
          process.stderr.write(`gemdb: ${message.charAt(0).toLowerCase()}${message.slice(1)}\r\n`),
      });
    }
    return true;
  } catch (e) {
    // Raw mode may be on by now, so bare `\n` would stairstep the message.
    process.stderr.write(`gemdb: ${errorMessage(e).replace(/\n/g, '\r\n')}\r\n`);
    return false;
  }
}

/**
 * How often the shell checks whether its session has been idle long enough to
 * refresh. The setting is in minutes, so a minute is fine-grained enough.
 */
const IDLE_CHECK_MS = 60_000;

/** A fresh session of this shell's own, shaped the way the loop wants it. */
function login(): ReplSession {
  const session = GciSession.login('shell');
  // A shell left at its prompt holds the commit record its view was taken
  // from, exactly as an idle notebook does, so it gets the same treatment:
  // aborted once idle, and only when that loses nothing. See
  // `GciSession.abortIfClean` and maintenance.ts.
  const idleAfterMs = abortIdleSessionsAfterMinutes() * 60_000;
  const idleCheck =
    idleAfterMs > 0
      ? setInterval(() => {
          if (!session.connected || session.idleMs < idleAfterMs) return;
          try {
            session.abortIfClean();
          } catch {
            /* the prompt reports a dead session at the next statement */
          }
        }, IDLE_CHECK_MS)
      : undefined;
  // Never what keeps the process alive.
  idleCheck?.unref();
  return {
    get connected(): boolean {
      return session.connected;
    },
    run: (source: string, onOutput: (text: string) => void) =>
      runPythonInSession(session, source, 'repl', onOutput),
    interrupt: () => session.interrupt(),
    logout: () => {
      clearInterval(idleCheck);
      session.logout();
    },
  };
}

async function main(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(
      'gemdb: the GemDB Shell needs a terminal. To run a program, pass a file, -m, or -c.\n',
    );
    process.exit(1);
  }
  if (!(await ensureDatabase())) process.exit(1);

  const repl = new PyRepl({
    write: (text) => process.stdout.write(text),
    close: (code = 0) => shutdown(code),
    ensureRunning: ensureDatabase,
    login,
  });

  // Python's input() reads this same tty, through the same line editor as the
  // prompt. Ctrl+C during the read is handled right there (the REPL answers
  // it as an interrupt), so the session never needs to cancel from outside.
  setInputHandler((request) => repl.readLine(request.prompt));

  function shutdown(code: number): never {
    try {
      process.stdin.setRawMode(false);
    } catch {
      /* the tty may already be gone */
    }
    repl.dispose();
    process.exit(code);
  }

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (data: string) => repl.handleInput(data));
  // Ctrl+C never arrives as a signal in raw mode; these are the window (or
  // machine) going away, and the logout in shutdown is the courtesy of not
  // leaving the stone a dead session to time out.
  process.on('SIGTERM', () => shutdown(1));
  process.on('SIGHUP', () => shutdown(1));

  repl.open();
}

void main();
