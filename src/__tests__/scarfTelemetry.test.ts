import { describe, expect, it } from 'vitest';
import { FAKE_EVENT_NAME_PREFIX } from '../__mocks__/vscode';
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
