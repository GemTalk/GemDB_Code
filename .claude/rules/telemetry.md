---
description: Keep the human-facing telemetry docs in step with the telemetry code.
paths:
  - 'src/telemetry.ts'
  - 'docs/telemetry.md'
  - 'USAGE_DATA.md'
---

# Telemetry docs

Two documents describe `src/telemetry.ts` to people who never read it:

- `docs/telemetry.md` — every event, when it fires, how often, and what each
  property and value means. Written for a product owner reading the data.
- `USAGE_DATA.md` — the privacy notice users see. It names categories, not
  events.

Any change to an event, a property, a value, or **when or how often** an event
is sent updates `docs/telemetry.md` in the same commit. `telemetryDocs.test.ts`
catches a missing name or value; it cannot catch a changed meaning or cadence,
so check the prose by hand. A new event also needs a call in that test's
`beforeAll`, or it fails.

Change `USAGE_DATA.md` too, and move its "Last updated" date, when what is
collected changes in kind — a new category of data, a new common property, a
change to storage or retention. A new event of an existing kind does not need
it.

Keep `docs/telemetry.md` plain: no function names, no internals. Say what the
user did, not which code path ran.
