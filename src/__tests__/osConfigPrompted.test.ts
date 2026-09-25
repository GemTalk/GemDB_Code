import { describe, expect, it } from 'vitest';
import { eventsNamed, fakeExtensionContext } from './telemetryTestSupport';

// `osConfigPrompted` failures are deduped by a module-level set in
// telemetry.ts that only a successful configure or a database start clears —
// exactly as in a real window. The phases below share that set, so they run
// as one sequence rather than as separate tests that would each need it reset.
// Constants on the act side, literals on the assert side, so a renamed wire
// value fails here rather than silently splitting a series in App Insights.
const {
  DATABASE_OUTCOME,
  FILED_GRAIL,
  OS_CONFIG_MISSING,
  OS_CONFIG_OUTCOME,
  TRIGGER,
  initTelemetry,
  reportDatabaseStarted,
  reportOsConfigPrompted,
} = await import('../telemetry');

const sent = (): Record<string, unknown>[] =>
  eventsNamed('osConfigPrompted').map((e) => e.properties as Record<string, unknown>);

describe('osConfigPrompted', () => {
  it('sends a failure once per trigger, outcome and missing until configured or started', () => {
    initTelemetry(fakeExtensionContext(), false);
    const { declined, stillUnconfigured, configured } = OS_CONFIG_OUTCOME;
    const { sharedMemory, both } = OS_CONFIG_MISSING;

    // A user who keeps declining sees the modal every batch, but it is sent once.
    reportOsConfigPrompted(TRIGGER.notebook, declined, sharedMemory);
    reportOsConfigPrompted(TRIGGER.notebook, declined, sharedMemory);
    reportOsConfigPrompted(TRIGGER.notebook, declined, sharedMemory);
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toMatchObject({
      trigger: 'notebook',
      outcome: 'declined',
      missing: 'sharedMemory',
    });

    // Another trigger is its own report; alternating between them adds nothing,
    // because the set remembers every key, not only the last.
    reportOsConfigPrompted(TRIGGER.startCommand, declined, sharedMemory);
    reportOsConfigPrompted(TRIGGER.notebook, declined, sharedMemory);
    reportOsConfigPrompted(TRIGGER.startCommand, declined, sharedMemory);
    expect(sent()).toHaveLength(2);
    expect(sent()[1]).toMatchObject({ trigger: 'startCommand' });

    // A different `missing` is a different state, so it is reported.
    reportOsConfigPrompted(TRIGGER.notebook, declined, both);
    expect(sent()).toHaveLength(3);
    expect(sent()[2]).toMatchObject({ missing: 'both' });

    // The explicit command is exempt: each run is a sudo attempt the user asked for.
    reportOsConfigPrompted(TRIGGER.sharedMemoryCommand, stillUnconfigured, sharedMemory);
    reportOsConfigPrompted(TRIGGER.sharedMemoryCommand, stillUnconfigured, sharedMemory);
    expect(sent()).toHaveLength(5);
    expect(sent()[4]).toMatchObject({
      trigger: 'sharedMemoryCommand',
      outcome: 'stillUnconfigured',
    });

    // Success is always sent, and clears the set.
    reportOsConfigPrompted(TRIGGER.sharedMemoryCommand, configured, sharedMemory);
    expect(sent()).toHaveLength(6);
    expect(sent()[5]).toMatchObject({ outcome: 'configured' });
    reportOsConfigPrompted(TRIGGER.notebook, declined, sharedMemory);
    expect(sent()).toHaveLength(7);

    // So does the database starting, e.g. after shared memory was raised outside GemDB.
    reportOsConfigPrompted(TRIGGER.notebook, declined, sharedMemory);
    expect(sent()).toHaveLength(7);
    reportDatabaseStarted(TRIGGER.notebook, DATABASE_OUTCOME.started, FILED_GRAIL.no, 1, true);
    reportOsConfigPrompted(TRIGGER.notebook, declined, sharedMemory);
    expect(sent()).toHaveLength(8);
  });
});
