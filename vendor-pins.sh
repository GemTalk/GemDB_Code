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

# Grail: main as of 2026-09-23, 282 commits (~110 PRs) on from the previous pin
# (9a0b0fc). Nothing GemDB's installer drives was renamed or moved, and the C
# shim is untouched, so the shim needs no source change -- though, as always,
# every platform rebuilds it. Three changes are worth knowing about:
#
# - IR codegen is ON by default (#1087). GRAIL_IR_CODEGEN now DISABLES it
#   (0/false/no/off); unset or empty means IR. A method compiled to IR has no
#   call-site positions, which is what mcp_server #43/#44 below account for.
# - `gemdb.schema` (#1076, #1084, #1089) is a new module beside gemdb.admin and
#   gemdb.sessions -- layout/report/drop/rename/compact for a schema change --
#   and deployGemdb.gs now deploys it. It also stops re-executing a module that
#   an earlier name's import closure already loaded.
# - install.gs no longer runs a markForCollection on every install when
#   STN_MAX_REPOSITORY_SIZE is unset (#1117), where GemDB's stone leaves it. An
#   MFC needs every session to vote, so a stone with idle sessions timed it out
#   and killed the install.
#
# Also: `durable`, a spike stdlib module on GemStone continuations (#1159), and
# a long run of CPython-conformance fixes (errno, pathlib, codecs, eval/exec).
PINNED_GRAIL_REF=9f46b86c52a17da1e8d4cec8a2d6a268ca9e9617

# mcp_server: main as of 2026-09-23, 21 commits on from the previous pin
# (4f02545). No shell entry point or load.gs changed, and every selector
# src/mcp.ts sends is still there. Two things moved:
#
# - Breaking upstream, inert here: the kernel-class guard is gone (#33). The
#   mutation tools no longer refuse a kernel class or `Globals`; the stone
#   enforces that instead, via SystemObjectSecurityPolicy, for any worker user
#   lacking ObjectSecurityPolicyProtection -- which is what
#   `gemdb.mcp.readOnly`'s McpReadOnly user already is. GemDB never called it.
# - The Python tools now ask Grail rather than reimplementing it: selectors
#   decode through `importlib pythonNameOfSelector:`, classes come from
#   `importlib pythonClasses`, and find_python_senders understands IR-compiled
#   methods. The Grail APIs it calls predate the previous Grail pin, but the
#   Grail above makes IR the default, and under IR the previous mcp_server pin
#   answered find_python_senders with silent misses -- so bump the two together.
PINNED_MCP_REF=afa3790aa0115f438f9703bb98dde854b9fca713
