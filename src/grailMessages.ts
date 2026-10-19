/**
 * What to say when Python is not in the database yet. Its own module so the
 * extension and the shell bundle can both import it: it must not live in
 * `lifecycle.ts` or anything that reaches telemetry, which the shell bundle
 * refuses.
 *
 * This is the sentence for a database Grail has not been filed into **yet**:
 * the first start is still running in the window, or has not happened. "Start
 * GemDB" is the cure. It is not `GRAIL_MISSING` (`pythonQueries.ts`), which
 * names a database whose stamp says Python is installed and which has lost it,
 * and which only "Reinstall the Python Execution Engine" repairs.
 */
export const GRAIL_NOT_INSTALLED =
  'Python support is not installed in this database yet. ' +
  'Run "GemDB: Start GemDB" in VS Code and let it finish, then run this again.';
