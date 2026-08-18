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
 *     OK           3.7.5     jfoster      72271 59317 Aug 08 18:38 Stone   gemdb
 *     exe deleted  3.7.5     jfoster      72287 59327 Aug 08 18:38 Netldi  gemdbldi
 *
 * Status is usually one word but can be two (`exe deleted`), so the first
 * capture is non-greedy and the match anchors on the version, which always
 * starts with a digit. Rows that are neither a Stone nor a Netldi — the shared
 * page cache gets its own row — do not match and are skipped, as are the header
 * and separator lines.
 */
export function parseGslist(output: string): EngineProcess[] {
  const processes: EngineProcess[] = [];
  for (const line of output.split('\n')) {
    const match = line.match(
      /^\s*(\S+(?: \S+)?)\s+(\d[\d.]*)\s+\S+\s+(\d+)\s+(\d+)\s+(?:\w+\s+\d+\s+[\d:]+)\s+(Stone|Netldi)\s+(.+)$/i,
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
