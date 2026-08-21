import { LineEditor } from './lineEditor';
import { log } from './log';
import { PyResult, isErrorResult } from './pythonQueries';
import { InputAnswer, SessionError } from './session';

/**
 * The GemDB Shell: the REPL loop between a terminal and a database session.
 *
 * Named `pyRepl`/`PyRepl` internally; "GemDB Shell" is what the user sees, and
 * the only name that appears in commands, terminals, and docs.
 *
 * This class is deliberately host-agnostic — bytes in through `handleInput`,
 * text out through `world.write` — for the same reason `lineEditor.ts` is
 * pure: the loop is where the decisions live (the continuation rule, exit(),
 * type-ahead, KeyboardInterrupt), so it is the part worth unit-testing without
 * a terminal attached. Its one production host is `cliMain.ts`, the `gemdb`
 * command: the editor's "Open GemDB Shell" opens a terminal running that same
 * command, so there is exactly one REPL, not an in-editor one and a lesser
 * command-line one.
 *
 * Two earlier shells are worth remembering. The first drove Grail's topaz
 * script in an ordinary terminal, which meant living with topaz: Ctrl+C
 * dropped the user into a Smalltalk debugger, and an uncaught Python error
 * left them at a `topaz 1>` prompt. The second ran this loop inside the
 * extension host as a `vscode.Pseudoterminal`; it behaved correctly, but every
 * shell then shared the extension host's process — a wedged FFI call degraded
 * the whole window — and the `gemdb` command in a plain terminal was still the
 * topaz handoff. Running the loop in its own process fixed both at once.
 *
 * Every shell is its own database session. That is not an implementation
 * shortcut — it is the demonstration: open two and you have two concurrent
 * sessions with separate uncommitted state, visible to each other exactly at
 * commit boundaries.
 */

const BANNER =
  'GemDB Shell — Python inside the database. This terminal is its own session.\r\n' +
  'Ctrl+C interrupts · exit() or Ctrl+D leaves\r\n';

/** The slice of a `GciSession` the loop needs, shaped for a fake to stand in. */
export interface ReplSession {
  readonly connected: boolean;
  /**
   * Run one Python statement and report what it printed and produced. What it
   * prints while running streams through `onOutput` (and then comes back with
   * an empty `output`); a session that cannot stream buffers it into `output`
   * instead, and the loop shows either correctly.
   */
  run(source: string, onOutput: (text: string) => void): Promise<PyResult>;
  interrupt(): void;
  logout(): void;
}

/**
 * Everything outside the loop, taken as an argument the way `runStop` takes
 * its `StopWorld` — so the branches below are testable without a terminal, a
 * process, or a database.
 */
export interface ReplWorld {
  /** Show the user some text. `\r\n` line endings — the terminal is raw. */
  write(text: string): void;
  /** The user asked to leave (exit() or Ctrl+D): tear the host down. */
  close(): void;
  /** Bring the database up, or explain why not; false suppresses the retry. */
  ensureRunning(): Promise<boolean>;
  /** Log a fresh session in; throws a `SessionError` saying why it cannot. */
  login(): ReplSession;
}

export class PyRepl {
  private readonly editor = new LineEditor('>>> ');
  private session: ReplSession | undefined;
  /** Lines gathered so far of a multi-line statement. */
  private pending: string[] = [];
  private continuing = false;
  private running = false;
  /** Input that arrived while Python was running, replayed afterwards. */
  private typeahead = '';
  /** A read the running Python asked for — input() — taking the keys for now. */
  private reading: { editor: LineEditor; resolve: (answer: InputAnswer) => void } | undefined;
  private closed = false;

  constructor(private readonly world: ReplWorld) {}

  open(): void {
    this.world.write(BANNER);
    try {
      this.session = this.world.login();
    } catch (e) {
      // The prompt appears even though the login failed, so the message has
      // somewhere to be read; the next Enter retries via ensureSession.
      this.world.write(`${message(e)}\r\n`);
    }
    this.world.write(this.editor.beginLine());
  }

  /** The host is going away; log out. Safe to call twice. */
  dispose(): void {
    this.closed = true;
    this.finishRead({ eof: true }); // never leave the gem waiting on a dead tty
    this.session?.logout();
    this.session = undefined;
  }

  /**
   * Read one line for the running Python — this is input(), arriving through
   * the session's stdin provider. The prompt is written here (over an RPC
   * session the gem's own output is captured until the evaluation ends, which
   * is exactly why the provider gets the prompt), a fresh line editor takes
   * the keys, and whatever was typed ahead is replayed into it first — the
   * user may well have typed the answer already.
   */
  readLine(prompt: string): Promise<InputAnswer> {
    return new Promise((resolve) => {
      this.world.write(prompt.replace(/\n/g, '\r\n'));
      this.reading = { editor: new LineEditor(''), resolve };
      this.world.write(this.reading.editor.beginLine());
      const replay = this.typeahead;
      this.typeahead = '';
      if (replay) this.handleInput(replay);
    });
  }

  /** Settle the pending input() read, if any. Safe to call when there is none. */
  private finishRead(answer: InputAnswer): void {
    const read = this.reading;
    if (!read) return;
    this.reading = undefined;
    read.resolve(answer);
  }

  handleInput(data: string): void {
    if (this.reading) {
      for (const event of this.reading.editor.feed(data)) {
        switch (event.kind) {
          case 'echo':
            this.world.write(event.text);
            break;
          case 'submit':
            this.finishRead({ line: event.line });
            return;
          case 'interrupt':
            // The editor has echoed ^C; the gem raises KeyboardInterrupt at
            // the input() call, so the display comes back the Python way.
            this.finishRead({ interrupt: true });
            return;
          case 'eof':
            this.world.write('\r\n');
            this.finishRead({ eof: true });
            return;
        }
      }
      return;
    }

    if (this.running) {
      // Ctrl+C must act *now* — interrupting the running code is its whole
      // point. Everything else is type-ahead, replayed once the prompt is back.
      if (data.includes('\u0003')) {
        this.typeahead = '';
        this.session?.interrupt();
        return;
      }
      this.typeahead += data;
      return;
    }

    for (const event of this.editor.feed(data)) {
      switch (event.kind) {
        case 'echo':
          this.world.write(event.text);
          break;
        case 'submit':
          void this.onLine(event.line);
          return; // onLine repaints the prompt and replays type-ahead
        case 'interrupt':
          // At a quiet prompt, ^C abandons the line — and any half-built
          // multi-line statement — exactly as CPython does.
          this.pending = [];
          this.continuing = false;
          this.world.write(this.prompt());
          break;
        case 'eof':
          this.world.write('\r\n');
          this.world.close();
          return;
      }
    }
  }

  /**
   * One submitted line. The continuation rule is grail.tpz's own, verbatim: a
   * non-empty line ending in `:` opens a block, and the block keeps growing
   * until an empty line closes it.
   */
  private async onLine(line: string): Promise<void> {
    this.pending.push(line);
    const trimmed = line.trimEnd();
    this.continuing = trimmed !== '' && (this.continuing || trimmed.endsWith(':'));

    if (this.continuing) {
      this.finishTurn();
      return;
    }

    const source = this.pending.join('\n');
    this.pending = [];
    if (source.trim() === '') {
      this.finishTurn();
      return;
    }
    if (/^\s*(exit|quit)\(\)\s*$/.test(source)) {
      this.world.close();
      return;
    }

    this.running = true;
    try {
      const result = await this.evaluate(source);
      if (result) this.show(result);
    } finally {
      this.running = false;
    }
    this.finishTurn();
  }

  /** Run one statement, reviving the session first if it has died under us. */
  private async evaluate(source: string): Promise<PyResult | undefined> {
    try {
      const session = await this.ensureSession();
      if (!session) return undefined;
      // print() arrives here chunk by chunk while the code runs; the terminal
      // is raw, so bare newlines must become \r\n on the way through.
      return await session.run(source, (text) => this.world.write(text.replace(/\n/g, '\r\n')));
    } catch (e) {
      this.world.write(`${message(e)}\r\n`);
      return undefined;
    }
  }

  /**
   * The session this shell runs in, brought back to life if need be.
   *
   * "Need be" is real: stopping the database logs every shell out. Typing into
   * one afterwards is a request for a running database, so the world is asked
   * to bring it up before the login is retried.
   */
  private async ensureSession(): Promise<ReplSession | undefined> {
    if (this.session?.connected) return this.session;
    if (!(await this.world.ensureRunning())) {
      this.world.write('GemDB is not running, so this could not be evaluated.\r\n');
      return undefined;
    }
    try {
      this.session = this.world.login();
      return this.session;
    } catch (e) {
      this.world.write(`${message(e)}\r\n`);
      return undefined;
    }
  }

  private show(result: PyResult): void {
    if (result.output) {
      this.world.write(result.output.replace(/\n/g, '\r\n'));
    }
    const value = result.value;
    if (!value) return;
    // Two spellings of the same event, one answer. A break sent mid-execution
    // comes back as the gem's own words ("a soft break was received"); a
    // cancelled input() comes back as the KeyboardInterrupt Grail raised. The
    // user caused both; report them the way Python does. Anchored to the
    // error's own class name and the break phrasing so a user's error that
    // merely *mentions* interrupting is not swallowed.
    if (isErrorResult(value) && /^Error: KeyboardInterrupt\b|\b(soft|hard) break\b/i.test(value)) {
      this.world.write('KeyboardInterrupt\r\n');
      return;
    }
    this.world.write(`${value.replace(/\n/g, '\r\n')}\r\n`);
  }

  /** Repaint the prompt, then replay whatever was typed while Python ran. */
  private finishTurn(): void {
    if (this.closed) return;
    this.editor.setPrompt(this.prompt());
    this.world.write(this.editor.beginLine());
    const replay = this.typeahead;
    this.typeahead = '';
    if (replay) this.handleInput(replay);
  }

  private prompt(): string {
    return this.continuing ? '... ' : '>>> ';
  }
}

function message(e: unknown): string {
  if (e instanceof SessionError) return e.message;
  const text = e instanceof Error ? e.message : String(e);
  log(`REPL error: ${text}`);
  return text;
}
