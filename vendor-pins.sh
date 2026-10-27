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

# Grail: TEMPORARILY the head of fix/engine-upgrade (GemTalk/Grail PR #1867),
# not main, for the engine move to 4.0.0.a8 (GemDB_Code #178). It carries
# scripts/upgrade_engine.sh --in-place, which GemDB runs to upgrade an a5
# database in place, with GemStone's upgradeImage.topaz for a8 bundled under
# scripts/upgrade/4.0.0.a8 (a8 ships none); and the install repairs a Grail an
# engine upgrade has stripped (it recompiles the LoadedMethods upgradeImage
# removed, and re-enables the user's GsPackage). ff418a3 also fixes a reinstall
# keeping methods a release removes (the upgrade test's synthetic case), and
# 5d0333f runs the upgrade's temporary stone on the caller's own stone config
# (UPGRADE_ENGINE_STONE_CONFIG): GemDB's key and 10240 MB cap, without which
# that stone refused GemDB's pregrown extent. Move this to the merge commit
# once #1867 lands on main.
#
# The previous pin was c8cbc92 (main as of 2026-10-20), the first Rowan-project
# Grail: Tonel packages in src/Grail-*, loaded by install_rowan.gs into an image
# started from extent0.rowan3.dbf.
PINNED_GRAIL_REF=5d0333f35c17b7051902471dba2b9fbd8c79185f

# mcp_server: 0.9.0 (main as of 2026-10-19), 20 commits (9 PRs) on from the
# previous pin (d836520) -- and, like Grail, NOW A ROWAN PROJECT (#57). Its six
# packages are Tonel in src/Mcp-* (components Core, Auth, Grail), its project is
# in rowan/, and install.sh loads it with Rowan by default; the src/*/load.gs
# loaders are gone. The Grail component -- the Python toolset GemDB serves --
# loads ONLY through Rowan: the release's file-out (--from-gs) carries Core and
# Auth. GemDB's flags are unchanged (--grail --no-auth), bundle-mcp.sh ships
# rowan/ and checks every package the components name, and check-vsix.sh looks
# for the Rowan router class. Also: every forked gem reaches the stone by
# localhost (#63), topaz runs with -i so no .topazini is read (#62), and
# find_python_senders takes its positions from Grail's send sites (#65).
PINNED_MCP_REF=7ab106728285c41f573b5469b8c341dfdad988aa

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
