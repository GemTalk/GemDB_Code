import { describe, expect, it } from 'vitest';
import { parseConsoleNames, parseConsoleReply, parsePersistedKeys } from '../pauseVariables';

/**
 * The console queries' answers, read. The queries themselves run against a
 * real database in `__integration__/debugConsole.test.ts`; this pins down the
 * reading of each shape they answer in.
 */

const F = '\u001f';
const R = '\u001e';
const rec = (...fields: Array<string | number>): string => fields.join(F) + R;

describe('reading a console line’s answer', () => {
  it('reads a value: the row, what was printed, the console’s position, and a persisted name’s origin', () => {
    const raw =
      rec('value', 12, 'hi\r\n', 'persisted') +
      rec('o', "Order(1013, 'katherine', 3/14)", 'Order', 40, 0, 3, 41, -1, 0, 'obj');

    expect(parseConsoleReply(raw)).toEqual({
      consoleRef: 12,
      output: 'hi\n',
      kind: 'value',
      origin: 'persisted',
      row: expect.objectContaining({
        name: 'o',
        value: "Order(1013, 'katherine', 3/14)",
        type: 'Order',
        ref: 40,
        named: 3,
        kind: 'obj',
      }),
    });
  });

  it('reads a value with no origin when the name is not a persisted one', () => {
    const reply = parseConsoleReply(rec('value', 3, '', '') + rec('n', '1', 'int', 0, 0, 0, 9));

    expect(reply).not.toHaveProperty('origin');
  });

  it('reads None or a statement, and an interrupted line', () => {
    expect(parseConsoleReply(rec('none', 3, 'printed\n', ''))).toEqual({
      consoleRef: 3,
      output: 'printed\n',
      kind: 'none',
    });
    expect(parseConsoleReply(rec('interrupted', 3, '', ''))).toMatchObject({ kind: 'interrupted' });
  });

  it('reads an error: its type and message, then each frame outermost first', () => {
    const raw =
      rec('error', 3, '', '') +
      rec('ZeroDivisionError', 'division by zero') +
      rec('<grail>', 1, '<module>', 'boom(0') +
      rec('/w/mod.py', 2, 'boom', '    return 10 / ');

    expect(parseConsoleReply(raw)).toEqual({
      consoleRef: 3,
      output: '',
      kind: 'error',
      error: {
        type: 'ZeroDivisionError',
        message: 'division by zero',
        frames: [
          { file: '<grail>', line: 1, name: '<module>', text: 'boom(0' },
          { file: '/w/mod.py', line: 2, name: 'boom', text: '    return 10 / ' },
        ],
      },
    });
  });

  it('reads a SyntaxError’s file, line, column and text', () => {
    const raw =
      rec('error', 3, '', '') + rec('SyntaxError', 'invalid syntax', '<string>', 1, 4, '1 +');

    expect(parseConsoleReply(raw)).toMatchObject({
      kind: 'error',
      error: { syntax: { file: '<string>', line: 1, offset: 4, text: '1 +' }, frames: [] },
    });
  });

  it('reads a stack overflow as an error', () => {
    const raw = rec('stack', 3, '', '') + rec('RecursionError', 'maximum recursion depth exceeded');

    expect(parseConsoleReply(raw)).toMatchObject({
      kind: 'error',
      error: { type: 'RecursionError' },
    });
  });

  it('turns an Error: line from the query itself into a failure', () => {
    expect(parseConsoleReply('Error: the pause is over')).toEqual({
      consoleRef: 0,
      output: '',
      kind: 'failed',
      message: 'the pause is over',
    });
  });
});

describe('reading the console’s names', () => {
  it('reads its position and each name with its type and repr', () => {
    const raw = `7${R}` + rec('p', 'list', '[1, 2]') + rec('_', 'int', '3');

    expect(parseConsoleNames(raw)).toEqual({
      consoleRef: 7,
      names: [
        { name: 'p', type: 'list', repr: '[1, 2]' },
        { name: '_', type: 'int', repr: '3' },
      ],
    });
  });

  it('reads no names, and throws on an Error: line', () => {
    expect(parseConsoleNames(`7${R}`)).toEqual({ consoleRef: 7, names: [] });
    expect(() => parseConsoleNames('Error: the pause is over')).toThrow('the pause is over');
  });
});

describe('reading Persisted Objects’ keys', () => {
  it('splits the keys, and reads an empty answer as none', () => {
    expect(parsePersistedKeys(`entry${F}o${F}two words`)).toEqual(['entry', 'o', 'two words']);
    expect(parsePersistedKeys('')).toEqual([]);
  });
});
