import { spawn, spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
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

/**
 * flutter_bootstrap.js: flutter.js inlined, then the config, then the load
 * call — GemDB Stats' own template, which registers no service worker, unless
 * `load` says otherwise.
 */
function bootstrap(config: unknown, load = '_flutter.loader.load();'): string {
  return [
    // The inlined flutter.js mentions service workers in its own code.
    'async load({serviceWorkerSettings:e}={}){ /* flutter.js */ }',
    `_flutter.buildConfig = ${JSON.stringify(config)};`,
    '',
    load,
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

function bundle(env: Record<string, string> = { STATS_WEB: web }): {
  status: number | null;
  stderr: string;
} {
  const result = spawnSync(process.execPath, [SCRIPT], {
    env: { ...process.env, STATS_OUT: out, ...env },
    encoding: 'utf8',
  });
  return { status: result.status, stderr: result.stderr };
}

/** The same, without blocking this process, which may be serving the download. */
function bundleAsync(
  env: Record<string, string>,
): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT], {
      env: { ...process.env, STATS_OUT: out, ...env },
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('close', (status) => resolve({ status, stderr }));
  });
}

const shipped = (relative: string) => fs.existsSync(path.join(out, relative));
const hostHtml = () => fs.readFileSync(path.join(out, 'host.html'), 'utf8');

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdb-stats-'));
  web = path.join(dir, 'web');
  out = path.join(dir, 'out');
  write('index.html', INDEX_HTML);
  write('flutter_bootstrap.js', bootstrap(BUILD_CONFIG));
  write('version.json', JSON.stringify({ app_name: 'vsd', version: '1.0.0' }));
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
      'flutter_bootstrap.js',
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

  it('starts the app with its own bootstrap, under the nonce like every script', () => {
    bundle();
    const scripts = hostHtml().match(/<script\b[^>]*>/g) ?? [];

    // The loading screen's, and the bootstrap.
    expect(scripts).toHaveLength(2);
    expect(scripts.every((tag) => tag.includes('nonce="{{GEMDB_NONCE}}"'))).toBe(true);
    expect(scripts[1]).toContain('src="flutter_bootstrap.js"');
  });

  it('refuses a bootstrap that registers a service worker', () => {
    // Flutter's stock template; GemDB Stats replaced it in PR #10.
    write(
      'flutter_bootstrap.js',
      bootstrap(
        BUILD_CONFIG,
        '_flutter.loader.load({ serviceWorkerSettings: { serviceWorkerVersion: "1" } });',
      ),
    );

    const result = bundle();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('service worker');
    expect(shipped('host.html')).toBe(false);
  });

  it('refuses a build that loads CanvasKit from a CDN', () => {
    write('flutter_bootstrap.js', bootstrap({ ...BUILD_CONFIG, useLocalCanvasKit: false }));

    const result = bundle();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--no-web-resources-cdn');
  });

  it('refuses a build that offers Wasm, whose renderers it leaves out', () => {
    write(
      'flutter_bootstrap.js',
      bootstrap({
        ...BUILD_CONFIG,
        builds: [{ compileTarget: 'dart2wasm', renderer: 'skwasm' }, ...BUILD_CONFIG.builds],
      }),
    );

    const result = bundle();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--wasm');
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
    });

    expect(page).not.toMatch(/\{\{GEMDB_/);
    expect(page).toContain('<base href="https://file.example/stats/">');
    expect(page).toContain('<script nonce="n0nce" src="flutter_bootstrap.js" async>');
  });

  describe('a release asset', () => {
    let server: http.Server;
    let url: string;
    let sha256: string;

    /** The build above as GemDB Stats' release would publish it: one folder in a .tar.gz. */
    beforeEach(async () => {
      const archive = path.join(dir, 'GemDB-Stats-1.0.0-web.tar.gz');
      fs.renameSync(web, path.join(dir, 'GemDB-Stats-1.0.0-web'));
      spawnSync('tar', ['-czf', archive, '-C', dir, 'GemDB-Stats-1.0.0-web']);
      const bytes = fs.readFileSync(archive);
      sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      server = http.createServer((request, response) => {
        if (request.url === '/web.tar.gz') {
          response.end(bytes);
        } else {
          response.writeHead(404).end();
        }
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/web.tar.gz`;
    });

    afterEach(async () => {
      await new Promise((resolve) => server.close(resolve));
    });

    it('is downloaded, checked and unpacked', async () => {
      const result = await bundleAsync({ STATS_URL: url, STATS_SHA256: sha256 });

      expect(result.status).toBe(0);
      expect(shipped('host.html')).toBe(true);
      expect(fs.readFileSync(path.join(out, 'STATS_VERSION'), 'utf8')).toContain(`source=${url}`);
    });

    it('is refused when its SHA-256 is not the pinned one', async () => {
      const result = await bundleAsync({ STATS_URL: url, STATS_SHA256: '0'.repeat(64) });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(sha256);
      expect(shipped('host.html')).toBe(false);
    });

    it('is refused when the server has no such file', async () => {
      const result = await bundleAsync({ STATS_URL: url.replace('web.tar.gz', 'gone.tar.gz') });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('404');
    });
  });
});

describe('fillHostPage', () => {
  const values = { base: 'B/', cspSource: 'C', nonce: 'N' };

  it('fills every occurrence of each placeholder', () => {
    expect(fillHostPage('{{GEMDB_NONCE}} {{GEMDB_NONCE}} {{GEMDB_CSP_SOURCE}}', values)).toBe(
      'N N C',
    );
  });

  it('does not fill a placeholder that arrives inside a value', () => {
    expect(fillHostPage('{{GEMDB_BASE}}', { ...values, base: '{{GEMDB_NONCE}}' })).toBe(
      '{{GEMDB_NONCE}}',
    );
  });
});

describe('unavailablePage', () => {
  it('shows its message as text', () => {
    expect(unavailablePage('N', 'Run `a <b>`')).toContain('Run `a &#60;b&#62;`');
  });
});
