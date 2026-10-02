import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { __setSetting } from '../__mocks__/vscode';
import { Extract, engineArtifact, installEngine } from '../engine';
import { engineDirName, enginePath, expectedEnginePath } from '../paths';

/**
 * Extracting the engine, and what a crash part way through leaves behind.
 *
 * `enginePath` takes any directory under the engine's name for an installed
 * engine, so the property that matters is that the name appears only once the
 * extraction is complete. The extraction itself is injected: the real one
 * unpacks hundreds of megabytes, and what is under test is where it writes and
 * what happens around it, not `unzip`.
 */

let root: string;

const progress: vscode.Progress<{ message?: string }> = { report: () => {} };
const token = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => {} }),
} as unknown as vscode.CancellationToken;

/** An extraction that writes an engine the way the archive does: read-only, under its own name. */
const extractEngine: Extract = (_archive, destDir) => {
  const engine = path.join(destDir, engineDirName());
  fs.mkdirSync(path.join(engine, 'sys'), { recursive: true });
  fs.writeFileSync(path.join(engine, 'sys', 'stoned'), '');
  fs.chmodSync(path.join(engine, 'sys'), 0o555);
  return Promise.resolve();
};

/** Directories an extraction left under the root path. */
function leftovers(): string[] {
  return fs.readdirSync(root).filter((e) => e.startsWith('.tmp-engine-'));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdb-engine-'));
  __setSetting('gemdb.rootPath', root);
  // Present already, so nothing is downloaded.
  fs.writeFileSync(path.join(root, engineArtifact().fileName), 'archive');
});

afterEach(() => {
  // The engine's directories are read-only, as the real ones are.
  execFileSync('chmod', ['-R', 'u+w', root]);
  fs.rmSync(root, { recursive: true, force: true });
});

describe('extracting the engine', () => {
  it('puts the engine at its final path, and leaves nothing beside it', async () => {
    await expect(installEngine(progress, token, extractEngine)).resolves.toBe(expectedEnginePath());

    expect(fs.existsSync(path.join(expectedEnginePath(), 'sys', 'stoned'))).toBe(true);
    expect(leftovers()).toEqual([]);
    expect(fs.existsSync(path.join(root, engineArtifact().fileName))).toBe(false);
  });

  it('reports no engine when the extraction stops before it is finished', async () => {
    // What the window closing mid-way looks like from the next run: some of
    // the engine written, under its own name, but never moved into place.
    const crash: Extract = async (archive, destDir, p) => {
      await extractEngine(archive, destDir, p);
      throw new Error('killed');
    };

    await expect(installEngine(progress, token, crash)).rejects.toThrow('killed');

    expect(enginePath()).toBeUndefined();
    // The archive stays, so the next attempt does not download it again.
    expect(fs.existsSync(path.join(root, engineArtifact().fileName))).toBe(true);
  });

  it('says the archive may be incomplete when nothing came out of it', async () => {
    await expect(installEngine(progress, token, () => Promise.resolve())).rejects.toThrow(
      /archive may be incomplete/,
    );
    expect(enginePath()).toBeUndefined();
    expect(leftovers()).toEqual([]);
  });

  it('refuses an engine that came out under a name other than the one expected', async () => {
    const otherVersion: Extract = (_archive, destDir) => {
      fs.mkdirSync(path.join(destDir, 'GemStone64Bit9.9.9-other', 'sys'), { recursive: true });
      return Promise.resolve();
    };

    await expect(installEngine(progress, token, otherVersion)).rejects.toThrow(
      /archive may be incomplete/,
    );

    expect(enginePath()).toBeUndefined();
    expect(leftovers()).toEqual([]);
  });

  it('removes what an earlier extraction left behind before starting again', async () => {
    // A process killed outright never reaches its own clean-up, so the next
    // install meets the directory — read-only files and all.
    const left = path.join(root, '.tmp-engine-abc123');
    await extractEngine('', left, progress);
    expect(leftovers()).toEqual(['.tmp-engine-abc123']);

    await installEngine(progress, token, extractEngine);

    expect(leftovers()).toEqual([]);
    expect(enginePath()).toBe(expectedEnginePath());
  });

  it('removes leftovers even when the engine is already installed', async () => {
    await installEngine(progress, token, extractEngine);
    fs.mkdirSync(path.join(root, '.tmp-engine-xyz789'));

    await installEngine(progress, token, () => Promise.reject(new Error('not called')));

    expect(leftovers()).toEqual([]);
  });
});
