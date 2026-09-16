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

# Grail: re-proven against 4.0.0.a2 on 2026-09-16 -- the shim builds, the
# payload stages, and every Python path in the integration suite passes. The
# commit is unchanged from the Alpha1 proof on 2026-09-15; only the engine under
# it moved. The previous pin
# (50468c7, 2026-09-11) cannot build this tree at all -- it predates Grail's
# 4.0-only installer, so it carries no scripts/kernel_class_extensions.gs and
# bundle-grail.sh stops on its own REQUIRED check. Grail dropped 3.7.x on
# 2026-09-12 and now refuses anything below 4.0, so the engine pin in
# src/config.ts and this one move together: neither is independently valid.
PINNED_GRAIL_REF=45f03ba5fc0075a8e81662d9952ebba00c7dad6b

# mcp_server: proven green on 4.0.0.Alpha1, 2026-09-15, and NOT green on
# 4.0.0.a2 -- through no fault of this pin. On a2 the router cannot fork a
# worker gem: GsTsExternalSession>>login fails with error 2710 (original 4136),
# "the connection to the Stone Repository monitor was refused", because the
# default stone NRS is hostname-qualified and a2's remote path rejects it.
# Reproduced outside GemDB with six lines of topaz, and it goes away when the
# stone NRS is pinned to localhost, so it is the engine's to fix and no pin here
# can route around it. Everything else on a2 passes; only mcp.test.ts is red.
# The previous
# pin (7b26a23, 2026-09-11) predates 0.9.0 and carries no
# setup-read-only-user.sh, which bundle-mcp.sh names as an entry point and
# src/mcp.ts runs to provision McpReadOnly. It also predates GemTalk/mcp_server#29,
# without which install.sh refuses every 4.0.0.Alpha1 stone and no Mcp class is
# ever filed in.
PINNED_MCP_REF=e717182507d262b1dd8c19ff91c6800bb52117e1
