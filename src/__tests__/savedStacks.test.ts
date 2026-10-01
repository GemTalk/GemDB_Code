import { describe, expect, it, vi } from 'vitest';

/**
 * Saved stacks, without a database: what a saved frame keeps, how it is shown
 * again when its notebook or file is gone, and what the queries answer. That a
 * stack really saves, commits and opens again from another session is
 * `breakpoint.test.ts`'s job.
 */

vi.mock('../session', () => ({ setHaltHandler: () => {} }));

const { __commands } = await import('../__mocks__/vscode');
const {
  STACK_KIND,
  knownSavedStacks,
  noteSavedStacks,
  onSavedStacksChanged,
  parseOpenedStack,
  restoredFrames,
  restoredSource,
  saveStackQuery,
  savedFrameOf,
  savedPauseLabel,
  stackKeyFor,
} = await import('../savedStacks');

const F = '\u001f';

const cellFrame = {
  name: 'Employee.find',
  line: 2,
  column: 5,
  end_column: 17,
  source_name: 'Cell [1]',
  path: 'vscode-notebook-cell:/w/breakpoint.ipynb#W0',
  text: 'def find(self):\n    breakpoint()',
};

const fileFrame = {
  name: 'helper',
  line: 1,
  column: 5,
  end_column: null,
  source_name: 'mod.py',
  path: '/w/mod.py',
  text: '    return f()',
};

const world = (files: string[], cells: Record<string, string[]> = {}) => ({
  fileExists: (file: string) => files.includes(file),
  openCellLines: (uri: string) => cells[uri],
});

describe('what a saved frame keeps', () => {
  it('keeps the frame’s place and its whole cell or file', () => {
    const frame = savedFrameOf(
      {
        id: 1,
        name: 'f',
        line: 2,
        column: 5,
        endColumn: 17,
        source: { name: 'Cell [1]', path: 'vscode-notebook-cell:/w/a.ipynb#W0' },
      },
      ['def f():', '    breakpoint()'],
    );

    expect(frame).toEqual({
      name: 'f',
      line: 2,
      column: 5,
      end_column: 17,
      source_name: 'Cell [1]',
      path: 'vscode-notebook-cell:/w/a.ipynb#W0',
      text: 'def f():\n    breakpoint()',
    });
  });

  it('keeps a frame with nowhere to show it, with no text', () => {
    const frame = savedFrameOf({ id: 1, name: 'g', line: 3, column: 1 }, undefined);

    expect(frame).toMatchObject({ path: null, text: null, end_column: null });
  });
});

describe('showing a saved frame’s source again', () => {
  const saved = (name: string, ref: number, shownPath: string) => ({
    name: `${name} (saved 2026-10-01 16:20)`,
    sourceReference: ref,
    path: shownPath,
    origin: 'saved with the stack on 2026-10-01 16:20, not the file on disk',
  });

  it('shows the saved copy, labelled with when, even while the original still exists', () => {
    expect(restoredSource(fileFrame, 2, world(['/w/mod.py']), '2026-10-01 16:20')).toEqual(
      saved('mod.py', 2, '/w/mod.py (saved 2026-10-01 16:20)'),
    );
  });

  it('shows the saved copy of a cell even while that notebook is open and unchanged', () => {
    const uri = cellFrame.path;

    const source = restoredSource(
      cellFrame,
      1,
      world([], { [uri]: ['def find(self):', '    breakpoint()'] }),
      '2026-10-01 16:20',
    );

    // The hover shows where it came from and that it's the saved copy; the tab shows the end.
    expect(source).toEqual(
      saved('Cell [1]', 1, '/w/breakpoint.ipynb · Cell [1] (saved 2026-10-01 16:20)'),
    );
  });

  it('falls back to the original only for a frame saved without text, and only if it exists', () => {
    const noText = { ...fileFrame, text: null };

    expect(restoredSource(noText, 1, world(['/w/mod.py']))).toEqual({
      name: 'mod.py',
      path: '/w/mod.py',
    });
    expect(restoredSource(noText, 1, world([]))).toBeUndefined();
  });

  it('has nothing to show for a frame saved without text or a path', () => {
    expect(restoredSource({ ...fileFrame, path: null, text: null }, 1, world([]))).toBeUndefined();
  });
});

describe('rebuilding the stack for the debugger', () => {
  const meta = {
    label: 'breakpoint.ipynb',
    notebook: 'file:///w/breakpoint.ipynb',
    saved_at: '2026-10-01 16:20',
    description: 'Saved at breakpoint()',
    frames: [cellFrame, fileFrame],
  };

  it('rebuilds each frame where it was, with its saved text behind a reference when needed', () => {
    const { frames, texts } = restoredFrames(meta, [3, 4], 9, world([]));

    expect(frames).toEqual([
      {
        id: 1,
        name: 'Employee.find',
        line: 2,
        column: 5,
        endLine: 2,
        endColumn: 17,
        source: {
          name: 'Cell [1] (saved 2026-10-01 16:20)',
          sourceReference: 1,
          path: '/w/breakpoint.ipynb · Cell [1] (saved 2026-10-01 16:20)',
          origin: 'saved with the stack on 2026-10-01 16:20, not the file on disk',
        },
      },
      {
        id: 2,
        name: 'helper',
        line: 1,
        column: 5,
        source: {
          name: 'mod.py (saved 2026-10-01 16:20)',
          sourceReference: 2,
          path: '/w/mod.py (saved 2026-10-01 16:20)',
          origin: 'saved with the stack on 2026-10-01 16:20, not the file on disk',
        },
      },
    ]);
    expect(texts.get(1)).toBe(cellFrame.text);
    expect(texts.get(2)).toBe(fileFrame.text);
  });

  it('offers the notebook’s globals under a cell’s frame only, as when it was live', () => {
    const { scopes } = restoredFrames(meta, [3, 4], 9, world(['/w/mod.py']));

    expect(scopes.get(1)?.map((s) => [s.name, s.variablesReference])).toEqual([
      ['Locals', 3],
      ['Globals', 9],
    ]);
    expect(scopes.get(2)?.map((s) => [s.name, s.variablesReference])).toEqual([['Locals', 4]]);
  });

  it('labels the stack as saved, with when', () => {
    expect(savedPauseLabel(meta)).toBe('Saved stack: breakpoint.ipynb (2026-10-01 16:20)');
  });
});

describe('the saved-stack queries', () => {
  it('reads the metadata, each frame’s locals ref and the globals ref', () => {
    const raw = JSON.stringify({ label: 'a', frames: [cellFrame] }) + F + '3 0 ' + F + '9';

    const opened = parseOpenedStack(raw);

    expect(opened.meta.frames[0].name).toBe('Employee.find');
    expect(opened.locals).toEqual([3, 0]);
    expect(opened.globals).toBe(9);
  });

  it('turns an error line into an error', () => {
    expect(() => parseOpenedStack('Error: KeyError - stack_x')).toThrow('KeyError - stack_x');
  });

  it('marks the snapshot as a stack, binds only frames that have locals, and removes the bindings', () => {
    const query = saveStackQuery(
      'stack_a',
      { label: 'a.ipynb', notebook: 'file:///a.ipynb', saved_at: 'now', description: null },
      [cellFrame, fileFrame],
      [12, 0],
      'file:///a.ipynb',
    );

    expect(query).toContain(`"kind": ${JSON.stringify(STACK_KIND)}`);
    expect(query).toContain("scope at: #'___gemdb_l0' put: ((reg at: 12) at: 2).");
    expect(query).not.toContain("___gemdb_l1' put:");
    expect(query).toContain('"locals": None');
    expect(query).toContain("scope removeKey: #'___gemdb_l0' ifAbsent: [].");
    expect(query).toContain("scope removeKey: #'___gemdb_m' ifAbsent: [].");
  });

  it('suggests a key from the notebook and the time', () => {
    expect(stackKeyFor('breakpoint.ipynb', new Date(2026, 9, 1, 16, 5))).toBe(
      'stack_breakpoint_20261001_1605',
    );
  });
});

describe('knowing whether there is a saved stack to restore', () => {
  it('sets the context key the Restore buttons show on, and tells listeners when it changes', () => {
    const contexts: unknown[][] = [];
    __commands.set('setContext', (...args: unknown[]) => contexts.push(args));
    let heard = 0;
    const listening = onSavedStacksChanged(() => heard++);

    noteSavedStacks(2);
    noteSavedStacks(2);
    noteSavedStacks(0);

    expect(contexts).toEqual([
      ['gemdb.hasSavedStacks', true],
      ['gemdb.hasSavedStacks', false],
    ]);
    expect(heard).toBe(2);
    expect(knownSavedStacks()).toBe(0);
    listening.dispose();
    __commands.delete('setContext');
  });
});
