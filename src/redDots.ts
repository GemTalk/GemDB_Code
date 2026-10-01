import { DOT_LINE, FIELD, RECORD, STEP_POINT_LINE, STEP_POINT_TEMPS } from './haltStack';
import { escapeString } from './smalltalkText';

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

/** The import methods GemDB breaks on, by their place in `importlib class`. */
const MODULE_HOOK = '___pushInitializingModule___:';
const CLASS_HOOK = '___resetClassAttrOverlay___:';

/**
 * Smalltalk declaring `dots`, the red dots as a dictionary of path to lines,
 * and the blocks that arm a class:
 *
 * - `lineAt`, the Python line of a step point (`STEP_POINT_LINE`).
 * - `armMethod` sets a break on every step point of each dotted line in the
 *   method and its blocks, and notes the line in `armed`. Every one, not the
 *   first: a method can compile a line twice, a fast path and a slow one, and
 *   the first may be the copy that does not run (measured — a dot on a
 *   recursive `return f(n - 1) + 1` never fired). The extra hits within one
 *   entry are resumed silently (`hookStopQuery`). Step points at offset 1 are
 *   the method's prologue and are skipped, so a dot on
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
armMethod := [:meth :file :want | | infos src ir |
  infos := meth _allDebugInfoWithMeths: 2.
  ir := BaseException ___isIRPythonMethod___: meth.
  src := meth sourceString.
  1 to: infos size do: [:sp | | line own off |
    own := (infos at: sp) at: 1.
    line := [lineAt value: meth value: own value: sp] on: Error do: [:e | e return: nil].
    off := own _sourceOffsetsAt: sp.
    (ir and: [off between: 1 and: src size]) ifTrue: [
      (src at: off) isSeparator ifTrue: [line := nil]].
    (line notNil and: [want includes: line]) ifTrue: [
      ${dryRun ? '' : 'meth setBreakAtStepPoint: sp.'}
      (armed at: file ifAbsentPut: [Set new]) add: line]]].
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

/**
 * SessionTemps key of this run's recent red-dot stops, newest first, each
 * `{depth. frames. line. home}`: frames top first as `{method. ip}`, `home`
 * the stopped function's method. More than one, because a frame resumes its
 * line after something deeper stopped — a call on the line returning, a
 * recursion unwinding — and must be matched to its own last stop.
 */
const LAST_STOP = 'GemDbRecentRedDots';

/** How many recent stops are kept: deeper than any frame a line is resumed in. */
const RECENT_STOPS = 64;

/** Temps every query here declares. */
const TEMPS = `dots armed ${STEP_POINT_TEMPS} armMethod fileOf armClass armModule il out`;

/**
 * Smalltalk arming every module this session has loaded and every committed
 * one — an import warm-binds a committed module without running its body, so
 * no hook would see it. Shared by `armQuery` and its dry run, which must agree.
 */
const ARM_LOADED = `il := System myUserProfile symbolList objectNamed: #'importlib'.
[(System myUserProfile symbolList objectNamed: #'sys') @env1:modules keysAndValuesDo: [:name :mod |
  armModule value: mod]] on: Error do: [:e | e return: nil].
il isNil ifFalse: [
  [il ___canonicalModules___ do: [:mod | armModule value: mod]] on: Error do: [:e | e return: nil]].`;

/** Smalltalk writing `armed` to `out` as records: the file, then each line armed in it. */
const REPORT = `armed keysAndValuesDo: [:file :lines |
  out nextPutAll: file.
  lines asSortedCollection do: [:line | out nextPut: (Character codePoint: 31); print: line].
  out nextPut: (Character codePoint: 30)].
out contents encodeAsUTF8`;

/**
 * Smalltalk that arms a run: it clears every method breakpoint in the session,
 * then breaks on each dotted line of every module loaded or committed
 * (`ARM_LOADED`), and sets the two import hooks. With no dots it only clears.
 * Answers what it armed (`parseArmed`). Every step after the clear but one is
 * guarded, so one that fails — a hook Grail renamed — costs only itself, not
 * the dots already cleared. The exception is converting a paused process:
 * without it the breaks will not fire, so its failure fails the query, and
 * the editor shows the dots unverified rather than armed.
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
    ? `${ARM_LOADED}
il isNil ifFalse: [
  #(#'${MODULE_HOOK}' #'${CLASS_HOOK}') do: [:hook |
    [(il class compiledMethodAt: hook environmentId: 0) setBreakAtStepPoint: 1]
      on: Error do: [:e | e return: nil]]].`
    : ''
}
${paused === undefined ? '' : `(Object _objectForOop: ${paused}) convertToPortableStack.`}
${REPORT}`;
}

/**
 * Smalltalk answering what `armQuery` would arm for `dots`, walking the same
 * modules, without touching a break — for telling the editor which dots hold
 * one, while paused, when they are the dots the run was armed with.
 */
export function armedLinesQuery(dots: DotsByFile): string {
  return `| ${TEMPS} |
${prelude(dots, true)}
${ARM_LOADED}
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
 * line meets several (measured: four per pass of a `for` body), and every step
 * point of the line holds one. A stop is the same entry as an earlier one of
 * this run, repeat or not, when it is in the same function at the same line,
 * at least as deep on the same stack, and the frame that stopped then has
 * only moved forward through that line since: every frame below it unchanged, its ip
 * further on, with no step point of another line in between, and no new call
 * of the function above it — a recursive call on the dotted line is a new
 * entry, and stops. The earlier stop is the last one, at any depth, or an
 * older one at this very depth: a frame resuming its line after something
 * deeper stopped — a call on the line returning, a recursion unwinding.
 * Older stops deeper or shallower are not matched: a loop's driver frames are
 * charged to the body's line too, so the one stop a method makes as its loop
 * starts would swallow every pass (measured). A pass meets its frame at the
 * same depth and the same ip as the pass before, not further on, so it stops
 * again. Earlier stops count whether they were shown or not.
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
 * stop of `proc` and recording it among the recent stops (see `hookStopQuery`).
 */
function repeatCheck(): string {
  return `| depth frames line home stops same matches |
${STEP_POINT_LINE}
${DOT_LINE}
depth := proc stackDepth.
frames := (1 to: depth) collect: [:lvl | | f |
  f := proc _frameContentsAt: lvl.
  f isNil ifTrue: [{nil. 0}] ifFalse: [{f at: 1. f at: 2}]].
line := dotLineOf value: proc.
home := ((frames at: 1) at: 1) homeMethod.
"Whether this stop continues the entry into the line that stop \`last\` began."
matches := [:last | | ok pd pFrames |
  ok := line notNil and: [line = (last at: 3) and: [home == (last at: 4) and: [depth >= (last at: 1)]]].
  ok ifTrue: [
    pd := last at: 1.
    pFrames := last at: 2.
    "A call of the function itself above that frame is a new entry: recursion."
    1 to: depth - pd do: [:lvl | ((frames at: lvl) at: 1) == home ifTrue: [ok := false]].
    "Bottom-aligned: position b from the bottom is level pd - b + 1 then, depth - b + 1 now."
    1 to: pd do: [:b | | was now |
      was := pFrames at: pd - b + 1.
      now := frames at: depth - b + 1.
      ((was at: 1) == (now at: 1) and: [b < pd ifTrue: [(was at: 2) = (now at: 2)] ifFalse: [(now at: 2) > (was at: 2)]])
        ifFalse: [ok := false]]].
  ok ifTrue: [| m p q |
    m := (pFrames at: 1) at: 1.
    p := (pFrames at: 1) at: 2.
    q := (frames at: depth - pd + 1) at: 2.
    (m homeMethod _allDebugInfoWithMeths: 2) doWithIndex: [:info :i | | other |
      ((info at: 1) == m and: [(info at: 2) > p and: [(info at: 2) < q]]) ifTrue: [
        other := lineAt value: m homeMethod value: m value: i.
        (other notNil and: [other ~= line]) ifTrue: [ok := false]]]].
  ok].
stops := SessionTemps current at: #'${LAST_STOP}' ifAbsentPut: [OrderedCollection new].
"The last stop, at any depth; or an older one at this depth — this frame
 resuming its line after a deeper stop, a call on the line returning."
same := (stops notEmpty and: [matches value: stops first])
  or: [stops anySatisfy: [:last | (last at: 1) = depth and: [matches value: last]]].
stops addFirst: {depth. frames. line. home}.
stops size > ${RECENT_STOPS} ifTrue: [stops removeLast].
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
