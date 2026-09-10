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
#
# ENTRYPOINTS is ENTRY POINTS ONLY: the scripts something OUTSIDE the payload
# names. What those scripts in turn source is deliberately absent, because it
# is derived below rather than listed. An earlier version of this file kept a
# list here and a SECOND, different list in the copy loop, and checked only
# this one; session-lifetime.sh was in neither, so every .vsix shipped a
# run-server.sh that sourced a file the payload did not contain and died on
# the user's first run -- taking MCP_MAX_SESSIONS, the session cap, with it.
# A list that has to be kept in step with another list is the defect; the only
# durable fix is to have one list, and to derive the rest from the payload.
ENTRYPOINTS=(
    install.sh      # src/mcp.ts runs this to file the classes in
    run-server.sh   # staged at a stable path for the user to run
    stop-server.sh  # ditto, and named by run-server.sh's own advice
)
# Loaders inside the wholesale src/ copy that src/mcp.ts's install path drives.
# Not entry points in the shell sense, so no closure applies -- what THEY read
# is checked by the `input` scan further down.
REQUIRED_GS=(
    src/core/load.gs
    src/tests/load.gs
    src/grail/load.gs
)
for item in "${ENTRYPOINTS[@]}" "${REQUIRED_GS[@]}"; do
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

# Documents and the top-level loader. Carried for the reader, not driven, so
# there is nothing to derive from them; load.gs's own `input` targets are
# covered by the scan below.
for item in load.gs LICENSE README.md; do
    if [ -e "$SRC/$item" ]; then cp "$SRC/$item" "$DEST/$item"; fi
done

# The shell scripts: the entry points, then the transitive closure of whatever
# those scripts source or run, until the set stops growing. gs-env.sh and
# session-lifetime.sh arrive this way rather than by being named -- which is
# the whole point, since the second of those is what nobody remembered to name.
#
# sourced_scripts matches COMMAND POSITION only -- `. ./x.sh`, `source ./x.sh`,
# a bare or env-prefixed `./x.sh` invocation. So the `./stop-server.sh` inside
# run-server.sh's advice-to-the-user string is not one of these. That is the
# difference between this scan and the wider one after it, and it is deliberate:
# this one decides what BELONGS in the payload, that one decides whether the
# payload keeps the promises it makes.
sourced_scripts() {
    sed -nE \
        -e 's#^[[:space:]]*(\.|source)[[:space:]]+"?\./([A-Za-z0-9_.-]+\.sh)"?([[:space:]].*)?$#\2#p' \
        -e 's#^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*(exec[[:space:]]+)?\./([A-Za-z0-9_.-]+\.sh)([[:space:]].*)?$#\3#p' \
        "$@"
}

echo "Staging the entry points and everything they reach"
for item in "${ENTRYPOINTS[@]}"; do
    cp "$SRC/$item" "$DEST/$item"
    echo "  $item (entry point)"
done
ADDED=1
while [ "$ADDED" -ne 0 ]; do
    ADDED=0
    while IFS= read -r ref; do
        [ -n "$ref" ] || continue
        [ -e "$DEST/$ref" ] && continue
        # Absent upstream too: not something this loop can fix, and silence
        # here would be the original bug again. Leave it to the check below,
        # which reports it by name and fails the build.
        [ -e "$SRC/$ref" ] || continue
        cp "$SRC/$ref" "$DEST/$ref"
        echo "  $ref (sourced by the payload)"
        ADDED=$((ADDED + 1))
    done < <(sourced_scripts "$DEST"/*.sh | sort -u)
done

chmod 0755 "$DEST"/*.sh
find "$DEST" \( -name '*.out' -o -name '.topazini' \) -delete 2>/dev/null || true

# ---------------------------------------------------------------------------
# Verify every sibling script the payload names is present.
# ---------------------------------------------------------------------------
# The `input` scan below does this for the Smalltalk half and has since day
# one; this is the shell half, which did not exist and should have. The scan
# is deliberately WIDER than the closure above: it takes every `./<name>.sh`
# appearing anywhere in a staged script, comments and message strings included.
#
# That width is the point, not an accident. run-server.sh tells the user, in an
# error it prints, to run `./stop-server.sh`; the manual at the head of the
# same file points at `./session-lifetime.sh` for how to choose MCP_MAX_SESSIONS.
# A payload that names a script it does not contain is lying to whoever reads
# it, whether the reference is executed or merely printed. And because this
# scan is wider than the one that decides the copying, it can genuinely fail:
# a script that references something upstream does not provide, or names a
# sibling in prose only, stops the build here rather than shipping.
#
# Only the payload root is scanned, because that is where `./` unambiguously
# resolves -- the flat set of scripts a user or src/mcp.ts runs in place.
echo "Checking that every './*.sh' the payload names is present"
SH_CHECKED=0
SH_MISSING=0
while IFS= read -r target; do
    SH_CHECKED=$((SH_CHECKED + 1))
    if [ ! -e "$DEST/$target" ]; then
        echo "  MISSING: $target" >&2
        SH_MISSING=$((SH_MISSING + 1))
    fi
done < <(grep -ohE '\./[A-Za-z0-9_.-]+\.sh' "$DEST"/*.sh | sed 's|^\./||' | sort -u)

if [ "$SH_MISSING" -ne 0 ]; then
    echo "ERROR: $SH_MISSING script(s) named by the payload are not in it." >&2
    echo "  Either mcp_server no longer provides them, or a staged script names" >&2
    echo "  a sibling in prose that nothing sources. Do NOT paper over this by" >&2
    echo "  adding names to a list -- fix the reference or widen ENTRYPOINTS." >&2
    exit 1
fi
# Same guard as the `input` scan's: a regex that matches nothing would report
# success for a payload it never looked at. Today the staged scripts name
# gs-env.sh, session-lifetime.sh and stop-server.sh between them.
if [ "$SH_CHECKED" -lt 3 ]; then
    echo "ERROR: only $SH_CHECKED './*.sh' references found; the payload's scripts name more." >&2
    echo "  The scan above is not matching -- fix it rather than trusting this build." >&2
    exit 1
fi
echo "  $SH_CHECKED referenced scripts, all present"

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
