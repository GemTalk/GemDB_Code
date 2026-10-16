import * as https from 'https';

const TIMEOUT_MS = 3000;

/** Where a Scarf request leaves the process. */
export interface ScarfTransport {
  get(url: string): void;
}

/**
 * The real network, kept to a module of its own so no test can reach it:
 * `src/__mocks__/setup.ts` swaps this module for a recorder in every test
 * file, and only `scarfTransport.test.ts` asks for the real one.
 *
 * Fire-and-forget: no retry, no queue, and nothing here can throw into the
 * caller. A lost event is cheaper than a slow or failing activation.
 * `https.get` rather than `fetch` because VS Code's proxy support patches
 * Node's `https` on every version GemDB supports.
 */
export const scarfTransport: ScarfTransport = {
  get(url) {
    try {
      const request = https.get(url, { timeout: TIMEOUT_MS }, (res) => res.resume());
      request.on('timeout', () => request.destroy());
      request.on('error', () => {
        /* fire-and-forget: a lost event is not worth a retry or a message */
      });
    } catch {
      // `https.get` can also throw before a request exists — a proxy agent
      // rejecting a malformed setting, say — and VS Code does not catch what
      // a sender throws, so it would reach `activate()`.
    }
  },
};
