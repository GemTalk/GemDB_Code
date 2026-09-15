import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Which text `scripts/changelog-section.sh` says belongs to a version.
 *
 * The release workflow runs it twice and the two runs are not equivalent in
 * cost: `collect` runs it as a guard and throws the output away, and `release`
 * runs it to render the GitHub Release notes — one step AFTER the tag has been
 * created. So every case where it fails is a case that must fail in `collect`,
 * while a re-dispatch is still all it takes.
 *
 * That guard exists because `validate`'s own pre-check is weaker: it reads
 * CHANGELOG.md over the API and is satisfied by a dated heading, where this
 * also requires a body. A dated but empty section passed validation, survived
 * the scan and the approval gate, got tagged, and only then failed. The second
 * test below is that gap.
 */

const SCRIPT = path.resolve(__dirname, '../../scripts/changelog-section.sh');

let dir: string;

function changelog(body: string): string {
  const file = path.join(dir, 'CHANGELOG.md');
  fs.writeFileSync(file, body);
  return file;
}

function run(version: string, changelogPath?: string) {
  const result = spawnSync('bash', [SCRIPT, version], {
    encoding: 'utf8',
    env: { ...process.env, CHANGELOG_PATH: changelogPath ?? path.join(dir, 'CHANGELOG.md') },
    cwd: dir,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** A changelog shaped exactly like the real one, down to the link block. */
const REAL_SHAPE = `# Changelog

All notable changes to the **GemDB Code** extension will be documented in this file.

## [Unreleased]

### Added

- Something still cooking.

## [1.5.0] - 2026-09-11

### Fixed

- The thing that was broken.

## [1.4.0] - 2026-09-03

### Added

- The oldest entry here.

[Unreleased]: https://github.com/GemTalk/GemDB_Code/compare/v1.5.0...HEAD
[1.5.0]: https://github.com/GemTalk/GemDB_Code/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/GemTalk/GemDB_Code/releases/tag/v1.4.0
`;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdb-changelog-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('what it prints', () => {
  it("prints one version's body and stops at the next heading", () => {
    changelog(REAL_SHAPE);
    const { status, stdout } = run('1.5.0');
    expect(status).toBe(0);
    expect(stdout).toContain('The thing that was broken.');
    // Neither the newer section above nor the older one below may leak in.
    expect(stdout).not.toContain('Something still cooking.');
    expect(stdout).not.toContain('The oldest entry here.');
  });

  // The oldest section is the one not followed by another heading, so without
  // an explicit stop it swallows the Keep a Changelog link block and puts three
  // link definitions into the Release notes.
  it('stops the oldest section at the link-definition block', () => {
    changelog(REAL_SHAPE);
    const { status, stdout } = run('1.4.0');
    expect(status).toBe(0);
    expect(stdout).toContain('The oldest entry here.');
    expect(stdout).not.toContain('https://github.com/GemTalk/GemDB_Code/compare');
    expect(stdout).not.toContain('[Unreleased]:');
  });
});

describe('what it refuses', () => {
  // THE gap the guard in `collect` exists to close. validate's grep is
  // satisfied by this heading; rendering it is not.
  it('refuses a dated section with an empty body', () => {
    changelog(`# Changelog

## [Unreleased]

## [1.5.0] - 2026-09-11

## [1.4.0] - 2026-09-03

- Real content.
`);
    const { status, stderr } = run('1.5.0');
    expect(status).toBe(1);
    expect(stderr).toContain('no dated');
  });

  it('refuses a version that is still sitting under [Unreleased]', () => {
    changelog(`# Changelog

## [Unreleased]

### Added

- Not promoted yet.

## [1.4.0] - 2026-09-03

- Older.
`);
    expect(run('1.5.0').status).toBe(1);
  });

  it('refuses a version with no section at all', () => {
    changelog(REAL_SHAPE);
    expect(run('9.9.9').status).toBe(1);
  });

  // A heading needs the date separator to count as promoted; `## [Unreleased]`
  // has no `-` in that position, which is exactly what distinguishes them.
  it('does not mistake [Unreleased] for a promoted section', () => {
    changelog(REAL_SHAPE);
    const { stdout } = run('1.5.0');
    expect(stdout).not.toContain('Something still cooking.');
  });
});

describe('usage', () => {
  it('refuses no arguments', () => {
    expect(run('').status).not.toBe(0);
    expect(spawnSync('bash', [SCRIPT], { encoding: 'utf8', cwd: dir }).status).toBe(2);
  });

  it('refuses a changelog that is not there', () => {
    const { status, stderr } = run('1.5.0', path.join(dir, 'absent.md'));
    expect(status).toBe(2);
    expect(stderr).toContain('not found');
  });
});

// Pinned rather than fixed. This script is the looser of the two checks in one
// direction — it accepts a separator with no date, where `validate` requires a
// full ISO date. Only the other direction is harmful (validate accepting what
// this rejects, which is what the `collect` guard closes), so the divergence
// stays and is recorded here so nobody "fixes" it and assumes the guard is
// therefore redundant.
describe('the divergence from validate, deliberately kept', () => {
  it('accepts a separator with no date, which validate would reject', () => {
    changelog(`# Changelog

## [Unreleased]

## [1.5.0] -

- Body present, date missing.

## [1.4.0] - 2026-09-03

- Older.
`);
    const { status, stdout } = run('1.5.0');
    expect(status).toBe(0);
    expect(stdout).toContain('Body present, date missing.');
  });
});
