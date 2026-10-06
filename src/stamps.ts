import * as fs from 'fs';
import * as path from 'path';

/**
 * What a payload's stamp says, and how two stamps compare.
 *
 * Several editors can share one root path — VS Code on one GemDB, Cursor on
 * another — and each would otherwise replace whatever Grail or MCP server the
 * other filed in, back and forth, on every start. The payload's own identifier
 * cannot settle which is newer: it is a `git describe` of an upstream commit,
 * and those do not order. So a stamp also records the GemDB that wrote it, as
 * an `extension=<version>` line, and GemDB's own version stands in for how new
 * the payload is — each release pins one Grail and one MCP server.
 *
 * The same format serves both records: the "filed in" stamp beside the
 * database, and the "staged by" marker inside the staged payload.
 */

export const STAMP_ORDER = {
  /** The record is from an older GemDB, or there is none: replace it. */
  older: 'older',
  /** The record is from a newer GemDB: leave it alone. */
  newer: 'newer',
  same: 'same',
  /** The same GemDB version wrote a different payload: replace it, as before versions were recorded. */
  sameVersionDifferent: 'sameVersionDifferent',
} as const;
export type StampOrder = (typeof STAMP_ORDER)[keyof typeof STAMP_ORDER];

/** This GemDB's own version, from its `package.json`, or undefined if unreadable. */
export function extensionVersion(extensionPath: string): string | undefined {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(extensionPath, 'package.json'), 'utf8'),
    ) as { version?: unknown };
    return typeof manifest.version === 'string' ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

interface ParsedVersion {
  core: [number, number, number];
  preRelease: string | undefined;
}

function parseVersion(version: string | undefined): ParsedVersion | undefined {
  const match = version?.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/);
  if (!match) return undefined;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    preRelease: match[4],
  };
}

/**
 * Order two `major.minor.patch` versions: negative when `a` is older.
 *
 * A version that does not parse, or is missing, is older than any that does:
 * a record GemDB cannot read is one it may replace. A pre-release ranks below
 * its release; two pre-releases of one version compare as text, which is
 * enough for the suffixes GemDB has shipped.
 */
export function compareVersions(a: string | undefined, b: string | undefined): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return (left ? 1 : 0) - (right ? 1 : 0);
  for (let i = 0; i < 3; i++) {
    if (left.core[i] !== right.core[i]) return left.core[i] - right.core[i];
  }
  if (left.preRelease === right.preRelease) return 0;
  if (left.preRelease === undefined) return 1;
  if (right.preRelease === undefined) return -1;
  return left.preRelease < right.preRelease ? -1 : 1;
}

const EXTENSION_LINE = /^extension=(.*)$/m;

/** A stamp split into the GemDB that wrote it and the payload's own lines. */
export function parseStamp(stamp: string): { extension: string | undefined; payload: string } {
  const extension = stamp.match(EXTENSION_LINE)?.[1].trim();
  const payload = stamp
    .split('\n')
    .filter((line) => !line.startsWith('extension='))
    .join('\n')
    .trim();
  return { extension, payload };
}

/**
 * The stamp this GemDB writes for a payload: the payload's own version file
 * (`GRAIL_VERSION`, `MCP_VERSION`) followed by `extension=<this version>`.
 */
export function stampFor(extensionPath: string, bundledPayloadStamp: string): string {
  const { payload } = parseStamp(bundledPayloadStamp);
  return `${payload}\nextension=${extensionVersion(extensionPath) ?? 'unknown'}`;
}

/**
 * How what is on record compares with what this GemDB would write.
 *
 * `older` when nothing is on record. Versions decide first; only at equal
 * versions do the payload lines, compared without the `extension=` line, say
 * whether the two differ.
 */
export function compareStamps(installed: string | undefined, bundled: string): StampOrder {
  if (installed === undefined) return STAMP_ORDER.older;
  const ours = parseStamp(bundled);
  const theirs = parseStamp(installed);
  const order = compareVersions(theirs.extension, ours.extension);
  if (order < 0) return STAMP_ORDER.older;
  if (order > 0) return STAMP_ORDER.newer;
  return theirs.payload === ours.payload ? STAMP_ORDER.same : STAMP_ORDER.sameVersionDifferent;
}
