import { describe, expect, it, vi } from 'vitest';
import { singleFlight } from '../singleFlight';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('singleFlight', () => {
  it('joins a call already in flight instead of starting another', async () => {
    const flight = singleFlight<string>();
    const work = deferred<string>();
    const start = vi.fn(() => work.promise);
    const onJoin = vi.fn();

    const first = flight.run(start, onJoin);
    const second = flight.run(start, onJoin);
    expect(flight.current).toBeDefined();
    work.resolve('done');

    expect(await Promise.all([first, second])).toEqual(['done', 'done']);
    expect(start).toHaveBeenCalledTimes(1);
    expect(onJoin).toHaveBeenCalledTimes(1);
  });

  it('starts afresh once the call has resolved', async () => {
    const flight = singleFlight<number>();
    const start = vi.fn(() => Promise.resolve(1));

    await flight.run(start);
    expect(flight.current).toBeUndefined();
    await flight.run(start);

    expect(start).toHaveBeenCalledTimes(2);
  });

  it('starts afresh once the call has rejected', async () => {
    const flight = singleFlight<number>();
    const start = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(new Error('first'))
      .mockResolvedValueOnce(2);

    await expect(flight.run(start)).rejects.toThrow('first');
    expect(flight.current).toBeUndefined();
    expect(await flight.run(start)).toBe(2);
  });

  it('hands a joiner the same rejection', async () => {
    const flight = singleFlight<number>();
    const work = deferred<number>();

    const first = flight.run(() => work.promise);
    const second = flight.run(() => Promise.resolve(0));
    work.reject(new Error('failed'));

    await expect(first).rejects.toThrow('failed');
    await expect(second).rejects.toThrow('failed');
  });
});
