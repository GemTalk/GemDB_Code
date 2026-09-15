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

# Grail: last proven green on GemDB main, 2026-09-11.
PINNED_GRAIL_REF=50468c783010f03b52d351eb20f64f4daa97bd42

# mcp_server: last proven green on GemDB main, 2026-09-11.
PINNED_MCP_REF=7b26a23080cf62029dda6287e8b4018e8596a5b1
