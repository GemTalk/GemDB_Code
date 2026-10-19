import { FIELD, RECORD } from './haltStack';
import {
  CHILDREN_OF,
  DESCRIBE,
  HELPERS,
  PREAMBLE,
  PauseVariable,
  REPLY_ERROR,
  ROW_TEMPS,
  parseChildren,
  withQuietConsole,
} from './pauseVariables';
import { escapeString } from './smalltalkText';

/**
 * Every query the Inspector panel makes (`inspector.ts`).
 *
 * The Inspector holds its objects the way the Variables view and Persisted
 * Objects do: in a registry — an OrderedCollection in `SessionTemps` — of the
 * session the object lives in, known to TypeScript only by position. It has a
 * registry of its own, `INSPECTOR_REGISTRY`, because the other two are dropped
 * when their reason ends (the pause's at every resume, Persisted Objects' at
 * every re-read), and an Inspector stays open past both. Opening an object
 * copies it from the registry it was found in into this one, and every row the
 * Inspector lists is registered there in turn, so diving into a row needs no
 * second lookup. The registry is dropped when the last panel on its session
 * closes (`dropInspectorRegistryQuery`).
 *
 * Being registered keeps an object alive, so an uncommitted object stays
 * readable while its session lives — between cells, after the pause it was
 * found at has resumed. A committed object is also readable by its permanent
 * number (its OOP), which every header carries.
 *
 * Rows are `childrenQuery`'s, read with this registry, so an attribute, an item
 * and an entry read here exactly as the Variables view reads them: the same
 * grouping, the same repr budget, the same type names.
 */

/** SessionTemps key of the Inspector's registry. */
export const INSPECTOR_REGISTRY = 'GemDbInspectorRefs';

/** Longest repr the Repr tab shows; past it, the text is cut and says so. */
export const REPR_CHARS = 200000;

/** What the Inspector knows about one object before reading any of its tabs. */
export interface InspectorHeader {
  /** The object's row, as `describe` writes it: type, short repr, size, kind, handle. */
  row: PauseVariable;
  /** Its OOP, as a decimal string: an object's identity in the database. */
  oop: string;
  /** Whether it is committed, so readable by its OOP from any session. */
  committed: boolean;
  /** `__class__.__module__` — `builtins` for a list, `__main__` for a notebook's class. */
  module: string;
  /** Whether the object is itself a class. */
  isClass: boolean;
}

/**
 * Smalltalk that puts the object at `handle` of registry `from` into the
 * Inspector's registry and answers its header (`parseHeader`), or an
 * `Error: …` line. `from` may be the Inspector's own registry, which is how a
 * dive re-reads a row's object: `describe` registers it again, and the header
 * carries that new position.
 *
 * A group row (`class variables`) or a scope is not an object, and is refused.
 */
export function openQuery(from: string, handle: number): string {
  return `| src reg obj out field record none saved describe childrenOf reprOf late clean isLeaf ${ROW_TEMPS} mod |
${PREAMBLE}
src := SessionTemps current at: #'${escapeString(from)}' otherwise: nil.
obj := (src notNil and: [${handle} between: 1 and: src size]) ifTrue: [src at: ${handle}] ifFalse: [nil].
(src isNil or: [(${handle} between: 1 and: src size) not])
  ifTrue: [^ 'Error: that value is no longer available' encodeAsUTF8].
(obj class == Array and: [obj size >= 2
    and: [#(#gemdbScope #gemdbGroup #gemdbConsole) includes: (obj at: 1)]])
  ifTrue: [^ 'Error: that row is not an object of its own' encodeAsUTF8].
reg := SessionTemps current at: #'${INSPECTOR_REGISTRY}' otherwise: nil.
reg isNil ifTrue: [
  reg := OrderedCollection new.
  SessionTemps current at: #'${INSPECTOR_REGISTRY}' put: reg].
${HELPERS}
${CHILDREN_OF}
${DESCRIBE}
${withQuietConsole(`describe value: '' value: obj.
  mod := [((obj @env1:___pyAttrLoad___: #'__class__') @env1:___pyAttrLoad___: #'__module__') asString]
    on: AbstractException do: [:e | e return: ''].
  out print: obj asOop; nextPut: field;
    nextPutAll: ((obj isCommitted) ifTrue: ['1'] ifFalse: ['0']); nextPut: field;
    nextPutAll: (clean value: mod); nextPut: field;
    nextPutAll: ((obj notNil and: [obj isBehavior]) ifTrue: ['1'] ifFalse: ['0']); nextPut: record`)}
out contents encodeAsUTF8`;
}

/** Parse `openQuery`'s answer; throws on an `Error: …` line. */
export function parseHeader(raw: string): InspectorHeader {
  if (raw.startsWith('Error: ')) throw new Error(raw.slice('Error: '.length));
  const records = raw.split(RECORD).filter((r) => r.length > 0);
  const [row] = parseChildren((records[0] ?? '') + RECORD);
  if (!row || records.length < 2) throw new Error('The object could not be read.');
  const [oop = '', committed, module = '', isClass] = (records[1] ?? '').split(FIELD);
  return { row, oop, committed: committed === '1', module, isClass: isClass === '1' };
}

/**
 * Smalltalk answering the object's whole `repr()`, cut at `REPR_CHARS`, and
 * then, when it differs, its `str()`: `repr`, field, `str`, field, `1` when the
 * repr was cut. A `print()` inside either goes nowhere (`withQuietConsole`).
 */
export function reprQuery(handle: number): string {
  return `| reg obj out field record none saved r s cut |
${PREAMBLE}
reg := SessionTemps current at: #'${INSPECTOR_REGISTRY}' otherwise: nil.
(reg notNil and: [${handle} between: 1 and: reg size])
  ifFalse: [^ 'Error: that value is no longer available' encodeAsUTF8].
obj := reg at: ${handle}.
cut := false.
${withQuietConsole(`r := [(obj @env1:__repr__) asString] on: AbstractException do: [:e |
    (e isKindOf: ControlInterrupt) ifTrue: ['<__repr__ took too long>'] ifFalse: ['<__repr__ raised ' , e class name , ': ' , e messageText asString , '>']].
  s := [(obj @env1:__str__) asString] on: AbstractException do: [:e | e return: r].
  r size > ${REPR_CHARS} ifTrue: [r := r copyFrom: 1 to: ${REPR_CHARS}. cut := true].
  s size > ${REPR_CHARS} ifTrue: [s := s copyFrom: 1 to: ${REPR_CHARS}. cut := true].`)}
out nextPutAll: r; nextPut: field; nextPutAll: (s = r ifTrue: [''] ifFalse: [s]); nextPut: field;
  nextPutAll: (cut ifTrue: ['1'] ifFalse: ['0']).
out contents encodeAsUTF8`;
}

/** What the Repr tab shows. */
export interface ReprText {
  repr: string;
  /** `str()`, when it says something `repr()` does not; empty otherwise. */
  str: string;
  /** Whether either was cut at `REPR_CHARS`. */
  cut: boolean;
}

export function parseRepr(raw: string): ReprText {
  if (raw.startsWith('Error: ')) throw new Error(raw.slice('Error: '.length));
  const [repr = '', str = '', cut] = raw.split(FIELD);
  return { repr, str, cut: cut === '1' };
}

/**
 * Python that describes the class of `_gemdb_obj` (the object itself, when it
 * is a class): one `head` record — name, qualname, module, docstring, whether
 * the object is the class — then an `mro` record per class in its MRO, then a
 * `member` record per name each class in the MRO defines itself (`object`'s
 * left out: every class has them), with what kind of thing it is. The fields
 * are joined in Python, so nothing is copied back into Smalltalk but one str.
 */
const CLASS_PYTHON = [
  'def _gemdb_class_info(o):',
  '    F, R = "\\x1f", "\\x1e"',
  '    def t(s):',
  '        return str(s if s is not None else "").replace(F, "?").replace(R, "?")',
  '    c = o if isinstance(o, type) else type(o)',
  '    mro = getattr(c, "__mro__", (c,))',
  '    out = [F.join(["head", t(c.__name__), t(getattr(c, "__qualname__", c.__name__)),',
  '                   t(getattr(c, "__module__", "")), t(getattr(c, "__doc__", "")),',
  '                   "1" if c is o else "0"])]',
  '    for k in mro:',
  '        out.append(F.join(["mro", t(getattr(k, "__module__", "")), t(k.__name__)]))',
  '    for k in mro:',
  '        if k is object:',
  '            continue',
  '        try:',
  '            names = sorted(vars(k).items())',
  '        except Exception:',
  '            continue',
  '        for n, v in names:',
  '            if isinstance(v, staticmethod):',
  '                kind = "staticmethod"',
  '            elif isinstance(v, classmethod):',
  '                kind = "classmethod"',
  '            elif isinstance(v, property):',
  '                kind = "property"',
  '            elif isinstance(v, type):',
  '                kind = "class"',
  '            elif callable(v):',
  '                kind = "method"',
  '            else:',
  '                kind = "attribute"',
  '            out.append(F.join(["member", t(k.__name__), t(n), kind]))',
  '    return R.join(out)',
  '_gemdb_class_info(_gemdb_obj)',
].join('\n');

/** Smalltalk running `CLASS_PYTHON` against registry entry `handle`. */
export function classQuery(handle: number): string {
  return pythonOnObject(handle, CLASS_PYTHON);
}

/** One name a class in the MRO defines. */
export interface ClassMember {
  /** The class that defines it. */
  owner: string;
  name: string;
  kind: 'method' | 'classmethod' | 'staticmethod' | 'property' | 'class' | 'attribute';
}

/** What the Class tab shows. */
export interface ClassInfo {
  name: string;
  qualname: string;
  module: string;
  doc: string;
  /** Whether the inspected object is this class, rather than an instance of it. */
  isClass: boolean;
  /** The MRO, as `module.name`, the class itself first. */
  mro: string[];
  members: ClassMember[];
}

export function parseClassInfo(raw: string): ClassInfo {
  if (raw.startsWith('Error: ')) throw new Error(raw.slice('Error: '.length));
  const info: ClassInfo = {
    name: '',
    qualname: '',
    module: '',
    doc: '',
    isClass: false,
    mro: [],
    members: [],
  };
  for (const record of raw.split(RECORD)) {
    const [tag, ...f] = record.split(FIELD);
    if (tag === 'head') {
      info.name = f[0] ?? '';
      info.qualname = f[1] ?? '';
      info.module = f[2] ?? '';
      info.doc = f[3] ?? '';
      info.isClass = f[4] === '1';
    } else if (tag === 'mro') {
      const [module = '', name = ''] = f;
      info.mro.push(module && module !== 'builtins' ? `${module}.${name}` : name);
    } else if (tag === 'member') {
      const [owner = '', name = '', kind = 'attribute'] = f;
      info.members.push({ owner, name, kind: kind as ClassMember['kind'] });
    }
  }
  return info;
}

/**
 * Smalltalk answering the source of member `name` of the class of
 * `_gemdb_obj` (the object itself, when it is a class), defined in `owner`:
 *
 * - **A Python function**: a `where` record — its code's file and first line —
 *   from which the panel reads the lines itself (`sourceAt`).
 * - **A method Grail implements** (`dict.get`, `list.append`): its Smalltalk
 *   source. Such a method has no `__code__`; it is an UnboundMethod holding
 *   its Smalltalk class and the Python name, and Grail's methods for it are in
 *   method environment 1 under that name, one per arity (`get:`, `get:_:`),
 *   on that class or a superclass (`dict.get` is KeyValueDictionary's). The
 *   answer is a `smalltalk` record: the class that defines them, then their
 *   sources.
 * - Anything else: a line saying there is no source to show.
 *
 * `inspect.getsource` is not used. Importing `inspect` took 4.6 s the first
 * time in a session (measured 2026-10-19), past the two-second budget every
 * Inspector read has, so the read was broken off; and for a notebook's
 * function it fails anyway (`OSError: could not get source code`): Grail
 * compiles a cell as `<grail>`, with its lines counted within the cell, and
 * keeps no source to read. The panel finds a cell's lines in the notebook,
 * the way the debugger places a frame.
 */
export function sourceQuery(handle: number, owner: string, name: string): string {
  const python = [
    'def _gemdb_member(o, owner, name):',
    '    c = o if isinstance(o, type) else type(o)',
    '    k = next((k for k in getattr(c, "__mro__", (c,)) if k.__name__ == owner), c)',
    '    v = vars(k).get(name)',
    '    v = getattr(v, "__func__", None) or getattr(v, "fget", None) or v',
    '    code = getattr(v, "__code__", None)',
    '    if code is None or not getattr(code, "co_firstlineno", 0):',
    '        return v',
    '    return "\\x1f".join(["where", str(code.co_filename), str(code.co_firstlineno)])',
    `_gemdb_member(_gemdb_obj, ${JSON.stringify(owner)}, ${JSON.stringify(name)})`,
  ].join('\n');
  const noSource = `'# ${escapeString(`${owner}.${name}`)} is built in: it has no source to show.'`;
  return `| reg out field record none saved dispatcher scope r names cls sel found at |
${PREAMBLE}
reg := SessionTemps current at: #'${INSPECTOR_REGISTRY}' otherwise: nil.
(reg notNil and: [${handle} between: 1 and: reg size])
  ifFalse: [^ 'Error: that value is no longer available' encodeAsUTF8].
dispatcher := System myUserProfile symbolList objectNamed: #'ModuleAst'.
scope := SymbolDictionary new.
scope at: #'_gemdb_obj' put: (reg at: ${handle}).
${withQuietConsole(`r := [dispatcher evaluateSource: '${escapeString(python)}' usingModuleScope: scope]
    on: AbstractException do: [:e | 'Error: ' , e class name , ' - ' , e messageText asString].`)}
r isString ifTrue: [^ r asString encodeAsUTF8].
names := r class allInstVarNames.
((names includes: #definingClass) and: [names includes: #selector])
  ifFalse: [^ ${noSource} encodeAsUTF8].
cls := r instVarAt: (names indexOf: #definingClass).
sel := (r instVarAt: (names indexOf: #selector)) asString.
"The nearest class in the chain with an environment-1 method of this name, at any arity."
found := nil.
[found isNil and: [cls notNil]] whileTrue: [| mine |
  mine := ([cls selectorsForEnvironment: 1] on: Error do: [:e | #()])
    select: [:x | x asString = sel or: [x size > sel size
      and: [(x asString copyFrom: 1 to: sel size + 1) = (sel , ':')]]].
  mine isEmpty
    ifTrue: [cls := cls superclass]
    ifFalse: [found := mine asSortedCollection: [:a :b | a size <= b size]]].
found isNil ifTrue: [^ ${noSource} encodeAsUTF8].
out nextPutAll: 'smalltalk'; nextPut: field; nextPutAll: cls name asString.
found do: [:x | | m |
  m := cls compiledMethodAt: x environmentId: 1 otherwise: nil.
  (m notNil and: [m sourceString notNil]) ifTrue: [out nextPut: field; nextPutAll: m sourceString]].
out contents encodeAsUTF8`;
}

/** What `sourceQuery` answered: the source, where to look for it, or Grail's Smalltalk for it. */
export type SourceAnswer =
  | { kind: 'text'; text: string }
  | { kind: 'where'; file: string; line: number }
  | { kind: 'smalltalk'; className: string; sources: string[] };

export function parseSource(raw: string): SourceAnswer {
  if (raw.startsWith('Error: ')) return { kind: 'text', text: `# ${raw.slice('Error: '.length)}` };
  const [tag, ...fields] = raw.split(FIELD);
  if (tag === 'where') {
    const [file = '', line = ''] = fields;
    return { kind: 'where', file, line: Number.parseInt(line, 10) || 0 };
  }
  if (tag === 'smalltalk') {
    const [className = '', ...sources] = fields;
    return { kind: 'smalltalk', className, sources: sources.map((t) => t.replace(/\r\n?/g, '\n')) };
  }
  return { kind: 'text', text: raw };
}

/**
 * The definition starting at 1-based `line` of `lines` — its decorators, the
 * `def` or `class` line, and every line indented under it — when that line
 * starts the definition of `name`; else undefined. A blank line inside the
 * body is kept; trailing blank lines are not.
 */
export function sourceAt(lines: string[], line: number, name: string): string | undefined {
  const first = line - 1;
  if (first < 0 || first >= lines.length) return undefined;
  const indentOf = (text: string): number => text.length - text.trimStart().length;
  const indent = indentOf(lines[first] ?? '');
  let at = first;
  while (at < lines.length && (lines[at] ?? '').trimStart().startsWith('@')) at++;
  const head = lines[at] ?? '';
  const defines = new RegExp(`^\\s*(async\\s+def|def|class)\\s+${name.replace(/\W/g, '\\$&')}\\b`);
  if (!defines.test(head) || indentOf(head) !== indent) return undefined;
  let end = at + 1;
  for (let i = at + 1; i < lines.length; i++) {
    const text = lines[i] ?? '';
    if (text.trim() === '') continue;
    if (indentOf(text) <= indent) break;
    end = i + 1;
  }
  return lines.slice(first, end).join('\n');
}

/**
 * Smalltalk that runs `python` in a fresh scope with `_gemdb_obj` bound to
 * registry entry `handle`, and answers the str it gives, or an `Error: …`
 * line. What the user's code prints goes nowhere.
 */
function pythonOnObject(handle: number, python: string): string {
  return `| reg out field record none saved dispatcher scope r |
${PREAMBLE}
reg := SessionTemps current at: #'${INSPECTOR_REGISTRY}' otherwise: nil.
(reg notNil and: [${handle} between: 1 and: reg size])
  ifFalse: [^ 'Error: that value is no longer available' encodeAsUTF8].
dispatcher := System myUserProfile symbolList objectNamed: #'ModuleAst'.
scope := SymbolDictionary new.
scope at: #'_gemdb_obj' put: (reg at: ${handle}).
${withQuietConsole(`r := [(dispatcher evaluateSource: '${escapeString(python)}' usingModuleScope: scope) asString]
    on: AbstractException do: [:e | 'Error: ' , e class name , ' - ' , e messageText asString].`)}
r encodeAsUTF8`;
}

/**
 * Smalltalk that runs Python `source` with `self` bound to registry entry
 * `handle`, and answers in `consoleQuery`'s format (`parseConsoleReply`), with
 * a value's row registered in the Inspector's registry so Inspect It can open
 * it.
 *
 * The names in scope are a copy of the notebook's globals when `scopeKey`
 * names one — so `Point(1, 2)` works in the Inspector of a notebook's object —
 * plus `gemdb`, and `self`, bound under Grail's spelling of it
 * (`NameAst doitScopeNameFor:`, see `consoleQuery`). A copy, so a name the
 * expression binds (`y = 5`) does not reach the notebook; the objects are the
 * real ones, so `self.x = 3` changes the object.
 */
export function inspectorEvaluateQuery(
  handle: number,
  source: string,
  scopeKey: string | undefined,
): string {
  const globals = scopeKey
    ? `g := SessionTemps current at: #'__gemdbScopes' ifAbsent: [nil].
g := g isNil ifTrue: [nil] ifFalse: [g at: '${escapeString(scopeKey)}' ifAbsent: [nil]].
g notNil ifTrue: [g keysAndValuesDo: [:k :x | dict at: k put: x]].`
    : '';
  return `| reg obj out field record none saved describe childrenOf reprOf late clean isLeaf dispatcher dict g r kind exc captured nameAst key ${ROW_TEMPS} |
${PREAMBLE}
${HELPERS}
${CHILDREN_OF}
${DESCRIBE}
reg := SessionTemps current at: #'${INSPECTOR_REGISTRY}' otherwise: nil.
(reg notNil and: [${handle} between: 1 and: reg size])
  ifFalse: [^ 'Error: that value is no longer available' encodeAsUTF8].
obj := reg at: ${handle}.
dispatcher := System myUserProfile symbolList objectNamed: #'ModuleAst'.
nameAst := System myUserProfile symbolList objectNamed: #'NameAst'.
dict := SymbolDictionary new.
${globals}
(dict includesKey: #gemdb) ifFalse: [
  g := [dispatcher evaluateSource: 'import gemdb
gemdb' usingModuleScope: SymbolDictionary new] on: AbstractException do: [:e | e return: nil].
  g notNil ifTrue: [dict at: #gemdb put: g]].
key := #self.
nameAst notNil ifTrue: [key := [nameAst doitScopeNameFor: key] on: Error do: [:e | e return: key]].
dict at: key put: obj.
kind := #value.
exc := nil.
captured := WriteStream on: Unicode7 new.
saved := SessionTemps current at: #'GrailConsole' otherwise: nil.
SessionTemps current at: #'GrailConsole' put: (Array with: captured).
[r := [[dispatcher evaluateSource: '${escapeString(source)}' usingModuleScope: dict]
    on: AlmostOutOfStack do: [:e | kind := #stack. e return: nil]]
  on: AbstractException do: [:e |
    (e isKindOf: ControlInterrupt)
      ifTrue: [kind := #interrupted]
      ifFalse: [kind == #value ifTrue: [kind := #error. exc := e]].
    e return: nil]]
  ensure: [
    saved isNil
      ifTrue: [SessionTemps current removeKey: #'GrailConsole' ifAbsent: []]
      ifFalse: [SessionTemps current at: #'GrailConsole' put: saved]].
(kind == #value and: [r == none or: [r isNil]]) ifTrue: [kind := #none].
out nextPutAll: kind; nextPut: field; nextPutAll: '0'; nextPut: field; nextPutAll: (clean value: captured contents);
  nextPut: field; nextPut: record.
kind == #value ifTrue: [
  ${withQuietConsole(`describe value: 'result' value: r`)}].
${REPLY_ERROR}
out contents encodeAsUTF8`;
}

/** Smalltalk that drops the Inspector's registry from its session. */
export function dropInspectorRegistryQuery(): string {
  return `SessionTemps current removeKey: #'${INSPECTOR_REGISTRY}' ifAbsent: []. 'dropped' encodeAsUTF8`;
}
