import { describe, expect, it } from 'vitest';
import { EditorEvent, LineEditor } from '../lineEditor';

/**
 * The editor is pure — bytes in, events out — so these tests drive it exactly
 * the way xterm.js will: one keystroke at a time, escape sequences and all.
 */

const UP = '\u001b[A';
const DOWN = '\u001b[B';
const LEFT = '\u001b[D';
const CTRL_C = '\u0003';
const CTRL_D = '\u0004';
const CTRL_U = '\u0015';
const BACKSPACE = '\u007f';

/** Everything the terminal would have painted for this input. */
function echoed(events: EditorEvent[]): string {
  return events
    .filter((e): e is { kind: 'echo'; text: string } => e.kind === 'echo')
    .map((e) => e.text)
    .join('');
}

function submitted(events: EditorEvent[]): string[] {
  return events
    .filter((e): e is { kind: 'submit'; line: string } => e.kind === 'submit')
    .map((e) => e.line);
}

function editor(): LineEditor {
  const e = new LineEditor('>>> ');
  e.beginLine();
  return e;
}

describe('LineEditor', () => {
  it('echoes what is typed and submits it on Enter', () => {
    const e = editor();
    const events = e.feed('x = 1\r');
    expect(echoed(events)).toBe('x = 1\r\n');
    expect(submitted(events)).toEqual(['x = 1']);
  });

  it('treats one Enter as one submit, whether it arrives as \\r or \\r\\n', () => {
    const e = editor();
    expect(submitted(e.feed('a\r\n'))).toEqual(['a']);
    expect(submitted(e.feed('b\r'))).toEqual(['b']);
  });

  it('backspace removes the character before the cursor', () => {
    const e = editor();
    e.feed('abc');
    e.feed(BACKSPACE);
    expect(submitted(e.feed('\r'))).toEqual(['ab']);
  });

  it('backspace at the start of the line does nothing', () => {
    const e = editor();
    const events = e.feed(BACKSPACE);
    expect(echoed(events)).toBe('');
    expect(submitted(e.feed('\r'))).toEqual(['']);
  });

  it('inserts at the cursor, not at the end', () => {
    const e = editor();
    e.feed('ac');
    e.feed(LEFT);
    e.feed('b');
    expect(submitted(e.feed('\r'))).toEqual(['abc']);
  });

  it('recalls history with the up arrow', () => {
    const e = editor();
    e.feed('first\r');
    e.beginLine();
    e.feed(UP);
    expect(submitted(e.feed('\r'))).toEqual(['first']);
  });

  it('walks history both ways and back to the line being typed', () => {
    const e = editor();
    e.feed('one\r');
    e.beginLine();
    e.feed('two\r');
    e.beginLine();
    e.feed('half');
    e.feed(UP); // two
    e.feed(UP); // one
    e.feed(DOWN); // two
    e.feed(DOWN); // back to the stashed "half"
    expect(submitted(e.feed('\r'))).toEqual(['half']);
  });

  it('does not put duplicates or blank lines in history', () => {
    const e = editor();
    e.feed('same\r');
    e.beginLine();
    e.feed('same\r');
    e.beginLine();
    e.feed('\r'); // blank
    e.beginLine();
    e.feed(UP); // 'same', once
    e.feed(UP); // still 'same' — nothing older
    expect(submitted(e.feed('\r'))).toEqual(['same']);
  });

  it('handles an escape sequence split across feeds, as terminals send them', () => {
    const e = editor();
    e.feed('ab\r');
    e.beginLine();
    e.feed('\u001b'); // just the escape byte…
    e.feed('[A'); // …and the rest in the next packet
    expect(submitted(e.feed('\r'))).toEqual(['ab']);
  });

  it('Ctrl+C abandons the line and signals an interrupt', () => {
    const e = editor();
    e.feed('doomed');
    const events = e.feed(CTRL_C);
    expect(events.some((ev) => ev.kind === 'interrupt')).toBe(true);
    expect(echoed(events)).toContain('^C');
    expect(submitted(e.feed('\r'))).toEqual(['']);
  });

  it('Ctrl+D on an empty line is end-of-input, on a non-empty line it deletes', () => {
    const empty = editor();
    expect(empty.feed(CTRL_D).some((ev) => ev.kind === 'eof')).toBe(true);

    const nonEmpty = editor();
    nonEmpty.feed('ab');
    nonEmpty.feed(LEFT);
    nonEmpty.feed(LEFT);
    expect(nonEmpty.feed(CTRL_D).some((ev) => ev.kind === 'eof')).toBe(false);
    expect(submitted(nonEmpty.feed('\r'))).toEqual(['b']);
  });

  it('Ctrl+U clears the line', () => {
    const e = editor();
    e.feed('all of this goes');
    e.feed(CTRL_U);
    expect(submitted(e.feed('\r'))).toEqual(['']);
  });

  it('drops unrecognised escape sequences instead of echoing garbage', () => {
    const e = editor();
    const events = e.feed('\u001b[5~'); // page-up — not handled
    expect(echoed(events)).toBe('');
    expect(submitted(e.feed('\r'))).toEqual(['']);
  });

  it('keeps an astral character whole through editing', () => {
    const e = editor();
    e.feed('a🐍b');
    e.feed(BACKSPACE);
    e.feed(BACKSPACE);
    expect(submitted(e.feed('\r'))).toEqual(['a']);
  });
});
