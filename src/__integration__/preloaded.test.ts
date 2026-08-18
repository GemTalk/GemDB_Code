import * as fs from 'fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../database';
import { stageGrail } from '../grail';
import { bundledExtentPath } from '../paths';
import { isRunning, startNetldi, startStone, stopNetldi, stopStone } from '../processes';
import { isErrorResult, isGrailInstalled, runPython } from '../pythonQueries';
import { logout } from '../session';
import { Fixture, makeFixture } from './fixture';

const ext = process.cwd();

// A build artifact of `npm run bundle:extent`, gitignored and absent from a
// fresh checkout. Without it `createDatabase` falls back to the engine's stock
// extent and Grail is filed in the old way — which grail.test.ts covers.
const havePreloaded = fs.existsSync(bundledExtentPath(ext));

let fixture: Fixture | undefined;

beforeAll(async () => {
  if (!havePreloaded) return;
  fixture = makeFixture();
  if (!fixture) return;
  // Deliberately no installGrail: the whole point is that the extent arrives
  // with Python already in it.
  createDatabase(fixture.engine, ext);
  stageGrail(ext);
  await startStone();
  await startNetldi();
});

afterAll(async () => {
  if (!fixture) return;
  logout();
  try {
    await stopNetldi();
  } finally {
    if (isRunning()) await stopStone(true);
    fixture.remove();
  }
});

describe.skipIf(!havePreloaded || !canMakeFixture())('a database from the shipped extent', () => {
  it('has Python support without any file-in', () => {
    expect(isGrailInstalled()).toBe(true);
  });

  it('runs Python immediately', () => {
    const result = runPython('sum(range(10))', 'nb');
    expect(isErrorResult(result)).toBe(false);
    expect(result).toBe('45');
  });

  it('keeps notebook scopes apart, as a filed-in database does', () => {
    runPython('x = 41', 'nb-a');
    expect(runPython('x + 1', 'nb-a')).toBe('42');
    expect(isErrorResult(runPython('x', 'nb-b'))).toBe(true);
  });
});

/** See database.test.ts — skipIf is evaluated during collection. */
function canMakeFixture(): boolean {
  const probe = makeFixture();
  probe?.remove();
  return probe !== undefined;
}
