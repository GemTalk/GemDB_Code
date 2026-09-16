import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

/**
 * Report diagnostics in a form VS Code's problem matcher can read.
 *
 * esbuild's own output is built for people: it puts the message, a blank line,
 * and then the source location on separate lines. VS Code's multi-line patterns
 * have to match *consecutive* lines, so that shape cannot be matched without a
 * helper extension. Emitting one flat `file:line:col: severity: message` line
 * per diagnostic keeps the problem matcher in this repo, where a new
 * contributor gets working red squiggles with nothing extra installed.
 *
 * The `[watch]` markers bracket each rebuild so VS Code knows a background task
 * has settled — without them, launching the extension stalls on "the task has
 * not exited".
 */
const problemMatcherPlugin = {
  name: 'problem-matcher',
  setup(build) {
    build.onStart(() => {
      if (watch) console.log('[watch] build started');
    });
    build.onEnd((result) => {
      const report = (kind) => (diagnostic) => {
        const { location, text } = diagnostic;
        if (location) {
          // esbuild columns are 0-based; VS Code counts from 1.
          console.log(`${location.file}:${location.line}:${location.column + 1}: ${kind}: ${text}`);
        } else {
          console.log(`${kind}: ${text}`);
        }
      };
      result.errors.forEach(report('error'));
      result.warnings.forEach(report('warning'));
      if (watch) console.log('[watch] build finished');
    });
  },
};

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  sourcemap: !production,
  minify: production,
  target: 'node22.15.1',
  // Watch mode is read by a problem matcher, so the plugin above is the only
  // reporter. A one-shot build is read by a person, so esbuild's own rendering
  // — which points at the offending source with a caret — earns its place;
  // the plugin's flat line appears after it, so a `build` task could carry the
  // same matcher. That one repeated line on a failed build is deliberate.
  logLevel: watch ? 'silent' : 'info',
  plugins: [problemMatcherPlugin],
};

/**
 * An assertion this file makes about the build, distinct from an esbuild
 * diagnostic — the catch block below needs to tell the two apart to know
 * what still needs printing.
 */
class BuildAssertionError extends Error {}

const builds = [
  {
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'out/extension.js',
    // `vscode` is provided by the host. `koffi` is a native addon that loads
    // its own platform-specific binary at run time — bundling it would break
    // that lookup, so it stays in node_modules and ships alongside the bundle.
    external: ['vscode', 'koffi'],
  },
  {
    // The GemDB Shell as a standalone program — what `gemdb` with no arguments
    // runs, and what "Open GemDB Shell" opens a terminal on. Same sources, no
    // editor: `vscode` is replaced by the environment-backed stand-in, exactly
    // as vitest.config.mts replaces it for unit tests. `writeCliScripts`
    // stages this bundle (and koffi) to `<rootPath>/bin`.
    ...common,
    entryPoints: ['src/cliMain.ts'],
    outfile: 'out/gemdb-shell.js',
    external: ['koffi'],
    alias: { vscode: './src/cliVscode.ts' },
    metafile: true,
  },
];

/**
 * Neither telemetry.ts nor the `@vscode/extension-telemetry` package it wraps
 * may reach the shell bundle: there is no extension host there to enforce the
 * user's telemetry setting (see telemetry.ts). ESLint's `no-restricted-imports`
 * catches a direct import of telemetry.ts, but not a rename, a re-export, or a
 * facade module — checking the graph esbuild actually built catches all of
 * those. The package check is the ultimate guard: it also catches a file that
 * imports `@vscode/extension-telemetry` directly, bypassing telemetry.ts
 * entirely — that package requires `vscode` itself, and constructing its
 * reporter is exactly what would ship real events with nothing enforcing
 * consent.
 */
function assertNoTelemetryInShellBundle(result) {
  if (!result.metafile) return;
  const inputs = Object.keys(result.metafile.inputs);
  const reachedOwnModule = inputs.some((input) => input.endsWith('src/telemetry.ts'));
  const reachedPackage = inputs.some((input) =>
    input.includes('node_modules/@vscode/extension-telemetry/'),
  );
  if (reachedOwnModule || reachedPackage) {
    throw new BuildAssertionError(
      `out/gemdb-shell.js pulled in ${reachedOwnModule ? 'src/telemetry.ts' : '@vscode/extension-telemetry'}. ` +
        "There is no extension host in the shell to enforce the user's telemetry setting — " +
        'this must never ship.',
    );
  }
}

/**
 * cliVscode.ts documents itself as deliberately tiny, on the theory that more
 * of the editor API leaking into the CLI's import graph "reports itself
 * through the loud failure of a missing export at bundle time". Measured: a
 * reference to a missing export produces an `import-is-undefined` warning,
 * and the build succeeds anyway — so without this, that comment is false.
 * Scoped to that one warning id, and to the shell build only: other warnings
 * (and the extension build, which has the real `vscode` module) are
 * unaffected.
 */
function assertNoUndefinedShellImports(result) {
  const undefinedImports = result.warnings.filter((w) => w.id === 'import-is-undefined');
  if (undefinedImports.length > 0) {
    throw new BuildAssertionError(
      'out/gemdb-shell.js references an export cliVscode.ts does not provide. ' +
        'See the warning above for which one.',
    );
  }
}

if (watch) {
  for (const options of builds) {
    const context = await esbuild.context(options);
    await context.watch();
  }
} else {
  try {
    const [, shellResult] = await Promise.all(builds.map((options) => esbuild.build(options)));
    assertNoTelemetryInShellBundle(shellResult);
    assertNoUndefinedShellImports(shellResult);
  } catch (e) {
    // esbuild has already printed the diagnostics; rethrowing would bury them
    // under a Node stack trace that says nothing extra. A BuildAssertionError
    // is not an esbuild diagnostic, so it still needs to be seen.
    if (e instanceof BuildAssertionError) console.error(e.message);
    process.exit(1);
  }
}
