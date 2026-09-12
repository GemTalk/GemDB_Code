# Usage data

This notice covers only the GemDB Code extension (`gemtalksystems.gemdb`). It
does not cover any other GemTalk product.

**Data controller:** GemTalk Systems LLC - **Contact:** <info@gemtalksystems.com>

## What we collect

GemDB sends usage events describing how the extension is used — for example,
when it starts up and how features within it perform — so we can tell
whether it's working and prioritize fixes. These events carry only
non-identifying, extension-level information: things like which platform
GemDB is running on, how long an operation took, or whether an operation
succeeded or failed. They never carry the contents of your work (see "What
we do not collect" below).

VS Code automatically attaches its own common properties to every event:
`common.extname`, `common.extversion`, `common.vscodemachineid`,
`common.vscodesessionid`, `common.vscodecommithash`, `common.vscodeversion`,
`common.vscodereleasedate`, `common.os`, `common.platformversion`,
`common.nodeArch`, `common.product`, `common.uikind`, `common.remotename`,
`common.isnewappinstall`, `common.sqmid`, `common.devDeviceId`.

`common.vscodemachineid` is a pseudonymous identifier VS Code generates per
installation. It is not tied to your name or email, but under GDPR it counts
as an online identifier, which is why this notice exists.

## What we do not collect

File paths, file names, notebook URIs or titles, Python source code, notebook
cell contents, query text, database contents, GemStone session or cache
names, usernames, email addresses, environment variables, or IP-derived
location.

## Why we collect it

To understand aggregate usage — for example, which platforms GemDB runs on
and how activation performs — so we can prioritize fixes and improvements.
This relies on legitimate interest (GDPR Art. 6(1)(f)); it is not used for
advertising or profiling.

## How it is transmitted and stored

Events go over TLS to Azure Application Insights / Azure Monitor, in an
Azure subscription owned by GemTalk. Region and retention period: [TBD].

## Disclosure

Microsoft/Azure processes this data as our infrastructure provider. We do
not sell it, use it for advertising, or share it with any other third party.

## Your controls

GemDB honours VS Code's `telemetry.telemetryLevel` setting via
`vscode.env.createTelemetryLogger`:

- `off` — no telemetry is sent.
- `crash` / `error` — only events containing an error are sent.
- `all` — all usage events described above are sent.

GemDB does not currently ship its own telemetry setting; VS Code's global
setting is the only control.

## Accessing or deleting your data

Events are keyed only by `common.vscodemachineid`, so we cannot look up or
delete data for you without that value. To find yours, run **Help: About**
in VS Code's Command Palette, or check the `machineId` field on
`vscode.env`. If you send it to the contact address above, we will locate
and delete the matching records.

## Changes

Last updated: 2026-09-09. Changes to this notice will be published in this
repository.
