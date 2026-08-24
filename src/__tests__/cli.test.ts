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
let ext: string;

/** A stand-in extension directory: the shell bundle and koffi, nothing else. */
function makeExtensionDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdb-ext-'));
  fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'out', 'gemdb-shell.js'), '// the shell bundle\n');
  const koffi = path.join(dir, 'node_modules', 'koffi');
  const machine = `${process.platform}_${process.arch}`;
  fs.mkdirSync(path.join(koffi, 'build', 'koffi', machine), { recursive: true });
  fs.mkdirSync(path.join(koffi, 'build', 'koffi', 'linux_ia32'), { recursive: true });
  fs.mkdirSync(path.join(koffi, 'doc'), { recursive: true });
  fs.writeFileSync(path.join(koffi, 'package.json'), '{"name":"koffi"}\n');
  fs.writeFileSync(path.join(koffi, 'build', 'koffi', machine, 'koffi.node'), 'native\n');
  fs.writeFileSync(path.join(koffi, 'build', 'koffi', 'linux_ia32', 'koffi.node'), 'native\n');
  fs.writeFileSync(path.join(koffi, 'doc', 'manual.md'), 'docs\n');
  return dir;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdb-cli-'));
  ext = makeExtensionDir();
  __setSetting('gemdb.rootPath', root);
  fs.mkdirSync(expectedEnginePath(), { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(ext, { recursive: true, force: true });
});

describe('writeCliScripts', () => {
  it('writes an executable wrapper with this installation baked in', () => {
    writeCliScripts(ext);

    const stat = fs.statSync(cliPath());
    expect(stat.mode & 0o111).not.toBe(0); // executable
    const script = fs.readFileSync(cliPath(), 'utf8');
    expect(script.startsWith('#!/bin/bash')).toBe(true);
    // Self-contained: the wrapper carries its own paths rather than assuming
    // any environment. These are the two everything else derives from.
    expect(script).toContain(`ROOT="${root}"`);
    expect(script).toContain(`GEMSTONE="${expectedEnginePath()}"`);
  });

  it('writes the topaz driver beside it', () => {
    writeCliScripts(ext);

    const run = fs.readFileSync(path.join(root, 'bin', 'gemdb-run.tpz'), 'utf8');
    // The two hard-won mechanics: status through the environment-named file,
    // and errors caught as AbstractException (Python errors are not Error).
    expect(run).toContain('GEMDB_STATUS_FILE');
    expect(run).toContain('on: AbstractException');
    expect(run).toContain('set gemstone gemdb');
    // sys.exit(n) is decoded in the driver: the status lives only in the
    // SystemExit's Python args tuple, and CPython truncates an int to n % 256.
    expect(run).toContain("objectNamed: #'SystemExit'");
    expect(run).toContain('\\\\ 256');
    // Grail retired the canonical-modules flag when warm binding became its
    // only path. Sending it is now a doesNotUnderstand that kills the run at
    // that line, so the driver must not carry it.
    expect(run).not.toContain('___canonicalClassesEnabled___');
    // A file run is linked topaz, so it never reaches session.ts and would
    // otherwise sit in the shared cache as the stock 'TopazL'. The truncation
    // is not optional: 32 characters raises OutOfRange, at login.
    expect(run).toContain('System cacheName: label');
    expect(run).toContain("label := 'GemDB run ', label");
    expect(run).toContain('label size > 31 ifTrue:');
  });

  it('makes no arguments the GemDB Shell, run by the recorded Node runtime', () => {
    writeCliScripts(ext);

    const script = fs.readFileSync(cliPath(), 'utf8');
    // The shell branch: the staged bundle, under the editor's own runtime,
    // with the setting the environment cannot otherwise carry.
    expect(script).toContain('gemdb-shell.js');
    expect(script).toContain(`NODE="${process.execPath}"`);
    expect(script).toContain('ELECTRON_RUN_AS_NODE=1');
    expect(script).toContain('GEMDB_ENGINE_VERSION');
    // The old handoff to Grail's topaz REPL is gone entirely.
    expect(script).not.toContain('gemdb-repl.tpz');
  });

  it('stages the shell bundle with only this platform of koffi', () => {
    writeCliScripts(ext);

    expect(fs.existsSync(path.join(root, 'bin', 'gemdb-shell.js'))).toBe(true);
    const koffi = path.join(root, 'bin', 'node_modules', 'koffi');
    const machine = `${process.platform}_${process.arch}`;
    expect(fs.existsSync(path.join(koffi, 'package.json'))).toBe(true);
    expect(fs.existsSync(path.join(koffi, 'build', 'koffi', machine, 'koffi.node'))).toBe(true);
    // The same pruning .vscodeignore applies to the extension's own copy:
    // other platforms' binaries and the documentation stay behind.
    expect(fs.existsSync(path.join(koffi, 'build', 'koffi', 'linux_ia32'))).toBe(false);
    expect(fs.existsSync(path.join(koffi, 'doc'))).toBe(false);
  });

  it('still writes the wrapper when the build carries no shell bundle', () => {
    fs.rmSync(path.join(ext, 'out', 'gemdb-shell.js'));

    writeCliScripts(ext);

    // File and module mode do not need the bundle, so the wrapper is written
    // regardless; its shell branch reports the gap at run time instead.
    expect(fs.existsSync(cliPath())).toBe(true);
    expect(fs.existsSync(path.join(root, 'bin', 'gemdb-shell.js'))).toBe(false);
    expect(fs.readFileSync(cliPath(), 'utf8')).toContain('has no shell program');
  });

  it('removes the retired topaz REPL driver a previous release wrote', () => {
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(root, 'bin', 'gemdb-repl.tpz'), 'input grail.tpz\n');

    writeCliScripts(ext);

    expect(fs.existsSync(path.join(root, 'bin', 'gemdb-repl.tpz'))).toBe(false);
  });

  it('refuses to generate against a missing engine', () => {
    fs.rmSync(expectedEnginePath(), { recursive: true, force: true });
    expect(() => writeCliScripts(ext)).toThrow(/not installed/);
  });
});
