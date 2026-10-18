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

# Grail: main as of 2026-10-18, 71 commits (31 PRs) on from the previous pin
# (9fb5d23). install.sh and every script resources/install-grail.sh drives are
# byte-identical, there are no deletions or renames, and every name in
# bundle-grail.sh's REQUIRED list is still there. install.gs only adds: one
# runtime input (GrailDynLoadRequest) and test classes, all under src/. The C
# shim's SOURCE changed (numpy, cffi, C-type introspection), so every platform
# rebuilds it; the Makefile adds shim_cffi.o to the default build, the only new
# includes are libc's, and the GCI calls are unchanged and declared in a5's
# headers. The gemdb Python package is unchanged. Grail #1667 (a bare `import
# flask` dirties every fresh session on a deployed stone) is still open.
#
# What users get: class bodies and the object model closer to CPython's
# (#1709, #1685, #1697, #1671, #1704 and more); numpy.random's Cython modules
# loading and nested extension loads (#1665); cffi entry points, `import
# uvicorn`, hashlib.sha224/sha384 (#1676); FastAPI's core tests at 99.8%
# (#1654); and abandoned generators running their `finally` blocks (#1684).
#
# Behaviour changes a user can meet: a class body now runs `raise`, `assert`,
# `match` and conditional `del`/`import` it used to skip, and one that fails
# leaves the name unbound (#1709); bad `__slots__` raise TypeError (#1697); a
# `@property` wins over an instance value of the same name (#1671); a coroutine
# is no longer a GeneratorType (#1672); `x *= y` where both sides decline raises
# instead of storing NotImplemented (#1690); and patching `json.dumps`,
# `math.sqrt` or `os.getcwd` now reaches their callers (#1654).
PINNED_GRAIL_REF=a78e8c03c78bf957acb9119ae10c01567acdda06

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
