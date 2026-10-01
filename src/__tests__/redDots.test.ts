import { describe, expect, it } from 'vitest';
import { armQuery, armedLinesQuery, hookStopQuery, parseArmed } from '../redDots';

/**
 * The red-dot queries' promises that hold without a database. That the
 * breaks are set and fire is `src/__integration__/redDots.test.ts`'s job.
 */

const F = '\u001f';
const R = '\u001e';

describe('arming a run', () => {
  it('only clears when no file has a dot, so a run with none never stops at an import', () => {
    const query = armQuery(new Map());

    expect(query).toContain('GsNMethod clearAllBreaks.');
    expect(query).not.toContain('setBreakAtStepPoint: 1');
  });

  it('sets the import hooks and quotes each path when a file has a dot', () => {
    const query = armQuery(new Map([["/w/it's.py", [3, 7]]]));

    expect(query).toContain("dots at: '/w/it''s.py' put: #(3 7).");
    expect(query).toContain(
      "#'___pushInitializingModule___:' environmentId: 0) setBreakAtStepPoint: 1",
    );
    expect(query).toContain(
      "#'___resetClassAttrOverlay___:' environmentId: 0) setBreakAtStepPoint: 1",
    );
  });

  it('converts a paused process only after its new breaks are set', () => {
    const query = armQuery(new Map([['/w/m.py', [3]]]), 77n);
    const convert = query.indexOf('(Object _objectForOop: 77) convertToPortableStack.');

    // Converting first leaves the new breaks silently ignored (measured).
    expect(convert).toBeGreaterThan(query.lastIndexOf('setBreakAtStepPoint: 1'));
    expect(armQuery(new Map([['/w/m.py', [3]]]))).not.toContain('convertToPortableStack');
  });

  it('only reports, setting nothing, when asked what is armed', () => {
    const query = armedLinesQuery(new Map([['/w/m.py', [3]]]));

    expect(query).not.toContain('setBreakAtStepPoint:');
    expect(query).not.toContain('clearAllBreaks');
  });
});

describe('a breakpoint stop', () => {
  it('answers dot before arming anything when the stop is not an import hook', () => {
    const query = hookStopQuery(5n, new Map([['/w/m.py', [3]]]));

    expect(query.indexOf("^ 'dot'")).toBeLessThan(query.indexOf('dots := Dictionary new.'));
  });
});

describe('parseArmed', () => {
  it('reads the lines armed in each file, past a hook stop’s leading record', () => {
    const armed = parseArmed(`hook${R}/w/m.py${F}3${F}7${R}/w/n.py${R}`);

    expect([...armed]).toEqual([
      ['/w/m.py', [3, 7]],
      ['/w/n.py', []],
    ]);
  });

  it('reads nothing armed from an empty answer', () => {
    expect(parseArmed('').size).toBe(0);
  });
});
