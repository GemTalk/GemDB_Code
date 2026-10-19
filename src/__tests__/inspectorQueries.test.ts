import { describe, expect, it } from 'vitest';
import { FIELD, RECORD } from '../haltStack';
import {
  INSPECTOR_REGISTRY,
  inspectorEvaluateQuery,
  openQuery,
  parseClassInfo,
  parseHeader,
  parseRepr,
  parseSource,
  sourceAt,
} from '../inspectorQueries';

/**
 * The Inspector's answers, parsed, and the one piece of its logic that runs in
 * TypeScript: finding a definition's lines in a notebook cell or a file. The
 * queries themselves run against a real database in
 * src/__integration__/inspector.test.ts.
 */

const row = (fields: string[]): string => fields.join(FIELD) + RECORD;

describe('parseHeader', () => {
  it("reads the object's row, then its OOP, whether it is committed, its module, and if it is a class", () => {
    const raw =
      row(['', 'Point(3, 4)', 'Point', '12', '0', '3', '12', '-1', '0', 'obj']) +
      row(['123456', '1', '__main__', '0']);
    expect(parseHeader(raw)).toEqual({
      row: {
        name: '',
        value: 'Point(3, 4)',
        type: 'Point',
        ref: 12,
        indexed: 0,
        named: 3,
        handle: 12,
        size: -1,
        readOnly: false,
        kind: 'obj',
      },
      oop: '123456',
      committed: true,
      module: '__main__',
      isClass: false,
    });
  });

  it('throws the reason on an Error: line, and on an answer missing its second record', () => {
    expect(() => parseHeader('Error: that value is no longer available')).toThrow(
      'that value is no longer available',
    );
    expect(() => parseHeader(row(['', '3', 'int', '0', '0', '0', '5', '-1', '0', '']))).toThrow(
      'could not be read',
    );
  });
});

describe('parseRepr', () => {
  it('reads repr, str and whether either was cut', () => {
    expect(parseRepr(["'a\\nb'", 'a\nb', '0'].join(FIELD))).toEqual({
      repr: "'a\\nb'",
      str: 'a\nb',
      cut: false,
    });
    expect(parseRepr(['[0, 1, …', '', '1'].join(FIELD)).cut).toBe(true);
  });
});

describe('parseClassInfo', () => {
  it('reads the head, the MRO without builtins, and each member with its owner', () => {
    const raw = [
      ['head', 'Point', 'Point', '__main__', 'A point.', '0'],
      ['mro', '__main__', 'Point'],
      ['mro', 'builtins', 'object'],
      ['member', 'Point', 'norm', 'method'],
      ['member', 'Point', 'origin', 'classmethod'],
    ]
      .map((f) => f.join(FIELD))
      .join(RECORD);
    expect(parseClassInfo(raw)).toEqual({
      name: 'Point',
      qualname: 'Point',
      module: '__main__',
      doc: 'A point.',
      isClass: false,
      mro: ['__main__.Point', 'object'],
      members: [
        { owner: 'Point', name: 'norm', kind: 'method' },
        { owner: 'Point', name: 'origin', kind: 'classmethod' },
      ],
    });
  });
});

describe('parseSource', () => {
  it('tells source text from where to look for it', () => {
    expect(parseSource('def f():\n    pass\n')).toEqual({
      kind: 'text',
      text: 'def f():\n    pass\n',
    });
    expect(parseSource(['where', '<grail>', '7'].join(FIELD))).toEqual({
      kind: 'where',
      file: '<grail>',
      line: 7,
    });
    expect(parseSource('Error: NameError - x')).toEqual({ kind: 'text', text: '# NameError - x' });
    expect(
      parseSource(
        ['smalltalk', 'KeyValueDictionary', 'get: key\r\t^ 1', 'get: key _: d'].join(FIELD),
      ),
    ).toEqual({
      kind: 'smalltalk',
      className: 'KeyValueDictionary',
      sources: ['get: key\n\t^ 1', 'get: key _: d'],
    });
  });
});

describe('sourceAt', () => {
  const cell = [
    'class Point:',
    '    @classmethod',
    '    @staticmethod',
    '    def origin(cls):',
    '        x = 1',
    '',
    '        return cls(0, 0)',
    '',
    '    def norm(self):',
    '        return 5',
    '',
    'p = Point()',
  ];

  it('takes the decorators, the def and its body, and stops at the next line as far out', () => {
    expect(sourceAt(cell, 2, 'origin')).toBe(cell.slice(1, 7).join('\n'));
    expect(sourceAt(cell, 9, 'norm')).toBe(cell.slice(8, 10).join('\n'));
    expect(sourceAt(cell, 1, 'Point')).toBe(cell.slice(0, 10).join('\n'));
  });

  it('answers nothing when that line does not define that name', () => {
    expect(sourceAt(cell, 9, 'origin')).toBeUndefined();
    expect(sourceAt(cell, 12, 'p')).toBeUndefined();
    expect(sourceAt(cell, 40, 'norm')).toBeUndefined();
    expect(sourceAt(cell, 0, 'norm')).toBeUndefined();
  });

  it('does not take a name that only starts the same', () => {
    expect(sourceAt(['def normal():', '    pass'], 1, 'norm')).toBeUndefined();
  });
});

describe('the queries', () => {
  it('open into the Inspector registry, refusing a group or a scope', () => {
    const q = openQuery('GemDbPauseRefs', 4);
    expect(q).toContain(`SessionTemps current at: #'GemDbPauseRefs'`);
    expect(q).toContain(`#'${INSPECTOR_REGISTRY}'`);
    expect(q).toContain('#gemdbGroup');
  });

  it("bind self under Grail's spelling, over a copy of the notebook's names only when given one", () => {
    const withScope = inspectorEvaluateQuery(3, 'self.x', 'file:///a.ipynb');
    expect(withScope).toContain("at: 'file:///a.ipynb'");
    expect(withScope).toContain('doitScopeNameFor:');
    expect(inspectorEvaluateQuery(3, 'self.x', undefined)).not.toContain('__gemdbScopes');
  });

  it("escape the user's quotes", () => {
    expect(inspectorEvaluateQuery(3, "self['k']", undefined)).toContain("self[''k'']");
  });
});
