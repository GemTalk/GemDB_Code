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

# Grail: main as of 2026-10-15, 388 commits (175 PRs) on from the previous pin
# (beef473). install.sh gains one step (#1556): after deployGemdb.gs it runs
# scripts/deployUnicodedata.gs, which builds and commits unicodedata's tables so
# a session's first normalize/category call neither takes a second nor leaves
# the session dirty. resources/install-grail.sh now mirrors it as its step 4,
# warn-only as upstream's is. Every other script it drives is byte-identical,
# and every name in bundle-grail.sh's REQUIRED list is still there. install.gs
# only adds: three runtime inputs (GrailCommitCoordinator, JSONDecoder,
# PythonTokenizerIdentifiers) and test classes, all under src/. The C shim's
# SOURCE changed (numpy, FastAPI, subclassing C types), so every platform
# rebuilds it; the Makefile and its GCI calls are unchanged, and the only new
# includes are libc's. The gemdb Python package is byte-identical.
#
# Deleted or moved, none of it referenced by GemDB: stdlib click and requests
# become _grail_click and _grail_requests (#1634), and importlib/metadata.py
# gives way to CPython's package (#1664).
#
# What users get: FastAPI's sync endpoints and HTTP serving (#1400, #1568,
# #1626); `import numpy` completing (#1560 and on); enough for boto3,
# sqlalchemy and pytest collection (#1547, #1550, #1551, #1597, #1598);
# identifiers per CPython's XID and NFKC rules (#1503, #1512); `except*`
# (#1625); tracebacks and frame lines as CPython reports them (#1373, #1509,
# #1519); and a method patched onto a throwaway instance no longer leaves
# something to commit (#1468).
#
# Behaviour changes a user can meet: `import click` or `import requests` with
# neither installed is ModuleNotFoundError (#1634); `vars(obj)` is a live view,
# so writing through it changes the object (#1664); calls CPython refuses now
# raise TypeError -- extra lambda arguments (#1524), an argument given twice
# (#1577); an exception in a decorator propagates instead of leaving the def
# undecorated (#1403); `date == datetime` is False and ordering the two raises
# (#1603); `^` and `&` on negative large integers are corrected (#1611); and
# `µ` and `μ` are one name (#1512).
PINNED_GRAIL_REF=9fb5d23a9f46e8e06c0d6783c06bb653d5b0c97e

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
