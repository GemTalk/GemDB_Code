import { describe, expect, it } from 'vitest';
import { GrailInstallFailure } from '../grail';
import { pythonRow, runningRow } from '../statusView';

/**
 * The status view's two rows about Python, decided without a database.
 *
 * What these guard is the state that used to look healthy: a failed Python
 * install leaves the stone and listener up, and staging has already deleted
 * the stamp, so both rows read exactly as they do on a fresh install. Once
 * the notification was dismissed nothing said anything was wrong.
 */

const BUNDLED = 'grail=0.1-2200-gnew\ncommit=new\nengine=4.0.0.a3';
const OLDER = 'grail=0.1-2100-gold\ncommit=old\nengine=4.0.0.a3';

const failure: GrailInstallFailure = {
  stamp: BUNDLED,
  at: '2026-09-28T12:00:00.000Z',
  message: 'Installing Python support failed (exit code 1). See the GemDB output for the full log.',
};

describe('the Python row', () => {
  it('says the install failed, and shows why', () => {
    const row = pythonRow({ installed: undefined, bundled: BUNDLED, failure, running: true });

    expect(row.description).toBe('install failed — see the GemDB output');
    expect(row.tooltip).toContain('exit code 1');
    expect(row.icon?.id).toBe('error');
  });

  it('retries the install when the database is running', () => {
    const row = pythonRow({ installed: undefined, bundled: BUNDLED, failure, running: true });

    expect(row.command?.command).toBe('gemdb.reinstallPython');
  });

  it('starts the database when it is stopped, since starting retries the install', () => {
    const row = pythonRow({ installed: undefined, bundled: BUNDLED, failure, running: false });

    expect(row.command?.command).toBe('gemdb.start');
    expect(row.tooltip).toContain('tries again the next time it starts');
  });

  it('reports a failed update as a failure, not as a first install', () => {
    // A failed update is recorded against the new build, and the old stamp
    // may or may not have survived; either way the row must not say Python
    // is waiting to be installed for the first time.
    const row = pythonRow({ installed: OLDER, bundled: BUNDLED, failure, running: true });

    expect(row.description).toBe('install failed — see the GemDB output');
  });

  it('waits for the first run when nothing has been attempted', () => {
    const row = pythonRow({
      installed: undefined,
      bundled: BUNDLED,
      failure: undefined,
      running: true,
    });

    expect(row.description).toBe('installs when you first run Python');
    expect(row.command).toBeUndefined();
  });

  it('shows the installed version once an install has succeeded', () => {
    const row = pythonRow({
      installed: BUNDLED,
      bundled: BUNDLED,
      failure: undefined,
      running: true,
    });

    expect(row.description).toBe('0.1-2200-gnew');
    expect(row.icon?.id).toBe('symbol-namespace');
  });

  it('offers the update a newer extension ships', () => {
    const row = pythonRow({
      installed: OLDER,
      bundled: BUNDLED,
      failure: undefined,
      running: true,
    });

    expect(row.description).toBe('0.1-2100-gold — update available');
    expect(row.command?.command).toBe('gemdb.reinstallPython');
  });
});

describe('the Running row', () => {
  it('promises Python only when Python is there', () => {
    const row = runningRow({ listening: true, pythonFailed: false });

    expect(row.description).toBe('Python runs inside the database');
    expect(row.icon?.id).toBe('pass-filled');
  });

  it('says Python failed to install rather than that it runs', () => {
    const row = runningRow({ listening: true, pythonFailed: true });

    expect(row.description).toBe('Running, but Python support failed to install');
    expect(row.icon?.id).toBe('warning');
  });

  it('puts a listener that is down first, since then nothing can connect at all', () => {
    const row = runningRow({ listening: false, pythonFailed: true });

    expect(row.description).toBe('Running, but not accepting new sessions');
  });
});
