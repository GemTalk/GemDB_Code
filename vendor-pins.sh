#!/bin/sh
#
# Pinned upstream commits for the payloads GemDB bundles into the .vsix.
# Sourced by scripts/bundle-grail.sh and scripts/bundle-mcp.sh, and read as
# text by scripts/bundle-stats.mjs; not meant to be run on its own.
#
# Full 40-character shas, not tags for now: neither upstream publishes tags worth
# tracking yet. Override per-build with GRAIL_REF/MCP_REF -- these are read only
# when that env var is unset.
#
# Bumping a pin is a one-line PR to this file; a green CI run on it is the
# proof the new upstream commit works.

# Grail: 172ad87, main as of 2026-10-18 and the LAST COMMIT BEFORE GRAIL BECAME A
# ROWAN PROJECT -- 13 commits (4 PRs) on from the previous pin (a78e8c0). Not
# main: from #1721 (db885a6, 2026-10-19) install.sh refuses any engine without
# bin/extent0.rowan3.dbf, loads Grail with Rowan (scripts/install_rowan.gs)
# instead of filing in src/smalltalk/install.gs, and kernel_class_extensions.gs
# is gone. Following it means creating GemDB's database from the Rowan extent
# and rewriting install-grail.sh to match -- a migration, not a pin move.
#
# Up to 172ad87 nothing GemDB's installer reads changed: every script
# install-grail.sh drives is byte-identical, install.gs adds six lines, and the
# Makefile and the gemdb package are untouched. #1716 moves the bundled
# third-party packages (flask, werkzeug, jinja2, django, ...) from
# src/python/stdlib to src/python/bundled, searched after sys.path, so a user's
# own copy now wins; GemDB stages src/python whole and names no path inside it.
# Also: a class binds its name only once complete (#1718), a shape-changing
# __defaults__ assignment rebinds calls (#1719), and numpy census fixes
# (#1720; numpy.random itself still needs a kernel with 64 user actions).
PINNED_GRAIL_REF=172ad87f58be33b1f3c85e1e1a52428703527f43

# HELD at d836520, on purpose. mcp_server 0.9.0 (7ab1067, 2026-10-19) became a
# Rowan project: its load.gs files are gone, and the Grail toolset -- the
# Python tools GemDB serves -- loads only through Rowan, on an image started
# from extent0.rowan3.dbf. The release file-out that needs no Rowan carries
# Core + Auth only. Moving needs the same Rowan-extent decision as Grail.
#
# mcp_server: main as of 2026-09-25, 26 commits (8 PRs) on from the previous pin
# (afa3790). No load.gs changed, and every selector src/mcp.ts sends --
# toolsetNames:, toolsetOptions:, workerUserId:, serverTitle:, forkOnPort:,
# McpServer defaultToolsetNames -- is still there, as is the "gem session N
# (host pid P)" status line it parses. What moved:
#
# - Upstream CI moved to 4.0.0.a3, the engine GemDB already pins. a3's
#   JsonParser refuses trailing whitespace after the outer value, so the server
#   now strips it before parsing (#54) -- a pretty-printed or newline-ended
#   request body was a -32700 under a3 before this.
# - Breaking upstream, inert here: the worker bootstrap selector gained an
#   `instructions:` keyword (#45), because the `initialize` instructions are
#   now router config (McpRouter>>serverInstructions:). The router sends that
#   selector to its own workers; GemDB never does. GemDB serves the full default
#   surface plus Grail, so the stock instructions, which name the transaction
#   tools, stay accurate.
# - find_python_senders places each call and reference in an IR-compiled method
#   with its own line (#46, #51) instead of one `line ?` per method, and
#   eval_python runs as `__main__` (#52).
PINNED_MCP_REF=d836520816d47bc5b8bb43386293f1b9dffbefce

# GemDB Stats: a release asset, not a commit. Its web build needs the Flutter
# SDK to compile, which GemDB Code's CI does not carry, so GemDB Stats'
# release.yml publishes it as GemDB-Stats-<version>-web.tar.gz beside the
# desktop builds, and bundle-stats.mjs downloads this one and refuses it unless
# the SHA-256 matches (the release's SHA256SUMS.txt carries the value). Override
# per-build with STATS_URL (and STATS_SHA256), or STATS_WEB for a local build.
#
# v1.1.1 (3f6487d), released 2026-10-06. v1.1.0 was the first release with the
# web build, including GemDB_Stats PR #10, which lets GemDB Code choose the file
# (ready / open / pickFile) and starts Flutter without a service worker. v1.1.1
# adds PR #16: the web build opens a .gz that statmonitor is still writing,
# with every sample so far, where v1.1.0 failed with "Compressed input was
# truncated" -- which is today's file whenever the database is recording.
PINNED_STATS_URL=https://github.com/GemTalk/GemDB_Stats/releases/download/v1.1.1/GemDB-Stats-1.1.1-web.tar.gz
PINNED_STATS_SHA256=d319df2541482a5032e1d87255f2b6a3ed658fb3cd6f7a4ce7907b12e6f060b6
