import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __setSetting } from '../__mocks__/vscode';
import { cliPath, writeCliScripts } from '../cli';
import { expectedEnginePath } from '../paths';

/**
 * The generator, not the command: what the files say and where they land.
 * The command itself — exit codes, streams, auto-start — runs against a real
 * database in src/__integration__/cli.test.ts.
 */

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdb-cli-'));
  __setSetting('gemdb.rootPath', root);
  fs.mkdirSync(expectedEnginePath(), { recursive: true });
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('writeCliScripts', () => {
  it('writes an executable wrapper with this installation baked in', () => {
    writeCliScripts();

    const stat = fs.statSync(cliPath());
    expect(stat.mode & 0o111).not.toBe(0); // executable
    const script = fs.readFileSync(cliPath(), 'utf8');
    expect(script.startsWith('#!/bin/bash')).toBe(true);
    // Self-contained: the wrapper carries its own paths rather than assuming
    // any environment. These are the two everything else derives from.
    expect(script).toContain(`ROOT="${root}"`);
    expect(script).toContain(`GEMSTONE="${expectedEnginePath()}"`);
  });

  it('writes the topaz drivers beside it', () => {
    writeCliScripts();

    const run = fs.readFileSync(path.join(root, 'bin', 'gemdb-run.tpz'), 'utf8');
    // The two hard-won mechanics: status through the environment-named file,
    // and errors caught as AbstractException (Python errors are not Error).
    expect(run).toContain('GEMDB_STATUS_FILE');
    expect(run).toContain('on: AbstractException');
    expect(run).toContain('set gemstone gemdb');

    const repl = fs.readFileSync(path.join(root, 'bin', 'gemdb-repl.tpz'), 'utf8');
    expect(repl).toContain(path.join(root, 'grail', 'scripts', 'grail.tpz'));
  });

  it('refuses to generate against a missing engine', () => {
    fs.rmSync(expectedEnginePath(), { recursive: true, force: true });
    expect(() => writeCliScripts()).toThrow(/not installed/);
  });
});
