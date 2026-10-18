import { platform } from 'os';
import { describe, expect, it, vi } from 'vitest';
import { ExtensionMode, FAKE_EVENT_NAME_PREFIX } from '../__mocks__/vscode';
import { GEMDB_STATE } from '../statusView';
import { ScarfSender, scarfUrl } from '../telemetry';

/** The query parameters of a Scarf request, decoded. */
function paramsOf(url: string): Record<string, string> {
  return Object.fromEntries(new URL(url).searchParams);
}

describe('scarfUrl', () => {
  it('sends GemDB properties and measures, and the allowlisted common properties', () => {
    const url = scarfUrl('databaseStarted', {
      trigger: 'notebook',
      durationMs: 1234,
      'common.extversion': '1.6.0',
      'common.os': 'darwin',
      'common.vscodeversion': '1.105.0',
      'common.remotename': 'ssh-remote',
    });

    expect(url.startsWith('https://gemdb.gateway.scarf.sh/gemdb/code/telemetry?')).toBe(true);
    expect(paramsOf(url)).toEqual({
      event: 'databaseStarted',
      trigger: 'notebook',
      durationMs: '1234',
      'common.extversion': '1.6.0',
      'common.os': 'darwin',
      'common.vscodeversion': '1.105.0',
      'common.remotename': 'ssh-remote',
    });
  });

  it('puts the event first', () => {
    const url = scarfUrl('activated', { state: 'running' });

    expect(new URL(url).search).toBe('?event=activated&state=running');
  });

  it('drops every other common property, the machine id included', () => {
    const params = paramsOf(
      scarfUrl('activated', {
        'common.vscodemachineid': 'machine',
        'common.vscodesessionid': 'session',
        'common.uikind': 'desktop',
      }),
    );

    expect(params).toEqual({ event: 'activated' });
  });

  it('drops undefined values', () => {
    const params = paramsOf(scarfUrl('activated', { 'common.remotename': undefined }));

    expect(params).toEqual({ event: 'activated' });
  });

  it('encodes values', () => {
    const url = scarfUrl('activated', { appName: 'Visual Studio Code', note: 'a&b=c' });

    expect(url).toContain('appName=Visual%20Studio%20Code');
    expect(paramsOf(url)).toMatchObject({ appName: 'Visual Studio Code', note: 'a&b=c' });
  });
});

describe('ScarfSender', () => {
  it('sends each event once, named without the extension id VS Code adds', () => {
    const urls: string[] = [];
    const sender = new ScarfSender({ get: (url) => urls.push(url) });

    sender.sendEventData(`${FAKE_EVENT_NAME_PREFIX}activated`, { state: 'running' });

    expect(urls).toHaveLength(1);
    expect(paramsOf(urls[0])).toEqual({ event: 'activated', state: 'running' });
  });
});

describe('sending to Scarf', () => {
  // Each case gets a fresh telemetry.ts, so `pythonUsed`'s once-per-surface
  // memory starts empty — and fresh mocks with it, which is why the recorders
  // are re-imported alongside.
  async function freshTelemetry(mode: number) {
    vi.resetModules();
    const telemetry = await import('../telemetry');
    const support = await import('./telemetryTestSupport');
    const { __scarfRequests } = await import('../__mocks__/scarfTransport');
    const { __telemetry } = await import('../__mocks__/vscode');
    const context = support.fakeExtensionContext();
    Object.assign(context, { extensionMode: mode });
    telemetry.initTelemetry(context, false);
    return { telemetry, scarfRequests: __scarfRequests, appInsights: __telemetry };
  }

  it('sends every event from a real install to both sinks', async () => {
    const { telemetry, scarfRequests, appInsights } = await freshTelemetry(
      ExtensionMode.Production,
    );

    telemetry.reportActivation(42, GEMDB_STATE.running);

    expect(scarfRequests).toHaveLength(1);
    expect(paramsOf(scarfRequests[0])).toMatchObject({
      event: 'activated',
      state: 'running',
      activationMs: '42',
      extensionMode: 'production',
      'common.os': platform(),
    });
    expect(paramsOf(scarfRequests[0])).not.toHaveProperty('common.fake');
    expect(appInsights.map((e) => e.name)).toEqual(['activated']);
  });

  it.each([
    ['a development host', ExtensionMode.Development],
    ['a test run', ExtensionMode.Test],
  ])('sends nothing to Scarf from %s', async (_label, mode) => {
    const { telemetry, scarfRequests, appInsights } = await freshTelemetry(mode);

    telemetry.reportActivation(42, GEMDB_STATE.running);

    expect(scarfRequests).toEqual([]);
    expect(appInsights.map((e) => e.name)).toEqual(['activated']);
  });

  it('sends measures as strings', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { telemetry, scarfRequests } = await freshTelemetry(ExtensionMode.Production);
    vi.setSystemTime(Date.now() + 5 * 60_000);

    telemetry.reportPythonUsed(telemetry.SURFACE.notebook, telemetry.EVIDENCE.executed);
    vi.useRealTimers();

    expect(paramsOf(scarfRequests[0])).toMatchObject({
      event: 'pythonUsed',
      minutesSinceFirstSeen: '5',
    });
  });
});
