# Usage data

This notice covers only the GemDB Code extension (`gemtalksystems.gemdb`). It
does not cover any other GemTalk product.

**Data controller:** GemTalk Systems LLC - **Contact:** <info@gemdb.com>

## What we collect

GemDB sends usage events describing how the extension is used — for example,
when it starts up and how features within it perform — so we can tell
whether it's working and prioritize fixes. These events carry only
non-identifying, extension-level information: things like which platform
GemDB is running on, how long an operation took, or whether an operation
succeeded or failed. They never carry the contents of your work (see "What
we do not collect" below). [docs/telemetry.md](docs/telemetry.md) lists every
event and what each of its properties can say.

VS Code automatically attaches its own common properties to every event:
`common.extname`, `common.extversion`, `common.vscodemachineid`,
`common.vscodesessionid`, `common.vscodecommithash`, `common.vscodeversion`,
`common.vscodereleasedate`, `common.os`, `common.platformversion`,
`common.nodeArch`, `common.product`, `common.uikind`, `common.remotename`,
`common.isnewappinstall`, `common.sqmid`, `common.devDeviceId`,
`common.telemetryclientversion`.

GemDB adds three properties of its own to every event:

- `extensionMode`, which is `production` for an installed extension and
  `development` or `test` when a GemDB developer is running it from source.
- `installDay`, a date only (e.g. `2026-09-15`) — never a timestamp — recording
  roughly when GemDB was first used on this machine.
- `installDaySource`, which says how `installDay` was determined:
  - `firstSeen` — the ordinary case: GemDB recorded this as a new install.
  - `reinstall` — GemDB's own files were reinstalled while the database
    survived.

`common.vscodemachineid` is a pseudonymous identifier VS Code generates per
installation. It is not tied to your name or email, but under GDPR it counts
as an online identifier, which is why this notice exists.

**Approximate location.** Azure derives a coarse location — city, state or
province, and country — from the IP address your events arrive from, and
stores those three fields alongside each event. Your IP address itself is
**not** stored: Azure masks it to `0.0.0.0` before the event is written. We
do not use the location to identify anyone; it tells us which regions GemDB
is used in.

## What we do not collect

File paths, file names, notebook URIs or titles, Python source code, notebook
cell contents, query text, database contents, GemStone session or cache
names, usernames, email addresses, environment variables, error messages, or
exception text, or your IP address (see "Approximate location" above for
what Azure derives from it before discarding it). Events that record a
failure — for example, whether setup or a database start succeeded — carry
only a short classified reason (such as "cancelled" or "failed"), never the
underlying error's own text, because GemStone errors can embed file paths.

## Why we collect it

To understand GemDB's usage in aggregate: whether setup and startup succeed
and how long they take, which platforms GemDB runs on and which regions it is
used in, and which features people actually use. That lets us prioritize
fixes and improvements. We do not use it to see what any individual does with
their data or code (see "What we do not collect"), and it is never used for
advertising or profiling. This relies on legitimate interest (GDPR Art.
6(1)(f)).

## How it is transmitted and stored

Events go over TLS to Azure Application Insights / Azure Monitor, in an
Azure subscription owned by GemTalk. They are stored in the **West US 2**
region (United States) and are **retained for 90 days**, after which Azure
deletes them.

## Disclosure

Microsoft/Azure processes this data as our infrastructure provider. We do
not sell it, use it for advertising, or share it with any other third party.

## Your controls

GemDB honours VS Code's `telemetry.telemetryLevel` setting via
`vscode.env.createTelemetryLogger`:

- `off` — no telemetry is sent.
- `crash` / `error` — only events containing an error are sent.
- `all` — all usage events described above are sent.

## Accessing or deleting your data

Events are keyed only by `common.vscodemachineid`, so we cannot look up or
delete data for you without that value. To find yours, run **Help: About**
in VS Code's Command Palette, or check the `machineId` field on
`vscode.env`. If you send it to the contact address above, we will locate
and delete the matching records.

## Changes

Last updated: 2026-09-23. Changes to this notice will be published in this
repository.
