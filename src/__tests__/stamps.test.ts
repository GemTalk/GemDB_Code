import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  STAMP_ORDER,
  compareStamps,
  compareVersions,
  extensionVersion,
  parseStamp,
  stampFor,
} from '../stamps';

/**
 * Which of two GemDB versions wrote the newer payload record.
 *
 * What these guard is the ping-pong between two editors on one root path:
 * each must recognise a payload the other filed in as newer or older, and
 * anything it cannot read must count as older, so a newer GemDB is never
 * stuck behind a record it does not understand.
 */

const GRAIL = 'grail=0.1-2200-gnew\ncommit=new\nengine=4.0.0.a4';
const OTHER_GRAIL = 'grail=0.1-2100-gold\ncommit=old\nengine=4.0.0.a4';

function stamp(payload: string, extension?: string): string {
  return extension === undefined ? payload : `${payload}\nextension=${extension}`;
}

let ext: string | undefined;

afterEach(() => {
  if (ext) fs.rmSync(ext, { recursive: true, force: true });
  ext = undefined;
});

function makeExtensionDir(manifest: string | undefined): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdb-ext-'));
  if (manifest !== undefined) fs.writeFileSync(path.join(dir, 'package.json'), manifest);
  return dir;
}

describe('comparing GemDB versions', () => {
  it('orders by major, minor and patch, numerically', () => {
    expect(compareVersions('1.5.4', '1.6.0')).toBeLessThan(0);
    expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareVersions('2.0.0', '1.99.99')).toBeGreaterThan(0);
    expect(compareVersions('1.5.4', '1.5.4')).toBe(0);
  });

  it('ranks a pre-release below its release', () => {
    expect(compareVersions('1.6.0-beta.1', '1.6.0')).toBeLessThan(0);
    expect(compareVersions('1.6.0', '1.6.0-beta.1')).toBeGreaterThan(0);
    expect(compareVersions('1.6.0-beta.1', '1.5.4')).toBeGreaterThan(0);
  });

  it('counts a version it cannot read, or none at all, as older', () => {
    expect(compareVersions(undefined, '0.0.1')).toBeLessThan(0);
    expect(compareVersions('unknown', '0.0.1')).toBeLessThan(0);
    expect(compareVersions('1.6', '1.5.4')).toBeLessThan(0);
    expect(compareVersions('1.5.4', 'garbage')).toBeGreaterThan(0);
    expect(compareVersions(undefined, 'garbage')).toBe(0);
  });
});

describe('comparing stamps', () => {
  it('says older when nothing is on record', () => {
    expect(compareStamps(undefined, stamp(GRAIL, '1.6.0'))).toBe(STAMP_ORDER.older);
  });

  it('says older for a record an older GemDB wrote', () => {
    expect(compareStamps(stamp(GRAIL, '1.5.4'), stamp(GRAIL, '1.6.0'))).toBe(STAMP_ORDER.older);
  });

  it('says newer for a record a newer GemDB wrote, whatever its payload', () => {
    expect(compareStamps(stamp(OTHER_GRAIL, '1.7.0'), stamp(GRAIL, '1.6.0'))).toBe(
      STAMP_ORDER.newer,
    );
  });

  it('says same when the version and the payload match', () => {
    expect(compareStamps(stamp(GRAIL, '1.6.0'), stamp(GRAIL, '1.6.0'))).toBe(STAMP_ORDER.same);
  });

  it('tells a different payload at the same version apart, so it is still replaced', () => {
    // A developer rebuilding the payload without bumping the version.
    expect(compareStamps(stamp(OTHER_GRAIL, '1.6.0'), stamp(GRAIL, '1.6.0'))).toBe(
      STAMP_ORDER.sameVersionDifferent,
    );
  });

  it('counts a record with no version as older: what GemDB wrote before it kept one', () => {
    expect(compareStamps(GRAIL, stamp(GRAIL, '1.6.0'))).toBe(STAMP_ORDER.older);
  });

  it('counts a record whose version it cannot read as older', () => {
    expect(compareStamps(stamp(GRAIL, 'unknown'), stamp(GRAIL, '1.6.0'))).toBe(STAMP_ORDER.older);
  });

  it('ranks a pre-release record below the release', () => {
    expect(compareStamps(stamp(GRAIL, '1.6.0-beta.1'), stamp(GRAIL, '1.6.0'))).toBe(
      STAMP_ORDER.older,
    );
    expect(compareStamps(stamp(GRAIL, '1.6.0'), stamp(GRAIL, '1.6.0-beta.1'))).toBe(
      STAMP_ORDER.newer,
    );
  });
});

describe('writing a stamp', () => {
  it('appends this GemDB version to the payload version file', () => {
    ext = makeExtensionDir(JSON.stringify({ name: 'gemdb', version: '1.6.0' }));

    expect(stampFor(ext, `${GRAIL}\n`)).toBe(`${GRAIL}\nextension=1.6.0`);
  });

  it('parses back into the version and the payload', () => {
    expect(parseStamp(stamp(GRAIL, '1.6.0'))).toEqual({ extension: '1.6.0', payload: GRAIL });
    expect(parseStamp(GRAIL)).toEqual({ extension: undefined, payload: GRAIL });
  });

  it('writes a version every other GemDB reads as older when its own is unreadable', () => {
    ext = makeExtensionDir('{ not json');

    expect(extensionVersion(ext)).toBeUndefined();
    expect(compareStamps(stampFor(ext, GRAIL), stamp(GRAIL, '0.0.1'))).toBe(STAMP_ORDER.older);
  });

  it('reads the version from the extension manifest', () => {
    ext = makeExtensionDir(JSON.stringify({ version: '2.0.0' }));

    expect(extensionVersion(ext)).toBe('2.0.0');
  });

  it('has no version for an extension without a manifest', () => {
    ext = makeExtensionDir(undefined);

    expect(extensionVersion(ext)).toBeUndefined();
  });
});
