import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** A request as `https.get` returns one: something to listen on and destroy. */
class FakeRequest extends EventEmitter {
  destroy = vi.fn();
}

const requests = vi.hoisted(() => ({
  urls: [] as string[],
  last: undefined as unknown,
  throwOnGet: undefined as Error | undefined,
}));
vi.mock('https', () => ({
  get: (url: string) => {
    if (requests.throwOnGet) throw requests.throwOnGet;
    requests.urls.push(url);
    const request = new FakeRequest();
    requests.last = request;
    return request;
  },
}));

// setup.ts replaces this module with a recorder for every test file; this is
// the one suite that exercises the real one, with `https` mocked above.
const { scarfTransport } =
  await vi.importActual<typeof import('../scarfTransport')>('../scarfTransport');

const EVENT_URL = 'https://gemdb.gateway.scarf.sh/gemdb/code/telemetry?event=activated';

beforeEach(() => {
  requests.urls.length = 0;
  requests.last = undefined;
  requests.throwOnGet = undefined;
});

describe('the Scarf transport', () => {
  it('issues one GET for each event', () => {
    scarfTransport.get(EVENT_URL);

    expect(requests.urls).toEqual([EVENT_URL]);
  });

  it('does not throw when the request fails', () => {
    scarfTransport.get(EVENT_URL);
    const request = requests.last as FakeRequest;

    expect(() => request.emit('error', new Error('ECONNREFUSED'))).not.toThrow();
  });

  it('does not throw when a request cannot even be made', () => {
    requests.throwOnGet = new TypeError('Invalid proxy URL');

    expect(() => scarfTransport.get(EVENT_URL)).not.toThrow();
  });

  it('gives up on a request that times out', () => {
    scarfTransport.get(EVENT_URL);
    const request = requests.last as FakeRequest;

    request.emit('timeout');

    expect(request.destroy).toHaveBeenCalled();
  });
});
