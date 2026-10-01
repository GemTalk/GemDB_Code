import { FIELD, RECORD, STEP_POINT_LINE } from './haltStack';

/**
 * Red-dot breakpoints in `.py` files.
 *
 * A red dot becomes a GemStone method breakpoint (`setBreakAtStepPoint:`) on
 * the method Grail compiled the line into, and fires as GCI error 6005 in a
 * run started with `GCI_PERFORM_FLAG_ENABLE_DEBUG` — native code included.
 * Breakpoints live in the session, not the repository: another session using
 * the same committed method never stops at them (measured).
 *
 * A method has to exist before it can hold a break, and a module's methods
 * are compiled when it is imported, mid-run. So a run is *armed* before it
 * starts — every module already loaded or committed gets its breaks — and two
 * of Grail's own import methods carry a break of GemDB's as well, which stop
 * the run just long enough to arm what they built:
 *
 * - `importlib class >> ___pushInitializingModule___:` runs after a cold
 *   import has compiled the module's functions and before its body runs;
 * - `importlib class >> ___resetClassAttrOverlay___:` runs after each
 *   module-level class is built, with the class, its methods installed.
 *
 * Those two stops are answered by `hookStopQuery` and resumed at once; the
 * user never sees them. Their cost is one round trip per cold import and per
 * class it defines, and only while some `.py` file has a red dot.
 *
 * Not covered: a class defined inside a function (its methods are compiled
 * each time the function runs, and no hook sees them), and notebook cells.
 */

/** Red dots by file: the absolute path Grail knows the file by, and 1-based lines. */
export type DotsByFile = ReadonlyMap<string, readonly number[]>;

/** A Smalltalk string literal's body. (Not `pythonQueries`' copy: that module needs the session, which needs this.) */
const escapeString = (value: string): string => value.replace(/'/g, "''");

/** The import methods GemDB breaks on, by their place in `importlib class`. */
const MODULE_HOOK = '___pushInitializingModule___:';
const CLASS_HOOK = '___resetClassAttrOverlay___:';

/**
 * Smalltalk declaring `dots`, the red dots as a dictionary of path to lines,
 * and the blocks that arm a class:
 *
 * - `lineAt`, the Python line of a step point (`STEP_POINT_LINE`).
 * - `armMethod` sets a break on the first step point of each dotted line in
 *   the method and each of its blocks, and notes the line in `armed`. Step
 *   points at offset 1 are the method's prologue and are skipped, so a dot on
 *   a `def` line does not stop every call.
 * - `armClass` arms every Python method of a class whose file has a dot.
 *
 * With `dryRun`, nothing is set: `armed` says what arming would set.
 */
function prelude(dots: DotsByFile, dryRun = false): string {
  const entries = [...dots]
    .filter(([, lines]) => lines.length > 0)
    .map(([file, lines]) => `dots at: '${escapeString(file)}' put: #(${lines.join(' ')}).`)
    .join('\n');
  return `dots := Dictionary new.
${entries}
armed := Dictionary new.
out := WriteStream on: Unicode7 new.
${STEP_POINT_LINE}
armMethod := [:meth :file :want | | infos seen |
  infos := meth _allDebugInfoWithMeths: 2.
  seen := Set new.
  1 to: infos size do: [:sp | | line key |
    line := [lineAt value: meth value: sp] on: Error do: [:e | e return: nil].
    (line notNil and: [want includes: line]) ifTrue: [
      key := { (infos at: sp) at: 1. line }.
      (seen includes: key) ifFalse: [
        seen add: key.
        ${dryRun ? '' : 'meth setBreakAtStepPoint: sp.'}
        (armed at: file ifAbsentPut: [Set new]) add: line]]]].
fileOf := [:meth | [(BaseException ___liveFrameFilenameFor___: meth) asString]
  on: Error do: [:e | e return: nil]].
armClass := [:cls |
  ((cls notNil and: [cls isBehavior]) and: [(cls respondsTo: #methodDictForEnv:)]) ifTrue: [
    (cls methodDictForEnv: 1) ifNotNil: [:md | md do: [:meth | | file want |
      file := fileOf value: meth.
      want := file isNil ifTrue: [nil] ifFalse: [dots at: file ifAbsent: [nil]].
      want notNil ifTrue: [armMethod value: meth value: file value: want]]]]].
armModule := [:mod | | file |
  file := [(mod @env0:dynamicInstVarAt: #'__file__') asString] on: Error do: [:e | e return: nil].
  (file notNil and: [dots includesKey: file]) ifTrue: [
    armClass value: mod class.
    [(mod @env1:__dict__) keysAndValuesDo: [:k :v |
      (v notNil and: [v isBehavior]) ifTrue: [armClass value: v]]]
      on: Error do: [:e | e return: nil]]].
`;
}

/** Temps every query here declares. */
const TEMPS = 'dots armed lineAt armMethod fileOf armClass armModule il out';

/** Smalltalk writing `armed` to `out` as records: the file, then each line armed in it. */
const REPORT = `armed keysAndValuesDo: [:file :lines |
  out nextPutAll: file.
  lines asSortedCollection do: [:line | out nextPut: (Character codePoint: 31); print: line].
  out nextPut: (Character codePoint: 30)].
out contents encodeAsUTF8`;

/**
 * Smalltalk that arms a run: it clears every method breakpoint in the session,
 * then breaks on each dotted line of every module this session has loaded and
 * every committed one (an import warm-binds a committed module without
 * running its body, so no hook would see it), and sets the two import hooks.
 * With no dots it only clears. Answers what it armed (`parseArmed`).
 *
 * `paused` is the process of a run paused now. A break set while paused
 * fires later in the run only if the process is converted to portable code
 * after the breaks are set (and the run, and its Continue, carry
 * `ENABLE_DEBUG`) — measured; converting first, or not at all, and the break
 * is silently ignored. Converting makes the frames on its stack run
 * interpreted, which is why it is done only when the dots change.
 */
export function armQuery(dots: DotsByFile, paused?: bigint): string {
  const any = [...dots.values()].some((lines) => lines.length > 0);
  return `| ${TEMPS} |
GsNMethod clearAllBreaks.
${prelude(dots)}
${
  any
    ? `il := System myUserProfile symbolList objectNamed: #'importlib'.
il isNil ifFalse: [
  [(System myUserProfile symbolList objectNamed: #'sys') @env1:modules keysAndValuesDo: [:name :mod |
    armModule value: mod]] on: Error do: [:e | e return: nil].
  [il ___canonicalModules___ do: [:mod | armModule value: mod]] on: Error do: [:e | e return: nil].
  (il class compiledMethodAt: #'${MODULE_HOOK}' environmentId: 0) setBreakAtStepPoint: 1.
  (il class compiledMethodAt: #'${CLASS_HOOK}' environmentId: 0) setBreakAtStepPoint: 1].`
    : ''
}
${paused === undefined ? '' : `(Object _objectForOop: ${paused}) convertToPortableStack.`}
${REPORT}`;
}

/**
 * Smalltalk answering what `armQuery` would arm for `dots` in the modules this
 * session has loaded, without touching a break — for telling the editor which
 * dots hold one, while paused, when nothing has changed.
 */
export function armedLinesQuery(dots: DotsByFile): string {
  return `| ${TEMPS} |
${prelude(dots, true)}
[(System myUserProfile symbolList objectNamed: #'sys') @env1:modules keysAndValuesDo: [:name :mod |
  armModule value: mod]] on: Error do: [:e | e return: nil].
${REPORT}`;
}

/**
 * Smalltalk run at a 6005 stop of the suspended process `processOop`: if the
 * stop is one of the import hooks, arm what that import just built and answer
 * `hook` and what was armed; otherwise the stop is a red dot, and it answers
 * `dot`.
 *
 * At the module hook the module's class is a temp of the caller,
 * `loadModuleFromPath:name:`, found by name rather than position. The module
 * itself cannot be looked up by name here: Grail's lookup waits for a module
 * whose body is running, and the body is the paused process (measured — the
 * query hung until soft-broken).
 */
export function hookStopQuery(processOop: bigint, dots: DotsByFile): string {
  return `| ${TEMPS} proc top sel fc names at |
proc := Object _objectForOop: ${processOop}.
top := (proc _frameContentsAt: 1) at: 1.
sel := top selector.
il := System myUserProfile symbolList objectNamed: #'importlib'.
(il notNil and: [top inClass == il class and: [sel == #'${MODULE_HOOK}' or: [sel == #'${CLASS_HOOK}']]])
  ifFalse: [^ 'dot' encodeAsUTF8].
${prelude(dots)}
sel == #'${CLASS_HOOK}'
  ifTrue: [armClass value: ((proc _frameContentsAt: 1) at: 11)]
  ifFalse: [
    fc := proc _frameContentsAt: 2.
    names := fc at: 9.
    at := names indexOf: #'moduleClass'.
    at > 0 ifTrue: [armClass value: (fc at: 10 + at)]].
out nextPutAll: 'hook'; nextPut: (Character codePoint: 30).
${REPORT}`;
}

/** What `armQuery` armed, or a hook stop after its `hook` record: the lines that now hold a break, by file. */
export function parseArmed(raw: string): Map<string, number[]> {
  const armed = new Map<string, number[]>();
  for (const record of raw.split(RECORD)) {
    if (!record || record === 'hook') continue;
    const [file, ...lines] = record.split(FIELD);
    if (!file) continue;
    armed.set(
      file,
      lines.map((n) => Number.parseInt(n, 10)).filter((n) => Number.isFinite(n)),
    );
  }
  return armed;
}
