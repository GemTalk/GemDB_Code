import { describe, expect, it } from 'vitest';
import { parseGslist } from '../gslist';

// Captured verbatim from `gslist -cvl` against a real database of the PINNED
// engine, 4.0.0.a3, on 2026-09-24. The shape — fixed-width columns, a `cache`
// row per stone, a two-word status — is what the parser has to survive.
//
// The version column is why the pattern is `\d\S*` rather than digits and
// dots: `4.0.0.a3` is not digits and dots, and an earlier `[\d.]*` dropped
// every row — see the comment on parseGslist.
const REAL_OUTPUT = `Status        Version    Owner       Pid   Port   Started     Type       Name
-------      --------- --------- -------- ----- ------------ ------      ----
OK           4.0.0.a3  jfoster      24428 61548 Sep 24 21:20 Stone       gemdb
OK           4.0.0.a3  jfoster      24441 61553 Sep 24 21:20 Netldi      gemdbldi
OK           4.0.0.a3  jfoster      24429 61546 Sep 24 21:20 cache       gemdb~5425c213e16565aa`;

// The same, from a 4.0.0.Alpha1 stone on 2026-09-11 — kept because it carries
// a shape the current pin does not: the engine TRUNCATED `4.0.0.Alpha1` to
// `4.0.0.Alpha`, eleven characters, in the lock file's fixed `char version[12]`
// field. `4.0.0.a3` is short enough to arrive whole, so the pin of the day
// hides that behaviour; the parser still has to survive the next version that
// does not. Reported upstream.
const TRUNCATED_OUTPUT = `Status        Version    Owner       Pid   Port   Started     Type       Name
-------      --------- --------- -------- ----- ------------ ------      ----
OK           4.0.0.Alpha jfoster      56970 65107 Sep 11 16:46 Stone       gemdb
OK           4.0.0.Alpha jfoster      56971 65105 Sep 11 16:46 cache       gemdb~ba58ac75392ee4e7
OK           4.0.0.Alpha jfoster      56992 65112 Sep 11 16:46 Netldi      gemdbldi`;

describe('parseGslist', () => {
  it('reads the stone and the listener out of real output', () => {
    const processes = parseGslist(REAL_OUTPUT);
    expect(processes).toEqual([
      {
        type: 'stone',
        version: '4.0.0.a3',
        pid: 24428,
        name: 'gemdb',
        status: 'OK',
        responding: true,
      },
      {
        type: 'netldi',
        version: '4.0.0.a3',
        pid: 24441,
        name: 'gemdbldi',
        status: 'OK',
        responding: true,
        port: 61553,
      },
    ]);
  });

  it('reads a version the engine truncated', () => {
    const processes = parseGslist(TRUNCATED_OUTPUT);
    expect(processes.map((p) => p.version)).toEqual(['4.0.0.Alpha', '4.0.0.Alpha']);
    expect(processes.find((p) => p.type === 'stone')?.name).toBe('gemdb');
  });

  it('skips the shared page cache, which is not a process we manage', () => {
    expect(parseGslist(REAL_OUTPUT).map((p) => p.name)).not.toContain('gemdb~5425c213e16565aa');
  });

  it('reports the listener port, which is how a session finds the database', () => {
    // GemDB names its listener `gemdbldi` rather than the conventional
    // `gs64ldi`, so it has no /etc/services entry and no fixed port. Reading
    // the port back from here is what replaces that entry.
    const netldi = parseGslist(REAL_OUTPUT).find((p) => p.type === 'netldi');
    expect(netldi?.port).toBe(61553);
  });

  it('handles a two-word status without mistaking it for the version', () => {
    const output =
      'exe deleted  4.0.0.Alpha jfoster      56992 65112 Sep 11 16:46 Netldi      gemdbldi';
    const [netldi] = parseGslist(output);
    expect(netldi.status).toBe('exe deleted');
    expect(netldi.version).toBe('4.0.0.Alpha');
    expect(netldi.responding).toBe(false);
  });

  it('treats anything other than OK as not responding', () => {
    const output =
      'frozen       4.0.0.Alpha jfoster      56970 65107 Sep 11 16:46 Stone       gemdb';
    expect(parseGslist(output)[0].responding).toBe(false);
  });

  it('accepts a version that is not just digits and dots', () => {
    // The row the old pattern could not match. A build-qualified version —
    // truncated or not — must not make a running stone invisible.
    for (const version of ['4.0.0.a3', '4.0.0.a2', '4.0.0.Alpha', '4.0.0.Alpha1', '4.0.1']) {
      const output = `OK           ${version} jfoster      56970 65107 Sep 11 16:46 Stone       gemdb`;
      const [stone] = parseGslist(output);
      expect(stone?.name).toBe('gemdb');
      expect(stone?.version).toBe(version);
    }
  });

  it('returns nothing when the engine reports nothing', () => {
    expect(parseGslist('')).toEqual([]);
    expect(parseGslist('Status        Version    Owner       Pid   Port\n----- ----')).toEqual([]);
  });
});
