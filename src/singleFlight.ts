/**
 * At most one call of something in flight in this window, shared by everyone
 * who asks while it runs.
 *
 * The first caller starts the work; a caller arriving before it settles joins
 * it and gets the same result, rejection included, instead of starting a
 * second copy. The slot empties when the work settles, so the next caller
 * starts afresh. Only the caller that started the work runs `start`, so
 * anything `start` reports — telemetry above all — is reported once.
 *
 * This is in-window only. Between windows, the locks in `lock.ts` decide.
 */
export interface SingleFlight<T> {
  /** Start `start` unless a call is already in flight; then join that one. */
  run(start: () => Promise<T>, onJoin?: () => void): Promise<T>;
  /** The call in flight, if any. */
  readonly current: Promise<T> | undefined;
}

export function singleFlight<T>(): SingleFlight<T> {
  let inFlight: Promise<T> | undefined;
  return {
    run(start, onJoin) {
      if (inFlight) {
        onJoin?.();
        return inFlight;
      }
      const run = start().finally(() => {
        if (inFlight === run) inFlight = undefined;
      });
      inFlight = run;
      return run;
    },
    get current() {
      return inFlight;
    },
  };
}
