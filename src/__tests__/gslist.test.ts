import { describe, expect, it } from 'vitest';
import { parseGslist } from '../gslist';

// Captured verbatim from `gslist -cvl` against a real install running two
// engine versions side by side. The shape — fixed-width columns, a `cache` row
// per stone, a two-word status — is what the parser has to survive.
const REAL_OUTPUT = `Status        Version    Owner       Pid   Port   Started     Type       Name
-------      --------- --------- -------- ----- ------------ ------      ----
OK           3.7.5     jfoster      72271 59317 Aug 08 18:38 Stone       gemdb
OK           3.7.5     jfoster      72272 59315 Aug 08 18:38 cache       gemdb~5eb9300db1bc17e4
OK           3.7.5     jfoster      72287 59327 Aug 08 18:38 Netldi      gemdbldi`;

describe('parseGslist', () => {
  it('reads the stone and the listener out of real output', () => {
    const processes = parseGslist(REAL_OUTPUT);
    expect(processes).toEqual([
      {
        type: 'stone',
        version: '3.7.5',
        pid: 72271,
        name: 'gemdb',
        status: 'OK',
        responding: true,
      },
      {
        type: 'netldi',
        version: '3.7.5',
        pid: 72287,
        name: 'gemdbldi',
        status: 'OK',
        responding: true,
        port: 59327,
      },
    ]);
  });

  it('skips the shared page cache, which is not a process we manage', () => {
    expect(parseGslist(REAL_OUTPUT).map((p) => p.name)).not.toContain('gemdb~5eb9300db1bc17e4');
  });

  it('reports the listener port, which is how a session finds the database', () => {
    // GemDB names its listener `gemdbldi` rather than the conventional
    // `gs64ldi`, so it has no /etc/services entry and no fixed port. Reading
    // the port back from here is what replaces that entry.
    const netldi = parseGslist(REAL_OUTPUT).find((p) => p.type === 'netldi');
    expect(netldi?.port).toBe(59327);
  });

  it('handles a two-word status without mistaking it for the version', () => {
    const output =
      'exe deleted  3.7.5     jfoster      72287 59327 Aug 08 18:38 Netldi      gemdbldi';
    const [netldi] = parseGslist(output);
    expect(netldi.status).toBe('exe deleted');
    expect(netldi.version).toBe('3.7.5');
    expect(netldi.responding).toBe(false);
  });

  it('treats anything other than OK as not responding', () => {
    const output = 'frozen       3.7.5     jfoster      72271 59317 Aug 08 18:38 Stone       gemdb';
    expect(parseGslist(output)[0].responding).toBe(false);
  });

  it('returns nothing when the engine reports nothing', () => {
    expect(parseGslist('')).toEqual([]);
    expect(parseGslist('Status        Version    Owner       Pid   Port\n----- ----')).toEqual([]);
  });
});
