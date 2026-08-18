#!/bin/bash
#
# Build the Grail payload that ships inside the .vsix.
#
# GemDB bundles Grail rather than cloning it at install time so that a new
# developer needs no C toolchain, no Python headers, and no network access
# beyond the engine download. The cost is that "latest Grail" means "the Grail
# that was latest when this extension was packaged" -- so run this as part of
# cutting a release, not once and forgotten.
#
# The prebuilt shim is specific to BOTH the platform and the engine version it
# was compiled against, so a full release runs this on each supported platform
# and merges the resulting grail/prebuilt/<platform>/ directories. Running it
# on one machine produces a .vsix that works only on that platform.
#
# Usage:
#   scripts/bundle-grail.sh                     # clone Grail's default branch
#   GRAIL_SRC=/path/to/Grail scripts/bundle-grail.sh   # use a local checkout
#
# Environment:
#   GRAIL_SRC   existing Grail checkout to bundle from (default: fresh clone)
#   GRAIL_REF   git ref to bundle when cloning (default: the default branch)
#   GEMSTONE    engine to build the shim against (default: the pinned version
#               under the GemDB root path)
#
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
DEST="$REPO_ROOT/grail"
GRAIL_URL="https://github.com/GemTalk/Grail.git"

# Keep this in step with PINNED_ENGINE_VERSION in src/config.ts. The shim links
# against $GEMSTONE/lib/gciualib.o, so it is only valid for the version it was
# built against -- bundling a shim built against a different engine than the one
# GemDB downloads produces a database that installs and then fails at import.
PINNED_ENGINE_VERSION=$(sed -n "s/^export const PINNED_ENGINE_VERSION = '\\(.*\\)';$/\\1/p" \
    "$REPO_ROOT/src/config.ts")
if [ -z "$PINNED_ENGINE_VERSION" ]; then
    echo "ERROR: could not read PINNED_ENGINE_VERSION from src/config.ts" >&2
    exit 1
fi

case "$(uname -s)" in
    Darwin)
        SHARED_EXT=dylib
        [ "$(uname -m)" = "arm64" ] && PLATFORM_KEY=arm64.Darwin || PLATFORM_KEY=i386.Darwin
        ;;
    Linux)
        SHARED_EXT=so
        [ "$(uname -m)" = "aarch64" ] && PLATFORM_KEY=arm64.Linux || PLATFORM_KEY=x86_64.Linux
        ;;
    *)
        echo "ERROR: unsupported platform $(uname -s)" >&2
        exit 1
        ;;
esac

GEMSTONE="${GEMSTONE:-$HOME/GemDB/GemStone64Bit${PINNED_ENGINE_VERSION}-${PLATFORM_KEY}}"
if [ ! -d "$GEMSTONE" ]; then
    echo "ERROR: no engine at $GEMSTONE." >&2
    echo "  Install GemDB once (which downloads it), or set GEMSTONE explicitly." >&2
    exit 1
fi
ACTUAL_VERSION=$(grep -oE '[0-9]+\.[0-9]+\.[0-9]+' "$GEMSTONE/version.txt" 2>/dev/null | head -1 || true)
if [ "$ACTUAL_VERSION" != "$PINNED_ENGINE_VERSION" ]; then
    echo "ERROR: \$GEMSTONE is version $ACTUAL_VERSION but GemDB pins $PINNED_ENGINE_VERSION." >&2
    echo "  A shim built against the wrong engine fails at run time, not install time." >&2
    exit 1
fi

# ---------------------------------------------------------------------------
# Obtain the Grail sources.
# ---------------------------------------------------------------------------
WORKDIR=""
cleanup() { [ -n "$WORKDIR" ] && rm -rf "$WORKDIR"; }
trap cleanup EXIT

if [ -n "${GRAIL_SRC:-}" ]; then
    SRC=$(cd "$GRAIL_SRC" && pwd)
    echo "Bundling Grail from local checkout: $SRC"
else
    WORKDIR=$(mktemp -d)
    SRC="$WORKDIR/Grail"
    echo "Cloning Grail from $GRAIL_URL"
    git clone --depth 1 ${GRAIL_REF:+--branch "$GRAIL_REF"} "$GRAIL_URL" "$SRC"
fi

GRAIL_COMMIT=$(git -C "$SRC" rev-parse --short HEAD 2>/dev/null || echo unknown)
GRAIL_DESCRIBE=$(git -C "$SRC" describe --tags --always --dirty 2>/dev/null || echo unknown)
echo "Grail commit: $GRAIL_COMMIT ($GRAIL_DESCRIBE)"

# ---------------------------------------------------------------------------
# Verify the scripts GemDB's installer drives are actually there.
# ---------------------------------------------------------------------------
# resources/install-grail.sh names these directly. If Grail reorganizes, that
# has to fail here -- at package time, where someone is watching -- rather than
# on a new developer's first run.
REQUIRED=(
    src/smalltalk/install.gs
    scripts/session_methods_env1_base_37.gs
    scripts/install_base37.gs
    scripts/install_base40.gs
    scripts/set_base_marker.gs
    scripts/setUnicodeMode.sh
    scripts/grail.tpz
    src/c/shim/Makefile
    src/python
)
for item in "${REQUIRED[@]}"; do
    if [ ! -e "$SRC/$item" ]; then
        echo "ERROR: Grail no longer provides $item -- GemDB's installer needs it." >&2
        exit 1
    fi
done

# ---------------------------------------------------------------------------
# Build the CPython shim against the pinned engine.
# ---------------------------------------------------------------------------
echo "Building the CPython shim for $PLATFORM_KEY against engine $PINNED_ENGINE_VERSION"
make -C "$SRC/src/c/shim" clean all GEMSTONE="$GEMSTONE"
SHIM="$SRC/src/c/shim/libcpython_ua.$SHARED_EXT"
[ -f "$SHIM" ] || { echo "ERROR: shim build produced no $SHIM" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Assemble the payload.
# ---------------------------------------------------------------------------
# Existing prebuilt shims for OTHER platforms are preserved, so a release can
# be assembled by running this script on each platform against the same
# working tree.
echo "Assembling $DEST"
PRESERVED=""
if [ -d "$DEST/prebuilt" ]; then
    PRESERVED=$(mktemp -d)
    cp -R "$DEST/prebuilt/." "$PRESERVED/"
fi
rm -rf "$DEST"
mkdir -p "$DEST"

# All of src/, plus the scripts the installer and REPL drive.
#
# src/ is copied WHOLESALE rather than as a hand-picked list of subdirectories.
# An earlier version named src/smalltalk and src/python explicitly and silently
# omitted src/weakref, which install.gs files in -- the install then ran for
# minutes before dying on a missing file. Grail decides what its source tree
# contains; this script's job is to carry it, not to curate it.
#
# src/c is the exception, and only because it is genuinely replaced: the shim
# built from it is staged into prebuilt/ above, so shipping the C sources would
# add weight nothing reads. Docs, benchmarks, and tests are simply not copied.
cp -R "$SRC/src" "$DEST/src"
rm -rf "$DEST/src/c"
cp -R "$SRC/scripts" "$DEST/scripts"
for item in LICENSE README.md; do
    [ -e "$SRC/$item" ] && cp "$SRC/$item" "$DEST/$item"
done
find "$DEST" \( -name '*.o' -o -name '*.out' -o -name '__pycache__' \) -exec rm -rf {} + 2>/dev/null || true

# ---------------------------------------------------------------------------
# Verify every file the topaz scripts read is actually in the payload.
# ---------------------------------------------------------------------------
# `input <path>` is how a .gs script pulls in another file, and topaz resolves
# it relative to the working directory -- so a missing target is not caught
# until the install is already running against a live database. Scanning the
# assembled payload for those targets turns that into a packaging error, here,
# where someone is watching.
#
# The match is deliberately narrow in two ways. The `./` prefix is optional, so
# both `input src/x.gs` and `input ./src/x.gs` are seen. And the target must end
# in `.gs`, because prose inside comments occasionally begins a line with the
# word "input" — without that anchor the scan reports words like "rather" as
# missing files, and a check that cries wolf gets ignored.
#
# out/gen/ is skipped: resources/install-grail.sh generates it at install time.
echo "Checking that every 'input' target is present"
CHECKED=0
MISSING=0
while IFS= read -r target; do
    case "$target" in
        out/*) continue ;;
    esac
    CHECKED=$((CHECKED + 1))
    if [ ! -e "$DEST/$target" ]; then
        echo "  MISSING: $target" >&2
        MISSING=$((MISSING + 1))
    fi
done < <(find "$DEST" -name '*.gs' -exec \
    sed -nE 's|^[[:space:]]*input[[:space:]]+(\./)?([A-Za-z0-9_./-]+\.gs).*|\2|p' {} + | sort -u)

if [ "$MISSING" -ne 0 ]; then
    echo "ERROR: $MISSING file(s) referenced by Grail's install scripts are not in the payload." >&2
    echo "  Grail's source tree has changed shape; adjust the copy step above." >&2
    exit 1
fi
# A scan that silently matches nothing is worse than no scan: it reports success
# for a payload it never looked at. An earlier version of this regex did exactly
# that, and the missing file surfaced minutes into a user's install instead.
if [ "$CHECKED" -lt 100 ]; then
    echo "ERROR: only $CHECKED 'input' targets found; Grail files in hundreds." >&2
    echo "  The scan above is not matching -- fix it rather than trusting this build." >&2
    exit 1
fi
echo "  $CHECKED referenced files, all present"

mkdir -p "$DEST/prebuilt/$PLATFORM_KEY"
[ -n "$PRESERVED" ] && cp -R "$PRESERVED/." "$DEST/prebuilt/"
cp "$SHIM" "$DEST/prebuilt/$PLATFORM_KEY/"
[ -n "$PRESERVED" ] && rm -rf "$PRESERVED"

# The stamp is what GemDB compares to decide whether a staged Grail is current.
# It names the engine too: a shim built against another engine is not
# interchangeable, so an engine change must force a restage.
cat > "$DEST/GRAIL_VERSION" <<EOF
grail=$GRAIL_DESCRIBE
commit=$GRAIL_COMMIT
engine=$PINNED_ENGINE_VERSION
EOF

echo
echo "Bundled Grail $GRAIL_DESCRIBE with a $PLATFORM_KEY shim for engine $PINNED_ENGINE_VERSION."
echo "Prebuilt shims now present:"
ls -1 "$DEST/prebuilt"
