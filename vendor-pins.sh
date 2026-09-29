#!/bin/sh
#
# Pinned upstream commits for the payloads GemDB bundles into the .vsix.
# Sourced by scripts/bundle-grail.sh and scripts/bundle-mcp.sh; not meant to
# be run on its own.
#
# Full 40-character shas, not tags for now: neither upstream publishes tags worth
# tracking yet. Override per-build with GRAIL_REF/MCP_REF -- these are read only
# when that env var is unset.
#
# Bumping a pin is a one-line PR to this file; a green CI run on it is the
# proof the new upstream commit works.

# Grail: main as of 2026-09-28, 72 commits (30 PRs) on from the previous pin
# (b86985f). The C shim, every script resources/install-grail.sh drives, and
# the REQUIRED list in bundle-grail.sh are untouched, and nothing was deleted or
# renamed. Built against 4.0.0.a4, the engine pin that moves with it.
#
# One installer change, inert for GemDB: install.gs's headroom-guarded MFC now
# probes `System sessionsHoldingGcLock` and `System voteState` and skips when
# another collection is under way, rather than waiting two minutes for the
# gcLock and dying with ERROR 2501 (#1245). That MFC runs only near a
# configured STN_MAX_REPOSITORY_SIZE, which GemDB's stone leaves unset.
#
# The rest is CPython conformance: typing.py and urllib are CPython's own again
# (#1241, #1246), CPython's ssl.py over an OpenSSL binding (#1247), NamedTuple
# and TypedDict (#1209), xml.etree, sax and pulldom (#1211, #1231, #1248,
# #1252), unittest.main() exiting non-zero on failure (#1257), any()/all()
# testing truth the way `if` does (#1256), a module attribute read that no
# longer runs the dict protocol underneath (#1259), ScaledDecimal hashing like
# an equal int (#1260), and a @staticmethod/@classmethod that can override a
# base's plain method (#1215).
PINNED_GRAIL_REF=84821c1e96e5d1918284e9353e63d79771a4709d

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
