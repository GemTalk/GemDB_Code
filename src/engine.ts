import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { engineVersion, isEngineVersionOverridden, rootPath } from './config';
import { archiveExtension, platformKey } from './platform';
import { log, logStep } from './log';
import { engineDirName, ensureRootPath, enginePath, expectedEnginePath } from './paths';

const CATALOG_BASE = 'https://downloads.gemtalksystems.com/platforms';

export type Progress = vscode.Progress<{ message?: string; increment?: number }>;

/** Archive name and download URL for the pinned version on this platform. */
export function engineArtifact(version = engineVersion()): { fileName: string; url: string } {
  const key = platformKey();
  const fileName = `GemStone64Bit${version}-${key}.${archiveExtension()}`;
  return { fileName, url: `${CATALOG_BASE}/${key}/${fileName}` };
}

/**
 * Download and extract the pinned engine version, unless it is already there.
 *
 * Returns the product directory. Throws with a message worth showing the user
 * — an overridden version that the catalog does not publish is the one failure
 * mode we can explain better than an HTTP status can.
 */
export async function installEngine(
  progress: Progress,
  token: vscode.CancellationToken,
): Promise<string> {
  const version = engineVersion();
  const existing = enginePath(version);
  if (existing) {
    log(`Database engine ${version} is already installed at ${existing}`);
    return existing;
  }

  logStep(`Installing database engine ${version}`);
  ensureRootPath();

  const { fileName, url } = engineArtifact(version);
  const archivePath = path.join(rootPath(), fileName);

  if (!fs.existsSync(archivePath)) {
    progress.report({ message: 'Downloading the database engine…' });
    log(`Downloading ${url}`);
    try {
      await downloadFile(url, archivePath, progress, token);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/HTTP 404/.test(msg) && isEngineVersionOverridden()) {
        throw new Error(
          `The database catalog does not publish version ${version}. ` +
            `Clear the "gemdb.engineVersion" setting to use the version GemDB ships with, ` +
            `or extract ${version} into ${rootPath()} yourself.`,
        );
      }
      throw e;
    }
  } else {
    log(`Reusing the archive already downloaded at ${archivePath}`);
  }

  // Cancelling during extraction is recorded but not obeyed until the copy
  // finishes. Killing it mid-way would leave a half-populated engine directory,
  // and `enginePath` treats any such directory as an installed engine — the
  // next run would skip the download and fail somewhere far less obvious. A few
  // seconds of finishing work is the cheaper end of that trade.
  progress.report({ message: 'Extracting the database engine…' });
  if (process.platform === 'darwin') {
    await extractDmg(archivePath, rootPath(), progress);
  } else {
    await extractZip(archivePath, rootPath());
  }

  const installed = enginePath(version);
  if (!installed) {
    throw new Error(
      `Extraction finished but ${expectedEnginePath(version)} is not there. ` +
        `The archive may be incomplete — delete ${archivePath} and try again.`,
    );
  }

  // The archive is ~1 GB and serves no purpose once extracted. Keeping it
  // would double the disk cost of an install that is meant to be unobtrusive.
  try {
    fs.unlinkSync(archivePath);
    log(`Removed the downloaded archive ${fileName}`);
  } catch {
    /* leaving it costs disk, not correctness */
  }

  log(`Database engine installed at ${installed}`);
  return installed;
}

/** Delete the extracted engine. Files ship read-only, so widen them first. */
export function removeEngine(version = engineVersion()): void {
  const dir = enginePath(version);
  if (!dir) return;
  execFileSync('chmod', ['-R', 'u+w', dir]);
  fs.rmSync(dir, { recursive: true, force: true });
  log(`Removed the database engine at ${dir}`);
}

/**
 * Fetch a URL to a file, resuming a previous attempt if one was interrupted.
 *
 * Exported for the tests in `src/__tests__/download.test.ts`, which drive it
 * against a local server rather than the 210 MB the extension really fetches.
 * Everything interesting here is a reply the real server almost never sends —
 * a range request ignored, a 416, a truncated body — so a fixture is the only
 * practical way to see those paths run.
 */
export function downloadFile(
  url: string,
  targetPath: string,
  progress: Progress,
  token: vscode.CancellationToken,
): Promise<void> {
  // Download beside the target and rename on success, so an interrupted
  // download can never be mistaken for a complete archive on the next run.
  //
  // The partial file is kept when a download is cancelled or fails, and the
  // next attempt asks the server to continue from where it stopped. That is
  // what makes "Cancel" behave as "Pause": nothing is lost, and resuming costs
  // only the bytes still outstanding. The file is deleted only when it is
  // known to be useless — a server that ignores the range request, or a
  // finished download whose size does not match what was advertised.
  const partPath = `${targetPath}.part`;
  const discardPartial = (): void => {
    try {
      fs.unlinkSync(partPath);
    } catch {
      /* nothing to clean up */
    }
  };
  const partialSize = (): number => {
    try {
      return fs.statSync(partPath).size;
    } catch {
      return 0;
    }
  };

  const attempt = (downloadUrl: string, redirectsLeft: number): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (redirectsLeft < 0) {
        reject(new Error(`Too many redirects downloading ${url}`));
        return;
      }

      const resumeFrom = partialSize();
      const headers = resumeFrom > 0 ? { Range: `bytes=${resumeFrom}-` } : undefined;
      if (resumeFrom > 0) {
        log(`Resuming the download at ${Math.round(resumeFrom / 1e6)} MB`);
      }

      let file: fs.WriteStream | undefined;
      let cancelled = false;

      // Chosen per URL rather than fixed to https: a redirect is free to send
      // us to either scheme, and `https.get` throws outright on an http: URL.
      const get = downloadUrl.startsWith('http:') ? http.get : https.get;
      const request = get(downloadUrl, headers ? { headers } : {}, (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          const next = new URL(res.headers.location, downloadUrl).toString();
          res.resume();
          subscription.dispose();
          if (!cancelled) attempt(next, redirectsLeft - 1).then(resolve, reject);
          return;
        }

        // 416 means our partial file is at or past the end of the resource —
        // it is not a usable prefix, so start over rather than resume garbage.
        if (status === 416) {
          res.resume();
          subscription.dispose();
          discardPartial();
          reject(new Error('The partly-downloaded file was unusable; it has been discarded.'));
          return;
        }
        if (status !== 200 && status !== 206) {
          res.resume();
          subscription.dispose();
          reject(new Error(`HTTP ${status} downloading ${downloadUrl}`));
          return;
        }

        // 206 continues our partial file; a 200 in reply to a range request
        // means the server ignored it and is sending the whole thing again, so
        // the existing bytes have to go.
        const resuming = status === 206 && resumeFrom > 0;
        if (resumeFrom > 0 && !resuming) {
          log('The server does not support resuming; starting the download again.');
          discardPartial();
        }
        const alreadyHave = resuming ? resumeFrom : 0;
        file = fs.createWriteStream(partPath, resuming ? { flags: 'a' } : { flags: 'w' });

        const remaining = parseInt(res.headers['content-length'] ?? '0', 10);
        const total = remaining > 0 ? alreadyHave + remaining : 0;
        let received = alreadyHave;
        let lastPercent = -1;
        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (total > 0) {
            const percent = Math.floor((received / total) * 100);
            if (percent !== lastPercent) {
              lastPercent = percent;
              progress.report({ message: `Downloading the database engine… ${percent}%` });
            }
          }
        });
        res.pipe(file);

        file.on('finish', () => {
          subscription.dispose();
          if (cancelled) return;
          // A truncated download would otherwise be renamed into place and
          // fail much later, during extraction, with nothing pointing back
          // here. Checking the size makes that failure land where it belongs.
          const finalSize = partialSize();
          if (total > 0 && finalSize !== total) {
            discardPartial();
            reject(
              new Error(`The download ended early (${finalSize} of ${total} bytes). Try again.`),
            );
            return;
          }
          try {
            fs.renameSync(partPath, targetPath);
            resolve();
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        });
        file.on('error', (err) => {
          subscription.dispose();
          reject(err);
        });
      });

      const subscription = token.onCancellationRequested(() => {
        cancelled = true;
        request.destroy();
        // The partial file stays: this is a pause, and the next attempt
        // continues from here.
        file?.close();
        reject(new Error('Download cancelled'));
      });

      // A dropped connection keeps the partial file too — this is the case
      // resuming exists for.
      request.on('error', (err) => {
        subscription.dispose();
        file?.close();
        reject(err);
      });
    });

  return attempt(url, 5);
}

/**
 * Extraction runs out of process and is awaited, never `execFileSync`.
 *
 * This is the longest step after the download — copying about 700 MB — and
 * running it synchronously blocks the extension host for its whole duration.
 * That freezes every other extension sharing the host, stops the progress
 * messages below from telling anyone anything, and makes Cancel unclickable,
 * because flipping a CancellationToken needs an event loop that is free to run.
 */
const run = promisify(execFile);

async function extractDmg(dmgPath: string, destDir: string, progress: Progress): Promise<void> {
  progress.report({ message: 'Mounting the disk image…' });
  const { stdout } = await run('hdiutil', ['attach', '-nobrowse', dmgPath], { encoding: 'utf-8' });
  const lines = stdout.trim().split('\n');
  const mountMatch = lines[lines.length - 1].match(/\t(\/Volumes\/.+)$/);
  if (!mountMatch) throw new Error(`Could not find the mount point in: ${lines.join(' | ')}`);
  const mountPoint = mountMatch[1];

  try {
    progress.report({ message: 'Copying the database engine…' });
    const entry = fs.readdirSync(mountPoint).find((e) => e.startsWith('GemStone64Bit'));
    if (!entry) throw new Error(`No engine directory inside the disk image at ${mountPoint}`);
    await run('cp', ['-R', path.join(mountPoint, entry), path.join(destDir, entry)]);
    log(`Extracted ${entry}`);
  } finally {
    try {
      await run('hdiutil', ['detach', mountPoint]);
    } catch {
      /* an un-detached image is untidy, not broken */
    }
  }
}

async function extractZip(zipPath: string, destDir: string): Promise<void> {
  await run('unzip', ['-o', '-q', zipPath, '-d', destDir]);
  log(`Extracted ${engineDirName()}`);
}
