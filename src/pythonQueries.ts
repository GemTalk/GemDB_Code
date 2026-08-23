import {
  ExecutionInterrupted,
  GciSession,
  OutputSink,
  SessionOwner,
  execute,
  executeAsync,
  sessionFor,
  sessionForIfOpen,
} from './session';

/**
 * Running Python inside the database.
 *
 * Grail compiles Python to Smalltalk and runs it in the database's own object
 * space, so "run this Python" is a Smalltalk expression sent over the session.
 * The wrapping below is the part that matters: it decides what a developer
 * sees when their code prints, returns, or raises.
 *
 * Adapted from Jasper's `queries/python.ts`, which worked out the encoding and
 * error-handling shape against the same Grail. The result display — `__repr__`,
 * with `None` suppressed — mirrors Grail's own topaz REPL (`scripts/grail.tpz`),
 * so what a value looks like here is what it looks like there and in CPython.
 */

/** Escape a string for inclusion in a Smalltalk string literal. */
export function escapeString(value: string): string {
  return value.replace(/'/g, "''");
}

const GRAIL_MISSING =
  'Python support is not installed in this database. ' +
  'Run "GemDB: Reinstall the Python Execution Engine" to install it.';

/** What one evaluation produced: what it printed, and what it evaluated to. */
export interface PyResult {
  /**
   * Everything `print()` wrote, `\n`-terminated lines. Empty when it printed
   * nothing — and empty when the caller passed `onOutput`, because everything
   * printed was already delivered through it, as it printed.
   */
  output: string;
  /** The result's `__repr__`, empty for `None`, or an `Error: …` line. */
  value: string;
}

/**
 * The frame separator between captured output and the result.
 *
 * `print()` output and the result come back over one string, split on a unit
 * separator (US, 0x1F) — a character with no keyboard key and no plausible
 * place in program output. Code that prints one anyway loses the text before
 * it to the output side of the split; nothing worse.
 */
const FRAME = '\u001f';

/**
 * The result of one framed evaluation, or — when `interrupt()` had to end it
 * at a forwarder stop, where nothing gem-side gets to compose a message — the
 * same `Error:` line Grail itself produces for a KeyboardInterrupt, so every
 * display path treats the two identically.
 */
async function framed(evaluation: Promise<string>): Promise<PyResult> {
  try {
    return splitFramed(await evaluation);
  } catch (e) {
    if (e instanceof ExecutionInterrupted) {
      return { output: '', value: 'Error: KeyboardInterrupt - ' };
    }
    throw e;
  }
}

function splitFramed(raw: string): PyResult {
  const at = raw.indexOf(FRAME);
  if (at < 0) return { output: '', value: raw };
  // Grail's print() ends lines through the stream's `cr`, which on a captured
  // WriteStream is a literal carriage return. The terminal and the notebook
  // both want newlines, so normalise here, once, for every caller.
  const output = raw.slice(0, at).replace(/\r\n?/g, '\n');
  return { output, value: raw.slice(at + 1) };
}

const scopePreamble = (scope: string): string => `
       scopes := SessionTemps current at: #'__gemdbScopes' ifAbsent: [nil].
       scopes isNil ifTrue: [
         scopes := Dictionary new.
         SessionTemps current at: #'__gemdbScopes' put: scopes].
       scope := scopes at: '${escapeString(scope)}' ifAbsentPut: [SymbolDictionary new].`;

/**
 * Evaluate in a named scope and render the result the way a REPL would:
 * `__repr__`, and nothing at all for `None`. Same display rule as Grail's own
 * topaz REPL and CPython — an expression shows its value, a statement shows
 * nothing, and what it printed arrives separately either way.
 */
const evaluateInScope = (scope: string): string => `| scopes scope r |
${scopePreamble(scope)}
       r := dispatcher evaluateSource: src usingModuleScope: scope.
       r == (System myUserProfile symbolList objectNamed: #'None')
         ifTrue: ['']
         ifFalse: [r @env1:__repr__]`;

/**
 * Run Python for one owner and return what it printed and what it evaluated to.
 *
 * The owner decides two things at once, and they are deliberately the same
 * string. Its `key` selects the database session — a notebook gets its own, so
 * it gets its own transaction — and it names the persistent set of globals
 * inside that session, so `x = 1` in one cell is visible in the next.
 *
 * Async on purpose: this is the path long computations take, and a blocking
 * call would freeze the whole extension host for their duration — including
 * the interrupt button that is supposed to end them.
 */
export async function runPython(
  source: string,
  owner: SessionOwner,
  onOutput?: OutputSink,
): Promise<PyResult> {
  return runPythonInSession(sessionFor(owner), source, owner.key, onOutput);
}

/** Run Python with no persistent globals — a one-shot evaluation. */
export async function runPythonOnce(source: string, onOutput?: OutputSink): Promise<PyResult> {
  return framed(
    executeAsync(
      buildQuery(
        `| r |
       r := dispatcher evaluateSource: src.
       r == (System myUserProfile symbolList objectNamed: #'None')
         ifTrue: ['']
         ifFalse: [r @env1:__repr__]`,
        source,
        onOutput !== undefined,
      ),
      onOutput,
    ),
  );
}

/**
 * Run Python in a caller-owned session — the REPL's path, and what `runPython`
 * resolves to once it has looked the owner's session up.
 *
 * Same evaluation, same display rule; the difference is only that the session
 * arrives ready-made. A GemDB Shell is its own process and logs in for itself,
 * which is why it holds a `GciSession` rather than an owner key.
 */
export async function runPythonInSession(
  session: GciSession,
  source: string,
  scopeId: string,
  onOutput?: OutputSink,
): Promise<PyResult> {
  return framed(
    session.executeAsync(
      buildQuery(evaluateInScope(scopeId), source, onOutput !== undefined),
      onOutput,
    ),
  );
}

/**
 * Forget a scope's globals, so the next run in it starts clean. This is the
 * "restart kernel" of a notebook. It touches only plain database collections,
 * so it works — and harmlessly does nothing — whether or not Grail is present.
 */
export function resetScope(owner: SessionOwner): void {
  // Must run in the OWNER's session: the scope dictionary lives in that
  // session's SessionTemps, so clearing it from anywhere else would empty a
  // namespace nobody is using and leave the notebook's variables in place.
  // A notebook with no session yet has nothing to reset, and logging one in
  // just to clear an empty namespace would spend a scarce session on nothing.
  const session = sessionForIfOpen(owner.key);
  if (!session) return;
  const scope = escapeString(owner.key);
  session.execute(
    `| scopes |
scopes := SessionTemps current at: #'__gemdbScopes' ifAbsent: [nil].
scopes ifNotNil: [scopes removeKey: '${scope}' ifAbsent: []].
'reset' encodeAsUTF8`,
  );
}

/** Is Grail installed in this database? */
export function isGrailInstalled(): boolean {
  return (
    execute(`(System myUserProfile symbolList objectNamed: #'ModuleAst') notNil printString`) ===
    'true'
  );
}

/**
 * Wrap a Grail expression so that it always returns text, whatever happens.
 *
 * Several things are going on here, each of which was a bug before it was a
 * design choice:
 *
 *   Grail is resolved at run time, by name, rather than referenced directly.
 *   A direct reference to `ModuleAst` is a *compile-time* name — in a database
 *   without Grail the expression would fail to parse, and there would be no
 *   runtime exception to catch. Looking it up in the symbol list turns "Grail
 *   is missing" into a nil check we can report properly.
 *
 *   `print()` is captured, not lost. Grail's console writes (`print()`,
 *   `input()`'s prompt, warnings) resolve through the session-local
 *   `#GrailConsole` entry in SessionTemps, falling back to the global
 *   `Transcript` (Grail's `builtins ___console___`). Over an RPC session the
 *   gem's stdout is a log file, so without a capture target every `print()`
 *   silently vanishes — measured, not supposed. Each evaluation installs the
 *   target under `#GrailConsole` and removes it in an `ensure:`, so output is
 *   captured per evaluation and attributed to the cell or prompt that caused
 *   it, and nothing is left behind for the next evaluation to trip over.
 *
 *   SessionTemps, and NOT `Transcript := target` (what this did first):
 *   `Transcript` is a committed SymbolAssociation, and reassigning it marked
 *   the session as needing a commit on every single evaluation — which
 *   `gemdb.transaction()`'s entry check then reported as the user's own
 *   pending changes. A SessionTemps write is transient; capture leaves
 *   `System needsCommit` exactly as it found it.
 *
 *   The target has two shapes. Without `onOutput` it is a WriteStream, and
 *   what it collected comes back with the result, after the frame separator.
 *   With `onOutput` it is a ClientForwarder: every write suspends the gem and
 *   surfaces client-side (session.ts services it), so print() streams while
 *   the code runs. The streaming `ensure:` only removes the override — it
 *   must send *nothing* to the forwarder, because a send from an unwind
 *   block would suspend the gem all over again on its way out of an error.
 *
 *   Two layers of exception handling. `AlmostOutOfStack` is signalled with
 *   only a little stack left, so its handler has to be cheap — it returns a
 *   fixed literal and does no string building. Everything else (a Python
 *   SyntaxError, a NameError, a division by zero) is caught outside it, where
 *   there is room to compose a real message. Output printed before a raise is
 *   still delivered — the `ensure:` runs either way.
 *
 *   One explicit transcoding at the boundary. Text is built in `Unicode7`,
 *   which is an internal storage format that widens as needed and supports
 *   `at:put:`, and converted once with `encodeAsUTF8` on the way out. Building
 *   directly in a UTF-8 class fails on buffer growth; returning a Unicode16
 *   without transcoding hands back raw UTF-16 bytes.
 */
function buildQuery(grailExpression: string, pythonSource: string, streaming = false): string {
  const source = escapeString(pythonSource);
  // The temp is called `dispatcher`, not `grail`: Grail registers a global of
  // its own named `grail` (its Python-facing module), and shadowing it here
  // would be quietly confusing to anyone reading the generated source.
  // The target is stored BOXED in an Array, exactly like Grail's stdin
  // provider (builtins.gs stdinProvider:, where this was first measured):
  // SessionTemps>>at:put: sends to the value it stores, and ClientForwarder
  // is a root class that forwards even those internal sends to the client —
  // which is in no position to answer them. Array construction and at: are
  // primitives, so the box crosses SessionTemps without a send. Grail's
  // ___console___ unboxes.
  const redirect = streaming
    ? "SessionTemps current at: #'GrailConsole' put: (Array with: ClientForwarder new)."
    : "SessionTemps current at: #'GrailConsole' put: (Array with: (WriteStream on: Unicode7 new)).";
  const restore = streaming
    ? // Nothing may be sent to the forwarder here; only the removal is safe.
      "SessionTemps current removeKey: #'GrailConsole' ifAbsent: []"
    : `captured := (SessionTemps current at: #'GrailConsole' otherwise: nil)
      ifNil: [''] ifNotNil: [:box | (box at: 1) contents].
    SessionTemps current removeKey: #'GrailConsole' ifAbsent: []`;
  return `| dispatcher src result captured out |
dispatcher := System myUserProfile symbolList objectNamed: #'ModuleAst'.
src := '${source}'.
captured := ''.
${redirect}
[result := dispatcher isNil
  ifTrue: ['${escapeString(GRAIL_MISSING)}']
  ifFalse: [
    [[${grailExpression}]
       on: AlmostOutOfStack do: [:e | 'Error: the code ran out of stack (infinite recursion?)']]
      on: AbstractException do: [:e |
        | ws |
        ws := WriteStream on: Unicode7 new.
        ws nextPutAll: 'Error: '.
        ws nextPutAll: e class name asString.
        ws nextPutAll: ' - '.
        ws nextPutAll: e messageText asString.
        ws contents]]]
  ensure: [
    ${restore}].
out := WriteStream on: Unicode7 new.
out nextPutAll: captured.
out nextPut: (Character codePoint: 31).
out nextPutAll: result.
out contents encodeAsUTF8`;
}

/** Does this result carry an error the notebook should render as one? */
export function isErrorResult(value: string): boolean {
  return value.startsWith('Error: ') || value === GRAIL_MISSING;
}
