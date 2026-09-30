/**
 * The variables of an evaluation paused at `breakpoint()`.
 *
 * The objects themselves stay in the gem. Each one the Variables view might
 * expand is put in a per-pause registry — an OrderedCollection in
 * `SessionTemps` — and the view knows it only by its position there, which is
 * the `variablesReference` the Debug Adapter Protocol hands back when a row is
 * expanded. The registry is per session and lives only as long as the pause:
 * `clearRegistry` drops it before the evaluation resumes, so nothing is kept
 * alive past the moment it could be shown.
 *
 * Locals come from Grail: `PyFrame ___pyLocalsFromFrameContentsList___:` merges
 * the Smalltalk frames one Python frame is made of, drops Grail's internal
 * temps, and adds `self`. Like the stack walk it is private to Grail, so a
 * failure costs the variables, never the pause.
 */

/** SessionTemps key of the per-pause registry. */
const REGISTRY = 'GemDbPauseRefs';

/** Field and record separators, as in haltStack.ts. */
const FIELD = '\u001f';
const RECORD = '\u001e';

/** The most rows one expansion answers, so a huge object cannot stall the editor. */
export const PAGE = 500;

/** One row of the Variables view, before it becomes a DAP Variable. */
export interface PauseVariable {
  name: string;
  value: string;
  type: string;
  /** Registry position of the object, when it has children; 0 when it has none. */
  ref: number;
  /** Children reached by position — a list's, a set's. */
  indexed: number;
  /** Children reached by name — a dict's entries, an object's attributes. */
  named: number;
}

/**
 * Smalltalk that describes `obj`'s children, one record each, and registers
 * the ones that can be expanded in turn. Shared by every query here so a local,
 * a global and a nested attribute look the same.
 *
 * Expects the temps `reg`, `out`, `field` and `record` and the block's `start`
 * and `count` to be bound. Strings are checked before collections because a
 * String is a SequenceableCollection, and a Python str should read as text,
 * not as a list of characters.
 */
const DESCRIBE = `
  describe := [:nm :v | | cls kids idx named text tname |
    text := v isNil
      ifTrue: ['nil']
      ifFalse: [[(v @env1:__repr__) asString] on: AbstractException do: [:e | e return: v class name asString]].
    text size > 300 ifTrue: [text := (text copyFrom: 1 to: 297) , '...'].
    tname := [((v @env1:___pyAttrLoad___: #'__class__') @env1:___pyAttrLoad___: #'__name__') asString]
      on: AbstractException do: [:e | e return: v class name asString].
    kids := childrenOf value: v.
    idx := 0. named := 0.
    kids notNil ifTrue: [
      (kids at: 1) == #indexed ifTrue: [idx := (kids at: 2) size] ifFalse: [named := (kids at: 2) size]].
    out nextPutAll: nm asString; nextPut: field; nextPutAll: text; nextPut: field;
      nextPutAll: tname; nextPut: field.
    (idx + named) > 0
      ifTrue: [reg add: v. out print: reg size]
      ifFalse: [out nextPutAll: '0'].
    out nextPut: field; print: idx; nextPut: field; print: named; nextPut: record].`;

/**
 * Smalltalk that answers `{#indexed. anArray}` or `{#named. anArrayOfPairs}`
 * for an object's children, or nil for a leaf. A Python instance's attributes
 * are its `__dict__`; an object with none falls back to its Smalltalk instance
 * variables, which is what a Grail runtime object shows.
 *
 * Sequences are tested before dictionaries: every Smalltalk sequence also
 * answers `keysAndValuesDo:`, with 1-based integer keys, and a Python list
 * must read as `[0]`, `[1]`, … (measured: a list came out as entries 1, 2, 3).
 */
const CHILDREN_OF = `
  childrenOf := [:v | | d |
    (v isNil or: [v isString or: [v isSymbol or: [v isNumber or: [v isCharacter or: [v == true or: [v == false or: [v == none]]]]]]])
      ifTrue: [nil]
      ifFalse: [
        (v isKindOf: SequenceableCollection)
          ifTrue: [{ #indexed. v asArray }]
          ifFalse: [
            (v respondsTo: #keysAndValuesDo:)
              ifTrue: [| pairs | pairs := OrderedCollection new.
                v keysAndValuesDo: [:k :x | pairs add: { k. x }].
                { #named. pairs asArray }]
              ifFalse: [
                (v isKindOf: Collection)
                  ifTrue: [{ #indexed. v asArray }]
                  ifFalse: [
                    d := [v @env1:___pyAttrLoad___: #'__dict__'] on: AbstractException do: [:e | e return: nil].
                    (d notNil and: [d respondsTo: #keysAndValuesDo:])
                      ifTrue: [| pairs | pairs := OrderedCollection new.
                        d keysAndValuesDo: [:k :x | pairs add: { k. x }].
                        { #named. pairs asArray }]
                      ifFalse: [| names |
                        names := v class allInstVarNames.
                        names isEmpty
                          ifTrue: [nil]
                          ifFalse: [{ #named. (1 to: names size) collect: [:i | { names at: i. v instVarAt: i }] }]]]]]]].`;

/**
 * Wrap a query body so the user's `__repr__` can print without harm.
 *
 * While the cell is paused, `SessionTemps #GrailConsole` holds the cell's own
 * streaming target — a ClientForwarder — and a `print()` inside a `__repr__`
 * run from here would send to it, suspending this query at a forwarder stop it
 * cannot answer. So the query installs a throwaway WriteStream box for its own
 * duration and puts the cell's back in an `ensure:`, leaving the paused cell's
 * output exactly as it was.
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

/** Escape a string for a Smalltalk literal. */
function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Smalltalk that starts a fresh registry for a pause and registers each
 * frame's locals, plus the notebook's globals when `scopeKey` names a scope.
 *
 * Answers one record per Python frame — the registry position of its locals,
 * or 0 — in the order `pythonStackQuery` lists them, and then a final record
 * with the globals' position. The frames come from the same Grail walk, so the
 * two queries agree on which frame is which.
 */
export function registerFramesQuery(processOop: bigint, scopeKey: string | undefined): string {
  return `| proc both pairs reg out field record none scopes scope |
${PREAMBLE}
proc := Object _objectForOop: ${processOop}.
reg := OrderedCollection new.
SessionTemps current at: #'${REGISTRY}' put: reg.
both := BaseException ___framesAndLevelsOfSuspendedProcess___: proc.
both isNil ifFalse: [
  pairs := BaseException ___liveFramePairsFrom___: (both at: 1)
    generatorBody: false levels: (both at: 2) offset: 0 running: false.
  pairs do: [:p | | locals |
    locals := [PyFrame ___pyLocalsFromFrameContentsList___: (p at: 5)]
      on: Error do: [:e | e return: nil].
    (locals notNil and: [locals size > 0])
      ifTrue: [reg add: { #gemdbScope. locals }. out print: reg size]
      ifFalse: [out nextPutAll: '0'].
    out nextPut: record]].
scope := nil.
${
  scopeKey === undefined
    ? ''
    : `scopes := SessionTemps current at: #'__gemdbScopes' ifAbsent: [nil].
scopes notNil ifTrue: [scope := scopes at: ${literal(scopeKey)} ifAbsent: [nil]].`
}
(scope notNil and: [scope size > 0])
  ifTrue: [reg add: { #gemdbScope. scope }. out print: reg size]
  ifFalse: [out nextPutAll: '0'].
out nextPut: record.
out contents encodeAsUTF8`;
}

/** Parse `registerFramesQuery`'s answer: locals refs per frame, then the globals ref. */
export function parseFrameRefs(raw: string): { locals: number[]; globals: number } {
  const refs = raw
    .split(RECORD)
    .filter((r) => r.length > 0)
    .map((r) => Number.parseInt(r, 10) || 0);
  const globals = refs.pop() ?? 0;
  return { locals: refs, globals };
}

/**
 * Smalltalk that lists the children of registry entry `ref`, `count` of them
 * from `start` (0-based), registering the expandable ones.
 *
 * Names follow what a Python user reads: a dict entry by its key's repr, a list
 * item by `[i]`, an attribute by its name.
 *
 * A *scope* — a frame's Locals, the notebook's Globals — is registered as
 * `{#gemdbScope. dict}` and reads differently: its data is listed by name,
 * sorted, and its classes, functions and modules are folded into collapsed
 * `class variables`, `function variables` and `module variables` rows at the
 * top, as VS Code's Python debugger does, so the values being debugged are
 * not lost among definitions. Only scopes are grouped; an ordinary dict that
 * holds functions shows every entry. Dunder names (`__builtins__`,
 * `__name__` and friends) are left out, as they are noise in a namespace; a
 * key that merely starts with `__` is kept.
 */
export function childrenQuery(ref: number, start: number, count: number): string {
  return `| reg obj kids out field record none saved describe childrenOf start count isDunder nameOf |
${PREAMBLE}
start := ${start}.
count := ${count}.
reg := SessionTemps current at: #'${REGISTRY}' otherwise: nil.
obj := (reg notNil and: [${ref} between: 1 and: reg size]) ifTrue: [reg at: ${ref}] ifFalse: [nil].
${CHILDREN_OF}
${DESCRIBE}
${withQuietConsole(`
  isDunder := [:key :nm |
    (key isString or: [key isSymbol])
      and: [nm size > 4 and: [(nm copyFrom: 1 to: 2) = '__' and: [(nm copyFrom: nm size - 1 to: nm size) = '__']]]].
  nameOf := [:key |
    (key isString or: [key isSymbol])
      ifTrue: [key asString]
      ifFalse: [[(key @env1:__repr__) asString] on: AbstractException do: [:e | e return: key printString]]].
  (obj class == Array and: [obj size = 2 and: [(obj at: 1) == #gemdbScope]])
    ifTrue: [| data groups |
      "A scope: data first-class, the rest folded away by kind."
      data := OrderedCollection new.
      groups := { 'class variables' -> OrderedCollection new.
        'function variables' -> OrderedCollection new.
        'module variables' -> OrderedCollection new }.
      (obj at: 2) keysAndValuesDo: [:key :v | | nm tname bucket |
        nm := nameOf value: key.
        (isDunder value: key value: nm) ifFalse: [
          tname := [((v @env1:___pyAttrLoad___: #'__class__') @env1:___pyAttrLoad___: #'__name__') asString]
            on: AbstractException do: [:e | e return: ''].
          bucket := (v notNil and: [v isBehavior])
            ifTrue: [(groups at: 1) value]
            ifFalse: [(#('function' 'builtin_function_or_method' 'method') includes: tname)
              ifTrue: [(groups at: 2) value]
              ifFalse: [tname = 'module' ifTrue: [(groups at: 3) value] ifFalse: [data]]].
          bucket add: nm -> v]].
      groups do: [:g |
        g value isEmpty ifFalse: [
          reg add: { #gemdbGroup. (g value asSortedCollection: [:a :b | a key <= b key]) asArray }.
          out nextPutAll: g key; nextPut: field; nextPut: field; nextPut: field;
            print: reg size; nextPut: field; print: 0; nextPut: field; print: g value size; nextPut: record]].
      (data asSortedCollection: [:a :b | a key <= b key]) do: [:a | describe value: a key value: a value]]
    ifFalse: [
  (obj class == Array and: [obj size = 2 and: [(obj at: 1) == #gemdbGroup]])
    ifTrue: [(obj at: 2) do: [:a | describe value: a key value: a value]]
    ifFalse: [
  kids := obj isNil ifTrue: [nil] ifFalse: [childrenOf value: obj].
  kids notNil ifTrue: [| items shown |
    items := kids at: 2.
    shown := 0.
    (kids at: 1) == #indexed
      ifTrue: [
        (start + 1) to: ((start + count) min: items size) do: [:i |
          describe value: '[' , (i - 1) printString , ']' value: (items at: i)]]
      ifFalse: [
        items do: [:pair | | key nm |
          key := pair at: 1.
          nm := nameOf value: key.
          (isDunder value: key value: nm)
            ifFalse: [
              shown >= start ifTrue: [
                (shown - start) < count ifTrue: [describe value: nm value: (pair at: 2)]].
              shown := shown + 1]]]]]]`)}
out contents encodeAsUTF8`;
}

/** Parse `childrenQuery`'s answer. */
export function parseChildren(raw: string): PauseVariable[] {
  return raw
    .split(RECORD)
    .filter((r) => r.length > 0)
    .map((record): PauseVariable => {
      const [name, value, type, ref, indexed, named] = record.split(FIELD);
      const int = (s: string | undefined): number => Number.parseInt(s ?? '', 10) || 0;
      return {
        name: name ?? '?',
        value: value ?? '',
        type: type ?? '',
        ref: int(ref),
        indexed: int(indexed),
        named: int(named),
      };
    });
}

/** Smalltalk that drops the pause's registry, so nothing is kept alive past the pause. */
export function clearRegistryQuery(): string {
  return `SessionTemps current removeKey: #'${REGISTRY}' ifAbsent: []. 'cleared' encodeAsUTF8`;
}
