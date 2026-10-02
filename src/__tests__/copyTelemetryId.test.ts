import { beforeEach, describe, expect, it } from 'vitest';
import { __clipboard, __commands, __resetSettings } from '../__mocks__/vscode';
import { fakeExtensionContext } from './telemetryTestSupport';

const { registerCopyTelemetryIdCommand } = await import('../telemetry');

beforeEach(() => {
  __resetSettings();
  __clipboard.text = '';
});

describe('gemdb.copyTelemetryId', () => {
  it('copies the machine ID to the clipboard', async () => {
    const context = fakeExtensionContext();

    registerCopyTelemetryIdCommand(context);

    expect(context.subscriptions).toHaveLength(1);
    await __commands.get('gemdb.copyTelemetryId')?.();
    expect(__clipboard.text).toBe('fake-machine-id');
  });
});
