# Telemetry events

What GemDB reports, and when. For what is collected overall, how it is stored,
and how users turn it off, see [USAGE_DATA.md](../USAGE_DATA.md).

Events go to Azure Application Insights, where they are kept for 90 days, and
to Scarf. Nothing is sent to either when a user sets VS Code's
`telemetry.telemetryLevel` to `off`.

Scarf receives the same events and properties, with three differences:

- Only real installs send to it, so everything in Scarf is production data.
  Events with an `extensionMode` of `development` or `test` go to Application
  Insights alone.
- Every value arrives as a string, measures included: `activationMs` is
  `"1234"`, not `1234`.
- Of VS Code's own `common.*` properties it gets only `common.extversion`,
  `common.os`, `common.vscodeversion` and `common.remotename`. There is no
  `common.vscodemachineid`, so Scarf cannot tell one installation's events
  from another's: count installs, or find a machine's first event, in
  Application Insights.

Scarf names the company behind each event from the IP address it arrives
from. In a remote window GemDB runs on the remote machine, so the event comes
from there: over SSH to a cloud machine, or in Codespaces, it reads as the
cloud provider (Amazon, Microsoft, Google) rather than the user's employer.
When counting companies, leave out events whose `common.remotename` is set.
WSL, and a Dev Container on the user's own machine, still send from that
machine, so this undercounts them slightly rather than miscounting.

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
| `appUriScheme`    | e.g. `vscode`, `vscode-insiders`, `cursor`, `windsurf` | Which editor GemDB runs in. Editors built on VS Code report the VS Code version they are based on in `common.vscodeversion`, so group by this before reading versions. Missing on events from 1.5.4 and earlier. |
| `appName`         | e.g. `Visual Studio Code`, `Cursor`        | The same editor, by its display name. Missing on events from 1.5.4 and earlier.   |

In a remote window (Dev Container, SSH, WSL), `appUriScheme` and `appName`
describe the editor on the user's desktop, not the remote machine, so a remote
window reports the same values as a local one. `common.remotename` says whether
the window was remote. When the editor runs in a web browser, as with
`code serve-web`, they describe that web version of the editor instead.

VS Code adds its own `common.*` properties too (machine id, OS, VS Code
version, extension version). [USAGE_DATA.md](../USAGE_DATA.md) lists them.

## What caused it: `trigger`

Several events carry `trigger`, which records what the user did to cause it:

| Value                 | The user…                                               |
| --------------------- | ------------------------------------------------------- |
| `firstRun`            | installed the extension; setup ran by itself            |
| `autoStart`           | opened VS Code; the database started by itself, or was already running and GemDB Code set up what it lacked (Python support, the NetLDI, the MCP server) |
| `installCommand`      | ran **GemDB: Set Up GemDB**                                  |
| `startCommand`        | ran **GemDB: Start GemDB**                               |
| `sharedMemoryCommand` | ran **GemDB: Configure Shared Memory**                  |
| `removeIpcCommand`    | ran **GemDB: Keep the Database Running After Logout**   |
| `notebook`            | ran a notebook cell                                     |
| `shell`               | ran **GemDB: Open GemDB Shell**                         |
| `runFile`             | ran **GemDB: Run Python File in GemDB**                 |
| `debugFile`           | ran **GemDB: Debug Python File in GemDB**               |
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
| `cancelledBefore`        | The unattended first run was cancelled, and no setup has completed since. The user has to resume it themselves. |
| `failedBefore`           | The unattended first run failed, for example on a network error, and no setup has completed since. It is not retried unasked. |
| `installedBefore`        | A setup completed on this machine and GemDB is no longer installed, without an uninstall — most often a changed root path or engine version. |
| `uninstalled`            | The user ran **GemDB: Uninstall**, and no setup has completed since. Unattended setup stays off. |
| `attemptedBefore`        | Setup was already offered once, by version 1.5.1 or earlier, which did not record how it ended. |
| `remoteWindow`           | A remote or browser window, which is not the machine GemDB would set up.  |
| `lockHeld`               | Another VS Code window is running setup.                                  |
| `installedByOtherWindow` | Another window finished setup while this one waited.                      |

The first five repeat each time the user opens VS Code until they install, so
they show how long users stay in each state.

They come from the unattended setup marker, which records the unattended first
run, an Uninstall, and a later completed setup replacing either. A setup the
user starts themselves that fails or is cancelled is not recorded there; see
`setupFinished`. Machines whose marker was written by 1.5.2 or earlier may still
carry a stale `cancelledBefore`, `failedBefore` or `attemptedBefore`, because
those releases never updated it after a later setup completed.

The five marker reasons also carry what is on disk at that moment. These
describe the files, not why they are there.

| Property         | Values                        | Meaning                                                  |
| ---------------- | ----------------------------- | -------------------------------------------------------- |
| `databaseOnDisk` | `true`, `false`               | The database's extent file exists.                       |
| `engineOnDisk`   | `none`, `current`, `other`    | `current` is the engine this version of GemDB installs; `other` is only an engine for this platform that it does not. |
| `grailOnDisk`    | `true`, `false`               | Python support has been copied into place.               |

`skipReason` says why the unattended setup is off; these say what is left. Together
they separate cases that look alike:

- A marker reason with the database and an `other` engine, and no `current`
  one, is a database stranded by an engine version change.
- `failedBefore` with the database and a `current` engine but no Grail is an
  unattended first run that failed partway.
- `uninstalled` with only the database is an uninstall that kept the data.
- Nothing on disk with `installedBefore` is a changed root path, or files that
  were deleted.

Leftovers are not causes. Uninstall removes only the current engine, so older
engine directories survive it.

### `setupStarted` and `setupFinished`

Setup downloads and unpacks the database (about 170 MB on macOS, 470 MB on
Linux). `setupStarted` is sent every time it begins, `setupFinished` when it
ends. A cancel followed by a Resume counts as two attempts.

Setup runs once at a time per machine (#68). Asking for it while it is already
running in the same window — Set Up GemDB pressed during the first-run
download, say — joins the run under way and sends nothing of its own. Asking
for it while another window is running it waits for that window, and is
reported like any other attempt: `completed` if the other window finished, with
the wait counted in `durationMs`, or `cancelled` if the user stopped waiting.

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
still going. The dialog appears only when shared memory is too low; RemoveIPC
is added to it when that is unset too, but never raises it alone. Sent only
when the dialog actually appeared, when the user ran **GemDB: Configure Shared
Memory** while shared memory was still too low, or when they ran **GemDB: Keep
the Database Running After Logout** while RemoveIPC was unset. The dialog comes
back every time the database is needed until the user agrees, but a failure is
sent once for each trigger, outcome and `missing` until setup works or the
database next starts. That rule does not apply to either command: every run
made while the setting was still unchanged is sent. A request that arrives
while the dialog, or the shared-memory setup it started, is already under way
in the same window waits for it and sends nothing, so one dialog is one event,
carrying the trigger of whatever opened it. The command is not such a request:
run during the dialog's setup, **GemDB: Configure Shared Memory** shares its
terminal but sends its own event, and a dialog that comes up while the
command's setup is running is shown and sent as usual, its "Configure" joining
that terminal rather than opening a second one.

| Property  | Values                                                                        |
| --------- | ----------------------------------------------------------------------------- |
| `trigger` | see above                                                                     |
| `missing` | what needed changing: `sharedMemory`, `removeIpc` (Linux only, from the command), or `both` |
| `outcome` | `configured`: it worked.<br>`declined`: the user said no.<br>`stillUnconfigured`: shared memory is still too low, so the database cannot start.<br>`removeIpcUnset`: the database starts, but will stop when the user logs out. |

### `databaseStarted`

The database was brought up, or failed to come up. Sent only when something
actually happened. Running a cell when the database is already up sends
nothing, and a failure is sent once for each trigger until the database next
starts. A request that arrives while a start is already under way in the same
window waits for it and sends nothing, so one start is one event, carrying the
trigger of whatever began it. The exception is a request that arrives after
the user stopped the database during that start: it waits for the stop and
then asks again, so the start that follows is an event of its own.

| Property / measure | Values                                                                                                                              |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `trigger`          | see above                                                                                                                           |
| `outcome`          | `started`, or why not: `setupCancelled`, `setupFailed`, `osConfigDeclined` (the user said no to the shared-memory change), `osConfigFailed` (they said yes, but shared memory is still too low: a wrong sudo password, a cancelled script), `startFailed`, `unsupportedPlatform`, `missingPayload` (the extension package is broken) |
| `filedGrail`       | whether Python support was installed into the database this time: `no`, `firstTime`, `update`                                       |
| `durationMs`       | how long it took                                                                                                                    |

### `pythonUsed`

The user ran Python, the last step of the journey. Sent at most once per window
for each place Python can run, so at most four per window.

| Property / measure      | Values                                                                                                   |
| ----------------------- | -------------------------------------------------------------------------------------------------------- |
| `surface`               | `notebook`, `shell`, `runFile`, `debugFile`                                                              |
| `evidence`              | `executed`: code ran and a result came back (notebooks, debug file).<br>`launched`: a terminal was opened, but GemDB cannot see whether anything was typed into it (shell, run file). |
| `minutesSinceFirstSeen` | minutes since GemDB was first seen on this machine                                                       |

## Changing this document

It must match `src/telemetry.ts`. Change the two together. A unit test
(`src/__tests__/telemetryDocs.test.ts`) fails if an event, property or value in
the code is missing here.
