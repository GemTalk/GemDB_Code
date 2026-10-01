import { DOT_LINE, FIELD, RECORD, STEP_POINT_LINE } from './haltStack';

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
 *   a module function's `def` line does not stop every call. So are step
 *   points on whitespace — a block's return at the line break after its
 *   statement — which are not an entry into the line: a `for` body met one
 *   on every pass after the statement's own (measured), a second stop each time.
 *   One extra stop remains: a `for` body's first line stops once before the
 *   first pass too, where the loop's setup runs a copy of that step point.
 *   Nothing static tells the copy from the per-pass one — preferring the
 *   innermost block picked paths that never run, and the dot never fired.
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
armMethod := [:meth :file :want | | infos seen src ir |
  infos := meth _allDebugInfoWithMeths: 2.
  seen := Set new.
  ir := BaseException ___isIRPythonMethod___: meth.
  src := meth sourceString.
  1 to: infos size do: [:sp | | line key own off |
    own := (infos at: sp) at: 1.
    line := [lineAt value: meth value: own value: sp] on: Error do: [:e | e return: nil].
    off := own _sourceOffsetsAt: sp.
    (ir and: [off between: 1 and: src size]) ifTrue: [
      (src at: off) isSeparator ifTrue: [line := nil]].
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

/** SessionTemps key of the last red-dot stop: `{depth. frames. line}`, frames top first as `{method. ip}`. */
const LAST_STOP = 'GemDbLastRedDot';

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
${paused === undefined ? `SessionTemps current removeKey: #'${LAST_STOP}' ifAbsent: [].` : ''}
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
 * `hook` and what was armed. Otherwise the stop is a red dot: `repeat` when it
 * is the same entry into a line as the last stop, else `dot`.
 *
 * One Python line is spread over a method and its blocks — a loop body, the
 * machinery of `+=` — and each holds a break on it, so one pass through the
 * line meets several (measured: four per pass of a `for` body). A stop is the
 * same entry as the last stop, repeat or not, when it is deeper on the same
 * stack, at the same line, and the frame that stopped last has run nothing but
 * that line since: every frame below it unchanged, and no step point of
 * another line between its old ip and its new one. A loop's next pass
 * re-enters at the same depth as its last, so it stops again. Comparing with
 * the last stop of any kind is what makes that hold: a `for` line's own
 * method stops once as the loop starts, and every pass runs deeper beneath it
 * (measured).
 *
 * At the module hook the module's class is a temp of the caller,
 * `loadModuleFromPath:name:`, found by name rather than position. The module
 * itself cannot be looked up by name here: Grail's lookup waits for a module
 * whose body is running, and the body is the paused process (measured — the
 * query hung until soft-broken).
 */
export function hookStopQuery(processOop: bigint, dots: DotsByFile): string {
  return `| ${TEMPS} proc top sel fc names at dotLineOf |
proc := Object _objectForOop: ${processOop}.
top := (proc _frameContentsAt: 1) at: 1.
sel := top selector.
il := System myUserProfile symbolList objectNamed: #'importlib'.
(il notNil and: [top inClass == il class and: [sel == #'${MODULE_HOOK}' or: [sel == #'${CLASS_HOOK}']]])
  ifFalse: [^ ([${repeatCheck()}] on: Error do: [:e | e return: 'dot']) encodeAsUTF8].
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

/**
 * Smalltalk, the body of a block, answering `repeat` or `dot` for a red-dot
 * stop of `proc` and recording it as the last stop (see `hookStopQuery`).
 */
function repeatCheck(): string {
  return `| depth frames line last same pd pFrames |
${STEP_POINT_LINE}
${DOT_LINE}
depth := proc stackDepth.
frames := (1 to: depth) collect: [:lvl | | f |
  f := proc _frameContentsAt: lvl.
  f isNil ifTrue: [{nil. 0}] ifFalse: [{f at: 1. f at: 2}]].
line := dotLineOf value: proc.
last := SessionTemps current at: #'${LAST_STOP}' otherwise: nil.
same := last notNil and: [line notNil and: [line = (last at: 3) and: [depth > (last at: 1)]]].
same ifTrue: [
  pd := last at: 1.
  pFrames := last at: 2.
  "Bottom-aligned: position b from the bottom is level pd - b + 1 then, depth - b + 1 now."
  1 to: pd do: [:b | | was now |
    was := pFrames at: pd - b + 1.
    now := frames at: depth - b + 1.
    ((was at: 1) == (now at: 1) and: [b < pd ifTrue: [(was at: 2) = (now at: 2)] ifFalse: [(now at: 2) >= (was at: 2)]])
      ifFalse: [same := false]].
  same ifTrue: [| m home p q |
    m := (pFrames at: 1) at: 1.
    p := (pFrames at: 1) at: 2.
    q := (frames at: depth - pd + 1) at: 2.
    home := m homeMethod.
    (home _allDebugInfoWithMeths: 2) doWithIndex: [:info :i | | other |
      ((info at: 1) == m and: [(info at: 2) > p and: [(info at: 2) < q]]) ifTrue: [
        other := lineAt value: home value: m value: i.
        (other notNil and: [other ~= line]) ifTrue: [same := false]]]]].
SessionTemps current at: #'${LAST_STOP}' put: {depth. frames. line}.
same ifTrue: ['repeat'] ifFalse: ['dot']`;
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
