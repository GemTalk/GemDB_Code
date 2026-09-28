import * as fs from 'fs';
import * as path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import { __resetSettings, __telemetry } from '../__mocks__/vscode';
import { GEMDB_STATE } from '../statusView';
import {
  DATABASE_OUTCOME,
  EVENT,
  EVIDENCE,
  FILED_GRAIL,
  INSTALL_DAY_SOURCE,
  OS_CONFIG_MISSING,
  OS_CONFIG_OUTCOME,
  SETUP_OUTCOME,
  SKIP_REASON,
  SURFACE,
  TRIGGER,
  initTelemetry,
  reportActivation,
  reportDatabaseStarted,
  reportOsConfigPrompted,
  reportPythonUsed,
  reportSetupFinished,
  reportSetupStarted,
  reportUnattendedSetupSkipped,
} from '../telemetry';
import { fakeExtensionContext } from './telemetryTestSupport';

// docs/telemetry.md is how people who read the data learn what an event
// means, so it has to keep up with telemetry.ts. This catches an event,
// property or value added in code and not in the doc. It cannot catch a
// changed meaning; `.claude/rules/telemetry.md` asks for that by hand.
// `extensionMode`'s values come from VS Code's own enum rather than a
// constant here, so only its name is checked.

const DOC_PATH = path.resolve(__dirname, '../../docs/telemetry.md');
const doc = fs.readFileSync(DOC_PATH, 'utf8');
const headings = doc.split('\n').filter((line) => line.startsWith('### '));

const VALUE_SETS = {
  TRIGGER,
  GEMDB_STATE,
  INSTALL_DAY_SOURCE,
  SKIP_REASON,
  SETUP_OUTCOME,
  OS_CONFIG_OUTCOME,
  OS_CONFIG_MISSING,
  DATABASE_OUTCOME,
  FILED_GRAIL,
  SURFACE,
  EVIDENCE,
};

/** Every property and measure name the real `report*` functions send, common.* aside. */
const sentFieldNames = new Set<string>();

beforeAll(() => {
  __resetSettings();
  initTelemetry(fakeExtensionContext(), false);

  reportActivation(1, GEMDB_STATE.running);
  reportUnattendedSetupSkipped(SKIP_REASON.cancelledBefore);
  reportSetupStarted(TRIGGER.firstRun);
  reportSetupFinished(TRIGGER.firstRun, SETUP_OUTCOME.completed, 1);
  reportOsConfigPrompted(TRIGGER.firstRun, OS_CONFIG_OUTCOME.configured, OS_CONFIG_MISSING.both);
  reportDatabaseStarted(TRIGGER.autoStart, DATABASE_OUTCOME.started, FILED_GRAIL.no, 1, true);
  reportPythonUsed(SURFACE.notebook, EVIDENCE.executed);

  for (const event of __telemetry) {
    for (const name of Object.keys(event.properties)) {
      if (!name.startsWith('common.')) sentFieldNames.add(name);
    }
    for (const name of Object.keys(event.measurements ?? {})) sentFieldNames.add(name);
  }
});

describe('docs/telemetry.md', () => {
  it('gives every event a section of its own', () => {
    const undocumented = Object.values(EVENT).filter(
      (name) => !headings.some((heading) => heading.includes(`\`${name}\``)),
    );

    expect(undocumented, `add a "### \`name\`" section to ${DOC_PATH}`).toEqual([]);
  });

  it('describes every property and measure an event carries', () => {
    const exercised = new Set(__telemetry.map((e) => e.name));
    const undocumented = [...sentFieldNames].filter((name) => !doc.includes(`\`${name}\``));

    expect([...exercised].sort()).toEqual(Object.values(EVENT).sort());
    expect(undocumented, `document these in ${DOC_PATH}`).toEqual([]);
  });

  it('lists every value a property can take', () => {
    const undocumented = Object.entries(VALUE_SETS).flatMap(([set, values]) =>
      Object.values(values)
        .filter((value) => !doc.includes(`\`${value}\``))
        .map((value) => `${set}.${value}`),
    );

    expect(undocumented, `document these in ${DOC_PATH}`).toEqual([]);
  });
});
