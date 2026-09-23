# Telemetry events

What GemDB reports, and when. For what is collected overall, how it is stored,
and how users turn it off, see [USAGE_DATA.md](../USAGE_DATA.md).

Events go to Azure Application Insights and are kept for 90 days. Nothing is
sent when a user sets VS Code's `telemetry.telemetryLevel` to `off`.

## The journey the events describe

A new user's first session usually sends these in order:

1. `activated`, when VS Code loads the extension.
2. `setupStarted` and `setupFinished`, around the download. `osConfigPrompted`
   arrives during the download if the machine needs a setting changed. If
   setup does not start by itself, `unattendedSetupSkipped` says why.
3. `databaseStarted`, when the database comes up.
4. `pythonUsed`, when they run their first Python.

A user who already has GemDB installed skips step 2.

There are no "first time" events. To find when a machine first did something,
take the earliest event of that kind for its `common.vscodemachineid`.

## On every event

| Property          | Values                                     | Meaning                                                                           |
| ----------------- | ------------------------------------------ | --------------------------------------------------------------------------------- |
| `extensionMode`   | `production`, `development`, `test`        | Only `production` is a real user. Filter out the others in every report.          |
| `installDay`      | a date, e.g. `2026-09-15`                   | Roughly when GemDB was first used on this machine.                                |
| `installDaySource` | `firstSeen`, `reinstall`                   | `reinstall`: GemDB was reinstalled but the user's database was still there.        |

VS Code adds its own `common.*` properties too (machine id, OS, VS Code
version, extension version). [USAGE_DATA.md](../USAGE_DATA.md) lists them.

## What caused it: `trigger`

Several events carry `trigger`, which records what the user did to cause it:

| Value                 | The user…                                               |
| --------------------- | ------------------------------------------------------- |
| `firstRun`            | installed the extension; setup ran by itself            |
| `autoStart`           | opened VS Code; the database started by itself          |
| `installCommand`      | ran **GemDB: Set Up GemDB**                                  |
| `startCommand`        | ran **GemDB: Start GemDB**                               |
| `sharedMemoryCommand` | ran **GemDB: Configure Shared Memory**                  |
| `notebook`            | ran a notebook cell                                     |
| `shell`               | ran **GemDB: Open GemDB Shell**                         |
| `runFile`             | ran **GemDB: Run Python File in GemDB**                 |
| `mcp`                 | connected an AI agent through the MCP server            |

## The events

### `activated`

The extension started in a VS Code window. Sent once per window, so it is the
starting count for the funnel.

| Property / measure | Values                                                  |
| ------------------ | ------------------------------------------------------- |
| `state`            | `notInstalled`, `stopped`, `running`, `unsupportedPlatform` |
| `activationMs`     | how long startup took, in milliseconds                  |

### `unattendedSetupSkipped`

GemDB is not installed, and the automatic first-run setup did not run in this
window. Sent at most once per window, and only while GemDB is not installed.

| `skipReason`             | Meaning                                                                   |
| ------------------------ | ------------------------------------------------------------------------- |
| `markerPresent`          | Setup was already offered once and the user cancelled it. They have to resume it themselves. Repeats each time they open VS Code, so it shows how long users stay stuck. |
| `remoteWindow`           | A remote or browser window, which is not the machine GemDB would set up.  |
| `lockHeld`               | Another VS Code window is running setup.                                  |
| `installedByOtherWindow` | Another window finished setup while this one waited.                      |

### `setupStarted` and `setupFinished`

Setup downloads and unpacks the database (about 210 MB). `setupStarted` is sent
every time it begins, `setupFinished` when it ends. A cancel followed by a
Resume counts as two attempts.

A `setupStarted` with no `setupFinished` after it means the user closed VS Code
during the download, which is the drop-out this pair measures.

| Property / measure | Values                              |
| ------------------ | ----------------------------------- |
| `trigger`          | see above                           |
| `outcome`          | `completed`, `cancelled`, `failed` (`setupFinished` only) |
| `durationMs`       | how long setup took (`setupFinished` only) |

### `osConfigPrompted`

GemDB asked for permission to change an operating system setting, which needs
the user's password. On first run the question comes up while the download is
still going. Sent only when the dialog actually appeared, or when the user ran
**GemDB: Configure Shared Memory** while shared memory was still too low.

| Property  | Values                                                                        |
| --------- | ----------------------------------------------------------------------------- |
| `trigger` | see above                                                                     |
| `missing` | what needed changing: `sharedMemory`, `removeIpc` (Linux only), or `both`     |
| `outcome` | `configured`: it worked.<br>`declined`: the user said no.<br>`stillUnconfigured`: shared memory is still too low, so the database cannot start.<br>`removeIpcUnset`: the database starts, but will stop when the user logs out. |

### `databaseStarted`

The database was brought up, or failed to come up. Sent only when something
actually happened. Running a cell when the database is already up sends
nothing, and the same failure is not sent twice in a row.

| Property / measure | Values                                                                                                                              |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `trigger`          | see above                                                                                                                           |
| `outcome`          | `started`, or why not: `setupCancelled`, `setupFailed`, `osConfigDeclined`, `startFailed`, `unsupportedPlatform`, `missingPayload` (the extension package is broken) |
| `filedGrail`       | whether Python support was installed into the database this time: `no`, `firstTime`, `update`                                       |
| `durationMs`       | how long it took                                                                                                                    |

### `pythonUsed`

The user ran Python, the last step of the journey. Sent at most once per window
for each place Python can run, so at most three per window.

| Property / measure      | Values                                                                                                   |
| ----------------------- | -------------------------------------------------------------------------------------------------------- |
| `surface`               | `notebook`, `shell`, `runFile`                                                                           |
| `evidence`              | `executed`: code ran and a result came back (notebooks).<br>`launched`: a terminal was opened, but GemDB cannot see whether anything was typed into it (shell, run file). |
| `minutesSinceFirstSeen` | minutes since GemDB was first seen on this machine                                                       |

## Changing this document

It must match `src/telemetry.ts`. Change the two together. A unit test
(`src/__tests__/telemetryDocs.test.ts`) fails if an event, property or value in
the code is missing here.
