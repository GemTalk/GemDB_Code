/**
 * Line editing for a raw pseudoterminal.
 *
 * A pseudoterminal echoes nothing: every keystroke arrives as bytes, and
 * whatever the user is to see, we must write. This class turns that byte
 * stream into edited lines — cursor movement, insertion, deletion, history —
 * and hands back both the events the REPL acts on and the exact text to echo.
 *
 * It is deliberately free of any vscode import so it can be unit-tested as a
 * pure object: bytes in, events out. The escape sequences handled are the ones
 * xterm.js actually sends for the keys a REPL user reaches for; anything
 * unrecognised is dropped rather than echoed, so a stray sequence cannot
 * corrupt the line.
 */

export type EditorEvent =
  | { kind: 'echo'; text: string }
  | { kind: 'submit'; line: string }
  | { kind: 'interrupt' }
  | { kind: 'eof' };

const ESC = '\u001b';
const CTRL_A = '\u0001';
const CTRL_C = '\u0003';
const CTRL_D = '\u0004';
const CTRL_E = '\u0005';
const CTRL_K = '\u000b';
const CTRL_U = '\u0015';
const BACKSPACE = '\u007f';

export class LineEditor {
  /** The line under construction, as code points so astral characters stay whole. */
  private buffer: string[] = [];
  private cursor = 0;
  private history: string[] = [];
  /** Where history navigation stands; history.length means "the fresh line". */
  private historyAt = 0;
  /** The fresh line saved while the user is off browsing history. */
  private stashed = '';
  /** Escape-sequence bytes seen so far, when one arrives split across feeds. */
  private pendingEscape = '';

  constructor(private prompt: string) {}

  setPrompt(prompt: string): void {
    this.prompt = prompt;
  }

  /** Echo text that begins a new input line: the prompt, with an empty buffer. */
  beginLine(): string {
    this.buffer = [];
    this.cursor = 0;
    this.historyAt = this.history.length;
    this.stashed = '';
    return this.prompt;
  }

  /** Feed raw input; returns the events it produced, echoes included, in order. */
  feed(data: string): EditorEvent[] {
    const events: EditorEvent[] = [];
    let input = this.pendingEscape + data;
    this.pendingEscape = '';

    while (input.length > 0) {
      if (input.startsWith(ESC)) {
        // Parsing terminal escape sequences is this class's job — matching the
        // ESC control character is the point, not a slip.
        // eslint-disable-next-line no-control-regex
        const match = /^\u001b(\[[0-9;]*[A-Za-z~]|[OA-Za-z])/.exec(input);
        if (!match) {
          // A prefix of a sequence — keep it for the next feed. Bound it so a
          // lone Escape key cannot dam up input forever.
          if (input.length <= 8) {
            this.pendingEscape = input;
            return events;
          }
          input = input.slice(1);
          continue;
        }
        this.applyEscape(match[1], events);
        input = input.slice(match[0].length);
        continue;
      }

      // By code point, not UTF-16 unit — indexing would split an emoji into
      // two lone surrogates and insert each half as its own "character".
      const ch = String.fromCodePoint(input.codePointAt(0) ?? 0);
      input = input.slice(ch.length);

      if (ch === '\r' || ch === '\n') {
        const line = this.buffer.join('');
        if (line.trim().length > 0 && line !== this.history[this.history.length - 1]) {
          this.history.push(line);
        }
        events.push({ kind: 'echo', text: '\r\n' });
        events.push({ kind: 'submit', line });
        this.buffer = [];
        this.cursor = 0;
        this.historyAt = this.history.length;
        // Swallow the \n of a \r\n pair so one Enter is one submit.
        if (ch === '\r' && input.startsWith('\n')) input = input.slice(1);
        continue;
      }

      switch (ch) {
        case CTRL_C:
          events.push({ kind: 'echo', text: '^C\r\n' });
          events.push({ kind: 'interrupt' });
          this.buffer = [];
          this.cursor = 0;
          break;
        case CTRL_D:
          if (this.buffer.length === 0) events.push({ kind: 'eof' });
          else this.deleteAtCursor(events);
          break;
        case BACKSPACE:
          if (this.cursor > 0) {
            this.cursor -= 1;
            this.buffer.splice(this.cursor, 1);
            this.redrawTail(events, '\b', 1);
          }
          break;
        case CTRL_A:
          events.push({ kind: 'echo', text: this.moveLeft(this.cursor) });
          this.cursor = 0;
          break;
        case CTRL_E:
          events.push({ kind: 'echo', text: this.moveRight(this.buffer.length - this.cursor) });
          this.cursor = this.buffer.length;
          break;
        case CTRL_K: {
          const cut = this.buffer.length - this.cursor;
          if (cut > 0) {
            this.buffer.length = this.cursor;
            events.push({ kind: 'echo', text: ' '.repeat(cut) + '\b'.repeat(cut) });
          }
          break;
        }
        case CTRL_U:
          events.push({ kind: 'echo', text: this.redrawLine([]) });
          this.buffer = [];
          this.cursor = 0;
          break;
        default:
          if (ch >= ' ' || ch === '\t') this.insert(ch === '\t' ? '  ' : ch, events);
          break;
      }
    }
    return events;
  }

  private applyEscape(seq: string, events: EditorEvent[]): void {
    switch (seq) {
      case '[A': // up
        if (this.historyAt > 0) {
          if (this.historyAt === this.history.length) this.stashed = this.buffer.join('');
          this.historyAt -= 1;
          events.push({ kind: 'echo', text: this.redrawLine([...this.history[this.historyAt]]) });
        }
        break;
      case '[B': // down
        if (this.historyAt < this.history.length) {
          this.historyAt += 1;
          const line =
            this.historyAt === this.history.length
              ? [...this.stashed]
              : [...this.history[this.historyAt]];
          events.push({ kind: 'echo', text: this.redrawLine(line) });
        }
        break;
      case '[C': // right
        if (this.cursor < this.buffer.length) {
          this.cursor += 1;
          events.push({ kind: 'echo', text: this.moveRight(1) });
        }
        break;
      case '[D': // left
        if (this.cursor > 0) {
          this.cursor -= 1;
          events.push({ kind: 'echo', text: '\b' });
        }
        break;
      case '[H':
      case '[1~': // home
        events.push({ kind: 'echo', text: this.moveLeft(this.cursor) });
        this.cursor = 0;
        break;
      case '[F':
      case '[4~': // end
        events.push({ kind: 'echo', text: this.moveRight(this.buffer.length - this.cursor) });
        this.cursor = this.buffer.length;
        break;
      case '[3~': // delete
        this.deleteAtCursor(events);
        break;
      default:
        break; // unrecognised — ignore rather than echo garbage
    }
  }

  private insert(text: string, events: EditorEvent[]): void {
    const chars = [...text];
    this.buffer.splice(this.cursor, 0, ...chars);
    this.cursor += chars.length;
    const tail = this.buffer.slice(this.cursor).join('');
    events.push({ kind: 'echo', text: text + tail + '\b'.repeat([...tail].length) });
  }

  private deleteAtCursor(events: EditorEvent[]): void {
    if (this.cursor < this.buffer.length) {
      this.buffer.splice(this.cursor, 1);
      this.redrawTail(events, '', 1);
    }
  }

  /** Repaint everything after the cursor after `removed` chars left the buffer. */
  private redrawTail(events: EditorEvent[], lead: string, removed: number): void {
    const tail = this.buffer.slice(this.cursor).join('');
    const wipe = ' '.repeat(removed);
    const back = '\b'.repeat([...tail].length + removed);
    events.push({ kind: 'echo', text: lead + tail + wipe + back });
  }

  /** Clear the whole line and repaint prompt + new content; cursor to the end. */
  private redrawLine(next: string[]): string {
    const text = `\u001b[2K\r${this.prompt}${next.join('')}`;
    this.buffer = next;
    this.cursor = next.length;
    return text;
  }

  private moveLeft(n: number): string {
    return n > 0 ? `\u001b[${n}D` : '';
  }

  private moveRight(n: number): string {
    return n > 0 ? `\u001b[${n}C` : '';
  }
}
