/**
 * Stands in for `src/scarfTransport.ts` in every test file, unit and integration, via
 * `src/__mocks__/setup.ts`, so no test can send a request to Scarf's real
 * gateway — `fakeExtensionContext` is a Production context, which is the
 * mode Scarf is sent from. Records each URL instead, for the suites that
 * assert on what Scarf would receive.
 */
import type { ScarfTransport } from '../scarfTransport';

/** Every URL sent to Scarf, in order. */
export const __scarfRequests: string[] = [];

export const scarfTransport: ScarfTransport = {
  get(url) {
    __scarfRequests.push(url);
  },
};
