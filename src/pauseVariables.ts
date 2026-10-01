import {
  FIELD,
  PythonFrame,
  RECORD,
  parseFrame,
  pythonStackQuery,
  withoutBreakpointStub,
} from './haltStack';
import { escapeString } from './pythonQueries';

/**
 * The variables of an evaluation paused at `breakpoint()`.
 *
 * The objects themselves stay in the gem. Each one the Variables view might
 * expand is put in a per-pause registry — an OrderedCollection in
 * `SessionTemps` — and the view knows it only by its position there, which is
 * the `variablesReference` the Debug Adapter Protocol hands back when a row is
 * expanded. The registry is per session and lives only as long as the pause:
 * `clearRegistryQuery` drops it before the evaluation resumes, so nothing is
 * kept alive past the moment it could be shown.
 *
 * Locals come from Grail: `PyFrame ___pyLocalsFromFrameContentsList___:` merges
 * the Smalltalk frames one Python frame is made of, drops Grail's internal
 * temps, and adds `self`. Like the stack walk it is private to Grail, so a
 * failure costs the variables, never the pause.
 *
 * Every query here runs the user's own `__repr__`, so each is kept cheap in
 * the gem: a row's children are counted, never copied, a page is read in
 * place, and a big container or string is not asked for its whole repr.
 */

/** SessionTemps key of the per-pause registry. */
const REGISTRY = 'GemDbPauseRefs';

/**
 * The most rows one `variables` request answers. VS Code pages indexed
 * children by itself, so a container with more children than this reports
 * them as indexed — a dict too — and a scope, which VS Code never pages, ends
 * with a row saying how many were left out.
 */
export const PAGE = 500;

/** Containers with more items than this show a size in place of their repr. */
const REPR_ITEMS = 100;

/** Longest value text a row carries. */
const VALUE_CHARS = 300;

/** One row of the Variables view, before it becomes a DAP Variable. */
export interface PauseVariable {
  name: string;
  value: string;
  type: string;
  /** Registry position of the object, when it has children; 0 when it has none. */
  ref: number;
  /** Children VS Code pages through by position — a list's, a set's, a big dict's. */
  indexed: number;
  /** Children read in one go by name — a dict's entries, an object's attributes. */
  named: number;
  /**
   * Registry position of the row's object whether or not it has children, so
   * any row can be saved (`saveToRootQuery`); 0 for a row with no object,
   * such as a group heading.
   */
  handle: number;
}

/**
 * Smalltalk that answers `{kind. source. size}` for an object's children, or
 * nil for a leaf. `kind` is `#seq` (read by position), `#coll` (a set: read in
 * order), `#dict` (entries named by their key's repr), `#attrs` (a Python
 * instance's `__dict__`, named by attribute) or `#ivars` (an object with no
 * `__dict__` — a Grail runtime object — shown by its Smalltalk instance
 * variables, whose names are `source`). Nothing is copied: `source` is the
 * object itself, or its `__dict__`.
 *
 * Sequences are tested before dictionaries: every Smalltalk sequence also
 * answers `keysAndValuesDo:`, with 1-based integer keys, and a Python list
 * must read as `[0]`, `[1]`, … (measured: a list came out as entries 1, 2, 3).
 */
const CHILDREN_OF = `
  childrenOf := [:v | | d names |
    (isLeaf value: v)
      ifTrue: [nil]
      ifFalse: [
        (v isKindOf: SequenceableCollection)
          ifTrue: [{ #seq. v. v size }]
          ifFalse: [
            (v respondsTo: #keysAndValuesDo:)
              ifTrue: [{ #dict. v. v size }]
              ifFalse: [
                (v isKindOf: Collection)
                  ifTrue: [{ #coll. v. v size }]
                  ifFalse: [
                    d := [v @env1:___pyAttrLoad___: #'__dict__'] on: AbstractException do: [:e | e return: nil].
                    (d notNil and: [d respondsTo: #keysAndValuesDo:])
                      ifTrue: [{ #attrs. d. d size }]
                      ifFalse: [
                        names := v class allInstVarNames.
                        names isEmpty ifTrue: [nil] ifFalse: [{ #ivars. names. names size }]]]]]]].`;

/**
 * Smalltalk that writes one row for `v`, named `nm`, and registers `v` — as
 * the row's `ref` when it has children, and always as its `handle`.
 *
 * Its repr is the user's `__repr__`, run through `reprOf`: a big container
 * shows its size instead, and a long string is asked for the repr of its
 * first characters only. Strings are checked before collections (in
 * `childrenOf`) because a String is a SequenceableCollection, and a Python str
 * should read as text, not as a list of characters.
 */
const DESCRIBE = `
  describe := [:nm :v | | kids n text tname idx named |
    tname := [((v @env1:___pyAttrLoad___: #'__class__') @env1:___pyAttrLoad___: #'__name__') asString]
      on: AbstractException do: [:e | e return: v class name asString].
    kids := childrenOf value: v.
    n := kids isNil ifTrue: [0] ifFalse: [kids at: 3].
    text := v isNil
      ifTrue: ['nil']
      ifFalse: [n > ${REPR_ITEMS}
        ifTrue: [tname , ' with ' , n printString , ' items']
        ifFalse: [(v isString and: [v size > ${VALUE_CHARS}])
          ifTrue: [reprOf value: (v copyFrom: 1 to: ${VALUE_CHARS})]
          ifFalse: [reprOf value: v]]].
    text isNil ifTrue: [text := late ifTrue: ['<__repr__ took too long>'] ifFalse: [tname]].
    text size > ${VALUE_CHARS} ifTrue: [text := (text copyFrom: 1 to: ${VALUE_CHARS - 3}) , '...'].
    idx := 0. named := 0.
    n > 0 ifTrue: [
      (((kids at: 1) == #seq or: [(kids at: 1) == #coll]) or: [n > ${PAGE}])
        ifTrue: [idx := n] ifFalse: [named := n]].
    out nextPutAll: (clean value: nm asString); nextPut: field; nextPutAll: (clean value: text); nextPut: field;
      nextPutAll: (clean value: tname); nextPut: field.
    reg add: v.
    n > 0
      ifTrue: [out print: reg size]
      ifFalse: [out nextPutAll: '0'].
    out nextPut: field; print: idx; nextPut: field; print: named; nextPut: field; print: reg size; nextPut: record].`;

/**
 * Smalltalk for the blocks every row needs.
 *
 * `isLeaf` is a value with no children to show — a number, a string, None.
 *
 * `reprOf` answers an object's `__repr__`, or nil when it raised. Past the
 * time budget `queryWhilePaused` soft-breaks the query, and the Break lands in
 * whichever `__repr__` is running; it is caught there, and `late` makes every
 * later row but a leaf's skip its `__repr__` (a leaf's is Grail's own, and
 * quick), so the rows already read still arrive.
 *
 * `clean` keeps the field and record separators out of a row: a name or
 * type could hold one, and it would shift every field after it.
 */
const HELPERS = `
  late := false.
  isLeaf := [:v |
    v isNil or: [v isString or: [v isSymbol or: [v isNumber or: [v isCharacter
      or: [v == true or: [v == false or: [v == none]]]]]]]].
  reprOf := [:v |
    (late and: [(isLeaf value: v) not])
      ifTrue: [nil]
      ifFalse: [[(v @env1:__repr__) asString] on: AbstractException do: [:e |
        (e isKindOf: ControlInterrupt) ifTrue: [late := true].
        e return: nil]]].
  clean := [:s |
    ((s includes: field) or: [s includes: record])
      ifTrue: [s collect: [:c | (c == field or: [c == record]) ifTrue: [$?] ifFalse: [c]]]
      ifFalse: [s]].`;

/**
 * Wrap a query body so the user's `__repr__` can print without harm.
 *
 * While the cell is paused, `SessionTemps #GrailConsole` holds the cell's own
 * streaming target — a ClientForwarder — and a `print()` inside a `__repr__`
 * run from here would send to it, suspending this query at a forwarder stop it
 * cannot answer. So the query installs a throwaway WriteStream box for its own
 * duration and puts the cell's back in an `ensure:`, leaving the paused cell's
 * output exactly as it was. A `__repr__` that reaches breakpoint() or input()
 * stops the query past every handler; `queryWhilePaused` then clears its
 * stack, which is what runs the `ensure:` (measured).
 */
function withQuietConsole(body: string): string {
  return `saved := SessionTemps current at: #'GrailConsole' otherwise: nil.
SessionTemps current at: #'GrailConsole' put: (Array with: (WriteStream on: Unicode7 new)).
[${body}] ensure: [
  saved isNil
    ifTrue: [SessionTemps current removeKey: #'GrailConsole' ifAbsent: []]
    ifFalse: [SessionTemps current at: #'GrailConsole' put: saved]].`;
}

const PREAMBLE = `field := Character codePoint: 31.
record := Character codePoint: 30.
none := System myUserProfile symbolList objectNamed: #'None'.
out := WriteStream on: Unicode7 new.`;

/**
 * Smalltalk that reads the paused stack and, in the same walk, starts a fresh
 * registry for the pause and registers each frame's locals, plus the
 * notebook's globals when `scopeKey` names a scope.
 *
 * Answers `pythonStackQuery`'s records, each with one more field — the
 * registry position of that frame's locals, or 0 — and then a final record
 * with the globals' position. One walk, so a frame and its locals cannot be
 * mismatched.
 */
export function pausedStackQuery(processOop: bigint, scopeKey: string | undefined): string {
  return pythonStackQuery(processOop, {
    temps: 'reg scopes scope',
    setup: `reg := OrderedCollection new.
SessionTemps current at: #'${REGISTRY}' put: reg.`,
    perFrame: `out nextPut: field.
    [| locals |
      locals := [PyFrame ___pyLocalsFromFrameContentsList___: (p at: 5)]
        on: Error do: [:e | e return: nil].
      (locals notNil and: [locals size > 0])
        ifTrue: [reg add: { #gemdbScope. locals }. out print: reg size]
        ifFalse: [out nextPutAll: '0']] value.`,
    after: `scope := nil.
${
  scopeKey === undefined
    ? ''
    : `scopes := SessionTemps current at: #'__gemdbScopes' ifAbsent: [nil].
scopes notNil ifTrue: [scope := scopes at: '${escapeString(scopeKey)}' ifAbsent: [nil]].`
}
(scope notNil and: [scope size > 0])
  ifTrue: [reg add: { #gemdbScope. scope }. out print: reg size]
  ifFalse: [out nextPutAll: '0'].
out nextPut: record.`,
  });
}

/** Parse `pausedStackQuery`'s answer: the frames, each with its locals ref, and the globals ref. */
export function parsePausedStack(raw: string): { frames: PythonFrame[]; globals: number } {
  const records = raw.split(RECORD).filter((r) => r.length > 0);
  const globals = Number.parseInt(records.pop() ?? '', 10) || 0;
  return { frames: withoutBreakpointStub(records.map(parseFrame)), globals };
}

/**
 * Smalltalk that writes a row for each of `obj`'s children, `count` of them
 * from `start`. Expects `describe`, `childrenOf`, `nameOf`, `kids` and `last`.
 */
const LIST_CHILDREN = `
  kids := obj isNil ifTrue: [nil] ifFalse: [childrenOf value: obj].
  kids notNil ifTrue: [| kind src i |
    kind := kids at: 1.
    src := kids at: 2.
    last := (start + count) min: (kids at: 3).
    kind == #seq ifTrue: [
      (start + 1) to: last do: [:k | describe value: '[' , (k - 1) printString , ']' value: (src at: k)]].
    kind == #ivars ifTrue: [
      (start + 1) to: last do: [:k | describe value: (src at: k) value: (obj instVarAt: k)]].
    kind == #coll ifTrue: [
      i := 0.
      src do: [:x |
        i := i + 1.
        (i > start and: [i <= last]) ifTrue: [describe value: '[' , (i - 1) printString , ']' value: x]]].
    (kind == #dict or: [kind == #attrs]) ifTrue: [
      i := 0.
      src keysAndValuesDo: [:key :x |
        i := i + 1.
        (i > start and: [i <= last]) ifTrue: [
          describe value: (kind == #dict ifTrue: [nameOf value: key] ifFalse: [key asString]) value: x]]]]`;

/**
 * Smalltalk that lists the children of registry entry `ref`, `count` of them
 * from `start` (0-based), registering the expandable ones.
 *
 * Names follow what a Python user reads: a dict entry by its key's repr (so
 * `'1'` and `1` differ), a list item by `[i]`, an attribute by its name.
 *
 * A *scope* — a frame's Locals, the notebook's Globals — is registered as
 * `{#gemdbScope. dict}` and reads differently: its data is listed by name,
 * sorted, and its classes, functions and modules are folded into collapsed
 * `class variables`, `function variables` and `module variables` rows at the
 * top, as VS Code's Python debugger does, so the values being debugged are
 * not lost among definitions. Only scopes are grouped, and only scopes leave
 * out dunder names (`__builtins__`, `__name__` and friends), which are noise
 * in a namespace; a key that merely starts with `__` is kept, and an ordinary
 * dict or object shows every entry.
 */
export function childrenQuery(ref: number, start: number, count: number): string {
  return `| reg obj kids out field record none saved describe childrenOf start count last isDunder nameOf reprOf late clean isLeaf |
${PREAMBLE}
start := ${start}.
count := ${count}.
reg := SessionTemps current at: #'${REGISTRY}' otherwise: nil.
obj := (reg notNil and: [${ref} between: 1 and: reg size]) ifTrue: [reg at: ${ref}] ifFalse: [nil].
${HELPERS}
${CHILDREN_OF}
${DESCRIBE}
${withQuietConsole(`
  isDunder := [:nm |
    nm size > 4 and: [(nm copyFrom: 1 to: 2) = '__' and: [(nm copyFrom: nm size - 1 to: nm size) = '__']]].
  nameOf := [:key | (reprOf value: key) ifNil: [key printString]].
  (obj class == Array and: [obj size = 2 and: [(obj at: 1) == #gemdbScope]])
    ifTrue: [| data groups rows |
      "A scope: data first-class, the rest folded away by kind."
      data := OrderedCollection new.
      groups := { 'class variables' -> OrderedCollection new.
        'function variables' -> OrderedCollection new.
        'module variables' -> OrderedCollection new }.
      (obj at: 2) keysAndValuesDo: [:key :v | | nm tname bucket |
        nm := key asString.
        (isDunder value: nm) ifFalse: [
          tname := [((v @env1:___pyAttrLoad___: #'__class__') @env1:___pyAttrLoad___: #'__name__') asString]
            on: AbstractException do: [:e | e return: ''].
          bucket := (v notNil and: [v isBehavior])
            ifTrue: [(groups at: 1) value]
            ifFalse: [(#('function' 'builtin_function_or_method' 'method') includes: tname)
              ifTrue: [(groups at: 2) value]
              ifFalse: [tname = 'module' ifTrue: [(groups at: 3) value] ifFalse: [data]]].
          bucket add: nm -> v]].
      rows := OrderedCollection new.
      groups do: [:g | g value isEmpty ifFalse: [rows add: g]].
      rows addAll: (data asSortedCollection: [:a :b | a key <= b key]).
      last := (start + count) min: rows size.
      (start + 1) to: last do: [:i | | row n |
        row := rows at: i.
        (groups includesIdentical: row)
          ifTrue: [
            n := row value size.
            reg add: { #gemdbGroup. (row value asSortedCollection: [:a :b | a key <= b key]) asArray }.
            out nextPutAll: row key; nextPut: field; nextPut: field; nextPut: field;
              print: reg size; nextPut: field;
              print: (n > ${PAGE} ifTrue: [n] ifFalse: [0]); nextPut: field;
              print: (n > ${PAGE} ifTrue: [0] ifFalse: [n]); nextPut: field; nextPutAll: '0'; nextPut: record]
          ifFalse: [describe value: row key value: row value]].
      rows size > last ifTrue: [
        out nextPutAll: '...'; nextPut: field;
          print: rows size - last; nextPutAll: ' more not shown'; nextPut: field; nextPut: field;
          nextPutAll: '0'; nextPut: field; nextPutAll: '0'; nextPut: field; nextPutAll: '0'; nextPut: field;
          nextPutAll: '0'; nextPut: record]]
    ifFalse: [
  (obj class == Array and: [obj size = 2 and: [(obj at: 1) == #gemdbGroup]])
    ifTrue: [
      last := (start + count) min: (obj at: 2) size.
      (start + 1) to: last do: [:i | | a | a := (obj at: 2) at: i. describe value: a key value: a value]]
    ifFalse: [
${LIST_CHILDREN}]]`)}
out contents encodeAsUTF8`;
}

/** Parse `childrenQuery`'s answer. */
export function parseChildren(raw: string): PauseVariable[] {
  return raw
    .split(RECORD)
    .filter((r) => r.length > 0)
    .map((record): PauseVariable => {
      const [name, value, type, ref, indexed, named, handle] = record.split(FIELD);
      const int = (s: string | undefined): number => Number.parseInt(s ?? '', 10) || 0;
      return {
        name: name ?? '?',
        value: value ?? '',
        type: type ?? '',
        ref: int(ref),
        indexed: int(indexed),
        named: int(named),
        handle: int(handle),
      };
    });
}

/** Smalltalk that drops the pause's registry, so nothing is kept alive past the pause. */
export function clearRegistryQuery(): string {
  return `SessionTemps current removeKey: #'${REGISTRY}' ifAbsent: []. 'cleared' encodeAsUTF8`;
}

// ---------------------------------------------------------------------------
// Saving a row's object under gemdb.root.
// ---------------------------------------------------------------------------

/** A Python str literal for `text`. JSON's escapes are all valid in Python. */
function pythonString(text: string): string {
  return JSON.stringify(text);
}

/**
 * Smalltalk that runs Python in a fresh, throwaway scope — never a notebook's,
 * so nothing here leaves a name in the user's globals — with `_gemdb_value`
 * bound to registry entry `handle` when one is given. Answers the Python
 * value's printString, or an `Error: …` line.
 */
function pythonInFreshScope(source: string, handle?: number, first = ''): string {
  const bind =
    handle === undefined
      ? ''
      : `reg := SessionTemps current at: #'${REGISTRY}' otherwise: nil.
(reg notNil and: [${handle} between: 1 and: reg size])
  ifFalse: [^ 'Error: that value is no longer available' encodeAsUTF8].
scope at: #'_gemdb_value' put: (reg at: ${handle}).`;
  return `| dispatcher scope reg r |
${first}
dispatcher := System myUserProfile symbolList objectNamed: #'ModuleAst'.
scope := SymbolDictionary new.
${bind}
r := [(dispatcher evaluateSource: '${escapeString(source)}' usingModuleScope: scope) printString]
  on: AbstractException do: [:e | 'Error: ' , e class name , ' - ' , e messageText asString].
r encodeAsUTF8`;
}

/**
 * Smalltalk that answers what a good key for registry entry `handle` is made
 * of: its Python type name and, when it has one, the first of the attributes
 * that usually identify an object (`name`, `id`, …) holding a str or a number.
 */
export function saveSuggestionQuery(handle: number): string {
  return `| reg v tname label field |
field := Character codePoint: 31.
reg := SessionTemps current at: #'${REGISTRY}' otherwise: nil.
v := (reg notNil and: [${handle} between: 1 and: reg size]) ifTrue: [reg at: ${handle}] ifFalse: [nil].
tname := [((v @env1:___pyAttrLoad___: #'__class__') @env1:___pyAttrLoad___: #'__name__') asString]
  on: AbstractException do: [:e | e return: v class name asString].
label := nil.
#(#name #id #key #title #label #slug #username #email) do: [:attr | | x |
  label isNil ifTrue: [
    x := [v @env1:___pyAttrLoad___: attr] on: AbstractException do: [:e | e return: nil].
    (x notNil and: [x isString or: [x isNumber]]) ifTrue: [label := x asString]]].
(tname , (String with: field) , (label ifNil: [''])) encodeAsUTF8`;
}

/** Parse `saveSuggestionQuery`'s answer. */
export function parseSaveSuggestion(raw: string): { type: string; label?: string } {
  const [type, label] = raw.split(FIELD);
  return { type: type ?? '', ...(label ? { label } : {}) };
}

/** Smalltalk that answers the first of `base`, `base_2`, `base_3`, … not yet in gemdb.root. */
export function freeKeyQuery(base: string): string {
  return pythonInFreshScope(
    [
      'import gemdb',
      `_base = ${pythonString(base)}`,
      '_key = _base',
      '_n = 2',
      'while _key in gemdb.root:',
      '    _key = _base + "_" + str(_n)',
      '    _n += 1',
      '_key',
    ].join('\n'),
  );
}

/** Smalltalk that answers whether gemdb.root already has `key`, as `true` or `false`. */
export function keyTakenQuery(key: string): string {
  return pythonInFreshScope(`import gemdb\n${pythonString(key)} in gemdb.root`);
}

/**
 * Smalltalk that puts registry entry `handle` in gemdb.root under `key`,
 * through Python so it is exactly what `gemdb.root[key] = value` in a cell
 * would do. It does not commit: the notebook's next commit writes it, with
 * everything else the notebook has changed. Answers `'saved'` or an error.
 */
export function saveToRootQuery(handle: number, key: string): string {
  return pythonInFreshScope(
    `import gemdb\ngemdb.root[${pythonString(key)}] = _gemdb_value\n"saved"`,
    handle,
  );
}

/** A Python printString of a str, `'saved'`, back to its text. */
export function unquote(printed: string): string {
  return /^'.*'$/s.test(printed) ? printed.slice(1, -1).replace(/''/g, "'") : printed;
}

/**
 * Smalltalk that takes back saves not yet committed: deletes `keys` from
 * gemdb.root in the notebook's own session, where the save is. Nothing is
 * committed; a notebook with nothing else changed is left with nothing to do.
 */
export function removeSavedQuery(keys: string[]): string {
  return pythonInFreshScope(
    [
      'import gemdb',
      `for _key in [${keys.map(pythonString).join(', ')}]:`,
      '    if _key in gemdb.root:',
      '        del gemdb.root[_key]',
      '"removed"',
    ].join('\n'),
  );
}

/**
 * Smalltalk, for a session with no work of its own (the extension's), that
 * deletes committed `keys` from gemdb.root and commits that alone, all in one
 * commit: a fresh view first, so the commit carries nothing but the removal,
 * and a conflict leaves every key in place rather than some. Answers
 * `'removed'`, or an `Error: …` line — a conflict when another session
 * changed gemdb.root since.
 */
export function removeCommittedQuery(keys: string[]): string {
  return pythonInFreshScope(
    [
      'import gemdb',
      `for _key in [${keys.map(pythonString).join(', ')}]:`,
      '    del gemdb.root[_key]',
      'gemdb.commit()',
      '"removed"',
    ].join('\n'),
    undefined,
    'System abortTransaction.',
  );
}

/** Smalltalk that commits this session's transaction through `gemdb.commit()`. */
export function commitQuery(): string {
  return pythonInFreshScope('import gemdb\ngemdb.commit()\n"committed"');
}

/** Smalltalk that discards this session's uncommitted changes through `gemdb.abort()`. */
export function abortQuery(): string {
  return pythonInFreshScope('import gemdb\ngemdb.abort()\n"aborted"');
}

/** Smalltalk that answers whether this session has changes a commit would write. */
export function needsCommitQuery(): string {
  return `System needsCommit printString encodeAsUTF8`;
}

/** The most gemdb.root entries the Persisted Objects view lists. */
export const ROOT_LISTING_LIMIT = 200;

/**
 * Smalltalk, for a session with no work of its own (the extension's), that
 * takes a fresh view and lists what is committed under gemdb.root: one row per
 * entry, in the Variables view's row format, a str key by its text. Values
 * are shown with the same bounded repr as the debugger's rows. `gemdb.root`
 * is a Python object (`_Root`), not a Smalltalk dictionary, so its entries
 * come from its own `items()`.
 */
export function rootListingQuery(): string {
  return `| reg obj out field record none saved describe childrenOf reprOf late clean isLeaf dispatcher root |
${PREAMBLE}
reg := OrderedCollection new.
${HELPERS}
${CHILDREN_OF}
${DESCRIBE}
System abortTransaction.
dispatcher := System myUserProfile symbolList objectNamed: #'ModuleAst'.
root := dispatcher evaluateSource: 'import gemdb
list(gemdb.root.items())[:${ROOT_LISTING_LIMIT}]' usingModuleScope: SymbolDictionary new.
${withQuietConsole(`
  root do: [:pair | | key |
    key := pair at: 1.
    describe value: (key isString ifTrue: [key] ifFalse: [(reprOf value: key) ifNil: [key printString]])
      value: (pair at: 2)]`)}
out contents encodeAsUTF8`;
}

/** How many of a saved object's children its hover shows. */
export const INSPECT_ROWS = 12;

/**
 * Smalltalk that describes `gemdb.root[key]` for a hover: a first row for the
 * object itself (its counts say how many children it has), then its first
 * `INSPECT_ROWS` children. `fresh` takes a new view first — right for the
 * extension's own session, which reads what is committed, and wrong for a
 * notebook's, whose uncommitted work is the very thing being looked at.
 * Answers an `Error: …` line when the key is not there.
 */
export function inspectQuery(key: string, fresh: boolean): string {
  return `| reg obj kids out field record none saved describe childrenOf start count last nameOf reprOf late clean isLeaf dispatcher |
${PREAMBLE}
reg := OrderedCollection new.
start := 0.
count := ${INSPECT_ROWS}.
${HELPERS}
${CHILDREN_OF}
${DESCRIBE}
${fresh ? 'System abortTransaction.' : ''}
dispatcher := System myUserProfile symbolList objectNamed: #'ModuleAst'.
obj := [dispatcher evaluateSource: '${escapeString(`import gemdb\ngemdb.root[${pythonString(key)}]`)}'
    usingModuleScope: SymbolDictionary new]
  on: AbstractException do: [:e | e return: e].
(obj isKindOf: AbstractException)
  ifTrue: [('Error: ' , obj class name , ' - ' , obj messageText asString) encodeAsUTF8]
  ifFalse: [
${withQuietConsole(`
  nameOf := [:k | (reprOf value: k) ifNil: [k printString]].
  describe value: 'value' value: obj.
${LIST_CHILDREN}`)}
out contents encodeAsUTF8]`;
}
