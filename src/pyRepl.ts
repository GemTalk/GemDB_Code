import * as vscode from 'vscode';
import { ensureRunning } from './lifecycle';
import { LineEditor } from './lineEditor';
import { log } from './log';
import { PyResult, isErrorResult, runPythonInSession } from './pythonQueries';
import { GciSession, SessionError } from './session';

/**
 * The GemDB Shell, as a pseudoterminal.
 *
 * Named `pyRepl`/`PyReplTerminal` internally; "GemDB Shell" is what the user
 * sees, and the only name that appears in commands, terminals, and docs.
 *
 * The previous REPL drove Grail's topaz script in an ordinary terminal, which
 * meant living with topaz: Ctrl+C dropped the user into a Smalltalk debugger,
 * and the session belonged to a process the extension could neither log out
 * nor interrupt. This one is a `vscode.Pseudoterminal` — no external process
 * at all. The loop runs in the extension host against the same GCI machinery
 * the notebooks use, so Ctrl+C is ours (it interrupts the running Python), the
 * session is ours (stopping the database logs it out like any other), and the
 * display rules are Grail's own REPL rules, produced by the same query layer.
 *
 * Every terminal is its own database session. That is not an implementation
 * shortcut — it is the demonstration: open two REPLs and you have two
 * concurrent sessions with separate uncommitted state, visible to each other
 * exactly at commit boundaries.
 */

const BANNER =
  'GemDB Shell — Python inside the database. This terminal is its own session.\r\n' +
  'Ctrl+C interrupts · exit() or Ctrl+D leaves\r\n';

export class PyReplTerminal implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<number | void>();
  readonly onDidWrite = this.writeEmitter.event;
  readonly onDidClose = this.closeEmitter.event;

  private readonly editor = new LineEditor('>>> ');
  private session: GciSession | undefined;
  /** Lines gathered so far of a multi-line statement. */
  private pending: string[] = [];
  private continuing = false;
  private running = false;
  /** Input that arrived while Python was running, replayed afterwards. */
  private typeahead = '';
  private closed = false;

  constructor(
    private readonly extensionPath: string,
    private readonly label: string,
  ) {}

  open(): void {
    this.writeEmitter.fire(BANNER);
    try {
      this.session = GciSession.login(this.label);
    } catch (e) {
      // The terminal opens even though the login failed, so the message has
      // somewhere to be read; the next Enter retries via ensureSession.
      this.writeEmitter.fire(`${message(e)}\r\n`);
    }
    this.writeEmitter.fire(this.editor.beginLine());
  }

  close(): void {
    this.closed = true;
    this.session?.logout();
    this.session = undefined;
  }

  handleInput(data: string): void {
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
          this.writeEmitter.fire(event.text);
          break;
        case 'submit':
          void this.onLine(event.line);
          return; // onLine repaints the prompt and replays type-ahead
        case 'interrupt':
          // At a quiet prompt, ^C abandons the line — and any half-built
          // multi-line statement — exactly as CPython does.
          this.pending = [];
          this.continuing = false;
          this.writeEmitter.fire(this.prompt());
          break;
        case 'eof':
          this.writeEmitter.fire('\r\n');
          this.closeEmitter.fire();
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
      this.closeEmitter.fire();
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
      return await runPythonInSession(session, source, 'repl');
    } catch (e) {
      this.writeEmitter.fire(`${message(e)}\r\n`);
      return undefined;
    }
  }

  /**
   * The session this terminal runs in, brought back to life if need be.
   *
   * "Need be" is real: stopping the database logs every REPL out. Typing into
   * this terminal afterwards is a request for a running database — the same
   * request a notebook cell makes — so it goes through `ensureRunning`, which
   * also clears a deliberate stop the way any other run of Python does.
   */
  private async ensureSession(): Promise<GciSession | undefined> {
    if (this.session?.connected) return this.session;
    if (!(await ensureRunning(this.extensionPath))) {
      this.writeEmitter.fire('GemDB is not running, so this could not be evaluated.\r\n');
      return undefined;
    }
    try {
      this.session = GciSession.login(this.label);
      return this.session;
    } catch (e) {
      this.writeEmitter.fire(`${message(e)}\r\n`);
      return undefined;
    }
  }

  private show(result: PyResult): void {
    if (result.output) {
      this.writeEmitter.fire(result.output.replace(/\n/g, '\r\n'));
    }
    const value = result.value;
    if (!value) return;
    if (isErrorResult(value) && /\b(soft break|hard break|interrupt)\b/i.test(value)) {
      // The break the user just sent is not news; report it the way Python does.
      this.writeEmitter.fire('KeyboardInterrupt\r\n');
      return;
    }
    this.writeEmitter.fire(`${value.replace(/\n/g, '\r\n')}\r\n`);
  }

  /** Repaint the prompt, then replay whatever was typed while Python ran. */
  private finishTurn(): void {
    if (this.closed) return;
    this.editor.setPrompt(this.prompt());
    this.writeEmitter.fire(this.editor.beginLine());
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
