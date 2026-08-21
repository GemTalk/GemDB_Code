import * as fs from 'fs';

/**
 * The `vscode` module, as the gemdb CLI sees it.
 *
 * `out/gemdb-shell.js` is bundled from the same sources as the extension, and
 * three of those (`config.ts`, `log.ts`, `platform.ts`) import `vscode` — for
 * a setting, an output channel, a context key. In the CLI there is no editor:
 * settings come from the environment the generated wrapper exports, log lines
 * go to a file only when one is asked for, and context keys mean nothing.
 * esbuild substitutes this module for `vscode` when bundling the CLI (see
 * esbuild.mjs) — the same move vitest.config.mts makes for unit tests.
 *
 * Deliberately tiny, and kept that way on purpose: more of the editor API
 * turning up in the CLI's import graph is a design smell, and the loud failure
 * of a missing export at bundle time is the guard that reports it.
 */

const SETTINGS: Record<string, string | undefined> = {
  // The wrapper exports the root path as GEMSTONE_GLOBAL_DIR — the engine
  // keeps its lock files there, so it is always set and always right. Absent
  // (someone running the bundle by hand), the defaults are the defaults.
  'gemdb.rootPath': process.env.GEMSTONE_GLOBAL_DIR,
  'gemdb.engineVersion': process.env.GEMDB_ENGINE_VERSION,
};

export const workspace = {
  getConfiguration(section: string) {
    return {
      get<T>(key: string, fallback: T): T {
        const value = SETTINGS[`${section}.${key}`];
        return value === undefined || value === '' ? fallback : (value as unknown as T);
      },
    };
  },
};

export const window = {
  createOutputChannel(_name: string) {
    const file = process.env.GEMDB_SHELL_LOG;
    return {
      appendLine(line: string): void {
        if (!file) return;
        try {
          fs.appendFileSync(file, `${line}\n`);
        } catch {
          /* logging must never break the shell */
        }
      },
      show(): void {},
      dispose(): void {},
    };
  },
};

export const commands = {
  // `setContext` keys drive `when` clauses in the editor; here there is no
  // editor, and no caller reads the result.
  executeCommand: (): Promise<undefined> => Promise.resolve(undefined),
};
