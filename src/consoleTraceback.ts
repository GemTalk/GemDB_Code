import { ConsoleError, TracebackFrame } from './pauseVariables';

/**
 * A Debug Console error, written the way a Jupyter notebook shows one:
 *
 * ```
 * ---------------------------------------------------------------------------
 * ZeroDivisionError                         Traceback (most recent call last)
 * Debug Console, line 1
 * ----> 1 boom(0)
 *
 * Cell [2], line 2, in boom
 *       1 def boom(d):
 * ----> 2     return 10 / d
 *
 * ZeroDivisionError: division by zero
 * ```
 *
 * Python developers read tracebacks in that shape every day, and IPython's is
 * the one they meet in notebooks, which is where GemDB's pauses mostly are.
 * Each frame is placed by `place`: its label and, when the source can be
 * found, its lines, so the frame shows a few lines around the one that
 * raised. A frame whose source cannot be found shows the text Grail recorded
 * for it. A SyntaxError has no frames, and shows the line it could not read
 * with a caret, as IPython does.
 */

/** Where a traceback frame's source is: what to call it, and its lines when they can be read. */
export interface PlacedFrame {
  /** `Debug Console`, `Cell [2]`, or for a file the path: `File /w/mod.py`. */
  label: string;
  /** Whether `label` names a file, which takes `:line` rather than `, line N`. */
  isFile: boolean;
  lines?: string[];
}

/** IPython's rule, the width of its header. */
const RULE = '-'.repeat(75);

/** Width of the line-number gutter, arrow included. */
const GUTTER = 7;

/** Lines shown on either side of the one that raised. */
const CONTEXT = 2;

export function jupyterTraceback(
  error: ConsoleError,
  place: (frame: TracebackFrame, index: number) => PlacedFrame,
): string {
  const last = error.message ? `${error.type}: ${error.message}` : error.type;
  if (error.syntax) {
    const { line, offset, text } = error.syntax;
    const where = place({ file: error.syntax.file || '<grail>', line, name: '<module>', text }, 0);
    const lineText = text.replace(/\r?\n$/, '');
    const indent = lineText.length - lineText.trimStart().length;
    const caret = offset > 0 ? [`    ${' '.repeat(Math.max(0, offset - 1 - indent))}^`] : [];
    return [
      `  ${where.isFile ? `${where.label}:${line}` : `${where.label}, line ${line}`}`,
      `    ${lineText.trim()}`,
      ...caret,
      last,
    ].join('\n');
  }
  const blocks = error.frames.map((frame, index) => frameBlock(frame, place(frame, index)));
  return [
    RULE,
    `${error.type.padEnd(41)} Traceback (most recent call last)`,
    blocks.join('\n\n'),
    '',
    last,
  ].join('\n');
}

function frameBlock(frame: TracebackFrame, placed: PlacedFrame): string {
  const inName = frame.name === '<module>' ? '' : `, in ${frame.name}`;
  const header = placed.isFile
    ? `${placed.label}:${frame.line}${inName}`
    : `${placed.label}, line ${frame.line}${inName}`;
  const shown: Array<[number, string]> = [];
  const lines = placed.lines;
  if (lines && frame.line >= 1 && frame.line <= lines.length) {
    const from = Math.max(1, frame.line - CONTEXT);
    const to = Math.min(lines.length, frame.line + CONTEXT);
    for (let n = from; n <= to; n++) shown.push([n, lines[n - 1]]);
  } else if (frame.line >= 1) {
    shown.push([frame.line, frame.text.replace(/\r?\n[\s\S]*$/, '')]);
  }
  const body = shown.map(([n, text]) => `${gutter(n, n === frame.line)} ${text.trimEnd()}`);
  return [header, ...body].join('\n');
}

/**
 * IPython's line-number gutter: the number right-aligned in seven columns,
 * and on the line that raised, an arrow filling the columns before it —
 * `----> 9`, `---> 10`, beside `     10`.
 */
function gutter(n: number, raised: boolean): string {
  const number = String(n);
  if (!raised) return number.padStart(GUTTER);
  return `${'-'.repeat(Math.max(1, GUTTER - number.length - 2))}> ${number}`;
}
