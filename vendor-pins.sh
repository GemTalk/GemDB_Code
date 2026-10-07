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

# Grail: main as of 2026-10-07, 213 commits (78 PRs) on from the previous pin
# (9f8b116). The scripts resources/install-grail.sh drives are byte-identical
# apart from deployGemdb.gs, whose warm-deploy list gains gemdb.modules (#1297),
# and every name in bundle-grail.sh's REQUIRED list is still there. install.gs
# is mostly re-sorted (#1360); its real changes are four new runtime inputs and
# five removed ones -- random, statistics, string, string_Formatter and
# StatisticsError -- which CPython's own .py files under src/python replace
# (#1301, #1305, #1329). Every `input` in it exists in the tree. The C shim's
# SOURCE changed (cpython.cc, shim_pyo3.cc, shim_numpy.cc, _sre, for FastAPI,
# pydantic and re), so every platform rebuilds it; the Makefile is unchanged
# and its two new GCI calls (GciFetchOop, GciIsKindOfClass) are in a4's gci.hf.
#
# Grail now targets CPython 3.14.8 (#1343, #1346, #1348, #1350, #1359):
# SyntaxError messages and positions match CPython's (#1363), runaway recursion
# is a catchable RecursionError (#1358), and random, statistics, string and
# str.format are CPython's own (#1301, #1305, #1329, #1330). FastAPI and
# starlette answer as CPython does for async endpoints (#1347, #1352).
#
# What the gemdb module adds: app namespaces, gemdb.use_namespace() (#1302,
# #1324, #1361); gemdb.SessionStateError, a catchable error naming the object a
# refused commit tripped on, where it was a Smalltalk error (#1319, #1336);
# __transient__ attributes that are never committed (#1337, #1338); and
# gemdb.modules (#1297). Nothing GemDB calls was removed or renamed.
#
# Behaviour changes a user can meet: importing a different file under a module
# name already deployed raises ImportError, naming gemdb.modules.relocate() and
# forget() (#1297); setting a global of one of Grail's own modules, such as
# gc.disable(), lasts for the session instead of being committed (#1344);
# `7 // 2.0` is 3.0 (#1311); a seeded random gives CPython's sequence, not the
# old one (#1305); and code CPython rejects, such as `01`, is a SyntaxError.
PINNED_GRAIL_REF=beef4736c897dff60fc9c81d210430cc785313af

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
