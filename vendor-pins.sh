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

# Grail: main as of 2026-09-27, 127 commits (43 PRs) on from the previous pin
# (9f46b86). The C shim, every script resources/install-grail.sh drives, and
# the REQUIRED list in bundle-grail.sh are untouched -- the only deletion is
# src/smalltalk/Python/ipaddress.gs, replaced by CPython's own module (#1175),
# and install.gs drops its globals in the same commit. Two changes bear on
# notes GemDB keeps:
#
# - Grail #851, the root of docs/grail.md's dirty-session note, is fixed in two
#   halves. A first read of a function in a committed module no longer caches
#   into that module (#1167), so a pure call leaves a clean session clean and
#   two sessions making the same first call no longer conflict. And a script's
#   `__main__` is session-local (#1179): `importlib runPath:`, which is what
#   `gemdb file.py` calls, wrote 4 committed objects before a script's first
#   line and now writes none, so `gemdb.transaction()` can be the first statement.
# - Code run as a script or at grail.tpz's prompt gets `__name__ = '__main__'`,
#   and type() / the Enum functional API / a class statement in evaluated code
#   infer `__module__` from `__name__` (#1168, #1173). GemDB's notebook and
#   shell scopes do not seed `__name__`, so they keep the old answer.
#
# Also: IR position fixes (#1164, #1183) that mcp_server below relies on, dict
# and comparison-protocol fixes (#1172, #1180, #1184, #1186), contextvars kept
# per-session (#1176), logging accepting exc_info (#1163), and vendored
# pickletools, dbm, xml.dom and an importlib.machinery facade. The last 16 PRs
# are CPython conformance: CPython's own pickle, abc and collections.abc
# (#1202, #1204), PEP 695 scopes (#1200), an os file-descriptor layer (#1193),
# suspended generators that can be collected (#1195), a never-awaited
# coroutine warning (#1199), @unittest.expectedFailure honoured (#1191), and
# lru_cache comparing keys with Python equality (#1207).
PINNED_GRAIL_REF=b86985f1a8604dae24fe740124aed96d58f0598a

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
