#!/bin/bash
#
# Build the MCP server payload that ships inside the .vsix.
#
# GemDB bundles GemTalk's native GemStone MCP server the same way it bundles
# Grail: the repository is the source of truth, the payload is a build
# artifact, and a release carries whatever was current when it was packaged.
#
# It is a far simpler payload than Grail's. The MCP server is Smalltalk --
# thirty-odd `.gs` class file-outs plus the loaders that `input` them -- so
# there is nothing to compile, nothing platform-specific, and the same payload
# is valid on every target. That is why this script takes no GEMSTONE and does
# not appear per-platform in CI the way bundle-grail.sh does.
#
# Usage:
#   scripts/bundle-mcp.sh                          # clone the default branch
#   MCP_SRC=/path/to/mcp_server scripts/bundle-mcp.sh   # use a local checkout
#
# Environment:
#   MCP_SRC   existing mcp_server checkout to bundle from (default: fresh clone)
#   MCP_REF   git ref to bundle when cloning (default: the default branch)
#
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
DEST="$REPO_ROOT/mcp"
MCP_URL="https://github.com/GemTalk/mcp_server.git"

# ---------------------------------------------------------------------------
# Obtain the sources.
# ---------------------------------------------------------------------------
WORKDIR=""
cleanup() { [ -n "$WORKDIR" ] && rm -rf "$WORKDIR"; return 0; }
trap cleanup EXIT

if [ -n "${MCP_SRC:-}" ]; then
    SRC=$(cd "$MCP_SRC" && pwd)
    echo "Bundling the MCP server from local checkout: $SRC"
else
    WORKDIR=$(mktemp -d)
    SRC="$WORKDIR/mcp_server"
    echo "Cloning the MCP server from $MCP_URL"
    git clone --depth 1 ${MCP_REF:+--branch "$MCP_REF"} "$MCP_URL" "$SRC"
fi

MCP_COMMIT=$(git -C "$SRC" rev-parse --short HEAD 2>/dev/null || echo unknown)
MCP_DESCRIBE=$(git -C "$SRC" describe --tags --always --dirty 2>/dev/null || echo unknown)
echo "MCP server commit: $MCP_COMMIT ($MCP_DESCRIBE)"

# ---------------------------------------------------------------------------
# Verify what GemDB drives is actually there.
# ---------------------------------------------------------------------------
# GemDB runs the payload's OWN install.sh rather than a GemDB copy of it -- the
# difference that justified resources/install-grail.sh (skipping a C compile)
# has no counterpart here. So these paths are named by src/mcp.ts, and if the
# repository reorganizes that has to fail at package time, where someone is
# watching, rather than on a user's first run.
REQUIRED=(
    install.sh
    gs-env.sh
    src/core/load.gs
    src/tests/load.gs
    src/grail/load.gs
)
for item in "${REQUIRED[@]}"; do
    if [ ! -e "$SRC/$item" ]; then
        echo "ERROR: mcp_server no longer provides $item -- GemDB's installer needs it." >&2
        exit 1
    fi
done

# ---------------------------------------------------------------------------
# Assemble the payload.
# ---------------------------------------------------------------------------
echo "Assembling $DEST"
rm -rf "$DEST"
mkdir -p "$DEST"

# src/ wholesale, for the same reason bundle-grail.sh copies Grail's src/
# wholesale: the loaders decide what the source tree contains, and a hand-picked
# list of subdirectories silently omits whatever is added next.
cp -R "$SRC/src" "$DEST/src"

# The shell scripts GemDB drives, plus the two the user may want at a stable
# path of their own (run-server.sh / stop-server.sh) once the payload is staged
# under the root path. gs-env.sh is sourced by all of them.
for item in install.sh gs-env.sh run-server.sh stop-server.sh load.gs LICENSE README.md; do
    if [ -e "$SRC/$item" ]; then cp "$SRC/$item" "$DEST/$item"; fi
done
chmod 0755 "$DEST"/*.sh
find "$DEST" \( -name '*.out' -o -name '.topazini' \) -delete 2>/dev/null || true

# ---------------------------------------------------------------------------
# Verify every file the loaders read is present.
# ---------------------------------------------------------------------------
# Same check bundle-grail.sh makes, and for the same reason: `input <path>` is
# resolved by topaz against the working directory, so a missing target is not
# caught until the file-in is already running against a live database.
echo "Checking that every 'input' target is present"
CHECKED=0
MISSING=0
while IFS= read -r target; do
    CHECKED=$((CHECKED + 1))
    if [ ! -e "$DEST/$target" ]; then
        echo "  MISSING: $target" >&2
        MISSING=$((MISSING + 1))
    fi
done < <(find "$DEST" -name '*.gs' -exec \
    sed -nE 's|^[[:space:]]*input[[:space:]]+(\./)?([A-Za-z0-9_./-]+\.gs).*|\2|p' {} + | sort -u)

if [ "$MISSING" -ne 0 ]; then
    echo "ERROR: $MISSING file(s) referenced by the MCP loaders are not in the payload." >&2
    exit 1
fi
# A scan that matches nothing reports success for a payload it never looked at.
# The four loaders together `input` one file per class, so this is dozens.
if [ "$CHECKED" -lt 20 ]; then
    echo "ERROR: only $CHECKED 'input' targets found; the MCP loaders file in dozens." >&2
    echo "  The scan above is not matching -- fix it rather than trusting this build." >&2
    exit 1
fi
echo "  $CHECKED referenced files, all present"

# The stamp is what GemDB compares to decide whether the payload filed into the
# database is the one this build ships. No engine in it, unlike Grail's: there
# is no compiled artifact here, so a payload is not tied to an engine version.
cat > "$DEST/MCP_VERSION" <<VERSION
mcp=$MCP_DESCRIBE
commit=$MCP_COMMIT
VERSION

echo
echo "Bundled the MCP server $MCP_DESCRIBE ($(find "$DEST/src" -name '*.gs' | wc -l | tr -d ' ') class files)."
