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
  },
];

if (watch) {
  for (const options of builds) {
    const context = await esbuild.context(options);
    await context.watch();
  }
} else {
  try {
    await Promise.all(builds.map((options) => esbuild.build(options)));
  } catch {
    // esbuild has already printed the diagnostics; rethrowing would bury them
    // under a Node stack trace that says nothing extra.
    process.exit(1);
  }
}
