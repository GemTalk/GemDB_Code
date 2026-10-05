import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fillHostPage, unavailablePage } from '../statistics';

/**
 * GemDB Stats in a webview: `scripts/bundle-stats.mjs`, which makes a Flutter
 * web build hostable, and `fillHostPage`, which fills the template it writes.
 *
 * The bundle script runs as a process against a small stand-in build, as
 * `npm run bundle:stats` would. Its refusals are the point of it — each one is
 * a build that would otherwise ship and show a blank panel — so most of these
 * are builds it must refuse.
 */

const SCRIPT = path.resolve(__dirname, '../../scripts/bundle-stats.mjs');

/** The shape of the index.html `flutter build web` writes for GemDB Stats. */
const INDEX_HTML = `<!DOCTYPE html>
<html>
<head>
  <base href="/">
  <meta charset="UTF-8">
  <title>GemDB Stats</title>
  <link rel="manifest" href="manifest.json">
  <style>#loading { color: #222; }</style>
</head>
<body>
  <div id="loading">Loading…</div>
  <script>
    window.addEventListener('flutter-first-frame', () => {}, { once: true });
  </script>
  <script src="flutter_bootstrap.js" async></script>
</body>
</html>
`;

const BUILD_CONFIG = {
  engineRevision: 'af7e796e',
  builds: [{ compileTarget: 'dart2js', renderer: 'canvaskit', mainJsPath: 'main.dart.js' }, {}],
  useLocalCanvasKit: true,
};

function bootstrap(config: unknown): string {
  return [
    '/* flutter.js */',
    '',
    `_flutter.buildConfig = ${JSON.stringify(config)};`,
    '',
    '_flutter.loader.load({',
    '  serviceWorkerSettings: { serviceWorkerVersion: "1105577256" }',
    '});',
  ].join('\n');
}

let dir: string;
let web: string;
let out: string;

function write(relative: string, content = 'x'): void {
  const file = path.join(web, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function bundle(): { status: number | null; stderr: string } {
  const result = spawnSync(process.execPath, [SCRIPT], {
    env: { ...process.env, STATS_WEB: web, STATS_OUT: out },
    encoding: 'utf8',
  });
  return { status: result.status, stderr: result.stderr };
}

const shipped = (relative: string) => fs.existsSync(path.join(out, relative));
const hostHtml = () => fs.readFileSync(path.join(out, 'host.html'), 'utf8');

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdb-stats-'));
  web = path.join(dir, 'web');
  out = path.join(dir, 'out');
  write('index.html', INDEX_HTML);
  write('flutter_bootstrap.js', bootstrap(BUILD_CONFIG));
  write('version.json', JSON.stringify({ app_name: 'vsd', version: '0.1.0' }));
  for (const file of [
    'flutter.js',
    'main.dart.js',
    'favicon.png',
    'logo.svg',
    'manifest.json',
    'flutter_service_worker.js',
    '.last_build_id',
    'icons/Icon-192.png',
    'assets/AssetManifest.bin.json',
    'assets/FontManifest.json',
    'assets/fonts/MaterialIcons-Regular.otf',
    'canvaskit/canvaskit.js',
    'canvaskit/canvaskit.js.symbols',
    'canvaskit/canvaskit.wasm',
    'canvaskit/chromium/canvaskit.js',
    'canvaskit/chromium/canvaskit.wasm',
    'canvaskit/skwasm.wasm',
    'canvaskit/wimp.wasm',
    'canvaskit/webparagraph/canvaskit.wasm',
  ]) {
    write(file);
  }
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('bundle-stats.mjs', () => {
  it('ships what the dart2js build loads, and none of what it never does', () => {
    expect(bundle().status).toBe(0);

    for (const file of [
      'host.html',
      'flutter.js',
      'main.dart.js',
      'logo.svg',
      'assets/fonts/MaterialIcons-Regular.otf',
      'canvaskit/canvaskit.wasm',
      'canvaskit/chromium/canvaskit.wasm',
    ]) {
      expect(shipped(file), file).toBe(true);
    }
    for (const file of [
      'index.html',
      'flutter_bootstrap.js',
      'flutter_service_worker.js',
      'manifest.json',
      'icons/Icon-192.png',
      '.last_build_id',
      'canvaskit/canvaskit.js.symbols',
      'canvaskit/skwasm.wasm',
      'canvaskit/wimp.wasm',
      'canvaskit/webparagraph/canvaskit.wasm',
    ]) {
      expect(shipped(file), file).toBe(false);
    }
  });

  it('puts the policy first in <head>, before any script', () => {
    bundle();
    const html = hostHtml();

    const head = html.indexOf('<head>');
    expect(html.indexOf('Content-Security-Policy')).toBeGreaterThan(head);
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<script'));
    expect(html).toContain(
      "script-src 'nonce-{{GEMDB_NONCE}}' {{GEMDB_CSP_SOURCE}} 'wasm-unsafe-eval'",
    );
    expect(html).toContain("default-src 'none'");
  });

  it('points <base> at the webview, and drops the manifest the policy would refuse', () => {
    bundle();
    const html = hostHtml();

    expect(html).toContain('<base href="{{GEMDB_BASE}}">');
    expect(html).not.toContain('<base href="/">');
    expect(html).not.toContain('manifest.json');
  });

  it('starts Flutter without the bootstrap, so no service worker is registered', () => {
    bundle();
    const html = hostHtml();

    expect(html).not.toContain('flutter_bootstrap.js');
    expect(html).not.toContain('serviceWorker');
    expect(html).toContain('<script nonce="{{GEMDB_NONCE}}" src="flutter.js"></script>');
    expect(html).toContain("_flutter.loader.load({ nonce: '{{GEMDB_NONCE}}' });");
  });

  it('keeps only the dart2js build in the loader’s config', () => {
    bundle();
    const config = /_flutter\.buildConfig = (\{.*\});/.exec(hostHtml())?.[1];

    expect(JSON.parse(config ?? 'null')).toEqual({
      ...BUILD_CONFIG,
      builds: [BUILD_CONFIG.builds[0]],
    });
  });

  it('puts the nonce on every script, the page’s own included', () => {
    bundle();
    const scripts = hostHtml().match(/<script\b[^>]*>/g) ?? [];

    // The host's settings, the loading screen's, and the loader's two.
    expect(scripts).toHaveLength(4);
    expect(scripts.every((tag) => tag.includes('nonce="{{GEMDB_NONCE}}"'))).toBe(true);
  });

  it('keeps Flutter’s history updates on the page’s own origin', () => {
    // The base is the webview's resource origin, so a URL Flutter resolves
    // against it is cross-origin, and the browser refuses it -- which stops
    // the app before its first frame.
    bundle();
    const html = hostHtml();
    const shim = html.indexOf("for (const name of ['pushState', 'replaceState'])");

    expect(shim).toBeGreaterThan(-1);
    expect(shim).toBeLessThan(html.indexOf('src="flutter.js"'));
  });

  it('refuses a build that loads CanvasKit from a CDN', () => {
    write('flutter_bootstrap.js', bootstrap({ ...BUILD_CONFIG, useLocalCanvasKit: false }));

    const result = bundle();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--no-web-resources-cdn');
    expect(shipped('host.html')).toBe(false);
  });

  it('refuses a Wasm-only build, whose renderer it leaves out', () => {
    write(
      'flutter_bootstrap.js',
      bootstrap({ ...BUILD_CONFIG, builds: [{ compileTarget: 'dart2wasm', renderer: 'skwasm' }] }),
    );

    expect(bundle().status).toBe(1);
  });

  it('names what a build is missing', () => {
    fs.rmSync(path.join(web, 'canvaskit/chromium/canvaskit.wasm'));

    const result = bundle();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('canvaskit/chromium/canvaskit.wasm');
  });

  it('refuses a page it cannot find the bootstrap in', () => {
    write('index.html', INDEX_HTML.replace(/<script src="flutter_bootstrap\.js".*<\/script>/, ''));

    const result = bundle();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('flutter_bootstrap.js');
  });

  it('leaves exactly the placeholders statistics.ts fills', () => {
    bundle();
    const page = fillHostPage(hostHtml(), {
      base: 'https://file.example/stats/',
      cspSource: 'https://file.example',
      nonce: 'n0nce',
      host: { file: { url: 'https://file.example/statmon.out', name: 'statmon.out' } },
    });

    expect(page).not.toMatch(/\{\{GEMDB_/);
    expect(page).toContain('<base href="https://file.example/stats/">');
    expect(page).toContain(
      'window.gemdbStatsHost = {"file":{"url":"https://file.example/statmon.out","name":"statmon.out"}};',
    );
  });
});

describe('fillHostPage', () => {
  const values = {
    base: 'B/',
    cspSource: 'C',
    nonce: 'N',
    host: { file: { url: 'U', name: 'statmon.out' } },
  };

  it('fills every occurrence of each placeholder', () => {
    expect(fillHostPage('{{GEMDB_NONCE}} {{GEMDB_NONCE}} {{GEMDB_CSP_SOURCE}}', values)).toBe(
      'N N C',
    );
  });

  it('keeps a file name from closing the script it sits in', () => {
    const page = fillHostPage('<script>x = {{GEMDB_HOST}};</script>', {
      ...values,
      host: { file: { url: 'U', name: '</script><script>alert(1)</script>' } },
    });

    expect(page.match(/<\/script>/g)).toHaveLength(1);
    expect(page).toContain('\\u003c/script>');
  });

  it('does not fill a placeholder that arrives inside a value', () => {
    const page = fillHostPage('{{GEMDB_HOST}}', {
      ...values,
      host: { file: { url: 'U', name: '{{GEMDB_NONCE}}' } },
    });

    expect(page).toContain('{{GEMDB_NONCE}}');
  });
});

describe('unavailablePage', () => {
  it('shows its message as text', () => {
    expect(unavailablePage('N', 'Run `a <b>`')).toContain('Run `a &#60;b&#62;`');
  });
});
