import { describe, expect, it } from 'vitest';
import { GrailInstallFailure } from '../grail';
import { STAMP_ORDER } from '../stamps';
import { pythonRow, runningRow } from '../statusView';

/**
 * The status view's two rows about Python, decided without a database.
 *
 * What these guard is the state that used to look healthy: a failed Python
 * install leaves the stone and listener up, and the file-in has already removed
 * the stamp, so both rows read exactly as they do on a fresh install. Once
 * the notification was dismissed nothing said anything was wrong.
 */

const BUNDLED = 'grail=0.1-2200-gnew\ncommit=new\nengine=4.0.0.a3';
const OLDER = 'grail=0.1-2100-gold\ncommit=old\nengine=4.0.0.a3';
const NEWER = 'grail=0.1-2300-gnewer\ncommit=newer\nengine=4.0.0.a3';

const failure: GrailInstallFailure = {
  stamp: BUNDLED,
  at: '2026-09-28T12:00:00.000Z',
  message: 'Installing Python support failed (exit code 1). See the GemDB output for the full log.',
};

describe('the Python row', () => {
  it('says the install failed, and shows why', () => {
    const row = pythonRow({
      installed: undefined,
      bundled: BUNDLED,
      order: STAMP_ORDER.older,
      failure,
      running: true,
    });

    expect(row.description).toBe('install failed — see the GemDB output');
    expect(row.tooltip).toContain('exit code 1');
    expect(row.icon?.id).toBe('error');
  });

  it('retries the install when the database is running', () => {
    const row = pythonRow({
      installed: undefined,
      bundled: BUNDLED,
      order: STAMP_ORDER.older,
      failure,
      running: true,
    });

    expect(row.command?.command).toBe('gemdb.reinstallPython');
  });

  it('starts the database when it is stopped, since starting retries the install', () => {
    const row = pythonRow({
      installed: undefined,
      bundled: BUNDLED,
      order: STAMP_ORDER.older,
      failure,
      running: false,
    });

    expect(row.command?.command).toBe('gemdb.start');
    expect(row.tooltip).toContain('tries again the next time it starts');
  });

  it('reports a failed update as a failure, not as a first install', () => {
    // A failed update is recorded against the new build, and the old stamp
    // may or may not have survived; either way the row must not say Python
    // is waiting to be installed for the first time.
    const row = pythonRow({
      installed: OLDER,
      bundled: BUNDLED,
      order: STAMP_ORDER.older,
      failure,
      running: true,
    });

    expect(row.description).toBe('install failed — see the GemDB output');
  });

  it('waits for the first run when nothing has been attempted', () => {
    const row = pythonRow({
      installed: undefined,
      bundled: BUNDLED,
      order: STAMP_ORDER.older,
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
      order: STAMP_ORDER.same,
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
      order: STAMP_ORDER.older,
      failure: undefined,
      running: true,
    });

    expect(row.description).toBe('0.1-2100-gold — update available');
    expect(row.command?.command).toBe('gemdb.reinstallPython');
  });

  it('offers to replace a different build recorded at the same GemDB version', () => {
    const row = pythonRow({
      installed: OLDER,
      bundled: BUNDLED,
      order: STAMP_ORDER.sameVersionDifferent,
      failure: undefined,
      running: true,
    });

    expect(row.description).toBe('0.1-2100-gold — update available');
  });

  it('leaves alone, and offers nothing for, a build a newer GemDB installed', () => {
    // Another editor on the same root path runs a newer GemDB. Reinstalling
    // from here would downgrade what it filed in.
    const row = pythonRow({
      installed: `${NEWER}\nextension=1.7.0`,
      bundled: BUNDLED,
      order: STAMP_ORDER.newer,
      failure: undefined,
      running: true,
    });

    expect(row.description).toBe('0.1-2300-gnewer — installed by a newer GemDB');
    expect(row.tooltip).toContain('GemDB 1.7.0');
    expect(row.command).toBeUndefined();
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
