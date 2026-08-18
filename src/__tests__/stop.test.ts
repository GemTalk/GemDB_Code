import { describe, expect, it } from 'vitest';
import { DB_PASSWORD, DB_USER, STONE_NAME, STOP_TIMEOUT_SECONDS } from '../config';
import { EngineProcess } from '../gslist';
import { StopWorld, runStop } from '../lifecycle';
import { isListening, isRunning, stopStoneArgs } from '../processes';

const stone: EngineProcess = {
  type: 'stone',
  name: 'gemdb',
  version: '3.7.5',
  pid: 101,
  status: 'OK',
  responding: true,
};

const netldi: EngineProcess = {
  type: 'netldi',
  name: 'gemdbldi',
  version: '3.7.5',
  pid: 102,
  port: 59327,
  status: 'OK',
  responding: true,
};

/**
 * A stand-in database that records what was asked of it.
 *
 * The order of the calls is the thing under test — logging out before the
 * stone is asked to stop, and never forcing without an answer — so the fake
 * keeps a transcript rather than a set of spies.
 */
function makeWorld(options: {
  stoneUp?: boolean;
  listenerUp?: boolean;
  /** Refuse an unforced stop, the way stopstone does while a session is logged in. */
  stoneRefuses?: boolean;
  /** Fail the stop but go down anyway, the way a timeout does. */
  stoneStopsLate?: boolean;
  confirm?: boolean;
}): { calls: string[]; world: StopWorld } {
  let stoneUp = options.stoneUp ?? true;
  let listenerUp = options.listenerUp ?? true;
  const calls: string[] = [];

  const world: StopWorld = {
    logout: () => calls.push('logout'),
    stoneUp: () => stoneUp,
    listenerUp: () => listenerUp,
    stopStone: (force: boolean) => {
      calls.push(`stopStone(${force})`);
      if (options.stoneStopsLate && !force) {
        stoneUp = false;
        return Promise.reject(new Error('timed out waiting for the stone to stop'));
      }
      if (options.stoneRefuses && !force) {
        return Promise.reject(new Error('sessions are still logged in'));
      }
      stoneUp = false;
      return Promise.resolve();
    },
    stopNetldi: () => {
      calls.push('stopNetldi');
      listenerUp = false;
      return Promise.resolve();
    },
    startNetldi: () => {
      calls.push('startNetldi');
      listenerUp = true;
      return Promise.resolve();
    },
    confirmForce: () => {
      calls.push('confirmForce');
      return Promise.resolve(options.confirm ?? false);
    },
    log: () => {},
  };

  return { calls, world };
}

describe('runStop', () => {
  it('drops GemDB’s own session first, and stops the listener before the stone', async () => {
    const { calls, world } = makeWorld({});
    await runStop(world);
    expect(calls).toEqual(['logout', 'stopNetldi', 'stopStone(false)']);
  });

  it('never forces without being asked', async () => {
    const { calls, world } = makeWorld({ stoneRefuses: true, confirm: false });
    await runStop(world);
    expect(calls).not.toContain('stopStone(true)');
  });

  it('puts the listener back when the user declines, rather than leaving it half stopped', async () => {
    const { calls, world } = makeWorld({ stoneRefuses: true, confirm: false });
    await runStop(world);
    expect(calls).toEqual([
      'logout',
      'stopNetldi',
      'stopStone(false)',
      'confirmForce',
      'startNetldi',
    ]);
  });

  it('forces only after the user confirms', async () => {
    const { calls, world } = makeWorld({ stoneRefuses: true, confirm: true });
    await runStop(world);
    expect(calls).toEqual([
      'logout',
      'stopNetldi',
      'stopStone(false)',
      'confirmForce',
      'stopStone(true)',
    ]);
  });

  it('does not offer to force a stone that went down during the timeout', async () => {
    const { calls, world } = makeWorld({ stoneStopsLate: true });
    await runStop(world);
    expect(calls).toEqual(['logout', 'stopNetldi', 'stopStone(false)']);
    expect(calls).not.toContain('confirmForce');
  });

  it('asks nothing of a database that is already down', async () => {
    const { calls, world } = makeWorld({ stoneUp: false, listenerUp: false });
    await runStop(world);
    expect(calls).toEqual(['logout']);
  });

  it('still clears a listener left behind by a stone that is already down', async () => {
    const { calls, world } = makeWorld({ stoneUp: false, listenerUp: true });
    await runStop(world);
    expect(calls).toEqual(['logout', 'stopNetldi']);
  });
});

describe('isRunning', () => {
  // The regression this exists for: a refused stop leaves the listener down and
  // the stone up, and the old "stone AND listener" test called that "stopped" —
  // hiding the Stop button while the database was still running.
  it('calls a database with no listener running', () => {
    expect(isRunning([stone])).toBe(true);
    expect(isListening([stone])).toBe(false);
  });

  it('calls a listener with no stone stopped', () => {
    expect(isRunning([netldi])).toBe(false);
    expect(isListening([netldi])).toBe(true);
  });

  it('calls an empty process list stopped', () => {
    expect(isRunning([])).toBe(false);
    expect(isListening([])).toBe(false);
  });

  it('ignores another installation’s stone', () => {
    expect(isRunning([{ ...stone, name: 'gs375' }])).toBe(false);
  });
});

describe('stopStoneArgs', () => {
  it('puts every flag before the stone name, where stopstone reads them as flags', () => {
    // After the name they would be taken for the account and password, and the
    // stop would fail in a way that looks like bad credentials.
    const args = stopStoneArgs(true);
    expect(args.slice(0, args.indexOf(STONE_NAME))).toEqual(['-i', '-t', '10']);
    expect(args.slice(args.indexOf(STONE_NAME))).toEqual([STONE_NAME, DB_USER, DB_PASSWORD]);
  });

  it('leaves -i off unless forced, so no stop disconnects anyone unasked', () => {
    expect(stopStoneArgs(false)).not.toContain('-i');
  });

  it('always bounds the wait, so a stop cannot hang forever', () => {
    for (const args of [stopStoneArgs(false), stopStoneArgs(true)]) {
      const timeout = args[args.indexOf('-t') + 1];
      expect(Number(timeout)).toBe(STOP_TIMEOUT_SECONDS);
      expect(Number(timeout)).toBeGreaterThan(0);
    }
  });
});
