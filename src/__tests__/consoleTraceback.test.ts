import { describe, expect, it } from 'vitest';
import { PlacedFrame, jupyterTraceback } from '../consoleTraceback';
import type { ConsoleError, TracebackFrame } from '../pauseVariables';

/**
 * A Debug Console error written as Jupyter writes one. Placing a frame — the
 * console's input, a cell, a file — is the caller's (`debugger.ts`); here it
 * is a stub, so the layout itself is what is tested.
 */

const CELL = ['def boom(d):', '    return 10 / d'];
const FILE = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`);

/** The console's input is frame 0; a `<grail>` frame is the cell; anything else the file. */
function placed(input: string[]) {
  return (frame: TracebackFrame, index: number): PlacedFrame =>
    index === 0
      ? { label: 'Debug Console', isFile: false, lines: input }
      : frame.file === '<grail>'
        ? { label: 'Cell [2]', isFile: false, lines: CELL }
        : { label: `File ${frame.file}`, isFile: true, lines: FILE };
}

const error = (frames: TracebackFrame[], more: Partial<ConsoleError> = {}): ConsoleError => ({
  type: 'ZeroDivisionError',
  message: 'division by zero',
  frames,
  ...more,
});

describe('a Jupyter-style traceback', () => {
  it('heads it as Jupyter does, then each frame outermost first, then the error', () => {
    const text = jupyterTraceback(
      error([
        { file: '<grail>', line: 1, name: '<module>', text: 'boom(0' },
        { file: '<grail>', line: 2, name: 'boom', text: '    return 10 / ' },
      ]),
      placed(['boom(0)']),
    );

    expect(text.split('\n')).toEqual([
      '-'.repeat(75),
      'ZeroDivisionError                         Traceback (most recent call last)',
      'Debug Console, line 1',
      '----> 1 boom(0)',
      '',
      'Cell [2], line 2, in boom',
      '      1 def boom(d):',
      '----> 2     return 10 / d',
      '',
      'ZeroDivisionError: division by zero',
    ]);
  });

  it('shows two lines either side of the one that raised, and keeps the gutter seven wide at two digits', () => {
    const text = jupyterTraceback(
      error([{ file: '/w/mod.py', line: 10, name: 'fail', text: '' }], {
        type: 'KeyError',
        message: "'missing'",
      }),
      (frame) => placed([])(frame, 1),
    );

    expect(text.split('\n').slice(2, 8)).toEqual([
      'File /w/mod.py:10, in fail',
      '      8 line 8',
      '      9 line 9',
      '---> 10 line 10',
      '     11 line 11',
      '     12 line 12',
    ]);
  });

  it('falls back to the text Grail recorded when a frame’s source cannot be found', () => {
    const text = jupyterTraceback(
      error([{ file: '<grail>', line: 4, name: 'helper', text: '    return x / y\nmore' }]),
      () => ({ label: 'Cell', isFile: false }),
    );

    expect(text.split('\n').slice(2, 4)).toEqual([
      'Cell, line 4, in helper',
      '----> 4     return x / y',
    ]);
  });

  it('shows a SyntaxError’s line with a caret under where it could not read, and no frames', () => {
    const text = jupyterTraceback(
      error([], {
        type: 'SyntaxError',
        message: 'invalid syntax',
        syntax: { file: '<string>', line: 1, offset: 4, text: '1 +' },
      }),
      placed(['1 +']),
    );

    expect(text.split('\n')).toEqual([
      '  Debug Console, line 1',
      '    1 +',
      '       ^',
      'SyntaxError: invalid syntax',
    ]);
  });

  it('ends with the type alone when the error has no message', () => {
    const text = jupyterTraceback(
      error([{ file: '<grail>', line: 1, name: '<module>', text: 'raise E' }], {
        type: 'E',
        message: '',
      }),
      placed(['raise E']),
    );

    expect(text.split('\n').pop()).toBe('E');
  });
});
