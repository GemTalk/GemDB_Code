import { FIELD, RECORD } from './haltStack';
import {
  CHILDREN_OF,
  DESCRIBE,
  HELPERS,
  MAIN_MODULE,
  MAIN_MODULE_GLOBALS,
  MainModule,
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
 * session the object lives in, known to TypeScript only by position. Each
 * panel has a registry of its own (`inspectorRegistry()`), because the other
 * two are dropped when their reason ends (the pause's at every resume,
 * Persisted Objects' at every re-read), and an Inspector stays open past both.
 * Opening an object copies it from the registry it was found in into the
 * panel's, and every row the panel lists is registered there in turn, so
 * diving into a row needs no second lookup. The registry is dropped when the
 * panel closes (`dropInspectorRegistryQuery`).
 *
 * One registry per panel, not per session: a panel left open after its
 * notebook's session was replaced (the notebook closed and opened again) must
 * find nothing at its positions, not another panel's objects at the same
 * positions in the new session's registry.
 *
 * Being registered keeps an object alive, so an uncommitted object stays
 * readable while its session lives — between cells, after the pause it was
 * found at has resumed. Every header carries the object's OOP too, so a
 * committed one could be re-found by it from any session; nothing does that
 * yet.
 *
 * Rows are `childrenQuery`'s, read with this registry, so an attribute, an item
 * and an entry read here exactly as the Variables view reads them: the same
 * grouping, the same repr budget, the same type names.
 */

/** What every Inspector registry's SessionTemps key starts with. */
export const INSPECTOR_REGISTRY = 'GemDbInspectorRefs';

/** A new panel's own registry key: `GemDbInspectorRefs-` and a random part. */
export function inspectorRegistry(): string {
  return `${INSPECTOR_REGISTRY}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Longest repr (and str) the Repr tab shows; past it, the text is cut and says
 * so. Far more than the pane shows at once, and small enough that a long str's
 * repr and str together stay well under a megabyte over the wire.
 */
export const REPR_CHARS = 20000;

/** What the Inspector knows about one object before reading any of its tabs. */
export interface InspectorHeader {
  /** The object's row, as `describe` writes it: type, short repr, size, kind, handle. */
  row: PauseVariable;
  /** Its OOP, as a decimal string: an object's identity in the database. */
  oop: string;
  /** Whether it is committed, so readable by its OOP from any session. */
  committed: boolean;
  /**
   * `__class__.__module__` — `builtins` for a list, and today for a notebook's
   * class too, where CPython says `__main__` (see docs/inspector.md, Measured).
   */
  module: string;
  /** Whether the object is itself a class. */
  isClass: boolean;
}

/**
 * Smalltalk that puts the object at `handle` of registry `from` into the
 * panel's `registry` and answers its header (`parseHeader`), or an `Error: …`
 * line. `from` may be the panel's own registry, which is how a dive re-reads a
 * row's object: `describe` registers it again, and the header carries that new
 * position.
 *
 * A group row (`class variables`) or a scope is not an object, and is refused.
 */
export function openQuery(from: string, handle: number, registry: string): string {
  return `| src reg obj out field record none saved describe childrenOf reprOf late clean isLeaf ${ROW_TEMPS} mod |
${PREAMBLE}
src := SessionTemps current at: #'${escapeString(from)}' otherwise: nil.
(src notNil and: [${handle} between: 1 and: src size])
  ifFalse: [^ 'Error: that value is no longer available' encodeAsUTF8].
obj := src at: ${handle}.
(obj class == Array and: [obj size >= 2
    and: [#(#gemdbScope #gemdbGroup #gemdbConsole) includes: (obj at: 1)]])
  ifTrue: [^ 'Error: that row is not an object of its own' encodeAsUTF8].
reg := SessionTemps current at: #'${escapeString(registry)}' otherwise: nil.
reg isNil ifTrue: [
  reg := OrderedCollection new.
  SessionTemps current at: #'${escapeString(registry)}' put: reg].
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
 * then, when it differs, its `str()`: `ok`, field, `1` when either was cut,
 * field, `repr`, field, `str`. The `ok` first, so a repr that itself starts
 * `Error: ` is not taken for a failure; the texts have the separators cleaned
 * out, so a str holding one cannot shift the fields. A `print()` inside either
 * goes nowhere (`withQuietConsole`).
 */
export function reprQuery(handle: number, registry: string): string {
  return `| reg obj out field record none saved r s cut clean |
${PREAMBLE}
clean := [:t | t collect: [:c | (c == field or: [c == record]) ifTrue: [$?] ifFalse: [c]]].
reg := SessionTemps current at: #'${escapeString(registry)}' otherwise: nil.
(reg notNil and: [${handle} between: 1 and: reg size])
  ifFalse: [^ 'Error: that value is no longer available' encodeAsUTF8].
obj := reg at: ${handle}.
cut := false.
${withQuietConsole(`r := [(obj @env1:__repr__) asString] on: AbstractException do: [:e |
    (e isKindOf: ControlInterrupt) ifTrue: ['<__repr__ took too long>'] ifFalse: ['<__repr__ raised ' , e class name , ': ' , e messageText asString , '>']].
  s := [(obj @env1:__str__) asString] on: AbstractException do: [:e | e return: r].
  r size > ${REPR_CHARS} ifTrue: [r := r copyFrom: 1 to: ${REPR_CHARS}. cut := true].
  s size > ${REPR_CHARS} ifTrue: [s := s copyFrom: 1 to: ${REPR_CHARS}. cut := true].`)}
out nextPutAll: 'ok'; nextPut: field; nextPutAll: (cut ifTrue: ['1'] ifFalse: ['0']); nextPut: field;
  nextPutAll: (clean value: r); nextPut: field; nextPutAll: (s = r ifTrue: [''] ifFalse: [clean value: s]).
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
  const [status, cut, repr = '', str = ''] = raw.split(FIELD);
  if (status !== 'ok') {
    throw new Error(
      raw.startsWith('Error: ') ? raw.slice('Error: '.length) : 'The repr could not be read.',
    );
  }
  return { repr, str, cut: cut === '1' };
}

/**
 * Python that describes the class of `_gemdb_obj` (the object itself, when it
 * is a class): one `head` record — name, qualname, module, docstring, whether
 * the object is the class — then an `mro` record per class in its MRO, a
 * `bases` record (`__bases__`, which with several bases is not just the MRO's
 * second class), then a `member` record per name each class in the MRO defines
 * itself (`object`'s left out: every class has them): the class's position in
 * the MRO — two classes there can share a name (`class Config(base.Config)`),
 * so it, not the name, says which — its name, the member, and what kind of
 * thing it is. The fields are joined in Python, so nothing is copied back into
 * Smalltalk but one str.
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
  '    out.append(F.join(["bases"] + [t(b.__name__) for b in getattr(c, "__bases__", ())]))',
  '    for i, k in enumerate(mro):',
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
  '            out.append(F.join(["member", str(i), t(k.__name__), t(n), kind]))',
  '    return R.join(out)',
  '_gemdb_class_info(_gemdb_obj)',
].join('\n');

/** Smalltalk running `CLASS_PYTHON` against registry entry `handle`. */
export function classQuery(handle: number, registry: string): string {
  return pythonOnObject(handle, CLASS_PYTHON, registry);
}

/** One name a class in the MRO defines. */
export interface ClassMember {
  /** The class that defines it, by name, for headings. */
  owner: string;
  /** That class's position in the MRO, from 0: what tells two classes of one name apart. */
  ownerIndex: number;
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
  /** `__bases__`, by name: the classes it was declared with. */
  bases: string[];
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
    bases: [],
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
    } else if (tag === 'bases') {
      info.bases = f.filter((b) => b !== '');
    } else if (tag === 'member') {
      const [index = '0', owner = '', name = '', kind = 'attribute'] = f;
      info.members.push({
        owner,
        ownerIndex: Number.parseInt(index, 10) || 0,
        name,
        kind: kind as ClassMember['kind'],
      });
    }
  }
  return info;
}

/**
 * Smalltalk answering the source of member `name` of the class of
 * `_gemdb_obj` (the object itself, when it is a class), defined in the class at
 * `ownerIndex` of its MRO (`owner` is that class's name, for the message):
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
export function sourceQuery(
  handle: number,
  ownerIndex: number,
  owner: string,
  name: string,
  registry: string,
): string {
  const python = [
    'def _gemdb_member(o, at, name):',
    '    c = o if isinstance(o, type) else type(o)',
    '    mro = getattr(c, "__mro__", (c,))',
    '    k = mro[at] if 0 <= at < len(mro) else c',
    '    v = vars(k).get(name)',
    '    v = getattr(v, "__func__", None) or getattr(v, "fget", None) or v',
    '    if isinstance(v, type):',
    '        line = getattr(v, "__firstlineno__", 0)',
    '        import sys',
    '        mod = sys.modules.get(getattr(v, "__module__", ""), None)',
    '        file = getattr(mod, "__file__", None) or "<grail>"',
    '        if line:',
    '            return "\\x1f".join(["where", str(file), str(line), "class"])',
    '        return "# " + name + " is a class, and where it was defined is not recorded."',
    '    code = getattr(v, "__code__", None)',
    '    if code is None or not getattr(code, "co_firstlineno", 0):',
    '        if not callable(v):',
    '            r = repr(v)',
    '            r = r if len(r) <= 200 else r[:197] + "..."',
    '            return "# " + name + " is a class attribute, with no source of its own:\\n" + name + " = " + r',
    '        return v',
    '    return "\\x1f".join(["where", str(code.co_filename), str(code.co_firstlineno)])',
    `_gemdb_member(_gemdb_obj, ${Math.trunc(ownerIndex)}, ${JSON.stringify(name)})`,
  ].join('\n');
  const noSource = `'# ${escapeString(`${owner}.${name}`)} is built in: it has no source to show.'`;
  return `| reg out field record none saved dispatcher scope r names cls sel found at |
${PREAMBLE}
reg := SessionTemps current at: #'${escapeString(registry)}' otherwise: nil.
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
  | { kind: 'where'; file: string; line: number; isClass?: boolean }
  | { kind: 'smalltalk'; className: string; sources: string[] };

export function parseSource(raw: string): SourceAnswer {
  if (raw.startsWith('Error: ')) return { kind: 'text', text: `# ${raw.slice('Error: '.length)}` };
  const [tag, ...fields] = raw.split(FIELD);
  if (tag === 'where') {
    const [file = '', line = '', what = ''] = fields;
    return {
      kind: 'where',
      file,
      line: Number.parseInt(line, 10) || 0,
      ...(what === 'class' ? { isClass: true } : {}),
    };
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
 * starts the definition of `name`, and, with `owner`, it is inside `class
 * owner` (the nearest line less indented above it says so); else undefined.
 * The owner check is what keeps one class's `__init__` from being shown as
 * another's, when two cells define them at the same line. A blank line inside
 * the body is kept; trailing blank lines are not.
 */
export function sourceAt(
  lines: string[],
  line: number,
  name: string,
  owner?: string,
): string | undefined {
  const first = line - 1;
  if (first < 0 || first >= lines.length) return undefined;
  const indentOf = (text: string): number => text.length - text.trimStart().length;
  const indent = indentOf(lines[first] ?? '');
  let at = first;
  while (at < lines.length && (lines[at] ?? '').trimStart().startsWith('@')) at++;
  const head = lines[at] ?? '';
  const defines = new RegExp(`^\\s*(async\\s+def|def|class)\\s+${name.replace(/\W/g, '\\$&')}\\b`);
  if (!defines.test(head) || indentOf(head) !== indent) return undefined;
  if (owner !== undefined) {
    let up = first - 1;
    while (up >= 0 && ((lines[up] ?? '').trim() === '' || indentOf(lines[up] ?? '') >= indent))
      up--;
    const enclosing = up >= 0 ? (lines[up] ?? '') : '';
    const isOwner = new RegExp(`^\\s*class\\s+${owner.replace(/\W/g, '\\$&')}\\b`);
    if (indent === 0 || !isOwner.test(enclosing)) return undefined;
  }
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
function pythonOnObject(handle: number, python: string, registry: string): string {
  return `| reg out field record none saved dispatcher scope r |
${PREAMBLE}
reg := SessionTemps current at: #'${escapeString(registry)}' otherwise: nil.
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
 * The names in scope are a copy of the program's globals — a notebook's, when
 * `globals` names one, or a debugged file's `__main__`, when it is `MAIN_MODULE`
 * — so `Point(1, 2)` works in the Inspector of the program's object, plus
 * `gemdb`, and `self`, bound under Grail's spelling of it
 * (`NameAst doitScopeNameFor:`, see `consoleQuery`). A copy, so a name the
 * expression binds (`y = 5`) does not reach the program; the objects are the
 * real ones, so `self.x = 3` changes the object.
 *
 * With `discard`, whatever the expression changed in the database is thrown
 * away afterwards (`System abortTransaction`), for the extension's own session,
 * where nothing would ever commit it — and where `removeCommittedQuery` does
 * commit, so a change left there would be written by an unrelated action.
 */
export function inspectorEvaluateQuery(
  handle: number,
  source: string,
  globals: string | MainModule | undefined,
  registry: string,
  discard = false,
): string {
  const scope =
    globals === MAIN_MODULE
      ? `g := ${MAIN_MODULE_GLOBALS}.
(g notNil and: [g respondsTo: #keysAndValuesDo:]) ifTrue: [g keysAndValuesDo: [:k :x | dict at: k put: x]].`
      : globals
        ? `g := SessionTemps current at: #'__gemdbScopes' ifAbsent: [nil].
g := g isNil ifTrue: [nil] ifFalse: [g at: '${escapeString(globals)}' ifAbsent: [nil]].
g notNil ifTrue: [g keysAndValuesDo: [:k :x | dict at: k put: x]].`
        : '';
  return `| reg obj out field record none saved describe childrenOf reprOf late clean isLeaf dispatcher dict g r kind exc captured nameAst key ${ROW_TEMPS} |
${PREAMBLE}
${HELPERS}
${CHILDREN_OF}
${DESCRIBE}
reg := SessionTemps current at: #'${escapeString(registry)}' otherwise: nil.
(reg notNil and: [${handle} between: 1 and: reg size])
  ifFalse: [^ 'Error: that value is no longer available' encodeAsUTF8].
obj := reg at: ${handle}.
dispatcher := System myUserProfile symbolList objectNamed: #'ModuleAst'.
nameAst := System myUserProfile symbolList objectNamed: #'NameAst'.
dict := SymbolDictionary new.
${scope}
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
${discard ? 'System needsCommit ifTrue: [System abortTransaction].' : ''}
out contents encodeAsUTF8`;
}

/** Smalltalk that drops a panel's registry from its session. */
export function dropInspectorRegistryQuery(registry: string): string {
  return `SessionTemps current removeKey: #'${escapeString(registry)}' ifAbsent: []. 'dropped' encodeAsUTF8`;
}
