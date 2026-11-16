# Security

If you find a security problem in GemDB Code, please tell us privately rather than in public, so we
can fix it before anyone can take advantage of it.

## Reporting a vulnerability

Don't open a public issue, pull request or discussion about it. Instead, use GitHub's private
reporting:

1. Go to the repository's [Security tab](https://github.com/GemTalk/GemDB_Code/security) and click
   **Report a vulnerability**, or go straight to the
   [new report form](https://github.com/GemTalk/GemDB_Code/security/advisories/new).
2. Fill in the form. Only you and the GemDB Code maintainers can see the report.

It helps to include:

1. What an attacker could do, and what they would need first (for example, access to the same
   machine, or a file or notebook you open).
2. Your GemDB Code, VS Code and operating system versions.
3. Steps to reproduce the problem, or a proof of concept.

We'll reply in the report, work on the fix there with you, and publish a security advisory once a
fixed release is out. Tell us if you'd like to be credited in it.

## Supported versions

GemDB Code is in beta. Security fixes go into the next release; older releases don't get them. VS
Code updates extensions automatically, so leave automatic updates on, or update GemDB Code by hand
when a release mentions a security fix.

## What isn't covered here

1. **The GemDB database itself.** Problems in the GemDB (GemStone) server or its libraries belong to
   the database, not this extension. Report them to GemTalk Systems through your usual support
   channel.
2. **Known vulnerabilities in GemDB Code's dependencies.** GitHub already tells us about these.
   Report one only if you've found a way to exploit it through GemDB Code.
