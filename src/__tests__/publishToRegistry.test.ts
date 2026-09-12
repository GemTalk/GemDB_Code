import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * What `scripts/publish-to-registry.sh` decides an outcome MEANS.
 *
 * The classification is the whole reason that script exists — it is the thing
 * `--skip-duplicate` gets wrong — and without this it would only ever run
 * during a real release, which is the one place a stale pattern cannot be
 * discovered cheaply: the first signal would be a red publish job on a version
 * number that can never be reused. The registries have reworded these messages
 * before (Jasper was rejected at 1.7.6 and again at 1.8.3 after Open VSX
 * widened a rule), so the patterns are a standing bet on someone else's
 * strings.
 *
 * A stub `npx` on PATH plays back each canned message and exit status. That
 * pins the outcomes, the ORDERING the two greps depend on (the inactive
 * message also contains "is already published", so a reordering would be
 * silent — both are successes), which CLI each registry gets, and the two
 * things GemDB adds to Jasper's version of this script: three packages in one
 * run, and stdout kept to one `result:` line per package.
 *
 * POSIX-only by construction — the stub relies on a shebang and a
 * `:`-separated PATH. That costs nothing here: GemDB ships macOS and Linux
 * only, and Windows is out of scope in the shipped product (CLAUDE.md,
 * "Platform support").
 */

const SCRIPT = path.resolve(__dirname, '../../scripts/publish-to-registry.sh');

let dir: string;
let argvLog: string;

/**
 * A stand-in `npx` that replays one canned response.
 *
 * It appends its own argv to a log first, so a test can assert which CLI the
 * script reached for without that being a second stub.
 */
function stubNpx(output: string, status: number, opts: { stallMs?: number } = {}): void {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(bin, 'npx'),
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> ${JSON.stringify(argvLog)}`,
      // Real CLIs write their diagnostics to stderr; the script merges 2>&1,
      // so this exercises the same path the CLIs take.
      `printf '%s\\n' ${JSON.stringify(output)} >&2`,
      opts.stallMs ? `sleep ${opts.stallMs / 1000}` : '',
      `exit ${status}`,
      '',
    ].join('\n'),
  );
  fs.chmodSync(path.join(bin, 'npx'), 0o755);
}

function vsix(target: string): string {
  const file = path.join(dir, `gemdb-${target}-1.5.0.vsix`);
  fs.writeFileSync(file, 'not really a zip');
  return file;
}

function run(...args: string[]) {
  const result = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${path.join(dir, 'bin')}:${process.env.PATH ?? ''}` },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** The `result:` lines a caller reading stdout would see, in order. */
function results(stdout: string): string[] {
  return stdout
    .split('\n')
    .filter((line) => line.startsWith('result:'))
    .map((line) => line.trim());
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdb-publish-'));
  argvLog = path.join(dir, 'argv.log');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the three ways a package can be up', () => {
  it('reports a clean publish', () => {
    stubNpx('Published gemtalksystems.gemdb v1.5.0', 0);
    const { status, stdout } = run('marketplace', vsix('darwin-arm64'));
    expect(status).toBe(0);
    expect(results(stdout)).toEqual(['result: published']);
  });

  // The case --skip-duplicate gets wrong. ovsx's own check is
  // `err.message.endsWith('is already published.')`, which this message does
  // not match, so ovsx fails hard — in the state a re-run normally meets.
  it('treats an uploaded-but-inactive package as success', () => {
    stubNpx(
      "Extension gemtalksystems.gemdb-1.5.0 is already published, but currently isn't active and therefore not visible.",
      1,
    );
    const { status, stdout } = run('openvsx', vsix('linux-x64'));
    expect(status).toBe(0);
    expect(results(stdout)).toEqual(['result: awaiting-activation']);
  });

  it('treats an already-published package as success (the ovsx spelling)', () => {
    stubNpx('Extension gemtalksystems.gemdb-1.5.0 is already published.', 1);
    const { status, stdout } = run('openvsx', vsix('linux-arm64'));
    expect(status).toBe(0);
    expect(results(stdout)).toEqual(['result: already-published']);
  });

  it('treats an already-published package as success (the vsce spelling)', () => {
    stubNpx('ERROR  Version number 1.5.0 already exists on the Marketplace.', 1);
    const { status, stdout } = run('marketplace', vsix('darwin-arm64'));
    expect(status).toBe(0);
    expect(results(stdout)).toEqual(['result: already-published']);
  });

  // Both branches above are successes, so swapping them would change nothing
  // a test asserting "exit 0" could see. This is the assertion that would go
  // red, because the inactive message contains the already-published one.
  it('does not let the inactive message fall through to already-published', () => {
    stubNpx(
      "Extension gemtalksystems.gemdb-1.5.0 is already published, but currently isn't active and therefore not visible.",
      1,
    );
    const { stdout } = run('openvsx', vsix('linux-x64'));
    expect(results(stdout)).toEqual(['result: awaiting-activation']);
    expect(results(stdout)).not.toContain('result: already-published');
  });
});

describe('a package that is genuinely not up', () => {
  it('fails, and says so on stdout as well as failing', () => {
    stubNpx('ERROR  Failed Request: Internal Server Error (500)', 1);
    const { status, stdout } = run('marketplace', vsix('darwin-arm64'));
    expect(status).not.toBe(0);
    expect(results(stdout)).toEqual(['result: FAILED']);
  });

  // Flattening every failure to 1 would throw away the CLI's own answer, which
  // is the only thing distinguishing a transport error from a rejection.
  it("propagates the CLI's exit status rather than flattening it", () => {
    stubNpx('ERROR  something specific', 7);
    const { status } = run('marketplace', vsix('darwin-arm64'));
    expect(status).toBe(7);
  });
});

describe('what the CLI is told, and what it is never told', () => {
  it('reaches for vsce on the Marketplace and ovsx on Open VSX', () => {
    stubNpx('ok', 0);
    run('marketplace', vsix('darwin-arm64'));
    run('openvsx', vsix('darwin-arm64'));
    const log = fs.readFileSync(argvLog, 'utf8');
    expect(log).toContain('@vscode/vsce publish');
    expect(log).toContain('ovsx publish');
    // Every invocation carries the flag, which stays on as the backstop for the
    // race between a state check and the upload.
    expect(
      log
        .split('\n')
        .filter(Boolean)
        .every((l) => l.includes('--skip-duplicate')),
    ).toBe(true);
  });

  it('never invokes the CLI for an unknown registry', () => {
    stubNpx('ok', 0);
    const { status } = run('bogus', vsix('darwin-arm64'));
    expect(status).toBe(2);
    expect(fs.existsSync(argvLog)).toBe(false);
  });

  it('never invokes the CLI for a missing package', () => {
    stubNpx('ok', 0);
    const { status } = run('marketplace', path.join(dir, 'absent.vsix'));
    expect(status).toBe(2);
    expect(fs.existsSync(argvLog)).toBe(false);
  });

  // A missing package must be caught for EVERY argument before anything is
  // published, not lazily when the loop reaches it: the alternative publishes
  // the first package and then discovers the third was never built.
  it('refuses before publishing anything when one of several is missing', () => {
    stubNpx('ok', 0);
    const { status } = run(
      'marketplace',
      vsix('darwin-arm64'),
      path.join(dir, 'absent.vsix'),
      vsix('linux-x64'),
    );
    expect(status).toBe(2);
    expect(fs.existsSync(argvLog)).toBe(false);
  });

  it('refuses a registry with no packages at all', () => {
    expect(run('marketplace').status).toBe(2);
    expect(run().status).toBe(2);
  });
});

// The reason this script takes several packages rather than being called three
// times: GemDB publishes three per registry, and one failing must neither hide
// the others' results nor leave them unattempted.
describe('three packages in one run', () => {
  it('attempts every package even after one fails, and names only the failure', () => {
    // Fail on linux-x64 alone, by having the stub answer on the argv it sees.
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(
      path.join(bin, 'npx'),
      [
        '#!/bin/sh',
        `printf '%s\\n' "$*" >> ${JSON.stringify(argvLog)}`,
        'case "$*" in',
        '  *linux-x64*) echo "ERROR  Failed Request: 500" >&2; exit 1 ;;',
        '  *) echo "Published" >&2; exit 0 ;;',
        'esac',
        '',
      ].join('\n'),
    );
    fs.chmodSync(path.join(bin, 'npx'), 0o755);

    const { status, stdout, stderr } = run(
      'marketplace',
      vsix('darwin-arm64'),
      vsix('linux-x64'),
      vsix('linux-arm64'),
    );

    expect(status).not.toBe(0);
    // All three attempted, in order, and each reported.
    expect(results(stdout)).toEqual(['result: published', 'result: FAILED', 'result: published']);
    expect(fs.readFileSync(argvLog, 'utf8').split('\n').filter(Boolean)).toHaveLength(3);
    // The summary must name the one that failed and not the two that landed,
    // because republishing those would burn identities that are already spent.
    expect(stderr).toContain('gemdb-linux-x64-1.5.0.vsix');
    expect(stderr).toContain('did not accept 1 of 3');
    expect(stderr).not.toContain('gemdb-darwin-arm64-1.5.0.vsix\n  gemdb');
  });

  it('keeps stdout to exactly one result line per package', () => {
    stubNpx('Published', 0);
    const { stdout } = run('openvsx', vsix('darwin-arm64'), vsix('linux-x64'), vsix('linux-arm64'));
    const lines = stdout.split('\n').filter((line) => line.length > 0);
    expect(lines).toEqual(['result: published', 'result: published', 'result: published']);
  });
});

describe("the CLI's own words survive", () => {
  it('streams the CLI output to stderr rather than only capturing it', () => {
    stubNpx('ERROR  Failed Request: Internal Server Error (500)', 1);
    const { stderr } = run('marketplace', vsix('darwin-arm64'));
    expect(stderr).toContain('Internal Server Error (500)');
  });

  // The regression this guards. The publish steps run under `timeout-minutes`,
  // so a hung CLI is killed by the runner — and with a plain `$(...)` the log
  // kept the "Publishing ..." line and nothing else, in exactly the case where
  // the CLI's own words are the only evidence of whether the upload went out.
  it('has already shown the CLI output when the run is killed mid-publish', async () => {
    stubNpx('ERROR  Failed Request: Internal Server Error (500)', 1, { stallMs: 5000 });
    // `detached` so the stub and its `sleep` join a process group this test can
    // tear down whole — which is also what a runner's timeout does. Killing
    // only the bash would leave the sleeping stub holding the stderr pipe open.
    const child = spawn('bash', [SCRIPT, 'marketplace', vsix('darwin-arm64')], {
      env: { ...process.env, PATH: `${path.join(dir, 'bin')}:${process.env.PATH ?? ''}` },
      detached: true,
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));

    await new Promise<void>((resolve) => {
      child.on('exit', () => resolve());
      // Long enough for the stub to have written and for tee to have flushed,
      // well short of the stub's stall.
      setTimeout(() => process.kill(-(child.pid as number), 'SIGKILL'), 400);
    });

    expect(stderr).toContain('Internal Server Error (500)');
  });
});
