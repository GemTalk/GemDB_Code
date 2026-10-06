import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __setSetting } from '../__mocks__/vscode';

/**
 * What creating the `gemdb` account says about what is installed.
 *
 * A database that gains the account here has had nothing installed into it,
 * whatever the records beside it claim, so creating it forgets them — in
 * every location any GemDB keeps them.
 */

const accountOutcome = vi.fn(() => 'created');

vi.mock('../session', () => ({
  GciSession: {
    login: () => ({ execute: () => accountOutcome(), logout: () => {} }),
  },
}));

const { ensureDatabaseAccount } = await import('../account');
const { databasePath, grailInstalled, grailStampPath, legacyGrailStampPath } =
  await import('../paths');

let root: string;

beforeEach(() => {
  root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gemdb-run-')), 'GemDB');
  __setSetting('gemdb.rootPath', root);
  fs.mkdirSync(path.join(databasePath(), 'conf'), { recursive: true });
  fs.mkdirSync(path.dirname(legacyGrailStampPath()), { recursive: true });
  fs.writeFileSync(grailStampPath(), 'grail=0.1-2200-gnew\nextension=1.6.0\n');
  fs.writeFileSync(legacyGrailStampPath(), 'grail=0.1-2100-gold\n');
});

afterEach(() => {
  fs.rmSync(path.dirname(root), { recursive: true, force: true });
});

describe('creating the database account', () => {
  it('forgets that Grail is filed in, wherever it was recorded', () => {
    accountOutcome.mockReturnValue('created');

    ensureDatabaseAccount();

    expect(fs.existsSync(grailStampPath())).toBe(false);
    expect(fs.existsSync(legacyGrailStampPath())).toBe(false);
    expect(grailInstalled()).toBe(false);
  });

  it('keeps the records when the account was already there', () => {
    accountOutcome.mockReturnValue('exists');

    ensureDatabaseAccount();

    expect(grailInstalled()).toBe(true);
  });
});
