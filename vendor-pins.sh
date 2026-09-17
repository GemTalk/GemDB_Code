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

# Grail: main as of 2026-09-17, ~70 commits on from the pin before last
# (45f03ba, proven against a2 on 2026-09-16). It picks up Grail's IR work and
# two changes that alter behaviour GemDB's own notes depend on: inferred
# instance slots are ON by default, and class attributes live in a per-class
# holder so adding one keeps the class identity -- which is the root of the demo
# finding that a schema change broke `isinstance` for records written before it.
# `runPath:` can now pass arguments through to `sys.argv` as well.
#
# The last commit is a CPython shim fix, so this pin cannot be taken without
# rebuilding the shim on every platform: Py_UNICODE_ISDECIMAL was iswdigit,
# which the C standard defines as the ten ASCII digits in every locale, so \d
# matched no non-ASCII digit and Decimal('１') answered NaN. It now searches a
# generated Nd table (src/c/shim/grail_digit_table.h). A payload staged from
# this commit with a shim built from the previous one installs cleanly and keeps
# the old answer.
PINNED_GRAIL_REF=9a0b0fcb5fb4fe49b7e4f777d12f955fb5b39996

# mcp_server: main as of 2026-09-16. Two commits on from the previous pin
# (e717182), and only one of them matters: upstream followed the catalog to
# 4.0.0.a2, because dl.gemdb.com keeps one alpha at a time and its 4.0 CI legs
# were downloading an Alpha1 that now answers 404. Nothing GemDB's installer
# reads moved; the entry points and load.gs files are unchanged.
PINNED_MCP_REF=4f0254539ee77b1eb4c41c8285d9d33d7ec8ca61
