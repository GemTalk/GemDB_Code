import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { NewerGrail } from '../grail';

// "Reinstall the Python Execution Engine" beside a newer GemDB, in another
// editor on the same root path. Reinstalling from here would downgrade what
// that GemDB put in place, so the command refuses and says why. Everything
// that touches the machine is mocked, as in databaseStarted.test.ts.
vi.mock('../cli', () => ({ writeCliScripts: () => {}, ensureCliCurrent: () => true }));

const newerGrail = vi.fn((): NewerGrail | undefined => undefined);
const fileInGrail = vi.fn(async () => true);
vi.mock('../grail', () => ({
  grailLabel: () => 'grail 0.1',
  grailNeedsUpdate: () => false,
  newerGrail: () => newerGrail(),
  stageGrail: () => true,
  fileInGrail: () => fileInGrail(),
  bundledGrailStamp: () => 'grail=0.1-1-gabc\n',
}));

vi.mock('../paths', () => ({
  databaseExists: () => true,
  databasePath: () => '/db',
  enginePath: () => '/engine',
  grailInstalled: () => true,
  grailPath: () => '/grail',
  grailStagedOnDisk: () => true,
  mcpPath: () => '/mcp',
}));

vi.mock('../processes', () => ({
  listProcesses: () => [],
  findStone: () => true,
  findNetldi: () => true,
  isListening: () => true,
  isRunning: () => true,
}));

vi.mock('../platform', () => ({ isSupportedPlatform: () => true, setContext: () => {} }));

const { reinstallGrail } = await import('../lifecycle');

let showError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  newerGrail.mockReset().mockReturnValue(undefined);
  fileInGrail.mockClear();
  showError = vi.spyOn(vscode.window, 'showErrorMessage');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('reinstalling Python support', () => {
  it('refuses when a newer GemDB installed it, naming that version', async () => {
    newerGrail.mockReturnValue({ where: 'installed', version: '1.7.0' });

    await reinstallGrail('/ext');

    expect(fileInGrail).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledWith(
      "Python support was installed by GemDB 1.7.0, newer than this editor's GemDB. " +
        'Update GemDB here to reinstall.',
    );
  });

  it('refuses when a newer GemDB has staged it and not yet installed it', async () => {
    newerGrail.mockReturnValue({ where: 'staged', version: '1.7.0' });

    await reinstallGrail('/ext');

    expect(fileInGrail).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledWith(
      'A newer GemDB (1.7.0) has prepared Python support for this database. ' +
        'Update GemDB here to reinstall.',
    );
  });

  it('reinstalls when nothing newer is in place', async () => {
    await reinstallGrail('/ext');

    expect(fileInGrail).toHaveBeenCalledTimes(1);
  });
});
