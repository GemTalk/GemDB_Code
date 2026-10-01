/**
 * The Python call stack of an evaluation paused at `breakpoint()`.
 *
 * The suspended GsProcess holds Smalltalk frames — Grail's runtime interleaved
 * with the methods and blocks Python compiled to — so the work is Grail's: it
 * already walks a suspended process for generators, names each frame the way
 * CPython would (`outer`, `<lambda>`, `<module>`), and maps a method and ip to
 * the Python line and columns. The query below only strings those together.
 *
 * Those selectors are private to Grail (the `___x___` spelling), so a Grail
 * that renames one fails this query rather than the evaluation: the debugger
 * then opens with no frames, and Continue and Stop still work.
 */

/** One Python frame, innermost first. */
export interface PythonFrame {
  /** `Class.method` for a method, the bare name for a function, `<module>`. */
  name: string;
  /** 1-based, or 0 when Grail could not place the frame. */
  line: number;
  /** Grail's PEP 657 span: 0-based columns, end exclusive; all 0 when absent. */
  column: number;
  endLine: number;
  endColumn: number;
  /** A real path, or `<grail>` for code a notebook cell or the shell compiled. */
  file: string;
  /** Text from the frame's line — often a slice of it — which is how a `<grail>` frame finds its cell. */
  lineText: string;
  /** Registry position of the frame's locals, when the query registered them (`pauseVariables.ts`); 0 for none. */
  locals?: number;
}

/** Field and record separators: characters with no place in names, paths or source lines. */
export const FIELD = '\u001f';
export const RECORD = '\u001e';

/**
 * Smalltalk declaring `lineAt` (needs the temps `STEP_POINT_TEMPS`), a block
 * answering the Python line of step point `sp` of method `home`, or nil for
 * its prologue (offset 1) or a step point it cannot place. `own` is the method the step point is in — `home`,
 * or one of its blocks (a loop body, a nested def, a comprehension): only that
 * method knows the step point's source offset, and `home` answers 1 for a
 * block's (measured), which would read as prologue and drop the dot.
 *
 * Grail's IR methods carry the Python source itself, followed by a
 * `# line N file …` header — the last one in the source, since the code above
 * it may hold that text too — so the line is N plus the newlines before the
 * step point's offset. Text-compiled methods are Smalltalk with a
 * `___curPos___ := line` before each statement, which is what Grail's own
 * ip-to-line lookup reads. That lookup answers the line already *reached*,
 * so on an IR method, at a step point not yet run, it is a line early
 * (measured), and it is not used for them. Each method's header and line
 * starts are read once and kept in `lineCache`, since arming asks for every
 * step point of the method.
 */
export const STEP_POINT_TEMPS = 'lineAt lineCache';
export const STEP_POINT_LINE = `lineCache := IdentityDictionary new.
lineAt := [:home :own :sp | | entry off |
  (BaseException ___isIRPythonMethod___: home)
    ifTrue: [
      entry := lineCache at: home ifAbsent: [| src at next lfs n |
        src := home sourceString.
        at := 0.
        [(next := src indexOfSubCollection: '# line ' startingAt: at + 1) > 0] whileTrue: [at := next].
        at = 0
          ifTrue: [lineCache at: home put: nil]
          ifFalse: [
            "lfs at: k is how many line breaks come before position k."
            lfs := Array new: src size.
            n := 0.
            1 to: src size do: [:k | lfs at: k put: n. (src at: k) == Character lf ifTrue: [n := n + 1]].
            lineCache at: home put: {((src copyFrom: at + 7 to: src size) readStream upTo: $ ) asNumber. lfs}]].
      off := own _sourceOffsetsAt: sp.
      (entry isNil or: [off <= 1 or: [off > (entry at: 2) size]])
        ifTrue: [nil]
        ifFalse: [(entry at: 1) + ((entry at: 2) at: off)]]
    ifFalse: [| info |
      info := home _meth_ip_ForStepPoint: sp.
      (info isNil or: [(own _sourceOffsetsAt: sp) <= 1])
        ifTrue: [nil]
        ifFalse: [BaseException ___pythonLineForMethod___: (info at: 1) ip: (info at: 2)]]].`;

/**
 * Smalltalk declaring `dotLineOf`, a block answering the Python line of the
 * step point a process stopped at a red dot is sitting on, or nil. Needs
 * `lineAt`. At a red dot the top Smalltalk frame is the very method or block
 * holding the break, at exactly the step point's ip (measured) — unlike the
 * frame Grail's walk reports for it, which for a block names its home method.
 */
export const DOT_LINE = `dotLineOf := [:aProc | | f m home sp |
  f := aProc _frameContentsAt: 1.
  m := f at: 1.
  home := m homeMethod.
  sp := 0.
  (home _allDebugInfoWithMeths: 2) doWithIndex: [:info :i |
    ((info at: 1) == m and: [(info at: 2) = (f at: 2)]) ifTrue: [sp := i]].
  sp = 0 ifTrue: [nil] ifFalse: [lineAt value: home value: m value: sp]].`;

/**
 * Smalltalk spliced into the stack query by a caller that wants more from the
 * same walk: `temps` are declared, `setup` runs first, `perFrame` runs for
 * each frame with the pair in `p` (appending its own fields to `out`), and
 * `after` runs last.
 */
export interface StackQueryExtras {
  temps: string;
  setup: string;
  perFrame: string;
  after: string;
}

/**
 * Smalltalk that answers the Python frames of the suspended process `processOop`.
 *
 * `___liveFramePairsFrom___:` drops the Smalltalk frames and names the Python
 * ones; `offset: 0 running: false` is how Grail itself calls it for a
 * suspended process (`___liveFrameChain___`). The walk's own line wins: for a
 * block frame (a def inside a notebook cell) the span helper answers a line
 * from somewhere else in the method (measured: 6 where the walk says 9), so a
 * span is used for its columns only when it agrees on the line, and a cell
 * frame without one takes its line text from the positions the generated
 * source records (`___curPosPositionsFromSource___:`). A frame is
 * qualified with its class when its method belongs to a Python class rather
 * than to a module — the receiver-side test Grail's own walk makes, done on
 * the defining class.
 *
 * Each frame is described inside its own error guard: a frame Grail cannot
 * place becomes a `?` row with no line, rather than failing the query and
 * costing every other frame.
 *
 * `atStepPoint` is for a process stopped at a red dot, before the statement
 * runs, where Grail's lookup reads the line before. The innermost frame's
 * line comes from the step point instead (`DOT_LINE`), without a span, so
 * the highlight takes the whole line.
 */
export function pythonStackQuery(
  processOop: bigint,
  extras?: StackQueryExtras,
  atStepPoint = false,
): string {
  return `| proc both pairs out modCls field record placeholder ${STEP_POINT_TEMPS} dotLineOf dotLine thisDot ${extras?.temps ?? ''} |
${STEP_POINT_LINE}
${DOT_LINE}
proc := Object _objectForOop: ${processOop}.
modCls := System myUserProfile symbolList objectNamed: #'module'.
field := Character codePoint: 31.
record := Character codePoint: 30.
out := WriteStream on: Unicode7 new.
placeholder := WriteStream on: Unicode7 new.
placeholder nextPutAll: '?'; nextPut: field.
4 timesRepeat: [placeholder nextPutAll: '0'; nextPut: field].
placeholder nextPutAll: '<grail>'; nextPut: field.
placeholder := placeholder contents.
dotLine := ${atStepPoint} ifTrue: [[dotLineOf value: proc] on: Error do: [:e | e return: nil]] ifFalse: [nil].
${extras?.setup ?? ''}
both := BaseException ___framesAndLevelsOfSuspendedProcess___: proc.
both isNil ifFalse: [
  pairs := BaseException ___liveFramePairsFrom___: (both at: 1)
    generatorBody: false levels: (both at: 2) offset: 0 running: false.
  pairs do: [:p |
    "Only the innermost frame takes the red dot's line, even if describing it fails."
    thisDot := dotLine.
    dotLine := nil.
    out nextPutAll: ([| meth home cls name span line file text rec |
    rec := WriteStream on: Unicode7 new.
    meth := p at: 1.
    home := [meth homeMethod] on: Error do: [:e | meth].
    cls := home inClass.
    name := (p at: 3) asString.
    (cls notNil and: [modCls notNil and: [(cls inheritsFrom: modCls) not]])
      ifTrue: [name := cls name asString , '.' , name].
    line := (p at: 4) ifNil: [BaseException ___pythonLineForMethod___: meth ip: (p at: 2)].
    span := [BaseException ___pythonSpanForMethod___: meth ip: (p at: 2)]
      on: Error do: [:e | nil].
    (span notNil and: [span size >= 1 and: [line notNil and: [(span at: 1) ~= line]]])
      ifTrue: [span := nil].
    thisDot notNil ifTrue: [line := thisDot. span := nil].
    file := [BaseException ___liveFrameFilenameFor___: home] on: Error do: [:e | '<grail>'].
    rec nextPutAll: name; nextPut: field;
      print: (line ifNil: [0]); nextPut: field.
    (span notNil and: [span size >= 4])
      ifTrue: [rec print: ((span at: 2) ifNil: [0]); nextPut: field;
        print: ((span at: 3) ifNil: [0]); nextPut: field;
        print: ((span at: 4) ifNil: [0]); nextPut: field]
      ifFalse: [rec nextPutAll: '0'; nextPut: field; nextPutAll: '0'; nextPut: field;
        nextPutAll: '0'; nextPut: field].
    rec nextPutAll: file asString; nextPut: field.
    text := (span notNil and: [span size >= 5 and: [(span at: 5) isString]])
      ifTrue: [span at: 5] ifFalse: [nil].
    (text isNil and: [line notNil and: [file asString = '<grail>']]) ifTrue: [
      text := [((BaseException ___curPosPositionsFromSource___: home sourceString)
          detect: [:pos | pos size >= 5 and: [(pos at: 1) = line and: [(pos at: 5) isString]]]
          ifNone: [nil]) ifNotNil: [:pos | pos at: 5]]
        on: Error do: [:e | nil]].
    text ifNotNil: [rec nextPutAll: text].
    rec contents] on: Error do: [:e | e return: placeholder]).
    ${extras?.perFrame ?? ''}
    out nextPut: record]].
${extras?.after ?? ''}
out contents encodeAsUTF8`;
}

/**
 * Parse the query's answer, dropping the frames `breakpoint()` itself added.
 *
 * Grail's breakpoint() reaches `pause` through its own `pdb.set_trace`, which
 * is Python and so appears as the innermost frame. The user asked to stop in
 * their code, not in Grail's stub, so leading frames from that file go.
 */
export function parsePythonStack(raw: string): PythonFrame[] {
  return withoutBreakpointStub(
    raw
      .split(RECORD)
      .filter((record) => record.length > 0)
      .map(parseFrame),
  );
}

/** One frame record. An eighth field, when there is one, is the frame's locals ref. */
export function parseFrame(record: string): PythonFrame {
  const [name, line, column, endLine, endColumn, file, lineText, locals] = record.split(FIELD);
  const int = (value: string | undefined): number => {
    const parsed = Number.parseInt(value ?? '', 10);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return {
    name: name || '?',
    line: int(line),
    column: int(column),
    endLine: int(endLine),
    endColumn: int(endColumn),
    file: file || '<grail>',
    lineText: lineText ?? '',
    ...(locals === undefined ? {} : { locals: int(locals) }),
  };
}

/** Drop the leading frames `breakpoint()` itself added (see `parsePythonStack`). */
export function withoutBreakpointStub(frames: PythonFrame[]): PythonFrame[] {
  let first = 0;
  while (first < frames.length && isBreakpointStub(frames[first])) first++;
  return frames.slice(first);
}

function isBreakpointStub(frame: PythonFrame): boolean {
  return /[/\\]stdlib[/\\]pdb\.py$/.test(frame.file);
}

/**
 * The first line of a frame's text, trimmed. A statement that spans lines — a
 * call black wrapped over four — arrives whole, and one cell line can only
 * ever hold its first.
 */
export function firstLineOf(lineText: string): string {
  return lineText.split(/\r?\n/, 1)[0].trim();
}

/** Where a notebook cell's text is, for `locateCell`. */
export interface CellText {
  uri: string;
  lines: string[];
  /** What to call the cell in the call stack: `Cell [7]`, as the notebook shows it. */
  label?: string;
}

/**
 * Which cell a `<grail>` frame came from.
 *
 * Grail compiles each cell under the one filename `<grail>`, so the filename
 * cannot say which cell a function was defined in — but the frame carries
 * text from its line (Grail's span, often a slice of the line), and that text
 * sits at that line in exactly the cell that defined it — its first line, for
 * a statement that spans several. The running cell is checked first, since
 * that is where a breakpoint() usually is and it breaks any tie.
 */
export function locateCell(
  frame: PythonFrame,
  running: CellText | undefined,
  cells: CellText[],
): string | undefined {
  if (frame.file !== '<grail>' || frame.line < 1) return undefined;
  const matches = (cell: CellText): boolean => {
    const text = cell.lines[frame.line - 1];
    if (text === undefined) return false;
    // Without the line text to compare, only the running cell is a fair guess.
    const wanted = firstLineOf(frame.lineText);
    if (!wanted) return cell === running;
    return text.includes(wanted);
  };
  if (running && matches(running)) return running.uri;
  return cells.find((cell) => cell !== running && matches(cell))?.uri;
}
