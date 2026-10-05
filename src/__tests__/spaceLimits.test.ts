import { describe, expect, it } from 'vitest';
import {
  FREE_SPACE_THRESHOLD_MB,
  REPOSITORY_LIMIT_MB,
  configuredExtentMb,
  extentShortfall,
  withSpaceLimits,
} from '../database';
import { accountQuery } from '../account';

/**
 * The two lines that cap the extent and set the free space the stone defends,
 * added to a database's configuration without disturbing anything already
 * there.
 *
 * What these guard is the existing database: `ensureSpaceLimits` rewrites
 * `system.conf` on every start, so it must change nothing the second time, and
 * must not override a value the developer chose — `gemdb.conf` is read after
 * `system.conf`, so a value there already wins, and adding ours would only
 * mislead whoever reads `system.conf`.
 */

const SYSTEM_CONF = [
  '# GemDB system configuration.',
  '',
  'DBF_EXTENT_NAMES = "/home/me/GemDB/db/data/extent0.dbf";',
  'STN_TRAN_FULL_LOGGING = TRUE;',
  '',
].join('\n');

describe('the space limits', () => {
  it('caps the extent at the license limit and sets the threshold', () => {
    const conf = withSpaceLimits(SYSTEM_CONF);

    expect(conf).toContain(`DBF_EXTENT_SIZES = ${REPOSITORY_LIMIT_MB}MB;`);
    expect(conf).toContain(`STN_FREE_SPACE_THRESHOLD = ${FREE_SPACE_THRESHOLD_MB}MB;`);
    expect(conf?.startsWith(SYSTEM_CONF.trimEnd())).toBe(true);
  });

  it('matches what the license says', () => {
    // `Repository size limit: 10240 MB` in the Community key, and a multiple of
    // 16 MB, which the stone would otherwise round down to.
    expect(REPOSITORY_LIMIT_MB).toBe(10240);
    expect(REPOSITORY_LIMIT_MB % 16).toBe(0);
  });

  it('reserves the whole cap on disk when the stone starts', () => {
    // Without it, a disk that fills first silently becomes the cap (measured).
    expect(withSpaceLimits(SYSTEM_CONF)).toMatch(/^DBF_PRE_GROW = TRUE;/m);
  });

  it('changes nothing the second time', () => {
    const once = withSpaceLimits(SYSTEM_CONF) ?? '';

    expect(withSpaceLimits(once)).toBeUndefined();
  });

  it("keeps a threshold the developer set in the stone's own file", () => {
    const conf = withSpaceLimits(SYSTEM_CONF, ['STN_FREE_SPACE_THRESHOLD = 1GB;\n']);

    expect(conf).toContain('DBF_EXTENT_SIZES');
    expect(conf).not.toMatch(/^STN_FREE_SPACE_THRESHOLD/m);
  });

  it('adds nothing when all three are already set', () => {
    const conf = `${SYSTEM_CONF}DBF_EXTENT_SIZES = 4GB;\n`;

    expect(
      withSpaceLimits(conf, ['  STN_FREE_SPACE_THRESHOLD=100MB;', 'DBF_PRE_GROW = FALSE;']),
    ).toBeUndefined();
  });

  it('does not count a commented-out setting as set', () => {
    // default.conf, copied beside the database, comments out every setting.
    const conf = withSpaceLimits(
      `${SYSTEM_CONF}#DBF_EXTENT_SIZES = ;\n# STN_FREE_SPACE_THRESHOLD = 0;\n`,
    );

    expect(conf).toMatch(/^DBF_EXTENT_SIZES = 10240MB;/m);
    expect(conf).toMatch(/^STN_FREE_SPACE_THRESHOLD = 500MB;/m);
  });
});

describe('the cap a configuration sets', () => {
  it('reads megabytes, with or without a unit', () => {
    expect(configuredExtentMb(['DBF_EXTENT_SIZES = 10240MB;'])).toBe(10240);
    expect(configuredExtentMb(['DBF_EXTENT_SIZES = 512;'])).toBe(512);
  });

  it('converts gigabytes and kilobytes', () => {
    expect(configuredExtentMb(['DBF_EXTENT_SIZES = 5GB;'])).toBe(5120);
    expect(configuredExtentMb(['DBF_EXTENT_SIZES = 1048576KB;'])).toBe(1024);
  });

  it("lets the stone's own file override system.conf, as the stone does", () => {
    expect(configuredExtentMb(['DBF_EXTENT_SIZES = 10240MB;', 'DBF_EXTENT_SIZES = 1024MB;'])).toBe(
      1024,
    );
  });

  it('knows no cap when none is set, or only a commented-out one', () => {
    expect(
      configuredExtentMb(['# DBF_EXTENT_SIZES = 2048MB;', 'SHR_PAGE_CACHE_SIZE_KB = 1;']),
    ).toBe(undefined);
  });
});

describe('room on disk for the reserved extent', () => {
  const facts = { capMb: 10240, extentMb: 48, freeDiskMb: 20000, directory: '/home/me/GemDB/db' };

  it('is enough when the disk can take what the extent still needs', () => {
    expect(extentShortfall(facts)).toBeUndefined();
  });

  it('needs nothing more once the extent has been reserved', () => {
    expect(extentShortfall({ ...facts, extentMb: 10240, freeDiskMb: 0 })).toBeUndefined();
  });

  it('says how much is needed, how much there is, and what to do', () => {
    const message = extentShortfall({ ...facts, freeDiskMb: 4096 });

    expect(message).toContain('10 GB');
    expect(message).toContain('4 GB free');
    expect(message).toContain('gemdb.rootPath');
  });
});

describe('the database account', () => {
  it('is created with its own security policy and exactly its two privileges', () => {
    const query = accountQuery('0123abcd', false);

    expect(query).toContain("addNewUserWithId: 'gemdb' password: '0123abcd'");
    expect(query).toContain('createNewSecurityPolicy: true');
    expect(query.match(/addPrivilege: #\w+/g)).toEqual([
      'addPrivilege: #CodeModification',
      'addPrivilege: #CreateOnetimePassword',
    ]);
  });

  it("leaves an existing account's password alone unless the password file was missing", () => {
    expect(accountQuery('pw', false)).not.toContain("u password: 'pw'");
    expect(accountQuery('pw', true)).toContain("u password: 'pw'");
  });
});
