import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { downloadFile } from '../engine';

/**
 * The download, against a server that misbehaves on purpose.
 *
 * Everything worth testing here is a reply the real engine catalog almost never
 * sends: a range request answered with the whole file, a 416, a body that stops
 * early. Waiting to meet those in the wild means meeting them on a user's
 * machine, and the real download is 210 MB — so the fixture is a local server
 * serving a few dozen bytes, and the whole file runs in milliseconds.
 */

const BODY = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');

let server: http.Server;
let baseUrl: string;
let workDir: string;
let target: string;

/** What the last request asked for, so a test can assert on the Range header. */
let lastRange: string | undefined;

/** Swapped per test to decide how the server replies. */
let handler: http.RequestListener;

const progress: vscode.Progress<{ message?: string }> = { report: () => {} };

/** A token that is never cancelled, and hands back a disposable like the real one. */
const token = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => {} }),
} as unknown as vscode.CancellationToken;

/** Serve `BODY`, honouring Range the way a well-behaved server does. */
const serveWithRanges: http.RequestListener = (req, res) => {
  const match = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
  if (!match) {
    res.writeHead(200, { 'content-length': String(BODY.length) });
    res.end(BODY);
    return;
  }
  const from = Number(match[1]);
  if (from >= BODY.length) {
    res.writeHead(416, { 'content-range': `bytes */${BODY.length}` });
    res.end();
    return;
  }
  const rest = BODY.subarray(from);
  res.writeHead(206, {
    'content-length': String(rest.length),
    'content-range': `bytes ${from}-${BODY.length - 1}/${BODY.length}`,
  });
  res.end(rest);
};

beforeEach(async () => {
  lastRange = undefined;
  handler = serveWithRanges;
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdb-dl-'));
  target = path.join(workDir, 'engine.dmg');

  server = http.createServer((req, res) => {
    lastRange = req.headers.range;
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}/engine.dmg`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(workDir, { recursive: true, force: true });
});

/** Pretend a previous attempt got this far. */
function partial(bytes: number): void {
  fs.writeFileSync(`${target}.part`, BODY.subarray(0, bytes));
}

const partExists = (): boolean => fs.existsSync(`${target}.part`);

describe('downloadFile', () => {
  it('fetches a whole file when there is nothing to resume', async () => {
    await downloadFile(baseUrl, target, progress, token);

    expect(fs.readFileSync(target)).toEqual(BODY);
    expect(lastRange).toBeUndefined();
    // The partial is renamed into place, never left beside the finished file.
    expect(partExists()).toBe(false);
  });

  it('resumes from a partial file and lands byte-identical', async () => {
    partial(10);
    await downloadFile(baseUrl, target, progress, token);

    expect(lastRange).toBe('bytes=10-');
    expect(fs.readFileSync(target)).toEqual(BODY);
  });

  it('starts again when the server ignores the range request', async () => {
    // A 200 in reply to a Range header means the whole body is coming. Appending
    // it to what we already have would corrupt the file silently, and the
    // corruption would only surface later, during extraction.
    handler = (_req, res) => {
      res.writeHead(200, { 'content-length': String(BODY.length) });
      res.end(BODY);
    };
    partial(10);
    await downloadFile(baseUrl, target, progress, token);

    expect(fs.readFileSync(target)).toEqual(BODY);
  });

  it('discards a partial file the server says is past the end', async () => {
    // 416: our partial is not a prefix of the resource — it is unusable, so it
    // goes rather than being resumed into nonsense.
    partial(BODY.length + 5);
    await expect(downloadFile(baseUrl, target, progress, token)).rejects.toThrow(/unusable/);
    expect(partExists()).toBe(false);
  });

  it('rejects a body that stops early instead of renaming it into place', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-length': String(BODY.length) });
      res.write(BODY.subarray(0, 8));
      res.destroy();
    };
    await expect(downloadFile(baseUrl, target, progress, token)).rejects.toThrow();

    // The point of the check: a truncated archive must never reach the target,
    // where the next run would take it for a complete download.
    expect(fs.existsSync(target)).toBe(false);
  });

  it('follows a redirect', async () => {
    let redirected = false;
    handler = (req, res) => {
      if (!redirected) {
        redirected = true;
        res.writeHead(302, { location: `${baseUrl}?moved` });
        res.end();
        return;
      }
      serveWithRanges(req, res);
    };
    await downloadFile(baseUrl, target, progress, token);
    expect(fs.readFileSync(target)).toEqual(BODY);
  });

  it('gives up rather than following redirects forever', async () => {
    handler = (_req, res) => {
      res.writeHead(302, { location: `${baseUrl}?again` });
      res.end();
    };
    await expect(downloadFile(baseUrl, target, progress, token)).rejects.toThrow(/redirects/);
  });

  it('reports an HTTP failure with its status', async () => {
    handler = (_req, res) => {
      res.writeHead(404);
      res.end();
    };
    await expect(downloadFile(baseUrl, target, progress, token)).rejects.toThrow(/HTTP 404/);
  });

  it('keeps the partial file when cancelled, so cancelling is pausing', async () => {
    let fire: (() => void) | undefined;
    const cancellable = {
      isCancellationRequested: false,
      onCancellationRequested: (listener: () => void) => {
        fire = listener;
        return { dispose: () => {} };
      },
    } as unknown as vscode.CancellationToken;

    handler = (_req, res) => {
      res.writeHead(200, { 'content-length': String(BODY.length) });
      res.write(BODY.subarray(0, 8));
      // Never finished: cancel arrives mid-flight, as it does in practice.
      setTimeout(() => fire?.(), 5);
    };

    await expect(downloadFile(baseUrl, target, progress, cancellable)).rejects.toThrow(/cancelled/);
    expect(fs.existsSync(target)).toBe(false);
    expect(partExists()).toBe(true);
  });
});
