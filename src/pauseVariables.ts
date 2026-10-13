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
}

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
const CHILDREN_OF = `
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
 * the row can be changed is `ro`, which the caller sets for each row.
 *
 * Its repr is the user's `__repr__`, run through `reprOf`: a big container
 * shows its size instead (a container only: a module or an object with many
 * attributes keeps its repr), and a long string is asked for the repr of its
 * first characters only. Strings are checked before collections (in
 * `childrenOf`) because a String is a SequenceableCollection, and a Python str
 * should read as text, not as a list of characters.
 */
const DESCRIBE = `
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
      nextPut: field; nextPutAll: (ro == true ifTrue: ['1'] ifFalse: ['0']); nextPut: record]].`;

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
const HELPERS = `
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
 * from `start` (0-based), registering the expandable ones.
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
export function childrenQuery(ref: number, start: number, count: number): string {
  return `| reg obj kids out field record none saved describe childrenOf start count last isDunder nameOf reprOf late clean isLeaf ro typeNameOf roIn groupOf emitGrouped withGroups moduleClass broke classCounts classData isMethodType tooLong |
${PREAMBLE}
start := ${start}.
count := ${count}.
withGroups := true.
reg := SessionTemps current at: #'${REGISTRY}' otherwise: nil.
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

/** Parse `childrenQuery`'s answer. */
export function parseChildren(raw: string): PauseVariable[] {
  return raw
    .split(RECORD)
    .filter((r) => r.length > 0)
    .map((record): PauseVariable => {
      const [name, value, type, ref, indexed, named, handle, size, readOnly] = record.split(FIELD);
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
 */
export function setVariableQuery(
  processOop: bigint,
  ref: number,
  name: string,
  source: string,
  globalsRef = 0,
): string {
  const nm = `'${escapeString(name)}'`;
  return `| reg c g owner isScope v failed problem dispatcher evalScope kind key found py s kids out field record none saved describe childrenOf start count last isDunder nameOf reprOf late clean isLeaf ro typeNameOf roIn groupOf emitGrouped withGroups moduleClass broke classCounts classData isMethodType tooLong |
${PREAMBLE}
start := 0.
count := 0.
reg := SessionTemps current at: #'${REGISTRY}' otherwise: nil.
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
    v := [dispatcher evaluateSource: '${escapeString(`(\n${source}\n)`)}' usingModuleScope: evalScope]
      on: AbstractException do: [:e |
        failed := true.
        e return: e class name , ' - ' , e messageText asString].
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
  return `| reg obj out field record none saved describe childrenOf reprOf late clean isLeaf dispatcher root ro isDunder typeNameOf broke classCounts classData isMethodType tooLong |
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
