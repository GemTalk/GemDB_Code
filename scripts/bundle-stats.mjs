#!/usr/bin/env node
//
// Assemble the GemDB Stats payload that ships inside the .vsix.
//
// GemDB Stats is GemTalk's statmon viewer, a Flutter app with a web build.
// GemDB Code shows that build in a webview (src/statistics.ts), so a statmon
// file can be charted wherever the editor is -- including code-server, where
// the only screen is a browser tab and a desktop app cannot appear.
//
// Like Grail and the MCP server, the payload is a build artifact of another
// repository. Unlike them it is not built here: compiling it needs the Flutter
// SDK, so this script takes a finished `flutter build web` output and turns it
// into something a webview can host.
//
// Usage:
//   STATS_WEB=/path/to/GemDB_Stats/app/build/web npm run bundle:stats
//
// Environment:
//   STATS_WEB   the `flutter build web` output to bundle (required)
//   STATS_OUT   where to assemble the payload (default: stats/, which is what
//               the .vsix ships; the unit tests point it elsewhere)
//
// What it does to the build, and why each step happens HERE rather than when
// the panel opens: everything below can fail, and a failure here is in front
// of whoever is packaging, while the same failure at run time is a blank panel
// on a user's screen.
//
// - The page. A webview needs a Content-Security-Policy, a <base href> that
//   points at the webview's own resource URL, and a nonce on every script.
//   That base is on another origin from the page, so Flutter's history updates
//   have to be kept off it (HISTORY_SHIM). And
//   Flutter's stock bootstrap registers a service worker, which a webview
//   cannot host, so the bootstrap is replaced by a direct call to Flutter's
//   loader. The build's own index.html is kept for everything else -- its
//   loading screen is GemDB Stats' to design -- and becomes `host.html`, a
//   template whose four `{{GEMDB_*}}` placeholders statistics.ts fills.
// - The files. Only the dart2js build with the CanvasKit renderer is kept,
//   which is what `flutter build web` without `--wasm` produces. The Wasm
//   renderers, debug symbols, the service worker and the PWA manifest go:
//   more than half of the build's 47 MB, none of it ever loaded here.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** What the hosted page loads. A build missing any of these is not one this can host. */
const REQUIRED = [
  'index.html',
  'flutter.js',
  'flutter_bootstrap.js',
  'main.dart.js',
  'version.json',
  'assets/AssetManifest.bin.json',
  'assets/FontManifest.json',
  // Flutter's loader picks the Chromium variant where the browser supports it
  // (VS Code's own window, Chrome, Edge) and the full one elsewhere (Firefox
  // or Safari pointed at code-server), so both stay.
  'canvaskit/canvaskit.js',
  'canvaskit/canvaskit.wasm',
  'canvaskit/chromium/canvaskit.js',
  'canvaskit/chromium/canvaskit.wasm',
];

/**
 * Paths, relative to the build, that never ship. Everything else does: GemDB
 * Stats decides what its build contains, and a list of what to KEEP would
 * silently drop the next asset it adds.
 */
function isLeftOut(relative) {
  const name = path.posix.basename(relative);
  return (
    name.endsWith('.symbols') ||
    // The Wasm renderers. Only a `--wasm` build loads them.
    /^canvaskit\/(skwasm|wimp)/.test(relative) ||
    // Loaded only when the build config sets `preferWebParagraph`, which
    // buildConfigFrom refuses.
    relative.startsWith('canvaskit/webparagraph/') ||
    // Replaced: host.html takes index.html's place, and calls the loader
    // itself instead of running the bootstrap.
    relative === 'index.html' ||
    relative === 'flutter_bootstrap.js' ||
    relative === 'flutter_service_worker.js' ||
    // A PWA's install metadata. A webview cannot install anything.
    relative === 'manifest.json' ||
    relative.startsWith('icons/') ||
    relative === '.last_build_id'
  );
}

/**
 * The `_flutter.buildConfig` that `flutter build web` writes into
 * flutter_bootstrap.js, reduced to the one build this payload keeps.
 */
function buildConfigFrom(bootstrap) {
  const match = /^_flutter\.buildConfig = (\{.*\});$/m.exec(bootstrap);
  if (!match) {
    throw new Error('flutter_bootstrap.js has no `_flutter.buildConfig = {...};` line.');
  }
  const config = JSON.parse(match[1]);
  // Without this the loader fetches CanvasKit from www.gstatic.com, which the
  // page's CSP refuses -- and which a server with no internet access could not
  // reach anyway.
  if (config.useLocalCanvasKit !== true) {
    throw new Error(
      'The build loads CanvasKit from a CDN. Build it with `--no-web-resources-cdn`.',
    );
  }
  if (config.canvasKitVariant !== undefined || config.preferWebParagraph !== undefined) {
    throw new Error(
      'The build chooses its own CanvasKit variant, which may need files this payload leaves out.',
    );
  }
  const builds = (config.builds ?? []).filter(
    (build) => build.compileTarget === 'dart2js' && build.renderer === 'canvaskit',
  );
  if (builds.length !== 1 || builds[0].mainJsPath !== 'main.dart.js') {
    throw new Error('The build has no dart2js + CanvasKit entry point at main.dart.js.');
  }
  return { ...config, builds };
}

/** The `<script>` that replaces flutter_bootstrap.js. */
function loaderScripts(buildConfig) {
  // `<` is escaped so no string in the config can close the script element.
  const json = JSON.stringify(buildConfig).replace(/</g, '\\u003c');
  return (
    '<script nonce="{{GEMDB_NONCE}}" src="flutter.js"></script>\n' +
    '  <script nonce="{{GEMDB_NONCE}}">\n' +
    `    _flutter.buildConfig = ${json};\n` +
    // No serviceWorkerSettings: that is what keeps the loader from
    // registering one. The nonce is passed on to the <script> it injects for
    // main.dart.js.
    "    _flutter.loader.load({ nonce: '{{GEMDB_NONCE}}' });\n" +
    '  </script>'
  );
}

/**
 * The policy the page runs under. `{{GEMDB_CSP_SOURCE}}` becomes the
 * webview's own resource origin, which serves both the build and the statmon
 * file, so nothing else is reachable.
 */
const CSP = [
  "default-src 'none'",
  // CanvasKit is WebAssembly, which a CSP blocks unless this allows it.
  "script-src 'nonce-{{GEMDB_NONCE}}' {{GEMDB_CSP_SOURCE}} 'wasm-unsafe-eval'",
  // Flutter writes its own <style> elements and style attributes.
  "style-src {{GEMDB_CSP_SOURCE}} 'unsafe-inline'",
  'img-src {{GEMDB_CSP_SOURCE}} data: blob:',
  'font-src {{GEMDB_CSP_SOURCE}} data: blob:',
  // Flutter fetches fonts, assets and CanvasKit's .wasm; the app fetches the
  // statmon file. All of them from the webview's resource origin.
  'connect-src {{GEMDB_CSP_SOURCE}}',
].join('; ');

/**
 * Keeps Flutter's history updates on the page's own URL.
 *
 * Flutter reports every route change with `history.replaceState` or
 * `pushState`, passing a URL it resolves against `<base href>`. In a webview
 * that base is the resource origin, not the page's, so the browser refuses the
 * call with a SecurityError -- and Flutter, which makes the first one while
 * starting up, never draws (measured: the loading screen, then grey). A
 * webview has no address bar and no back button, so the URL has nothing to
 * show: the state is kept and the URL dropped.
 */
const HISTORY_SHIM =
  "for (const name of ['pushState', 'replaceState']) {" +
  ' const original = history[name].bind(history);' +
  ' history[name] = (state, title) => original(state, title);' +
  ' }';

/**
 * Replace exactly one match of `pattern` in `html`, or say which anchor the
 * build no longer has.
 */
function replaceOnce(html, pattern, replacement, what) {
  const matches = html.match(new RegExp(pattern.source, `${pattern.flags}g`)) ?? [];
  if (matches.length !== 1) {
    throw new Error(`index.html has ${matches.length} ${what}; GemDB Code needs exactly one.`);
  }
  return html.replace(pattern, replacement);
}

/** index.html, made into the template statistics.ts fills for each panel. */
function hostTemplate(indexHtml, buildConfig) {
  let html = indexHtml;
  html = replaceOnce(
    html,
    /<base\s+href="[^"]*"\s*\/?>/,
    '<base href="{{GEMDB_BASE}}">',
    '<base href> elements',
  );
  html = replaceOnce(
    html,
    /<script\b[^>]*\bsrc="flutter_bootstrap\.js"[^>]*>\s*<\/script>/,
    // A function, so `$` in the config is not read as a replacement pattern.
    () => loaderScripts(buildConfig),
    'flutter_bootstrap.js <script> tags',
  );
  // The page's own inline scripts -- its loading screen's -- run under the
  // same nonce as the loader. The two inserted above already carry one.
  html = html.replace(/<script(?![^>]*\bnonce=)(?=[\s>])/g, '<script nonce="{{GEMDB_NONCE}}"');
  // The PWA manifest is left out, and the CSP would refuse to fetch it.
  html = html.replace(/\s*<link\b[^>]*\brel="manifest"[^>]*>/g, '');
  // First in <head>, so the policy governs everything after it, and the host's
  // settings exist before any of the page's own scripts run.
  html = replaceOnce(
    html,
    /<head\b[^>]*>/,
    (head) =>
      `${head}\n  <meta http-equiv="Content-Security-Policy" content="${CSP}">\n` +
      '  <script nonce="{{GEMDB_NONCE}}">window.gemdbStatsHost = {{GEMDB_HOST}};\n' +
      `  ${HISTORY_SHIM}</script>`,
    '<head> elements',
  );
  return html;
}

function filesUnder(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? filesUnder(path.join(dir, entry.name), relative) : [relative];
  });
}

function main() {
  const source = process.env.STATS_WEB;
  if (!source) {
    console.error('ERROR: set STATS_WEB to a GemDB Stats web build (app/build/web).');
    process.exit(1);
  }
  const web = path.resolve(source);
  const missing = REQUIRED.filter((file) => !fs.existsSync(path.join(web, file)));
  if (missing.length) {
    console.error(`ERROR: ${web} is not a complete GemDB Stats web build. Missing:`);
    for (const file of missing) console.error(`  ${file}`);
    process.exit(1);
  }

  const DEST = path.resolve(process.env.STATS_OUT ?? path.join(REPO, 'stats'));
  const read = (file) => fs.readFileSync(path.join(web, file), 'utf8');
  const buildConfig = buildConfigFrom(read('flutter_bootstrap.js'));
  const template = hostTemplate(read('index.html'), buildConfig);

  console.log(`Assembling ${DEST} from ${web}`);
  fs.rmSync(DEST, { recursive: true, force: true });
  let kept = 0;
  let bytes = 0;
  for (const relative of filesUnder(web)) {
    if (isLeftOut(relative)) continue;
    const to = path.join(DEST, relative);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(web, relative), to);
    kept += 1;
    bytes += fs.statSync(to).size;
  }
  fs.writeFileSync(path.join(DEST, 'host.html'), template);

  // What was bundled, for whoever is reading a .vsix later. GemDB Code reads
  // nothing from it.
  const version = JSON.parse(read('version.json'));
  fs.writeFileSync(
    path.join(DEST, 'STATS_VERSION'),
    `stats=${version.version ?? 'unknown'}\n` +
      `engine=${buildConfig.engineRevision ?? 'unknown'}\n`,
  );

  console.log(
    `Bundled GemDB Stats ${version.version ?? ''}: ${kept} files, ` +
      `${(bytes / 1024 / 1024).toFixed(1)} MB.`,
  );
}

try {
  main();
} catch (error) {
  console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
