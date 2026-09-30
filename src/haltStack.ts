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
}

/** Field and record separators: characters with no place in names, paths or source lines. */
const FIELD = '\u001f';
const RECORD = '\u001e';

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
 */
export function pythonStackQuery(processOop: bigint): string {
  return `| proc both pairs out modCls field record |
proc := Object _objectForOop: ${processOop}.
modCls := System myUserProfile symbolList objectNamed: #'module'.
field := Character codePoint: 31.
record := Character codePoint: 30.
out := WriteStream on: Unicode7 new.
both := BaseException ___framesAndLevelsOfSuspendedProcess___: proc.
both isNil ifFalse: [
  pairs := BaseException ___liveFramePairsFrom___: (both at: 1)
    generatorBody: false levels: (both at: 2) offset: 0 running: false.
  pairs do: [:p | | meth home cls name span line file text |
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
    file := [BaseException ___liveFrameFilenameFor___: home] on: Error do: [:e | '<grail>'].
    out nextPutAll: name; nextPut: field;
      print: (line ifNil: [0]); nextPut: field.
    (span notNil and: [span size >= 4])
      ifTrue: [out print: ((span at: 2) ifNil: [0]); nextPut: field;
        print: ((span at: 3) ifNil: [0]); nextPut: field;
        print: ((span at: 4) ifNil: [0]); nextPut: field]
      ifFalse: [out nextPutAll: '0'; nextPut: field; nextPutAll: '0'; nextPut: field;
        nextPutAll: '0'; nextPut: field].
    out nextPutAll: file asString; nextPut: field.
    text := (span notNil and: [span size >= 5 and: [(span at: 5) isString]])
      ifTrue: [span at: 5] ifFalse: [nil].
    (text isNil and: [line notNil and: [file asString = '<grail>']]) ifTrue: [
      text := [((BaseException ___curPosPositionsFromSource___: home sourceString)
          detect: [:pos | pos size >= 5 and: [(pos at: 1) = line and: [(pos at: 5) isString]]]
          ifNone: [nil]) ifNotNil: [:pos | pos at: 5]]
        on: Error do: [:e | nil]].
    text ifNotNil: [out nextPutAll: text].
    out nextPut: record]].
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
  const frames = raw
    .split(RECORD)
    .filter((record) => record.length > 0)
    .map((record): PythonFrame => {
      const [name, line, column, endLine, endColumn, file, lineText] = record.split(FIELD);
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
      };
    });
  let first = 0;
  while (first < frames.length && isBreakpointStub(frames[first])) first++;
  return frames.slice(first);
}

function isBreakpointStub(frame: PythonFrame): boolean {
  return /[/\\]stdlib[/\\]pdb\.py$/.test(frame.file);
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
 * sits at that line in exactly the cell that defined it. The running cell is checked first, since that is
 * where a breakpoint() usually is and it breaks any tie.
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
    const wanted = frame.lineText.trim();
    if (!wanted) return cell === running;
    return text.includes(wanted);
  };
  if (running && matches(running)) return running.uri;
  return cells.find((cell) => cell !== running && matches(cell))?.uri;
}
