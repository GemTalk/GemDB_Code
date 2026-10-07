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

# Grail: main as of 2026-10-01, 47 commits (21 PRs) on from the previous pin
# (84821c1). Every script resources/install-grail.sh drives and the REQUIRED
# list in bundle-grail.sh are untouched, and nothing was deleted or renamed.
# The C shim's SOURCE changed, so every platform rebuilds it: cpython.cc grows,
# and shim_pyo3.cc joins it, the CPython 3.14 entry points a PyO3 wheel such as
# pydantic_core needs (#1277, #1282). Same toolchain, no new build dependency.
#
# One addition GemDB does not take up: src/c/ssl, a second C library holding
# the four OpenSSL callbacks _ssl.py cannot make through CCallout -- server-side
# ALPN, msg_callback, keylog and PSK (#1266). Grail's install.sh builds it and
# passes GRAIL_SSL_LIB_PATH; resources/install-grail.sh does neither, and
# bundle-grail.sh ships no src/c. install.gs records an unset path as nil, so
# the install succeeds and those four raise NotImplementedError, which is what
# they did before #1266. The rest of ssl is unaffected.
#
# Session hygiene, which bears on any app with more than one gem: a module-level
# lru_cache in a deployed module is per-session (#1279) -- a hit wrote a shared
# object and a miss committed its arguments -- and `Cls.x = v` on a deployed
# class stays session-local whichever name it uses (#1278), so two gems setting
# Flask.secret_key no longer conflict. A committed WeakSet drops dead references
# (#1283).
#
# Also: a Flask view that raises answers 500 instead of ending the process
# (#1284, by way of a catchable KeyError from `%(key)s` and a real root
# logger), re.sub with a callable on a deployed pattern (#1285), a dotted import
# of an unfindable package raises instead of answering nil (#1274), Fraction
# hashing like the equal float (#1267), and statistics adding, sorting and
# dividing as Python does (#1280).
PINNED_GRAIL_REF=9f8b1161101608cb57d696887c672a3a5c5ce9f2

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
# v1.1.0 (3cc86a7), released 2026-10-06: the first release with the web build.
# It includes GemDB_Stats PR #10, which lets GemDB Code choose the file
# (ready / open / pickFile) and starts Flutter without a service worker.
PINNED_STATS_URL=https://github.com/GemTalk/GemDB_Stats/releases/download/v1.1.0/GemDB-Stats-1.1.0-web.tar.gz
PINNED_STATS_SHA256=1b748c36c0db9ef12fce563feb64ab8254fa8c8bd780d1d45bb514752d16f538
