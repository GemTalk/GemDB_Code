/**
 * Parsing `gslist` output.
 *
 * Kept free of any editor or filesystem dependency so it can be tested against
 * real captured output — which is the only way to be confident about a format
 * defined by a fixed-width report rather than a specification.
 */

export interface EngineProcess {
  type: 'stone' | 'netldi';
  name: string;
  version: string;
  pid: number;
  /** TCP port, for a NetLDI. */
  port?: number;
  status: string;
  responding: boolean;
}

/**
 * Turn `gslist -cvl` output into records.
 *
 * A data row is `{status} {version} {owner} {pid} {port} {date} {type} {name}`:
 *
 *     exists       4.0.0.a2  jfoster      64458 53809 Sep 16 06:17 Stone   gemdb
 *     exe deleted  4.0.0.a2  jfoster      64464 53807 Sep 16 06:17 Netldi  gemdbldi
 *
 * Status is usually one word but can be two (`exe deleted`), so the first
 * capture is non-greedy and the match anchors on the version, which always
 * starts with a digit.
 *
 * **The version is not always digits and dots, and that cost a whole release
 * once.** An earlier version of this pattern matched `[\d.]*`, so every Stone
 * and Netldi row was silently dropped, `findStone()` answered undefined
 * forever, the status bar read "stopped" over a running database, and every
 * login failed with "GemDB is not running." `4.0.0.a2` does not match
 * `[\d.]*` either, so the current pin would break it just as thoroughly.
 *
 * The version can also be TRUNCATED, which is worth keeping in mind even
 * though the current pin does not show it. `gslist` reported `4.0.0.Alpha` for
 * a `4.0.0.Alpha1` stone — eleven characters, cut before the row is ever
 * formatted (its own format is `%-9s`, a minimum width, so printf is not the
 * culprit; the lock file's fixed `char version[12]` is). Measured against a
 * live Alpha1 stone on 2026-09-11 and reported upstream; `4.0.0.a2` is eight
 * characters and so arrives whole, measured 2026-09-16. Both shapes are in the
 * tests, because the pin that hides the truncation today is not the pin
 * forever.
 *
 * Nothing consumes the version field, so accepting whatever the engine prints
 * costs nothing and matching it narrowly costs everything.
 *
 * Rows that are neither a Stone nor a Netldi — the shared page cache gets its
 * own row — do not match and are skipped, as are the header and separator
 * lines.
 */
export function parseGslist(output: string): EngineProcess[] {
  const processes: EngineProcess[] = [];
  for (const line of output.split('\n')) {
    const match = line.match(
      /^\s*(\S+(?: \S+)?)\s+(\d\S*)\s+\S+\s+(\d+)\s+(\d+)\s+(?:\w+\s+\d+\s+[\d:]+)\s+(Stone|Netldi)\s+(.+)$/i,
    );
    if (!match) continue;
    const type = match[5].toLowerCase() === 'stone' ? 'stone' : 'netldi';
    const status = match[1].trim();
    const record: EngineProcess = {
      type,
      version: match[2],
      pid: parseInt(match[3], 10),
      name: match[6].trim(),
      status,
      responding: status.toUpperCase() === 'OK',
    };
    if (type === 'netldi') record.port = parseInt(match[4], 10);
    processes.push(record);
  }
  return processes;
}
