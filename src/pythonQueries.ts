import { execute } from './session';

/**
 * Running Python inside the database.
 *
 * Grail compiles Python to Smalltalk and runs it in the database's own object
 * space, so "run this Python" is a Smalltalk expression sent over the session.
 * The wrapping below is the part that matters: it decides what a developer
 * sees when their code raises.
 *
 * Adapted from Jasper's `queries/python.ts`, which worked out the encoding and
 * error-handling shape against the same Grail.
 */

/** Escape a string for inclusion in a Smalltalk string literal. */
export function escapeString(value: string): string {
  return value.replace(/'/g, "''");
}

const GRAIL_MISSING =
  'Python support is not installed in this database. ' +
  'Run "GemDB: Reinstall the Python Execution Engine" to install it.';

/**
 * Run Python and return its result as text.
 *
 * `scopeId` names a persistent set of globals, so `x = 1` in one call is
 * visible in the next — the semantics a notebook needs. Each notebook passes
 * its own URI, giving it its own namespace within the one shared session.
 */
export function runPython(source: string, scopeId: string): string {
  const scope = escapeString(scopeId);
  return execute(
    buildQuery(
      `| scopes scope |
       scopes := SessionTemps current at: #'__gemdbScopes' ifAbsent: [nil].
       scopes isNil ifTrue: [
         scopes := Dictionary new.
         SessionTemps current at: #'__gemdbScopes' put: scopes].
       scope := scopes at: '${scope}' ifAbsentPut: [SymbolDictionary new].
       (dispatcher evaluateSource: src usingModuleScope: scope) printString`,
      source,
    ),
  );
}

/** Run Python with no persistent globals — a one-shot evaluation. */
export function runPythonOnce(source: string): string {
  return execute(buildQuery('(dispatcher evaluateSource: src) printString', source));
}

/**
 * Forget a scope's globals, so the next run in it starts clean. This is the
 * "restart kernel" of a notebook. It touches only plain database collections,
 * so it works — and harmlessly does nothing — whether or not Grail is present.
 */
export function resetScope(scopeId: string): void {
  const scope = escapeString(scopeId);
  execute(
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
 * Three things are going on here, each of which was a bug before it was a
 * design choice:
 *
 *   Grail is resolved at run time, by name, rather than referenced directly.
 *   A direct reference to `ModuleAst` is a *compile-time* name — in a database
 *   without Grail the expression would fail to parse, and there would be no
 *   runtime exception to catch. Looking it up in the symbol list turns "Grail
 *   is missing" into a nil check we can report properly.
 *
 *   Two layers of exception handling. `AlmostOutOfStack` is signalled with
 *   only a little stack left, so its handler has to be cheap — it returns a
 *   fixed literal and does no string building. Everything else (a Python
 *   SyntaxError, a NameError, a division by zero) is caught outside it, where
 *   there is room to compose a real message.
 *
 *   One explicit transcoding at the boundary. Text is built in `Unicode7`,
 *   which is an internal storage format that widens as needed and supports
 *   `at:put:`, and converted once with `encodeAsUTF8` on the way out. Building
 *   directly in a UTF-8 class fails on buffer growth; returning a Unicode16
 *   without transcoding hands back raw UTF-16 bytes.
 */
function buildQuery(grailExpression: string, pythonSource: string): string {
  const source = escapeString(pythonSource);
  // The temp is called `dispatcher`, not `grail`: Grail registers a global of
  // its own named `grail` (its Python-facing module), and shadowing it here
  // would be quietly confusing to anyone reading the generated source.
  return `| dispatcher src result |
dispatcher := System myUserProfile symbolList objectNamed: #'ModuleAst'.
src := '${source}'.
result := dispatcher isNil
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
        ws contents]].
result encodeAsUTF8`;
}

/** Does this result string carry an error the notebook should render as one? */
export function isErrorResult(result: string): boolean {
  return result.startsWith('Error: ') || result === GRAIL_MISSING;
}
