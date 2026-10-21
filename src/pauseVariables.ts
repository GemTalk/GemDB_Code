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

/** SessionTemps key of the per-pause registry (a saved stack opened again uses it too). */
export const REGISTRY = 'GemDbPauseRefs';

/**
 * SessionTemps key of the Persisted Objects view's registry: the objects its
 * rows open, kept apart from the pause's because that one is dropped at every
 * resume, and this view is read with nothing paused. It is started afresh by
 * every reading of the view (`rootListingQuery`, `persistedRowsQuery`), so it
 * holds no more than the rows the view has shown since.
 */
export const PERSISTED_REGISTRY = 'GemDbPersistedRefs';

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
  /**
   * How many items a container holds — a list's, a dict's, a set's — for the
   * size in the row's badge; -1 for anything that is not a container.
   */
  size: number;
  /** The row cannot be changed with Set Value: a tuple's item, a group heading, a method's `self`. */
  readOnly: boolean;
  /**
   * How its children are read, when it has any (`CHILDREN_OF`): `seq`, `coll`
   * and `dict` are containers, `obj` and `ivars` an object's attributes.
   * Absent on a row with no object, such as a group heading.
   */
  kind?: ChildKind;
}

export type ChildKind = 'seq' | 'coll' | 'dict' | 'obj' | 'ivars';

/**
 * Smalltalk that answers `{kind. source. size}` for an object's children, or
 * nil for a leaf. `kind` is `#seq` (read by position), `#coll` (a set: read in
 * order), `#dict` (entries named by their key's repr), `#obj` (a Python
 * object, read by attribute; `source` is its `__dict__`, or nil for a
 * `__slots__` object, which has none) or `#ivars` (a Grail runtime object, with
 * neither, shown by its Smalltalk instance variables, whose names are
 * `source`). Nothing is copied.
 *
 * This runs for every row listed, to tell whether the row opens and how big
 * it is, so it stays as cheap as it was before objects were read whole: one
 * `__dict__` load, and for an object without one, one `__slots__` load. The
 * object's whole `dir()` is read only when the row is opened (`LIST_CHILDREN`).
 * Measured on a page of 500 objects: calling `dir()` here instead took the
 * page from about 17 ms to about 980 ms, half the two-second budget.
 *
 * So an object's size is its own attributes. An object with none of its own
 * still opens when its class gives it data — class attributes, properties —
 * as a settings object or a singleton does; `classData` answers that, reading
 * the class's `dir()` once per class per query, so a page of 500 instances of
 * one class costs one `dir()`. An object with neither — a function, an
 * instance of an empty class or of one with only methods — stays a leaf.
 *
 * Sequences are tested before dictionaries: every Smalltalk sequence also
 * answers `keysAndValuesDo:`, with 1-based integer keys, and a Python list
 * must read as `[0]`, `[1]`, … (measured: a list came out as entries 1, 2, 3).
 */
export const CHILDREN_OF = `
  childrenOf := [:v | | d ds slots names |
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
                      ifTrue: [
                        "Sized once: a Python object's __dict__ counts its attributes
                         each time it is asked, and this runs for every row."
                        ds := d size.
                        ds > 0
                          ifTrue: [{ #obj. d. ds }]
                          ifFalse: [| fromClass |
                            fromClass := classData value: v.
                            fromClass > 0 ifTrue: [{ #obj. nil. fromClass }] ifFalse: [nil]]]
                      ifFalse: [
                        slots := [v @env1:___pyAttrLoad___: #'__slots__'] on: AbstractException do: [:e | e return: nil].
                        (slots notNil and: [slots ~~ none and: [slots size > 0]])
                          ifTrue: [{ #obj. nil. slots isString ifTrue: [1] ifFalse: [slots size] }]
                          ifFalse: [
                            names := v class allInstVarNames.
                            names isEmpty ifTrue: [nil] ifFalse: [{ #ivars. names. names size }]]]]]]]].`;

/**
 * Smalltalk that writes one row for `v`, named `nm`, and registers `v` — as
 * the row's `ref` when it has children, and always as its `handle`. Whether
 * the row can be changed is `ro`, which the caller sets for each row. The row
 * ends with the kind `childrenOf` reads its children by, or nothing for a leaf.
 *
 * Its repr is the user's `__repr__`, run through `reprOf`: a big container
 * shows its size instead (a container only: a module or an object with many
 * attributes keeps its repr), and a long string is asked for the repr of its
 * first characters only. Strings are checked before collections (in
 * `childrenOf`) because a String is a SequenceableCollection, and a Python str
 * should read as text, not as a list of characters.
 */
export const DESCRIBE = `
  describe := [:nm :v | | kids n text tname idx named container |
   v == tooLong
    ifTrue: [
      out nextPutAll: (clean value: nm asString); nextPut: field; nextPutAll: '<getter took too long>';
        nextPut: field; nextPut: field; nextPutAll: '0'; nextPut: field; nextPutAll: '0'; nextPut: field;
        nextPutAll: '0'; nextPut: field; nextPutAll: '0'; nextPut: field; nextPutAll: '-1'; nextPut: field;
        nextPutAll: '1'; nextPut: record]
    ifFalse: [
    "Inline rather than through typeNameOf: this runs for every row listed."
    tname := [((v @env1:___pyAttrLoad___: #'__class__') @env1:___pyAttrLoad___: #'__name__') asString]
      on: AbstractException do: [:e | e return: v class name asString].
    kids := childrenOf value: v.
    n := kids isNil ifTrue: [0] ifFalse: [kids at: 3].
    container := kids notNil and: [(kids at: 1) ~~ #obj and: [(kids at: 1) ~~ #ivars]].
    text := v isNil
      ifTrue: ['nil']
      ifFalse: [(container and: [n > ${REPR_ITEMS}])
        ifTrue: [tname , ' with ' , n printString , ' items']
        ifFalse: [(v isString and: [v size > ${VALUE_CHARS}])
          ifTrue: [reprOf value: (v copyFrom: 1 to: ${VALUE_CHARS})]
          ifFalse: [reprOf value: v]]].
    text isNil ifTrue: [text := late ifTrue: ['<__repr__ took too long>'] ifFalse: [tname]].
    text size > ${VALUE_CHARS} ifTrue: [text := (text copyFrom: 1 to: ${VALUE_CHARS - 3}) , '...'].
    idx := 0. named := 0.
    "An object's rows are grouped, and a group cannot be paged into, so an
     object never reports its children as indexed, however many it has."
    n > 0 ifTrue: [
      (((kids at: 1) == #seq or: [(kids at: 1) == #coll]) or: [n > ${PAGE} and: [(kids at: 1) ~~ #obj]])
        ifTrue: [idx := n] ifFalse: [named := n]].
    out nextPutAll: (clean value: nm asString); nextPut: field; nextPutAll: (clean value: text); nextPut: field;
      nextPutAll: (clean value: tname); nextPut: field.
    reg add: v.
    n > 0
      ifTrue: [out print: reg size]
      ifFalse: [out nextPutAll: '0'].
    out nextPut: field; print: idx; nextPut: field; print: named; nextPut: field; print: reg size; nextPut: field.
    out print: (container ifTrue: [n] ifFalse: [-1]);
      nextPut: field; nextPutAll: (ro == true ifTrue: ['1'] ifFalse: ['0']);
      nextPut: field; nextPutAll: (kids isNil ifTrue: [''] ifFalse: [kids at: 1]); nextPut: record]].`;

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
 *
 * `isDunder` is a name like `__init__`: two underscores at each end.
 *
 * `typeNameOf` is the Python type name, `__class__.__name__`, or the Smalltalk
 * class name for an object Python does not describe.
 *
 * `broke` is for a handler around the user's own code — a getter, a `__dir__`
 * — that catches every exception: when the one caught is the soft break, it
 * sets `late`, as `reprOf` does, so what follows stops running the user's
 * code rather than spending another budget on each slow getter.
 *
 * `classData` counts the data a class gives its instances — class
 * attributes, properties: names that are not dunders, methods or classes —
 * cached per class in `classCounts`. `tooLong` stands in for an attribute
 * whose getter ran past the budget, or was skipped after one did; `describe`
 * writes it as such.
 */
export const HELPERS = `
  late := false.
  ro := false.
  isDunder := [:nm |
    nm size > 4 and: [(nm copyFrom: 1 to: 2) = '__' and: [(nm copyFrom: nm size - 1 to: nm size) = '__']]].
  typeNameOf := [:v |
    [((v @env1:___pyAttrLoad___: #'__class__') @env1:___pyAttrLoad___: #'__name__') asString]
      on: AbstractException do: [:e | e return: v class name asString]].
  broke := [:e | (e isKindOf: ControlInterrupt) ifTrue: [late := true]. e].
  isMethodType := [:tname |
    #('function' 'builtin_function_or_method' 'method' 'BoundMethod' 'staticmethod' 'classmethod'
      'method-wrapper' 'wrapper_descriptor' 'method_descriptor' 'classmethod_descriptor') includes: tname].
  classCounts := IdentityDictionary new.
  classData := [:v |
    late
      ifTrue: [0]
      ifFalse: [
        "Keyed by the Smalltalk class, a primitive, so a cached answer costs no
         Python attribute load; the Python class is read only on a miss."
        classCounts at: v class ifAbsent: [| n names cls |
          n := 0.
          cls := [v @env1:___pyAttrLoad___: #'__class__'] on: AbstractException do: [:e | e return: nil].
          names := cls isNil
            ifTrue: [#()]
            ifFalse: [[cls @env1:__dir__] on: AbstractException do: [:e | (broke value: e) return: #()]].
          names do: [:nm | | x ok |
            (late or: [isDunder value: nm asString]) ifFalse: [
              ok := true.
              x := [cls @env1:___pyAttrLoad___: nm asString asSymbol]
                on: AbstractException do: [:e | ok := false. (broke value: e) return: nil].
              (ok and: [(x notNil and: [x isBehavior]) not
                  and: [(isMethodType value: (typeNameOf value: x)) not]])
                ifTrue: [n := n + 1]]].
          classCounts at: v class put: n.
          n]]].
  tooLong := Object new.
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
export function withQuietConsole(body: string): string {
  return `saved := SessionTemps current at: #'GrailConsole' otherwise: nil.
SessionTemps current at: #'GrailConsole' put: (Array with: (WriteStream on: Unicode7 new)).
[${body}] ensure: [
  saved isNil
    ifTrue: [SessionTemps current removeKey: #'GrailConsole' ifAbsent: []]
    ifFalse: [SessionTemps current at: #'GrailConsole' put: saved]].`;
}

/**
 * The temps `HELPERS`, `CHILDREN_OF` and `DESCRIBE` use beyond the row's own
 * (`reg out field record none describe childrenOf reprOf late clean
 * isLeaf`), for a query that writes rows without listing children.
 */
export const ROW_TEMPS = 'ro isDunder typeNameOf broke classCounts classData isMethodType tooLong';

export const PREAMBLE = `field := Character codePoint: 31.
record := Character codePoint: 30.
none := System myUserProfile symbolList objectNamed: #'None'.
out := WriteStream on: Unicode7 new.`;

/**
 * A file run's globals live in its `__main__` module, not in a notebook scope:
 * `pausedStackQuery` and `saveStackQuery` are handed this in place of a scope key.
 */
export const MAIN_MODULE = Symbol('__main__');
export type MainModule = typeof MAIN_MODULE;

/** Smalltalk answering the running script's `__main__` globals, or nil. */
export const MAIN_MODULE_GLOBALS = `[((System myUserProfile symbolList objectNamed: #'ModuleAst')
    evaluateSource: 'import sys
sys.modules["__main__"]') @env1:__dict__]
  on: AbstractException do: [:e | e return: nil]`;

/**
 * Smalltalk that reads the paused stack and, in the same walk, starts a fresh
 * registry for the pause and registers each frame's locals, plus the
 * notebook's globals when `scopeKey` names a scope, or a file run's when it is
 * `MAIN_MODULE`. A frame's locals are registered with the levels of the
 * Smalltalk frames they were read from, innermost first, so Set Value can
 * write a local back into the paused frame (`setVariableQuery`), and with the
 * names of the temps those frames hold a value in: the locals a write can
 * reach. The receiver is not among them. Grail adds it to the locals under
 * the name the def gave it (`self`, `cls`, …), but it is the frame's
 * receiver, not a temp.
 *
 * Answers `pythonStackQuery`'s records, each with one more field — the
 * registry position of that frame's locals, or 0 — and then a final record
 * with the globals' position. One walk, so a frame and its locals cannot be
 * mismatched. `atStepPoint` is for a stop at a red dot (see `pythonStackQuery`).
 */
export function pausedStackQuery(
  processOop: bigint,
  scopeKey: string | MainModule | undefined,
  atStepPoint = false,
): string {
  return pythonStackQuery(
    processOop,
    {
      temps: 'reg scopes scope',
      setup: `reg := OrderedCollection new.
SessionTemps current at: #'${REGISTRY}' put: reg.`,
      perFrame: `out nextPut: field.
    [| locals levels temps |
      locals := [PyFrame ___pyLocalsFromFrameContentsList___: (p at: 5)]
        on: Error do: [:e | e return: nil].
      levels := [((p at: 5) collect: [:fc | (both at: 2) indexOfIdentical: fc])
          reject: [:lvl | lvl = 0]]
        on: Error do: [:e | e return: #()].
      temps := Set new.
      [(p at: 5) do: [:fc | | names |
          names := fc at: 9.
          names notNil ifTrue: [
            1 to: names size do: [:i | (fc atOrNil: 10 + i) notNil ifTrue: [temps add: (names at: i) asString]]]]]
        on: Error do: [:e | e return: nil].
      (locals notNil and: [locals size > 0])
        ifTrue: [reg add: { #gemdbScope. locals. levels asArray. temps asArray }. out print: reg size]
        ifFalse: [out nextPutAll: '0']] value.`,
      after: `scope := nil.
${
  scopeKey === undefined
    ? ''
    : scopeKey === MAIN_MODULE
      ? `scope := ${MAIN_MODULE_GLOBALS}.`
      : `scopes := SessionTemps current at: #'__gemdbScopes' ifAbsent: [nil].
scopes notNil ifTrue: [scope := scopes at: '${escapeString(scopeKey)}' ifAbsent: [nil]].`
}
(scope notNil and: [scope size > 0])
  ifTrue: [reg add: { #gemdbScope. scope }. out print: reg size]
  ifFalse: [out nextPutAll: '0'].
out nextPut: record.`,
    },
    atStepPoint,
  );
}

/** Parse `pausedStackQuery`'s answer: the frames, each with its locals ref, and the globals ref. */
export function parsePausedStack(raw: string): { frames: PythonFrame[]; globals: number } {
  const records = raw.split(RECORD).filter((r) => r.length > 0);
  const globals = Number.parseInt(records.pop() ?? '', 10) || 0;
  return { frames: withoutBreakpointStub(records.map(parseFrame)), globals };
}

/**
 * Smalltalk for the rows of a namespace — a scope, or an object's attributes —
 * folded the way VS Code's Python debugger folds them, so the values being
 * debugged are not lost among definitions: dunders under `special variables`,
 * then `class variables`, `function variables` and `module variables`, each a
 * collapsed row, and the data after them, sorted by name.
 *
 * `emitGrouped value: pairs value: specials value: owner value: withGroups`
 * writes `count` rows from `start` of `pairs` (name -> value associations).
 * `specials` false leaves the dunders out altogether, as a scope does: there
 * they are noise (`__builtins__`, `__name__`), where on an object they are
 * what the object is. `withGroups` false writes only the data rows, for a
 * hover. Each group is registered as `{#gemdbGroup. rows. owner}`, so a
 * change to a row inside it reaches the scope or object it came from.
 *
 * A module is told by its class, not its type name: Grail gives each module a
 * class of its own, so `os` reports its type as `os`, and only `isKindOf:` the
 * `module` class finds it (as `pythonStackQuery` does).
 *
 * `roIn` says whether `owner`'s row `nm` cannot be changed. A frame's Locals
 * are `{#gemdbScope. dict. levels. temps}`, the levels of the Smalltalk frames
 * that hold them and the temps those frames hold values in: a local that is
 * not a temp — the receiver, whether the def calls it `self`, `cls` or
 * anything else — cannot be reassigned, and a frame whose levels were not
 * found cannot be written at all. Globals, and an
 * object's attributes, can be changed.
 */
const GROUPED = `
  roIn := [:c :nm |
    (c class == Array and: [c size >= 2 and: [(c at: 1) == #gemdbScope]])
      ifTrue: [c size >= 3 and: [(c at: 3) isEmpty or: [c size < 4 or: [((c at: 4) includes: nm) not]]]]
      ifFalse: [c isNil]].
  moduleClass := false.
  groupOf := [:v | | tname |
    (v notNil and: [v isBehavior])
      ifTrue: [2]
      ifFalse: [
        tname := typeNameOf value: v.
        (isMethodType value: tname)
          ifTrue: [3]
          ifFalse: [
            "Looked up on first use: a symbol-list search costs every listing that pays it."
            moduleClass == false ifTrue: [moduleClass := System myUserProfile symbolList objectNamed: #'module'].
            (tname = 'module' or: [moduleClass notNil and: [v isKindOf: moduleClass]])
              ifTrue: [4]
              ifFalse: [0]]]].
  emitGrouped := [:pairs :specials :owner :withGroups | | groups data rows |
    groups := { 'special variables' -> OrderedCollection new.
      'class variables' -> OrderedCollection new.
      'function variables' -> OrderedCollection new.
      'module variables' -> OrderedCollection new }.
    data := OrderedCollection new.
    pairs do: [:a | | g |
      (isDunder value: a key)
        ifTrue: [specials ifTrue: [(groups at: 1) value add: a]]
        ifFalse: [
          g := groupOf value: a value.
          g = 0 ifTrue: [data add: a] ifFalse: [(groups at: g) value add: a]]].
    rows := OrderedCollection new.
    withGroups ifTrue: [groups do: [:g | g value isEmpty ifFalse: [rows add: g]]].
    rows addAll: (data asSortedCollection: [:x :y | x key <= y key]).
    last := (start + count) min: rows size.
    (start + 1) to: last do: [:i | | row n |
      row := rows at: i.
      (groups includesIdentical: row)
        ifTrue: [
          n := row value size.
          reg add: { #gemdbGroup. (row value asSortedCollection: [:x :y | x key <= y key]) asArray. owner }.
          out nextPutAll: row key; nextPut: field; nextPut: field; nextPut: field;
            print: reg size; nextPut: field;
            print: (n > ${PAGE} ifTrue: [n] ifFalse: [0]); nextPut: field;
            print: (n > ${PAGE} ifTrue: [0] ifFalse: [n]); nextPut: field; nextPutAll: '0'; nextPut: field;
            nextPutAll: '-1'; nextPut: field; nextPutAll: '1'; nextPut: record]
        ifFalse: [
          ro := roIn value: owner value: row key.
          describe value: row key value: row value]].
    rows size > last ifTrue: [
      out nextPutAll: '...'; nextPut: field;
        print: rows size - last; nextPutAll: ' more not shown'; nextPut: field; nextPut: field;
        nextPutAll: '0'; nextPut: field; nextPutAll: '0'; nextPut: field; nextPutAll: '0'; nextPut: field;
        nextPutAll: '0'; nextPut: field; nextPutAll: '-1'; nextPut: field; nextPutAll: '1'; nextPut: record]].`;

/**
 * Smalltalk that writes a row for each of `obj`'s children, `count` of them
 * from `start`. Expects `describe`, `childrenOf`, `nameOf`, `emitGrouped`,
 * `withGroups`, `kids` and `last`.
 *
 * Which rows Set Value may change follows the container: a list's items, a
 * dict's entries and an object's attributes can be; a tuple's, a str's, a
 * set's (which has no positions to assign to), a class's `__dict__` (a
 * read-only mappingproxy) and a Grail runtime object's instance variables
 * cannot.
 *
 * An opened object lists everything its `dir()` names — its own attributes,
 * its class's, its properties and `__slots__`, and the dunders, which
 * `emitGrouped` folds — read with getattr, so a property's getter runs, as it
 * does in VS Code's and PyCharm's Python debuggers. An attribute that raises —
 * an unset slot, a property that fails — is left out. Past the time budget no
 * more getters run: the getter the soft break stopped, and every later
 * attribute the object does not hold itself, reads `<getter took too long>`;
 * a `__dir__` the break stopped leaves the attributes the object holds
 * itself. A hover
 * (`withGroups` false) lists only what the object holds itself, its
 * `__dict__`, which is what the row's size counted.
 */
const LIST_CHILDREN = `
  kids := obj isNil ifTrue: [nil] ifFalse: [childrenOf value: obj].
  kids notNil ifTrue: [| kind src i ctype pairs |
    kind := kids at: 1.
    src := kids at: 2.
    ctype := typeNameOf value: obj.
    last := (start + count) min: (kids at: 3).
    kind == #seq ifTrue: [
      "A tuple, a namedtuple or another tuple subclass, bytes or a range: told
       by the type's ancestry, not by its name. A plain list or tuple, the
       common case, is answered without walking its ancestry."
      ro := ctype = 'list' ifTrue: [false] ifFalse: [ctype = 'tuple' or: [
        ([(obj @env1:___pyAttrLoad___: #'__class__') @env1:___pyAttrLoad___: #'__mro__']
          on: AbstractException do: [:e | e return: #()])
        anySatisfy: [:c | | cn cm |
          cn := [(c @env1:___pyAttrLoad___: #'__name__') asString] on: AbstractException do: [:e | e return: ''].
          cm := [(c @env1:___pyAttrLoad___: #'__module__') asString] on: AbstractException do: [:e | e return: ''].
          (#('tuple' 'bytes' 'range') includes: cn) and: [cm = 'builtins']]]].
      (start + 1) to: last do: [:k | describe value: '[' , (k - 1) printString , ']' value: (src at: k)]].
    kind == #ivars ifTrue: [
      ro := true.
      (start + 1) to: last do: [:k | describe value: (src at: k) value: (obj instVarAt: k)]].
    kind == #coll ifTrue: [
      ro := true.
      i := 0.
      src do: [:x |
        i := i + 1.
        (i > start and: [i <= last]) ifTrue: [describe value: '[' , (i - 1) printString , ']' value: x]]].
    kind == #dict ifTrue: [
      ro := ctype = 'mappingproxy'.
      i := 0.
      src keysAndValuesDo: [:key :x |
        i := i + 1.
        (i > start and: [i <= last]) ifTrue: [describe value: (nameOf value: key) value: x]]].
    kind == #obj ifTrue: [
      (withGroups not and: [src notNil])
        ifTrue: [
          "A hover lists what the object holds itself, which is what its size counts."
          ro := false.
          i := 0.
          src keysAndValuesDo: [:key :x |
            i := i + 1.
            (i > start and: [i <= last]) ifTrue: [describe value: key asString value: x]]]
        ifFalse: [| names own |
          "What the object holds itself, readable without running its code."
          own := Dictionary new.
          src notNil ifTrue: [src keysAndValuesDo: [:key :x | own at: key asString put: x]].
          names := late
            ifTrue: [nil]
            ifFalse: [[obj @env1:__dir__] on: AbstractException do: [:e | (broke value: e) return: nil]].
          names isNil ifTrue: [names := own keys asSortedCollection asArray].
          pairs := OrderedCollection new.
          names do: [:nm | | key x ok |
            key := nm asString.
            late
              ifTrue: [
                (own includesKey: key)
                  ifTrue: [pairs add: key -> (own at: key)]
                  ifFalse: [(isDunder value: key) ifFalse: [pairs add: key -> tooLong]]]
              ifFalse: [
                ok := true.
                x := [obj @env1:___pyAttrLoad___: key asSymbol]
                  on: AbstractException do: [:e | ok := false. (broke value: e) return: nil].
                ok
                  ifTrue: [pairs add: key -> x]
                  ifFalse: [late ifTrue: [pairs add: key -> tooLong]]]].
          emitGrouped value: pairs value: true value: obj value: withGroups]]]`;

/**
 * Smalltalk that lists the children of registry entry `ref`, `count` of them
 * from `start` (0-based), registering the expandable ones. `registry` is the
 * pause's by default, or `PERSISTED_REGISTRY` for the Persisted Objects view.
 *
 * Names follow what a Python user reads: a dict entry by its key's repr (so
 * `'1'` and `1` differ), a list item by `[i]`, an attribute by its name.
 *
 * A *scope* — a frame's Locals, the notebook's Globals — is registered as
 * `{#gemdbScope. dict}` (Locals add the frame's levels, see `GROUPED`) and is
 * grouped like an object, except that its dunder names (`__builtins__`,
 * `__name__` and friends) are left out rather than folded: in a namespace
 * they are noise. A key that merely starts with `__` is kept, and an ordinary
 * dict shows every entry, dunder keys included.
 */
export function childrenQuery(
  ref: number,
  start: number,
  count: number,
  registry: string = REGISTRY,
): string {
  return `| reg obj kids out field record none saved describe childrenOf start count last isDunder nameOf reprOf late clean isLeaf ro typeNameOf roIn groupOf emitGrouped withGroups moduleClass broke classCounts classData isMethodType tooLong |
${PREAMBLE}
start := ${start}.
count := ${count}.
withGroups := true.
reg := SessionTemps current at: #'${registry}' otherwise: nil.
obj := (reg notNil and: [${ref} between: 1 and: reg size]) ifTrue: [reg at: ${ref}] ifFalse: [nil].
${HELPERS}
${CHILDREN_OF}
${DESCRIBE}
${GROUPED}
${withQuietConsole(`
  nameOf := [:key | (reprOf value: key) ifNil: [key printString]].
  (obj class == Array and: [obj size >= 2 and: [(obj at: 1) == #gemdbScope]])
    ifTrue: [| pairs |
      pairs := OrderedCollection new.
      (obj at: 2) keysAndValuesDo: [:key :v | pairs add: key asString -> v].
      emitGrouped value: pairs value: false value: obj value: true]
    ifFalse: [
  (obj class == Array and: [obj size >= 2 and: [(obj at: 1) == #gemdbGroup]])
    ifTrue: [| owner |
      owner := obj size >= 3 ifTrue: [obj at: 3] ifFalse: [nil].
      last := (start + count) min: (obj at: 2) size.
      (start + 1) to: last do: [:i | | a |
        a := (obj at: 2) at: i.
        ro := roIn value: owner value: a key.
        describe value: a key value: a value]]
    ifFalse: [
${LIST_CHILDREN}]]`)}
out contents encodeAsUTF8`;
}

/**
 * Smalltalk that answers where a dict's key is among its entries — the
 * position `childrenQuery` lists it at, from 0 — or -1 when none of its keys
 * reads as one of `names`. A key reads as `childrenQuery` names its row: by
 * its repr, so `'SKU0042'` for a str and `42` for an int; the caller passes
 * the forms the user might have meant. Answers -1 for anything not a dict.
 */
export function keyPositionQuery(
  ref: number,
  names: string[],
  registry: string = REGISTRY,
): string {
  const want = names.map((n) => `'${escapeString(n)}'`).join(' ');
  return `| reg obj kids out field record none saved describe childrenOf nameOf reprOf late clean isLeaf want pos i ${ROW_TEMPS} |
${PREAMBLE}
reg := SessionTemps current at: #'${registry}' otherwise: nil.
obj := (reg notNil and: [${ref} between: 1 and: reg size]) ifTrue: [reg at: ${ref}] ifFalse: [nil].
${HELPERS}
${CHILDREN_OF}
${DESCRIBE}
want := #(${want}).
pos := -1.
i := 0.
${withQuietConsole(`
  nameOf := [:key | (reprOf value: key) ifNil: [key printString]].
  kids := obj isNil ifTrue: [nil] ifFalse: [childrenOf value: obj].
  (kids notNil and: [(kids at: 1) == #dict]) ifTrue: [
    (kids at: 2) keysAndValuesDo: [:key :x |
      pos < 0 ifTrue: [
        (want includes: (nameOf value: key)) ifTrue: [pos := i].
        i := i + 1]]]`)}
pos printString encodeAsUTF8`;
}

/** Parse `childrenQuery`'s answer. */
export function parseChildren(raw: string): PauseVariable[] {
  return raw
    .split(RECORD)
    .filter((r) => r.length > 0)
    .map((record): PauseVariable => {
      const [name, value, type, ref, indexed, named, handle, size, readOnly, kind] =
        record.split(FIELD);
      const int = (s: string | undefined): number => Number.parseInt(s ?? '', 10) || 0;
      return {
        name: name ?? '?',
        value: value ?? '',
        type: type ?? '',
        ref: int(ref),
        indexed: int(indexed),
        named: int(named),
        handle: int(handle),
        size: size === undefined || size === '' ? -1 : int(size),
        readOnly: readOnly === '1',
        ...(kind ? { kind: kind as ChildKind } : {}),
      };
    });
}

/**
 * Smalltalk that gives the row `name` under registry entry `ref` a new value,
 * the value of the Python expression `source`, and answers the row as it reads
 * now, in `childrenQuery`'s format, or an `Error: …` line.
 *
 * `source` must be an expression, so it runs inside parentheses, each on a line
 * of its own (so a trailing `# comment` cannot swallow the closing one). A
 * statement then fails as a SyntaxError. Unwrapped, `n = 5` — a habit from
 * typing assignments — would run as a module, which Grail answers with None
 * for a statement (`ModuleAst>>evaluateWithScope:as:`), and None would be
 * stored without a word.
 *
 * The expression runs in a scratch scope holding the pause's globals — the
 * notebook's, or a `.py` run's `__main__` — registry entry `globalsRef`, so
 * `Point(1, 2)` or `g + 1` works on any row. On a Locals row the frame's
 * locals go on top, so `n + 1` works there too, and a local shadows a global
 * of the same name, as it does in the frame's own code.
 *
 * Where the value goes depends on the row's container:
 *
 * - **A frame's Locals**: into the paused Smalltalk frame, the innermost of
 *   the frame's levels that holds the name with a value (the same rule
 *   Grail's locals follow when one Python frame spans several Smalltalk
 *   frames), so the run continues with it. `_frameAt:tempAt:put:` and not
 *   `_frameAt:tempNamed:put:`: a local a nested block closes over lives in a
 *   VariableContext, and only the first writes one (measured: the second
 *   answered rtErrShouldNotImplement). The registry's snapshot of the locals
 *   is updated too, so the row reads the new value.
 * - **Globals**: into the notebook's scope, or the file's `__main__`.
 * - **An object, list or dict**: through Python — `setattr`, or
 *   `container[key] = value` — so a property without a setter, a tuple or a
 *   class's mappingproxy refuses exactly as it would in a cell.
 *
 * A row inside a group (`class variables` and the rest) changes in the scope
 * or object the group was made from.
 *
 * `registry` is the pause's by default; an Inspector passes its panel's
 * (`inspectorRegistry()`). All three handles — `ref`, `globalsRef` and
 * `valueHandle` — are positions in that one registry, so a pause's `globalsRef`
 * means nothing with the Inspector's. With `valueHandle`, the new value is that
 * registry entry rather than `source` evaluated: how the Inspector stores the
 * value its Evaluate-style run of an edit produced, and puts back the value a
 * row held before its first edit.
 */
export function setVariableQuery(
  processOop: bigint,
  ref: number,
  name: string,
  source: string,
  globalsRef = 0,
  registry: string = REGISTRY,
  valueHandle = 0,
): string {
  const nm = `'${escapeString(name)}'`;
  return `| reg c g owner isScope v failed problem dispatcher evalScope kind key found py s kids out field record none saved describe childrenOf start count last isDunder nameOf reprOf late clean isLeaf ro typeNameOf roIn groupOf emitGrouped withGroups moduleClass broke classCounts classData isMethodType tooLong |
${PREAMBLE}
start := 0.
count := 0.
reg := SessionTemps current at: #'${registry}' otherwise: nil.
c := (reg notNil and: [${ref} between: 1 and: reg size]) ifTrue: [reg at: ${ref}] ifFalse: [nil].
c isNil ifTrue: [^ 'Error: that value is no longer available' encodeAsUTF8].
${HELPERS}
${CHILDREN_OF}
${DESCRIBE}
${GROUPED}
problem := nil.
${withQuietConsole(`
  nameOf := [:k | (reprOf value: k) ifNil: [k printString]].
  owner := c.
  (c class == Array and: [c size >= 2 and: [(c at: 1) == #gemdbGroup]])
    ifTrue: [owner := c size >= 3 ifTrue: [c at: 3] ifFalse: [nil]].
  isScope := owner class == Array and: [owner size >= 2 and: [(owner at: 1) == #gemdbScope]].
  (roIn value: owner value: ${nm})
    ifTrue: [problem := ${nm} , ' cannot be changed here'].
  problem isNil ifTrue: [
    dispatcher := System myUserProfile symbolList objectNamed: #'ModuleAst'.
    evalScope := SymbolDictionary new.
    g := (${globalsRef} between: 1 and: reg size) ifTrue: [reg at: ${globalsRef}] ifFalse: [nil].
    (g class == Array and: [g size >= 2 and: [(g at: 1) == #gemdbScope]])
      ifTrue: [(g at: 2) keysAndValuesDo: [:k :x | evalScope at: k asString asSymbol put: x]].
    "A row's own scope goes on top: a frame's local shadows a global of its name."
    isScope ifTrue: [(owner at: 2) keysAndValuesDo: [:k :x | evalScope at: k asString asSymbol put: x]].
    failed := false.
    v := ${
      valueHandle > 0
        ? `(${valueHandle} between: 1 and: reg size)
      ifTrue: [reg at: ${valueHandle}]
      ifFalse: [failed := true. 'the value to put back is no longer available']`
        : `[dispatcher evaluateSource: '${escapeString(`(\n${source}\n)`)}' usingModuleScope: evalScope]
      on: AbstractException do: [:e |
        failed := true.
        e return: e class name , ' - ' , e messageText asString]`
    }.
    failed ifTrue: [problem := v]].
  (problem isNil and: [isScope]) ifTrue: [| dict |
    dict := owner at: 2.
    found := false.
    dict keysAndValuesDo: [:k :x | (found not and: [k asString = ${nm}]) ifTrue: [key := k. found := true]].
    found ifFalse: [problem := 'there is no variable called ' , ${nm}].
    (problem isNil and: [owner size >= 3]) ifTrue: [| proc done |
      "A frame's local: into the paused frame first."
      proc := Object _objectForOop: ${processOop}.
      done := false.
      (owner at: 3) do: [:lvl | | fc names |
        done ifFalse: [
          fc := proc _frameContentsAt: lvl.
          names := fc isNil ifTrue: [nil] ifFalse: [fc at: 9].
          names notNil ifTrue: [
            1 to: names size do: [:i |
              (done not and: [(names at: i) asString = ${nm} and: [(fc atOrNil: 10 + i) notNil]])
                ifTrue: [proc _frameAt: lvl tempAt: i put: v. done := true]]]]].
      done ifFalse: [problem := 'could not find ' , ${nm} , ' in the paused frame']].
    problem isNil ifTrue: [dict at: key put: v]].
  (problem isNil and: [isScope not]) ifTrue: [
    kids := owner isNil ifTrue: [nil] ifFalse: [childrenOf value: owner].
    kind := kids isNil ifTrue: [nil] ifFalse: [kids at: 1].
    py := nil.
    found := false.
    kind == #obj ifTrue: [py := 'setattr(_gemdb_c, _gemdb_k, _gemdb_v)'. key := ${nm}. found := true].
    kind == #seq ifTrue: [
      py := '_gemdb_c[_gemdb_k] = _gemdb_v'.
      key := ((${nm} copyFrom: 2 to: (${nm} size - 1 max: 1)) select: [:ch | ch isDigit]) asNumber.
      found := key notNil].
    kind == #dict ifTrue: [
      py := '_gemdb_c[_gemdb_k] = _gemdb_v'.
      owner keysAndValuesDo: [:k :x | (found not and: [(nameOf value: k) = ${nm}]) ifTrue: [key := k. found := true]]].
    (py isNil or: [found not])
      ifTrue: [problem := ${nm} , ' cannot be changed here']
      ifFalse: [
        s := SymbolDictionary new.
        s at: #'_gemdb_c' put: owner; at: #'_gemdb_k' put: key; at: #'_gemdb_v' put: v.
        failed := false.
        problem := [dispatcher evaluateSource: py usingModuleScope: s. nil]
          on: AbstractException do: [:e |
            failed := true.
            e return: e class name , ' - ' , e messageText asString].
        (failed not and: [kind == #obj]) ifTrue: [
          "Read it back: a property's setter may store something else."
          v := [owner @env1:___pyAttrLoad___: ${nm} asSymbol] on: AbstractException do: [:e | e return: v]]]].
  problem isNil ifTrue: [
    ro := roIn value: owner value: ${nm}.
    describe value: ${nm} value: v]`)}
problem notNil ifTrue: [^ ('Error: ' , problem asString) encodeAsUTF8].
out contents encodeAsUTF8`;
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
 * bound to registry entry `handle` when one is given — of the pause's
 * registry, or of `registry` (the Inspector's). Answers the Python value's
 * printString, or an `Error: …` line.
 */
function pythonInFreshScope(
  source: string,
  handle?: number,
  first = '',
  registry: string = REGISTRY,
): string {
  const bind =
    handle === undefined
      ? ''
      : `reg := SessionTemps current at: #'${registry}' otherwise: nil.
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
 * Smalltalk that answers what a good key for registry entry `handle` (of the
 * pause's registry, or of `registry`) is made of: its Python type name and, when it has one, the first of the attributes
 * that usually identify an object (`name`, `id`, …) holding a str or a number.
 */
export function saveSuggestionQuery(handle: number, registry: string = REGISTRY): string {
  return `| reg v tname label field |
field := Character codePoint: 31.
reg := SessionTemps current at: #'${registry}' otherwise: nil.
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
 * Smalltalk that puts registry entry `handle` (of the pause's registry, or of
 * `registry`) in gemdb.root under `key`,
 * through Python so it is exactly what `gemdb.root[key] = value` in a cell
 * would do. It does not commit: the notebook's next commit writes it, with
 * everything else the notebook has changed. Answers `'saved'` or an error.
 */
export function saveToRootQuery(handle: number, key: string, registry: string = REGISTRY): string {
  return pythonInFreshScope(
    `import gemdb\ngemdb.root[${pythonString(key)}] = _gemdb_value\n"saved"`,
    handle,
    '',
    registry,
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

/**
 * How many gemdb.root entries the Persisted Objects view lists at first. When
 * it holds more, the view shows all of them as ranges instead.
 */
export const ROOT_LISTING_LIMIT = 200;

/**
 * Smalltalk, for a session with no work of its own (the extension's), that
 * lists what is committed under gemdb.root: one row per entry, `count` of
 * them from `start`, in the Variables view's row format, a str key by its
 * text. Values are shown with the same bounded repr as the debugger's rows.
 * `gemdb.root` is a Python object (`_Root`), not a Smalltalk dictionary, so
 * its entries come from its own `items()`.
 *
 * A `fresh` listing — the view's first read — takes a fresh view and
 * registers each entry in a fresh `PERSISTED_REGISTRY`, so a row that has
 * children opens with `childrenQuery(ref, …, PERSISTED_REGISTRY)` in the same
 * session, against the view this listing took. Opening one of the view's
 * ranges is not fresh: it adds to that registry, so the rows already shown
 * still open, and reads the same view, so its entries are the ones that
 * range covered when the view was read.
 */
export function rootListingQuery(start = 0, count = ROOT_LISTING_LIMIT, fresh = true): string {
  return `| reg obj out field record none saved describe childrenOf reprOf late clean isLeaf dispatcher root ro isDunder typeNameOf broke classCounts classData isMethodType tooLong |
${PREAMBLE}
${
  fresh
    ? `reg := OrderedCollection new.
SessionTemps current at: #'${PERSISTED_REGISTRY}' put: reg.`
    : `reg := SessionTemps current at: #'${PERSISTED_REGISTRY}' otherwise: nil.
reg isNil ifTrue: [^ 'Error: the listing this range belongs to is gone; refresh the view' encodeAsUTF8].`
}
${HELPERS}
${CHILDREN_OF}
${DESCRIBE}
${fresh ? 'System abortTransaction.' : ''}
dispatcher := System myUserProfile symbolList objectNamed: #'ModuleAst'.
root := dispatcher evaluateSource: 'import gemdb
list(gemdb.root.items())[${start}:${start + count}]' usingModuleScope: SymbolDictionary new.
${withQuietConsole(`
  root do: [:pair | | key |
    key := pair at: 1.
    describe value: (key isString ifTrue: [key] ifFalse: [(reprOf value: key) ifNil: [key printString]])
      value: (pair at: 2)]`)}
out contents encodeAsUTF8`;
}

/**
 * Smalltalk, for the extension's session, that answers how many entries
 * gemdb.root holds, in the view a fresh `rootListingQuery` took — so run it
 * after that listing, which is what tells the view whether there is more.
 */
export function rootSizeQuery(): string {
  return `((System myUserProfile symbolList objectNamed: #'ModuleAst')
  evaluateSource: 'import gemdb
len(gemdb.root)' usingModuleScope: SymbolDictionary new) printString encodeAsUTF8`;
}

/**
 * Smalltalk, for a notebook's own session, that describes what `keys` hold
 * in its `gemdb.root` — additions not committed yet, which only that session
 * can see — one row each, named by its key, in `childrenQuery`'s format. Each
 * is registered in a fresh `PERSISTED_REGISTRY`, as `rootListingQuery` does
 * for what is committed, so its row opens in that session. A key no longer
 * there is left out. No fresh view: the notebook's uncommitted work is the very
 * thing being read.
 */
export function persistedRowsQuery(keys: string[]): string {
  return `| reg obj out field record none saved describe childrenOf reprOf late clean isLeaf dispatcher pairs ro isDunder typeNameOf broke classCounts classData isMethodType tooLong |
${PREAMBLE}
reg := OrderedCollection new.
SessionTemps current at: #'${PERSISTED_REGISTRY}' put: reg.
${HELPERS}
${CHILDREN_OF}
${DESCRIBE}
dispatcher := System myUserProfile symbolList objectNamed: #'ModuleAst'.
pairs := dispatcher evaluateSource: '${escapeString(
    [
      'import gemdb',
      `[(_k, gemdb.root[_k]) for _k in [${keys.map(pythonString).join(', ')}] if _k in gemdb.root]`,
    ].join('\n'),
  )}' usingModuleScope: SymbolDictionary new.
${withQuietConsole(`
  pairs do: [:pair | describe value: (pair at: 1) value: (pair at: 2)]`)}
out contents encodeAsUTF8`;
}

/** How many of a saved object's children its hover shows. */
export const INSPECT_ROWS = 12;

/**
 * Smalltalk that describes `gemdb.root[key]` for a hover: a first row for the
 * object itself (its counts say how many children it has), then its first
 * `INSPECT_ROWS` children. An object's children are its own attributes, its
 * `__dict__`, as before objects were read whole: the methods, class
 * attributes and dunders the Variables view adds are left out of a hover. `fresh` takes a new view first — right for the
 * extension's own session, which reads what is committed, and wrong for a
 * notebook's, whose uncommitted work is the very thing being looked at.
 * Answers an `Error: …` line when the key is not there.
 */
export function inspectQuery(key: string, fresh: boolean): string {
  return `| reg obj kids out field record none saved describe childrenOf start count last nameOf reprOf late clean isLeaf dispatcher ro isDunder typeNameOf roIn groupOf emitGrouped withGroups moduleClass broke classCounts classData isMethodType tooLong |
${PREAMBLE}
reg := OrderedCollection new.
start := 0.
count := ${INSPECT_ROWS}.
withGroups := false.
${HELPERS}
${CHILDREN_OF}
${DESCRIBE}
${GROUPED}
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

// ---------------------------------------------------------------------------
// What the next commit writes (`%pending`), and where each object is.
// ---------------------------------------------------------------------------

/** How many changed objects `%pending` lists; it says how many more there were. */
export const PENDING_ROWS = 200;

/**
 * The most objects the search for paths from `gemdb.root` registers before it
 * gives up. A complete search of a warehouse of 12,000 orders, their 36,000
 * lines, a 300,000-float list, a 1,200-key dict and a 2,000-item set took
 * about 0.7 s (measured); the limit is what keeps a far bigger database from
 * filling the session's memory.
 */
const PATH_SEARCH_LIMIT = 200000;

/** How many of the time budget's soft breaks the search for paths carries on through (`FIND_PATHS`). */
const SEARCH_BREAKS = 5;

/** A container with more items than this is searched last (`FIND_PATHS`). */
const PATH_BIG = 1000;

/** Separates the steps of a path in a query's answer. */
const STEP = '\u001d';

/**
 * One step from `gemdb.root` down to an object, as `findPaths` writes it:
 * an entry of `gemdb.root` (`root`, its key by its text when it is a str,
 * else by its repr), an attribute (`attr`), a list's or tuple's item
 * (`index`), a dict's entry (`dictKey`, its key's repr) or a set's item
 * (`setItem`, in the order the set iterates). `position` is where the step
 * is among what Persisted Objects lists, from 0, so the view can open
 * straight to it.
 */
export type PathStep =
  | { kind: 'root'; position: number; key: string; str: boolean }
  | { kind: 'attr'; name: string }
  | { kind: 'index'; position: number }
  | { kind: 'dictKey'; position: number; key: string }
  | { kind: 'setItem'; position: number };

/** The temps `FIND_PATHS` declares, for a query that uses it. */
const PATH_TEMPS = 'stepSep cleanStep cut via nameOf findPaths stepsOf breaks pastBreak orResume';

/**
 * Smalltalk that finds where objects are under `gemdb.root`: `findPaths`
 * takes an IdentitySet of targets and answers an IdentityDictionary from
 * each target it found to the object a path names, and `stepsOf` writes that
 * object's path from `gemdb.root` (`parseSteps` reads it). Expects
 * `dispatcher` and `HELPERS`.
 *
 * The search goes breadth first from `gemdb.root`'s entries, so a path is as
 * short as it can be, and it follows only what a Python user can name: list
 * and tuple items, dict entries, set items and an object's `__dict__`. A
 * target that is an object's `__dict__` names that object; one that is
 * `gemdb.root`'s own dict names `gemdb.root`. It reads no getter and runs no
 * `__repr__` until a path is written. It stops when every target is found,
 * after `PATH_SEARCH_LIMIT` objects, or at the time budget's soft break;
 * `cut` says whether it stopped short.
 *
 * Two things keep big data from using up the limit before a deep object is
 * reached (measured: a warehouse's 12,000 orders and their lines filled it,
 * and an Order ten attributes down `.deep` went unfound). A container of more
 * than `PATH_BIG` items is opened only once everything else has been
 * searched, so a narrow, deep path is followed first. And a target is
 * recognised as it is first seen, not when its turn comes, so the item a big
 * list holds is found the moment the list is opened.
 */
const FIND_PATHS = `
  stepSep := Character codePoint: 29.
  cleanStep := [:t | t collect: [:c | (c == field or: [c == record or: [c == stepSep]]) ifTrue: [$?] ifFalse: [c]]].
  cut := false.
  via := IdentityDictionary new.
  nameOf := [:key | (reprOf value: key) ifNil: [key printString]].
  "The search runs none of the user's code, so the time budget's soft break, there to stop a slow
   __repr__, does not stop it: it carries on through ${SEARCH_BREAKS} of them, and only then counts
   as cut short. Measured: on CI's machines, beside the suite's other data, the 2 s budget cut it
   before it had looked everywhere, and Grail's records then showed as not found."
  breaks := 0.
  pastBreak := [:e | breaks := breaks + 1. breaks <= ${SEARCH_BREAKS}].
  "For a handler around a read that must not fail: resume past the budget's soft break, as the
   search does, and answer fallback only for a real error (or a break past the allowance)."
  orResume := [:e :fallback |
    ((e isKindOf: ControlInterrupt) and: [pastBreak value: e])
      ifTrue: [e resume: nil]
      ifFalse: [e return: fallback]].
  findPaths := [:targets | | found queue later add backing pairs |
    found := IdentityDictionary new.
    queue := OrderedCollection new.
    later := OrderedCollection new.
    add := [:child :parent :kind :key |
      ((isLeaf value: child) or: [child isBehavior or: [via includesKey: child]]) ifFalse: [
        via size < ${PATH_SEARCH_LIMIT}
          ifTrue: [
            via at: child put: { parent. kind. key }.
            ((targets includes: child) and: [(found includesKey: child) not])
              ifTrue: [found at: child put: child].
            (((child isKindOf: Collection) and: [child isString not]) and: [child size > ${PATH_BIG}])
              ifTrue: [later add: child]
              ifFalse: [queue add: child]]
          ifFalse: [cut := true]]].
    backing := [dispatcher evaluateSource: 'import gemdb
gemdb.root._peek()' usingModuleScope: SymbolDictionary new]
      on: AbstractException do: [:e | orResume value: e value: nil].
    (backing notNil and: [targets includes: backing]) ifTrue: [found at: backing put: backing].
    pairs := [dispatcher evaluateSource: 'import gemdb
list(gemdb.root.items())' usingModuleScope: SymbolDictionary new]
      on: AbstractException do: [:e | orResume value: e value: #()].
    1 to: pairs size do: [:i | | pair |
      pair := pairs at: i.
      add value: (pair at: 2) value: nil value: #k value: { i - 1. pair at: 1 }].
    [[(queue notEmpty or: [later notEmpty]) and: [found size < targets size and: [late not]]] whileTrue: [| node d i |
      "The big containers held back are opened once nothing else is left."
      queue isEmpty ifTrue: [queue addAll: later. later := OrderedCollection new].
      node := queue removeFirst.
      ((targets includes: node) and: [(found includesKey: node) not]) ifTrue: [found at: node put: node].
      (node isKindOf: SequenceableCollection)
        ifTrue: [1 to: node size do: [:k | add value: (node at: k) value: node value: #i value: k - 1]]
        ifFalse: [
          (node respondsTo: #keysAndValuesDo:)
            ifTrue: [
              i := 0.
              node keysAndValuesDo: [:key :x | add value: x value: node value: #d value: { i. key }. i := i + 1]]
            ifFalse: [
              (node isKindOf: Collection)
                ifTrue: [
                  i := 0.
                  node do: [:x | add value: x value: node value: #s value: i. i := i + 1]]
                ifFalse: [
                  d := [node @env1:___pyAttrLoad___: #'__dict__'] on: AbstractException do: [:e |
                    ((e isKindOf: ControlInterrupt) and: [pastBreak value: e])
                      ifTrue: [e resume: nil]
                      ifFalse: [(broke value: e) return: nil]].
                  (d notNil and: [d respondsTo: #keysAndValuesDo:]) ifTrue: [
                    ((targets includes: d) and: [(found includesKey: d) not]) ifTrue: [found at: d put: node].
                    d keysAndValuesDo: [:key :x | add value: x value: node value: #a value: key]]]]]]]
      on: ControlInterrupt do: [:e | (pastBreak value: e) ifTrue: [e resume: nil] ifFalse: [late := true. e return: nil]].
    late ifTrue: [cut := true].
    found].
  stepsOf := [:node | | at link steps s |
    steps := OrderedCollection new.
    at := node.
    [at notNil and: [(link := via at: at ifAbsent: [nil]) notNil]] whileTrue: [
      steps addFirst: link.
      at := link at: 1].
    s := WriteStream on: Unicode7 new.
    steps do: [:st | | kind key |
      kind := st at: 2.
      key := st at: 3.
      s nextPut: stepSep.
      kind == #k ifTrue: [
        s nextPutAll: ((key at: 2) isString ifTrue: ['k'] ifFalse: ['K']); print: (key at: 1); nextPut: $:;
          nextPutAll: (cleanStep value: ((key at: 2) isString
            ifTrue: [(key at: 2) asString]
            ifFalse: [nameOf value: (key at: 2)]))].
      kind == #i ifTrue: [s nextPutAll: 'i'; print: key].
      kind == #s ifTrue: [s nextPutAll: 's'; print: key].
      kind == #d ifTrue: [
        s nextPutAll: 'd'; print: (key at: 1); nextPut: $:; nextPutAll: (cleanStep value: (nameOf value: (key at: 2)))].
      kind == #a ifTrue: [s nextPutAll: 'a'; nextPutAll: (cleanStep value: key asString)]].
    s contents].`;

/**
 * Smalltalk, for a notebook's (or a saved stack's) own session, that lists
 * what its next commit writes: every object its transaction has changed that
 * was already in the database (`System _writtenObjects`, kept to the
 * committed ones). An object created since the last commit is not listed on
 * its own: it is written as part of a committed object that now holds it,
 * which is listed. A cell's own variables live in the session's SessionTemps
 * and are never committed, so they never show here.
 *
 * Each object is matched to a place under `gemdb.root` (`FIND_PATHS`), read in
 * this session, so the path is where the object is as the notebook sees it.
 * One record per object, up to `PENDING_ROWS`, the found ones first: its path
 * (`?` for a Python object the search stopped short of, `!` for an internal
 * object, which is not looked for, or one a complete search did not find
 * under `gemdb.root`), then its row in `childrenQuery`'s format, named by its permanent
 * object number.
 *
 * A last record, `#`, carries how many were written, how many were left out,
 * and whether the search stopped short. `parsePending` reads it.
 *
 * The `!` ones are internal objects: storage inside a Python object, such as
 * a big dict's collision buckets (measured: a PyDictCollisionBucket when one
 * entry of a 1,200-entry dict changed), or the database's own caches (the
 * first pause in a fresh database writes a SymbolDictionary and four
 * RcCollisionBuckets as Grail caches the modules the debugger imports). They
 * are part of the commit like anything else, so they are counted, never left
 * out. They are not looked for under `gemdb.root`, where they never are: the
 * search stops once every Python object is found, rather than running on to
 * its limit (measured: with them looked for, it always said it stopped early).
 */
export function pendingQuery(): string {
  return `| reg out field record none saved describe childrenOf reprOf late clean isLeaf dispatcher written targets internal found shown skipped ${PATH_TEMPS} ${ROW_TEMPS} |
${PREAMBLE}
reg := OrderedCollection new.
${HELPERS}
${CHILDREN_OF}
${DESCRIBE}
dispatcher := System myUserProfile symbolList objectNamed: #'ModuleAst'.
written := IdentitySet new.
System _writtenObjects do: [:o | o isCommitted ifTrue: [written add: o]].
${FIND_PATHS}
${withQuietConsole(`
  "Only Python objects are looked for. An internal one, whose class has no __module__
   (measured: true of SymbolDictionary and RcCollisionBucket, and of no Python type),
   is never under gemdb.root, so looking for it would only run the search to its limit."
  targets := IdentitySet new.
  internal := IdentitySet new.
  written do: [:o |
    ([(o @env1:___pyAttrLoad___: #'__class__') @env1:___pyAttrLoad___: #'__module__'. true]
        on: AbstractException do: [:e | orResume value: e value: false])
      ifTrue: [targets add: o]
      ifFalse: [internal add: o]].
  found := targets isEmpty ifTrue: [IdentityDictionary new] ifFalse: [findPaths value: targets].
  shown := IdentitySet new.
  skipped := IdentitySet new.
  "An object and its __dict__ can both be written; they name one object, listed once."
  found keysAndValuesDo: [:t :node |
    (shown includes: node) ifFalse: [
      shown size < ${PENDING_ROWS}
        ifTrue: [
          shown add: node.
          out nextPutAll: (stepsOf value: node); nextPut: field.
          describe value: node asOop printString value: node]
        ifFalse: [skipped add: node]]].
  "? for a Python object not found because the search stopped short, ! for an internal one.
   Once the search has looked everywhere, a Python object it did not find is not under
   gemdb.root at all — measured: lists of a class's attribute names and a dict of exception
   classes, which Grail keeps as ordinary Python objects — so it counts as internal too."
  targets do: [:t |
    (found includesKey: t) ifFalse: [
      shown size < ${PENDING_ROWS}
        ifTrue: [
          shown add: t.
          out nextPutAll: (cut ifTrue: ['?'] ifFalse: ['!']); nextPut: field.
          describe value: t asOop printString value: t]
        ifFalse: [skipped add: t]]].
  internal do: [:t |
    shown size < ${PENDING_ROWS}
      ifTrue: [
        shown add: t.
        out nextPutAll: '!'; nextPut: field.
        describe value: t asOop printString value: t]
      ifFalse: [skipped add: t]].
  out nextPutAll: '#'; nextPut: field; print: shown size + skipped size; nextPut: field;
    print: skipped size; nextPut: field; nextPutAll: (cut ifTrue: ['1'] ifFalse: ['0']); nextPut: record`)}
out contents encodeAsUTF8`;
}

/**
 * Smalltalk, for the extension's session, that answers the path from
 * `gemdb.root` to the object whose permanent number is `oop`, as
 * `FIND_PATHS` writes it, or `?` when it is not found. It reads the view the
 * session already has, so run it right after the Persisted Objects view's own
 * fresh listing: the positions it answers are then the ones the view shows.
 */
export function pathToQuery(oop: number): string {
  return `| reg out field record none saved reprOf late clean isLeaf dispatcher target found ${PATH_TEMPS} ${ROW_TEMPS} |
${PREAMBLE}
${HELPERS}
dispatcher := System myUserProfile symbolList objectNamed: #'ModuleAst'.
target := [Object _objectForOop: ${Math.trunc(oop)}] on: AbstractException do: [:e | e return: nil].
${FIND_PATHS}
${withQuietConsole(`
  found := target isNil
    ifTrue: [IdentityDictionary new]
    ifFalse: [findPaths value: (IdentitySet with: target)].
  out nextPutAll: (found isEmpty ifTrue: ['?'] ifFalse: [stepsOf value: found values asArray first])`)}
out contents encodeAsUTF8`;
}

/**
 * Smalltalk, for the extension's session, that answers the path from
 * `gemdb.root` to each object in `oops` in one search: a record per number,
 * `oop␟steps`, the steps as `pathToQuery` writes them (`?` for one not
 * found). Like `pathToQuery`, it reads the view the session already has.
 */
export function pathsToQuery(oops: number[]): string {
  return `| reg out field record none saved reprOf late clean isLeaf dispatcher targets byOop found ${PATH_TEMPS} ${ROW_TEMPS} |
${PREAMBLE}
${HELPERS}
dispatcher := System myUserProfile symbolList objectNamed: #'ModuleAst'.
targets := IdentitySet new.
byOop := OrderedCollection new.
#(${oops.map((o) => Math.trunc(o)).join(' ')}) do: [:oop | | t |
  t := [Object _objectForOop: oop] on: AbstractException do: [:e | e return: nil].
  byOop add: oop -> t.
  t notNil ifTrue: [targets add: t]].
${FIND_PATHS}
${withQuietConsole(`
  found := targets isEmpty ifTrue: [IdentityDictionary new] ifFalse: [findPaths value: targets].
  byOop do: [:a | | node |
    node := a value isNil ifTrue: [nil] ifFalse: [found at: a value ifAbsent: [nil]].
    out print: a key; nextPut: field;
      nextPutAll: (node isNil ifTrue: ['?'] ifFalse: [stepsOf value: node]); nextPut: record]`)}
out contents encodeAsUTF8`;
}

/** `pathsToQuery`'s answer: each number's path, or undefined where none was found. */
export function parsePaths(raw: string): Map<number, PathStep[] | undefined> {
  const paths = new Map<number, PathStep[] | undefined>();
  for (const record of raw.split(RECORD)) {
    if (!record) continue;
    const at = record.indexOf(FIELD);
    paths.set(Number(record.slice(0, at)), parseSteps(record.slice(at + 1)));
  }
  return paths;
}

/** The most entries `snapshotQuery` compares; a bigger container is not compared. */
export const SNAPSHOT_LIMIT = 20000;

/** Longest value text a snapshot carries for one entry. */
const SNAPSHOT_CHARS = 120;

/** Longest repr a snapshot keeps whole, so the value can be put back by a revert. */
const REVERT_CHARS = 2000;

/**
 * Smalltalk that writes what the object numbered `oop` holds, as this
 * session sees it, for comparing with another session's: a first record
 * `#␟kind` (`obj`, `seq`, `dict`, or `set`, `big` and `gone` for what is not
 * compared), then a record per entry, `name␟key␟text`. Names are what
 * Persisted Objects calls the rows: an attribute, `[i]`, a dict key's repr.
 * `key` is what decides whether an entry changed, and what a revert puts
 * back: `v` and a plain value's whole repr, or `h` with its size and hash
 * when that repr is over `REVERT_CHARS` (compared, but not put back), or for
 * any other object `o` and its permanent number, so an object that changed in
 * place is not reported again by every container holding it. `text` is how
 * the value reads, a container's or object's repr only when it holds at most
 * a few entries, else its type name.
 *
 * Run in the extension's session it reads what is committed; run in a
 * notebook's, what its next commit would write.
 */
export function snapshotQuery(oop: number): string {
  return `| reg out field record none saved reprOf late clean isLeaf obj kind emit textOf src ${ROW_TEMPS} |
${PREAMBLE}
${HELPERS}
obj := [Object _objectForOop: ${Math.trunc(oop)}] on: AbstractException do: [:e | e return: nil].
textOf := [:v | | t n |
  n := ((v isKindOf: Collection) and: [v isString not]) ifTrue: [v size] ifFalse: [0].
  t := ((isLeaf value: v) or: [n <= 8])
    ifTrue: [(v isString and: [v size > ${SNAPSHOT_CHARS}])
      ifTrue: [(reprOf value: (v copyFrom: 1 to: ${SNAPSHOT_CHARS})) , '...']
      ifFalse: [reprOf value: v]]
    ifFalse: [nil].
  t isNil ifTrue: [t := typeNameOf value: v].
  t size > ${SNAPSHOT_CHARS} ifTrue: [t := (t copyFrom: 1 to: ${SNAPSHOT_CHARS - 3}) , '...'].
  clean value: t].
emit := [:nm :v | | full |
  out nextPutAll: (clean value: nm); nextPut: field.
  (isLeaf value: v)
    ifTrue: [
      full := (v isString and: [v size > ${REVERT_CHARS}]) ifTrue: [nil] ifFalse: [reprOf value: v].
      (full notNil and: [full size <= ${REVERT_CHARS}])
        ifTrue: [out nextPutAll: 'v'; nextPutAll: (clean value: full)]
        ifFalse: [out nextPutAll: 'h'; print: v size; nextPut: $:; print: v hash]]
    ifFalse: [out nextPutAll: 'o'; print: v asOop].
  out nextPut: field; nextPutAll: (textOf value: v); nextPut: record].
${withQuietConsole(`
  obj isNil
    ifTrue: [kind := 'gone']
    ifFalse: [
      (obj isKindOf: SequenceableCollection)
        ifTrue: [kind := 'seq']
        ifFalse: [
          (obj respondsTo: #keysAndValuesDo:)
            ifTrue: [kind := 'dict']
            ifFalse: [
              (obj isKindOf: Collection)
                ifTrue: [kind := 'set']
                ifFalse: [
                  kind := 'obj'.
                  src := [obj @env1:___pyAttrLoad___: #'__dict__'] on: AbstractException do: [:e | e return: nil].
                  (src notNil and: [src respondsTo: #keysAndValuesDo:]) ifFalse: [kind := 'set']]]].
      ((kind = 'seq' or: [kind = 'dict']) and: [obj size > ${SNAPSHOT_LIMIT}]) ifTrue: [kind := 'big']].
  out nextPutAll: '#'; nextPut: field; nextPutAll: kind; nextPut: record.
  kind = 'seq' ifTrue: [1 to: obj size do: [:k | emit value: '[' , (k - 1) printString , ']' value: (obj at: k)]].
  kind = 'dict' ifTrue: [obj keysAndValuesDo: [:key :x |
    emit value: ((reprOf value: key) ifNil: [key printString]) value: x]].
  kind = 'obj' ifTrue: [src keysAndValuesDo: [:key :x | emit value: key asString value: x]]`)}
out contents encodeAsUTF8`;
}

/** What `snapshotQuery` read: its kind, and each entry's key and text by name. */
export interface Snapshot {
  kind: 'obj' | 'seq' | 'dict' | 'set' | 'big' | 'gone';
  entries: Map<string, { key: string; text: string }>;
}

/** Parse `snapshotQuery`'s answer. */
export function parseSnapshot(raw: string): Snapshot {
  const snapshot: Snapshot = { kind: 'gone', entries: new Map() };
  for (const record of raw.split(RECORD)) {
    if (!record) continue;
    const [name = '', key = '', text = ''] = record.split(FIELD);
    if (name === '#') snapshot.kind = key as Snapshot['kind'];
    else snapshot.entries.set(name, { key, text });
  }
  return snapshot;
}

/** How one object's next commit differs from what is committed. */
export interface ObjectDiff {
  /** Entries whose value changes, by name: its committed text and its new one. */
  changed: Array<{ name: string; before: string; after: string }>;
  added: Array<{ name: string; after: string }>;
  removed: Array<{ name: string; before: string }>;
  /** Why it was not compared entry by entry, when it was not: a set, or too big. */
  notCompared?: string;
}

/**
 * Compare an object as committed (`before`) with what its next commit writes
 * (`after`), entry by entry, in `after`'s order then `before`'s leftovers.
 */
export function diffSnapshots(before: Snapshot, after: Snapshot): ObjectDiff {
  const diff: ObjectDiff = { changed: [], added: [], removed: [] };
  if (after.kind === 'set' || after.kind === 'big' || after.kind === 'gone') {
    diff.notCompared =
      after.kind === 'set'
        ? 'a set, or an object whose attributes are not kept in a __dict__, is not compared entry by entry'
        : after.kind === 'big'
          ? `more than ${SNAPSHOT_LIMIT.toLocaleString('en-US')} entries: not compared`
          : 'it could not be read';
    return diff;
  }
  for (const [name, now] of after.entries) {
    const was = before.entries.get(name);
    if (!was) diff.added.push({ name, after: now.text });
    else if (was.key !== now.key) diff.changed.push({ name, before: was.text, after: now.text });
  }
  for (const [name, was] of before.entries) {
    if (!after.entries.has(name)) diff.removed.push({ name, before: was.text });
  }
  return diff;
}

/**
 * A repr a revert may write into Python as it is: a str or bytes literal, a
 * number, `True`, `False` or `None`. Anything else, such as an object's own
 * repr, could run code if evaluated, so it is never put back this way.
 */
export function isLiteral(text: string): boolean {
  return /^(?:-?\d+(?:\.\d+)?(?:e[-+]?\d+)?|True|False|None|b?'(?:[^'\\\n]|\\.)*'|b?"(?:[^"\\\n]|\\.)*")$/.test(
    text,
  );
}

/** Python that undoes changes to one object, and the committed objects it puts back by number. */
export interface RevertPlan {
  source: string;
  oops: number[];
}

/**
 * The Python that puts an object (`_gemdb_obj`) back as `before` holds it:
 * every change in `diff`, or only the entry named `only`. An attribute is set
 * or deleted, a dict entry assigned or deleted, a list item assigned, and a
 * whole list reverted by assigning all its items (`[:]`), so one that grew
 * or shrank is put back too. A committed object goes back by its number, as
 * `_gemdb_o<number>`; a plain value as its literal. Throws, saying why, for
 * an entry that cannot be put back: a key or value that is no plain literal,
 * a value too long to have been kept, or a set.
 */
export function revertPlan(
  kind: Snapshot['kind'],
  before: Snapshot,
  diff: ObjectDiff,
  only?: string,
): RevertPlan {
  if (kind !== 'obj' && kind !== 'dict' && kind !== 'seq') {
    throw new Error(
      `it is ${kind === 'set' ? 'a set, which' : 'not something that'} cannot be reverted entry by entry`,
    );
  }
  const oops = new Set<number>();
  const value = (name: string): string => {
    const key = before.entries.get(name)?.key ?? '';
    if (key.startsWith('o')) {
      oops.add(Number(key.slice(1)));
      return `_gemdb_o${key.slice(1)}`;
    }
    if (key.startsWith('v') && isLiteral(key.slice(1))) return key.slice(1);
    throw new Error(
      key.startsWith('h')
        ? `${name}'s committed value is too long to put back`
        : `${name}'s committed value is not a plain value that can be put back`,
    );
  };
  const dictKey = (name: string): string => {
    if (!isLiteral(name)) throw new Error(`the key ${name} is not a plain value that can be named`);
    return name;
  };
  const lines: string[] = [];
  const wanted = <T extends { name: string }>(list: T[]) =>
    only === undefined ? list : list.filter((e) => e.name === only);
  if (kind === 'seq' && only === undefined) {
    const items = [...before.entries.keys()].map(value);
    lines.push(`_gemdb_obj[:] = [${items.join(', ')}]`);
  } else {
    for (const e of [...wanted(diff.changed), ...wanted(diff.removed)]) {
      if (kind === 'obj')
        lines.push(`setattr(_gemdb_obj, ${JSON.stringify(e.name)}, ${value(e.name)})`);
      else if (kind === 'dict') lines.push(`_gemdb_obj[${dictKey(e.name)}] = ${value(e.name)}`);
      else lines.push(`_gemdb_obj[${Number(e.name.slice(1, -1))}] = ${value(e.name)}`);
    }
    for (const e of wanted(diff.added)) {
      if (kind === 'obj') lines.push(`delattr(_gemdb_obj, ${JSON.stringify(e.name)})`);
      else if (kind === 'dict') lines.push(`del _gemdb_obj[${dictKey(e.name)}]`);
      else throw new Error(`${e.name} was added to a list: revert the whole list instead`);
    }
  }
  if (lines.length === 0) throw new Error('there is nothing to revert');
  return { source: [...lines, '"reverted"'].join('\n'), oops: [...oops] };
}

/**
 * Smalltalk, for a notebook's session, that runs a revert (`revertPlan`) on
 * the object numbered `oop`: it binds that object as `_gemdb_obj` and each
 * committed object the plan puts back as `_gemdb_o<number>`, then runs the
 * plan's Python in a throwaway scope. Answers `'reverted'`, or an `Error: …`
 * line.
 */
export function revertQuery(oop: number, plan: RevertPlan): string {
  const binds = plan.oops
    .map(
      (o) => `scope at: #'_gemdb_o${Math.trunc(o)}' put: (Object _objectForOop: ${Math.trunc(o)}).`,
    )
    .join('\n');
  return `| dispatcher scope r |
dispatcher := System myUserProfile symbolList objectNamed: #'ModuleAst'.
scope := SymbolDictionary new.
scope at: #'_gemdb_obj' put: (Object _objectForOop: ${Math.trunc(oop)}).
${binds}
r := [(dispatcher evaluateSource: '${escapeString(plan.source)}' usingModuleScope: scope) printString]
  on: AbstractException do: [:e | 'Error: ' , e class name , ' - ' , e messageText asString].
r encodeAsUTF8`;
}

/** The names of the rows a path opens in Persisted Objects, from `gemdb.root` down. */
export function stepNames(steps: PathStep[]): string[] {
  return steps.map((step) => {
    switch (step.kind) {
      case 'root':
        return step.key;
      case 'attr':
        return step.name;
      case 'dictKey':
        return step.key;
      default:
        return `[${step.position}]`;
    }
  });
}

/** A path as `stepsOf` writes it; undefined for `?` or `!`, an object no path was found to. */
export function parseSteps(text: string): PathStep[] | undefined {
  if (text === '?' || text === '!') return undefined;
  return text
    .split(STEP)
    .filter((s) => s.length > 0)
    .map((s): PathStep => {
      const kind = s[0];
      const rest = s.slice(1);
      const colon = rest.indexOf(':');
      const position = Number.parseInt(colon < 0 ? rest : rest.slice(0, colon), 10) || 0;
      const after = colon < 0 ? '' : rest.slice(colon + 1);
      switch (kind) {
        case 'k':
        case 'K':
          return { kind: 'root', position, key: after, str: kind === 'k' };
        case 'd':
          return { kind: 'dictKey', position, key: after };
        case 'i':
          return { kind: 'index', position };
        case 's':
          return { kind: 'setItem', position };
        default:
          return { kind: 'attr', name: rest };
      }
    });
}

/**
 * A path as Python reads it: `gemdb.root["orders"][2].customer`. A set has
 * no index in Python, so a set's item is written `{n}`, the nth it iterates.
 */
export function pathText(steps: PathStep[]): string {
  return steps.reduce((text, step) => {
    switch (step.kind) {
      case 'root':
        return `${text}[${step.str ? JSON.stringify(step.key) : step.key}]`;
      case 'attr':
        return `${text}.${step.name}`;
      case 'index':
        return `${text}[${step.position}]`;
      case 'dictKey':
        return `${text}[${step.key}]`;
      case 'setItem':
        return `${text}{${step.position}}`;
    }
  }, 'gemdb.root');
}

/** One changed object `%pending` lists. */
export interface PendingChange {
  /** Where it is under `gemdb.root`; undefined when the search did not find it. */
  steps?: PathStep[];
  /** Not found, and not a Python object: internal storage or one of the database's caches. */
  internal?: boolean;
  /** Its permanent object number. */
  oop: number;
  type: string;
  value: string;
}

/** `pendingQuery`'s answer, read. */
export interface Pending {
  changes: PendingChange[];
  /** How many objects the commit writes in all. */
  total: number;
  /** How many of those are not in `changes`. */
  more: number;
  /** The search for paths stopped before it had looked everywhere. */
  cut: boolean;
  /**
   * How many written objects were left out of `changes` because they read
   * exactly as committed: reverted, or set to what they already held.
   */
  unchanged?: number;
}

/**
 * `pending` without the objects that read exactly as committed, by `before`
 * (each object's committed snapshot, by number) against `after` (as the
 * notebook would commit it): reverted, or set to what they already held. A
 * commit still writes them, but nothing about them would change, so they are
 * counted rather than listed. An object not compared entry by entry, or with
 * no snapshot either side, stays listed.
 */
export function withoutUnchanged(
  pending: Pending,
  before: Map<number, Snapshot>,
  after: Map<number, Snapshot>,
): Pending {
  const same = (oop: number): boolean => {
    const was = before.get(oop);
    const now = after.get(oop);
    if (!was || !now || was.kind === 'gone') return false;
    const diff = diffSnapshots(was, now);
    return !diff.notCompared && diff.changed.length + diff.added.length + diff.removed.length === 0;
  };
  const changes = pending.changes.filter((c) => c.internal || !same(c.oop));
  return { ...pending, changes, unchanged: pending.changes.length - changes.length };
}

/** Parse `pendingQuery`'s answer. */
export function parsePending(raw: string): Pending {
  const pending: Pending = { changes: [], total: 0, more: 0, cut: false };
  for (const record of raw.split(RECORD)) {
    if (!record) continue;
    const at = record.indexOf(FIELD);
    const head = record.slice(0, at);
    if (head === '#') {
      const [, total, more, cut] = record.split(FIELD);
      pending.total = Number(total) || 0;
      pending.more = Number(more) || 0;
      pending.cut = cut === '1';
      continue;
    }
    const [row] = parseChildren(record.slice(at + 1) + RECORD);
    if (!row) continue;
    const steps = parseSteps(head);
    pending.changes.push({
      ...(steps ? { steps } : {}),
      ...(head === '!' ? { internal: true } : {}),
      oop: Number(row.name),
      type: row.type,
      value: row.value,
    });
  }
  return pending;
}

// ---------------------------------------------------------------------------
// The Debug Console and the Watch pane.
// ---------------------------------------------------------------------------

/**
 * Where a frame's console names come from: its Locals (a registry position,
 * 0 for none) over its globals. Those are the pause's Globals (a registry
 * position) for a frame in the notebook's cells or the `.py` run's own file,
 * and for a frame in an imported module, that module's, found by its file.
 */
export interface ConsoleScope {
  locals: number;
  globals: number;
  moduleFile?: string;
}

/** One frame of a console error's traceback, outermost first. */
export interface TracebackFrame {
  /** A real path, or `<grail>` for the console's input or a notebook cell. */
  file: string;
  line: number;
  name: string;
  /** Text from the frame's line, as Grail's codegen recorded it — often a slice. */
  text: string;
}

/** A console line's exception, as data. */
export interface ConsoleError {
  /** The type as a traceback's last line names it: `ZeroDivisionError`, `json.JSONDecodeError`. */
  type: string;
  message: string;
  /** Where a SyntaxError could not read: 1-based line and column, and the line. */
  syntax?: { file: string; line: number; offset: number; text: string };
  frames: TracebackFrame[];
}

/**
 * For a console line that is a bare name: `persisted` when its value is the
 * Persisted Objects entry of that key, rather than a name of the paused code's
 * own or one the console bound.
 */
export type NameOrigin = 'persisted';

/** What `consoleQuery` answered. */
export type ConsoleReply = { consoleRef: number; output: string } & (
  | { kind: 'value'; row: PauseVariable; origin?: NameOrigin }
  | { kind: 'none' }
  | { kind: 'error'; error: ConsoleError }
  | { kind: 'interrupted' }
  | { kind: 'failed'; message: string }
);

/**
 * Smalltalk that finds frame `scope`'s console scope at registry entry
 * `consoleRef`, or makes it and registers it, leaving it in `console` and its
 * position in `cref` (`consoleQuery` says what it holds). Needs the temps
 * `reg dispatcher cref console dict g l bind nameAst none`.
 */
function consoleScopeSetup(scope: ConsoleScope, consoleRef: number): string {
  const findModule = scope.moduleFile
    ? `g := [dispatcher evaluateSource: '${escapeString(
        [
          'import sys as _gemdb_sys',
          '_gemdb_found = None',
          'for _gemdb_m in list(_gemdb_sys.modules.values()):',
          `    if getattr(_gemdb_m, "__file__", None) == ${pythonString(scope.moduleFile)}:`,
          '        _gemdb_found = _gemdb_m.__dict__',
          '        break',
          '_gemdb_found',
        ].join('\n'),
      )}' usingModuleScope: SymbolDictionary new]
      on: AbstractException do: [:e | e return: nil].
    (g notNil and: [g ~~ none and: [g respondsTo: #keysAndValuesDo:]])
      ifTrue: [g keysAndValuesDo: [:k :x | bind value: k value: x]].`
    : '';
  return `reg := SessionTemps current at: #'${REGISTRY}' otherwise: nil.
reg isNil ifTrue: [^ 'Error: the pause is over' encodeAsUTF8].
dispatcher := System myUserProfile symbolList objectNamed: #'ModuleAst'.
cref := ${consoleRef}.
nameAst := System myUserProfile symbolList objectNamed: #'NameAst'.
bind := [:k :x | | nm |
  nm := k asString asSymbol.
  nameAst notNil ifTrue: [nm := [nameAst doitScopeNameFor: nm] on: Error do: [:e | e return: nm]].
  dict at: nm put: x].
console := (cref between: 1 and: reg size) ifTrue: [reg at: cref] ifFalse: [nil].
(console class == Array and: [console size = 4 and: [(console at: 1) == #gemdbConsole]]) ifFalse: [| persisted |
  "Which names came from Persisted Objects, so a bare name typed later can say so."
  persisted := SymbolDictionary new.
  dict := SymbolDictionary new.
  g := (${scope.globals} between: 1 and: reg size) ifTrue: [reg at: ${scope.globals}] ifFalse: [nil].
  (g class == Array and: [g size >= 2 and: [(g at: 1) == #gemdbScope]])
    ifTrue: [(g at: 2) keysAndValuesDo: [:k :x | bind value: k value: x]].
  ${findModule}
  "The frame's locals over its globals: a local shadows a global of its name."
  l := (${scope.locals} between: 1 and: reg size) ifTrue: [reg at: ${scope.locals}] ifFalse: [nil].
  (l class == Array and: [l size >= 2 and: [(l at: 1) == #gemdbScope]])
    ifTrue: [(l at: 2) keysAndValuesDo: [:k :x | bind value: k value: x]].
  "gemdb itself, unless the frame has a name of its own spelled so: a line copied from
   Persisted Objects (gemdb.root[...]) then works in any program, imported or not."
  (dict includesKey: #gemdb) ifFalse: [
    g := [dispatcher evaluateSource: 'import gemdb
gemdb' usingModuleScope: SymbolDictionary new] on: AbstractException do: [:e | e return: nil].
    g notNil ifTrue: [dict at: #gemdb put: g]].
  "persisted, the same entries by attribute (persisted.o), there even when o means something else.
   Made once a session: its class is compiled on first use, and that is a write."
  (dict includesKey: #persisted) ifFalse: [
    g := SessionTemps current at: #'GemDbPersistedView' otherwise: nil.
    g isNil ifTrue: [
      g := [dispatcher evaluateSource: 'import gemdb
class PersistedObjects:
    """What Persisted Objects holds, by name: persisted.o is gemdb.root["o"]."""
    def __getattr__(self, name):
        try:
            return gemdb.root[name]
        except KeyError:
            raise AttributeError(f"Persisted Objects has no {name!r}") from None
    def __getitem__(self, key):
        return gemdb.root[key]
    def __dir__(self):
        return sorted(k for k in gemdb.root.keys() if isinstance(k, str))
    def __repr__(self):
        return "Persisted Objects: " + (", ".join(self.__dir__()) or "nothing yet")
PersistedObjects()' usingModuleScope: SymbolDictionary new]
        on: AbstractException do: [:e | e return: nil].
      g notNil ifTrue: [SessionTemps current at: #'GemDbPersistedView' put: g]].
    g notNil ifTrue: [dict at: #persisted put: g]].
  "Then what Persisted Objects holds, each under its key: o for gemdb.root['o']. Never over a
   name the frame has, nor over a builtin (list, print), and only keys that are Python names."
  g := [dispatcher evaluateSource: 'import gemdb, builtins, keyword
[(k, v) for k, v in gemdb.root.items() if isinstance(k, str) and k.isidentifier() and not keyword.iskeyword(k) and not hasattr(builtins, k)]' usingModuleScope: SymbolDictionary new]
    on: AbstractException do: [:e | e return: #()].
  g do: [:pair | | nm |
    nm := (pair at: 1) asString asSymbol.
    nameAst notNil ifTrue: [nm := [nameAst doitScopeNameFor: nm] on: Error do: [:e | e return: nm]].
    (dict includesKey: nm) ifFalse: [dict at: nm put: (pair at: 2). persisted at: nm put: (pair at: 2)]].
  "The names it starts with, so the ones the console binds can be told apart (%names)."
  console := { #gemdbConsole. dict. dict keys copy. persisted }.
  reg add: console.
  cref := reg size].
`;
}

/**
 * Smalltalk for **Show in Debug Console**: what to type at the console's
 * prompt to reach registry entry `handle`'s object. When `name` — a Python
 * identifier — already means that very object in the frame's console scope
 * (a Locals or Globals row), the answer is
 * `name`; otherwise the object is bound to `_`, Python's name for the last
 * result, and the answer is `_`. Answers `<consoleRef> <name>`, or an
 * `Error: …` line.
 */
export function consoleNameQuery(
  scope: ConsoleScope,
  consoleRef: number,
  name: string,
  handle: number,
): string {
  return `| reg dispatcher cref console dict g l bind nameAst none field record out o key |
${PREAMBLE}
${consoleScopeSetup(scope, consoleRef)}
dict := console at: 2.
${ROW_OBJECT(handle, 'o')}
key := nil.
${
  name
    ? `key := '${escapeString(name)}' asSymbol.
nameAst notNil ifTrue: [key := [nameAst doitScopeNameFor: key] on: Error do: [:e | e return: key]].`
    : ''
}
((key notNil and: [dict includesKey: key]) and: [(dict at: key) == o])
  ifTrue: [^ (cref printString , ' ${escapeString(name)}') encodeAsUTF8].
"Bound by Python itself: Grail carries \`_\` under a spelling of its own (measured: a read of a
 dictionary's #'_' raised NameError for '___unused___')."
dict at: #'_gemdb_shown' put: o.
[dispatcher evaluateSource: '_ = _gemdb_shown' usingModuleScope: dict]
  ensure: [dict removeKey: #'_gemdb_shown' ifAbsent: []].
(cref printString , ' _') encodeAsUTF8`;
}

/**
 * Smalltalk that runs Debug Console or watch input `source` in a frame's
 * console scope and answers what came of it (`parseConsoleReply`).
 *
 * The scope is made on a frame's first line and kept in the pause's registry
 * as `{#gemdbConsole. dict. startingNames. persisted}`, at `consoleRef` once made, so a name the
 * console binds (`y = 5`, `import json`, a `def`) is there for the next line
 * and gone with the registry at resume, as under debugpy. It is one
 * SymbolDictionary run as a module scope: the frame's globals, copied, with
 * its locals copied over them, so a local shadows a global as it does in the
 * frame's own code, and a comprehension or lambda sees the locals — with
 * locals in a dict of their own, as debugpy evaluates, it would not.
 * `gemdb` is bound too when the frame has no name of that spelling, so a line
 * copied from Persisted Objects (`gemdb.root["orders"]`) runs in a program
 * that never imported it; and so is each entry of `gemdb.root` under its key
 * (`orders`), below the frame's own names and never over a builtin, so what a
 * user persisted is there by name at every later pause. `persisted` reaches
 * the same entries by attribute (`persisted.o`), so a persisted object stays
 * reachable by a short name when `o` means something else here.
 * Because they are copies, rebinding a name (`x = 5`) stays in the console;
 * the objects are the real ones, so `p.x = 10` changes the program's `p`.
 * A frame's locals are keyed by their Python spelling, but a scope evaluated
 * this way carries the six names that are Smalltalk pseudo-variables — `self`
 * above all — under Grail's own stand-in, which `NameAst doitScopeNameFor:`
 * answers (`___pyresv_self___`), so they are copied in under that; copied as
 * `self`, a method's `self` read as undefined (measured).
 *
 * What the input prints is captured, as `withQuietConsole` does for a
 * `__repr__`, and answered with the result. An exception is caught from
 * Smalltalk, where Python never gave it a `__traceback__`; Grail's
 * `pythonTracebackFrames` walks the stack the raise captured instead, which
 * is the same walk Python's own outermost handler would have made. A soft
 * break — the watch's time budget, or the user cancelling — lands as a
 * ControlInterrupt and is answered as interrupted, not as an error in the
 * user's code.
 *
 * `selfHandle`, when given, is a registry entry to run with as `self` — a
 * Variables row's object, for **Evaluate with self…**. It is bound in a copy
 * of the console scope, used for this input alone, so the frame's own `self`
 * and the names the console has bound are left as they were.
 */
export function consoleQuery(
  scope: ConsoleScope,
  consoleRef: number,
  source: string,
  selfHandle = 0,
  bareName = '',
): string {
  const origin = bareName
    ? `kind == #value ifTrue: [| key |
  key := '${escapeString(bareName)}' asSymbol.
  nameAst notNil ifTrue: [key := [nameAst doitScopeNameFor: key] on: Error do: [:e | e return: key]].
  (((console at: 4) includesKey: key) and: [((console at: 4) at: key) == r])
    ifTrue: [origin := 'persisted']].`
    : '';
  return `| reg out field record none saved describe childrenOf reprOf late clean isLeaf dispatcher cref console dict g l r kind exc captured bind nameAst target origin ${ROW_TEMPS} |
${PREAMBLE}
${HELPERS}
${CHILDREN_OF}
${DESCRIBE}
${consoleScopeSetup(scope, consoleRef)}target := console at: 2.
${
  selfHandle > 0
    ? `${ROW_OBJECT(selfHandle, 'g')}
dict := target copy.
bind value: #self value: g.
target := dict.`
    : ''
}
kind := #value.
exc := nil.
captured := WriteStream on: Unicode7 new.
saved := SessionTemps current at: #'GrailConsole' otherwise: nil.
SessionTemps current at: #'GrailConsole' put: (Array with: captured).
[r := [[dispatcher evaluateSource: '${escapeString(source)}' usingModuleScope: target]
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
origin := ''.
${origin}
out nextPutAll: kind; nextPut: field; print: cref; nextPut: field; nextPutAll: (clean value: captured contents);
  nextPut: field; nextPutAll: origin; nextPut: record.
kind == #value ifTrue: [
  "The result's own row, as the Variables pane would write it, with its __repr__ quiet."
  SessionTemps current at: #'GrailConsole' put: (Array with: (WriteStream on: Unicode7 new)).
  [describe value: 'result' value: r] ensure: [
    saved isNil
      ifTrue: [SessionTemps current removeKey: #'GrailConsole' ifAbsent: []]
      ifFalse: [SessionTemps current at: #'GrailConsole' put: saved]]].
${REPLY_ERROR}
out contents encodeAsUTF8`;
}

/**
 * Smalltalk that writes the error records of `consoleQuery`'s answer, when
 * `kind` is `#stack` or `#error` (with the exception in `exc`): the type and
 * message, where a SyntaxError could not read, and then the traceback's frames,
 * as `parseConsoleReply` reads them. The Inspector's Evaluate tab answers in
 * the same format (`inspectorEvaluateQuery`).
 *
 * A caller must have `kind`, `exc`, `out`, `field`, `record` and `clean` (from
 * `PREAMBLE` and `HELPERS`) in scope. Only the error branch reads `clean` and
 * the separators, and a missing temp is a compile error of the whole query, so
 * a caller missing one fails on its first line, not only when one raises.
 */
export const REPLY_ERROR = `kind == #stack ifTrue: [
  out nextPutAll: 'RecursionError'; nextPut: field; nextPutAll: 'maximum recursion depth exceeded'; nextPut: record].
kind == #error ifTrue: [| payload frames tname msg attr sx |
  attr := [:o :name | [o @env1:___pyAttrLoad___: name] on: AbstractException do: [:e | e return: nil]].
  payload := [exc ensurePythonTraceback] on: AbstractException do: [:e | e return: exc].
  frames := [exc pythonTracebackFrames] on: AbstractException do: [:e | e return: #()].
  tname := [payload ___pythonTypeNameForTraceback___] on: AbstractException do: [:e | e return: exc class name asString].
  msg := [payload ___safeStrForTraceback___] on: AbstractException do: [:e | e return: exc messageText asString].
  "A SyntaxError says where it could not read, and str() of one is a tuple: its msg is the message."
  sx := ((attr value: payload value: #'lineno') isNumber and: [(attr value: payload value: #'text') isString])
    ifTrue: [{ attr value: payload value: #'filename'. attr value: payload value: #'lineno'.
      attr value: payload value: #'offset'. attr value: payload value: #'text' }]
    ifFalse: [nil].
  (sx notNil and: [(attr value: payload value: #'msg') isString]) ifTrue: [msg := attr value: payload value: #'msg'].
  out nextPutAll: (clean value: tname asString); nextPut: field; nextPutAll: (clean value: msg asString).
  sx notNil ifTrue: [
    out nextPut: field; nextPutAll: (clean value: ((sx at: 1) isString ifTrue: [sx at: 1] ifFalse: [''])); nextPut: field;
      print: (sx at: 2); nextPut: field;
      print: ((sx at: 3) isNumber ifTrue: [sx at: 3] ifFalse: [0]); nextPut: field;
      nextPutAll: (clean value: (sx at: 4))].
  out nextPut: record.
  frames do: [:f |
    out nextPutAll: (clean value: ((f at: 1) ifNil: ['<grail>']) asString); nextPut: field;
      print: ((f at: 2) isNumber ifTrue: [f at: 2] ifFalse: [0]); nextPut: field;
      nextPutAll: (clean value: ((f at: 3) ifNil: ['?']) asString); nextPut: field;
      nextPutAll: (clean value: ((f at: 4) isString ifTrue: [f at: 4] ifFalse: [''])); nextPut: record]].`;

/**
 * Smalltalk that puts in `into` the object of registry entry `handle`, the
 * one a Variables row was registered with, or answers an `Error: …` line when
 * there is none — a group row (`class variables`) or a scope is not an object.
 */
function ROW_OBJECT(handle: number, into: string): string {
  return `${into} := (${handle} between: 1 and: reg size) ifTrue: [reg at: ${handle}] ifFalse: [nil].
(${into} isNil or: [${into} class == Array and: [${into} size >= 2
    and: [#(#gemdbScope #gemdbGroup #gemdbConsole) includes: (${into} at: 1)]]])
  ifTrue: [^ 'Error: that row is not an object of its own' encodeAsUTF8].`;
}

/**
 * Smalltalk that writes one row, named `name`, for the object of registry
 * entry `handle` — what **Show in Debug Console** puts in the console — in
 * `childrenQuery`'s format, or answers an `Error: …` line.
 */
export function describeRowQuery(handle: number, name: string): string {
  return `| reg obj out field record none saved describe childrenOf reprOf late clean isLeaf ${ROW_TEMPS} |
${PREAMBLE}
reg := SessionTemps current at: #'${REGISTRY}' otherwise: nil.
reg isNil ifTrue: [^ 'Error: the pause is over' encodeAsUTF8].
${ROW_OBJECT(handle, 'obj')}
${HELPERS}
${CHILDREN_OF}
${DESCRIBE}
${withQuietConsole(`describe value: '${escapeString(name)}' value: obj`)}
out contents encodeAsUTF8`;
}

/**
 * Smalltalk answering the names bound in frame `scope`'s console since it was
 * made — what the user typed, not the frame's own names — one per record, as
 * `name`, field, `type`, field, short repr, in their Python spelling (`self`,
 * not Grail's stand-in). GemDB's own `_gemdb…` names are left out, and so are
Grail's own `___…___` ones that stay so spelled (a saved stack's console gains
`___pyGlobals___` after it is made). For
 * `%names`, and for completing a name after `%persist `.
 */
export function consoleNamesQuery(scope: ConsoleScope, consoleRef: number): string {
  return `| reg dispatcher cref console dict g l bind nameAst none field record out names |
${PREAMBLE}
${consoleScopeSetup(scope, consoleRef)}
dict := console at: 2.
names := (dict keys reject: [:k | (console at: 3) includes: k]) asSortedCollection: [:a :b | a <= b].
names do: [:k | | v nm tname text |
  nm := nameAst isNil ifTrue: [k asString]
    ifFalse: [[(nameAst doitScopeNameToPythonName: k) asString] on: Error do: [:e | e return: k asString]].
  "Grail carries Python's _ under a spelling of its own (measured: ___unused___)."
  nm = '___unused___' ifTrue: [nm := '_'].
  ((nm size >= 6 and: [(nm copyFrom: 1 to: 6) = '_gemdb'])
    or: [nm size > 6 and: [(nm copyFrom: 1 to: 3) = '___' and: [(nm copyFrom: nm size - 2 to: nm size) = '___']]])
      ifFalse: [
    v := dict at: k.
    tname := [((v @env1:___pyAttrLoad___: #'__class__') @env1:___pyAttrLoad___: #'__name__') asString]
      on: AbstractException do: [:e | e return: v class name asString].
    text := [(v @env1:__repr__) asString] on: AbstractException do: [:e | e return: '?'].
    text size > 80 ifTrue: [text := (text copyFrom: 1 to: 77) , '...'].
    out nextPutAll: nm; nextPut: field; nextPutAll: tname; nextPut: field;
      nextPutAll: (text collect: [:c | (c == field or: [c == record]) ifTrue: [$?] ifFalse: [c]]);
      nextPut: record]].
(cref printString , (String with: record) , out contents) encodeAsUTF8`;
}

/** Parse `consoleNamesQuery`'s answer: the console's position, and its names. */
export function parseConsoleNames(raw: string): {
  consoleRef: number;
  names: Array<{ name: string; type: string; repr: string }>;
} {
  if (raw.startsWith('Error: ')) throw new Error(raw.slice('Error: '.length));
  const [ref = '', ...records] = raw.split(RECORD);
  return {
    consoleRef: Number.parseInt(ref, 10) || 0,
    names: records
      .filter((r) => r.length > 0)
      .map((r) => {
        const [name = '', type = '', repr = ''] = r.split(FIELD);
        return { name, type, repr };
      }),
  };
}

/**
 * Smalltalk answering what Persisted Objects holds: the `gemdb.root` keys that
 * are strings, separated by the field character, for the console's
 * autocomplete. A read, run in the paused session, so it sees what the run
 * has added too.
 */
export function persistedKeysQuery(): string {
  return `| keys out |
keys := [(System myUserProfile symbolList objectNamed: #'ModuleAst') evaluateSource: 'import gemdb
sorted(k for k in gemdb.root.keys() if isinstance(k, str))' usingModuleScope: SymbolDictionary new]
  on: AbstractException do: [:e | e return: #()].
out := WriteStream on: Unicode7 new.
keys do: [:k | out nextPutAll: k asString] separatedBy: [out nextPut: (Character codePoint: 31)].
out contents encodeAsUTF8`;
}

/** Parse `persistedKeysQuery`'s answer. */
export function parsePersistedKeys(raw: string): string[] {
  return raw.split(FIELD).filter((k) => k.length > 0);
}

/** Parse `consoleQuery`'s answer. */
export function parseConsoleReply(raw: string): ConsoleReply {
  if (raw.startsWith('Error: ')) {
    return { consoleRef: 0, output: '', kind: 'failed', message: raw.slice('Error: '.length) };
  }
  const [head = '', ...rest] = raw.split(RECORD);
  const [kind, ref, printed, origin] = head.split(FIELD);
  const consoleRef = Number.parseInt(ref ?? '', 10) || 0;
  const output = (printed ?? '').replace(/\r\n?/g, '\n');
  const records = rest.filter((r) => r.length > 0);
  if (kind === 'value') {
    const [row] = parseChildren(records.join(RECORD) + RECORD);
    if (row) {
      return {
        consoleRef,
        output,
        kind,
        row,
        ...(origin === 'persisted' ? { origin } : {}),
      };
    }
    return { consoleRef, output, kind: 'failed', message: 'The result could not be read.' };
  }
  if (kind === 'none' || kind === 'interrupted') return { consoleRef, output, kind };
  if (kind === 'error' || kind === 'stack') {
    const [type = '', message = '', file, line, offset, text] = (records[0] ?? '').split(FIELD);
    const int = (s: string | undefined): number => Number.parseInt(s ?? '', 10) || 0;
    const frames = records.slice(1).map((record): TracebackFrame => {
      const [frameFile, frameLine, name, frameText] = record.split(FIELD);
      return {
        file: frameFile || '<grail>',
        line: int(frameLine),
        name: name || '?',
        text: frameText ?? '',
      };
    });
    return {
      consoleRef,
      output,
      kind: 'error',
      error: {
        type,
        message,
        ...(line === undefined
          ? {}
          : {
              syntax: { file: file ?? '', line: int(line), offset: int(offset), text: text ?? '' },
            }),
        frames,
      },
    };
  }
  return { consoleRef, output, kind: 'failed', message: raw || 'The console got no answer.' };
}
