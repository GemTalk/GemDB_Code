#!/bin/bash
# Build the extent GemDB ships: a database with Grail already filed in.
#
#   npm run bundle:extent        (after npm run bundle:grail)
#
# Every user's database starts as a byte-for-byte copy of what this produces,
# so the file-in runs once here, on a machine we control, rather than several
# hundred Smalltalk files through topaz on each user's machine. That turns a
# per-install risk into a per-release one, which is the trade this exists for.
#
# The result is one file for every platform: extents are portable across
# GemStone's supported platforms at a given version, unlike the CPython shim,
# which has to be built per platform by bundle-grail.sh.
#
# Requires: an installed engine, shared memory configured, and a Grail payload.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$REPO/extent"
VERSION="$(sed -nE "s/^export const PINNED_ENGINE_VERSION = '(.+)';$/\1/p" "$REPO/src/config.ts")"
[ -n "$VERSION" ] || { echo "ERROR: could not read PINNED_ENGINE_VERSION from src/config.ts" >&2; exit 1; }

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) PLATFORM="arm64.Darwin" ;;
  # `i386.Darwin` is the vendor's spelling for the 64-bit Intel build, and it
  # is what platformKey() and bundle-grail.sh use. There is no
  # `x86_64.Darwin` engine directory to find.
  Darwin-x86_64) PLATFORM="i386.Darwin" ;;
  Linux-aarch64) PLATFORM="arm64.Linux" ;;
  Linux-x86_64) PLATFORM="x86_64.Linux" ;;
  *) echo "ERROR: unsupported platform $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

export GEMSTONE="${GEMSTONE:-$HOME/GemDB/GemStone64Bit${VERSION}-${PLATFORM}}"
[ -x "$GEMSTONE/sys/stoned" ] || {
  echo "ERROR: no engine at $GEMSTONE." >&2
  echo "       Install GemDB once from the editor, or set GEMSTONE to an existing tree." >&2
  exit 1
}
[ -f "$REPO/grail/GRAIL_VERSION" ] || {
  echo "ERROR: no Grail payload at $REPO/grail. Run 'npm run bundle:grail' first." >&2
  exit 1
}

# A scratch root of its own, so this cannot touch a real GemDB. GEMSTONE_GLOBAL_DIR
# is where the engine keeps its lock files and what gslist reads, so a stone
# started here is invisible to any other on this machine — including one that
# happens to share the name.
BUILD="$(mktemp -d "${TMPDIR:-/tmp}/gemdb-extent-XXXXXX")"
STONE="gemdbbuild"
NETLDI="gemdbbuildldi"
cleanup() {
  "$GEMSTONE/bin/stopnetldi" "$NETLDI" >/dev/null 2>&1 || true
  "$GEMSTONE/bin/stopstone" -i -t 30 "$STONE" DataCurator swordfish >/dev/null 2>&1 || true
  rm -rf "$BUILD"
}
trap cleanup EXIT

export GEMSTONE_GLOBAL_DIR="$BUILD"
export GEMSTONE_SYS_CONF="$BUILD/conf"
export GEMSTONE_EXE_CONF="$BUILD/conf"
export PATH="$GEMSTONE/bin:$PATH"
mkdir -p "$BUILD/conf" "$BUILD/data" "$BUILD/log" "$BUILD/locks"

cp "$GEMSTONE/bin/extent0.dbf" "$BUILD/data/extent0.dbf"
chmod 644 "$BUILD/data/extent0.dbf"

# Mirrors what src/database.ts writes, so the extent is built by the same
# engine configuration that will later open it.
cat > "$BUILD/conf/$STONE.conf" <<CONF
SHR_PAGE_CACHE_SIZE_KB = 100000;
KEYFILE = "$GEMSTONE/sys/community.starter.key";
DBF_EXTENT_NAMES = "$BUILD/data/extent0.dbf";
STN_TRAN_FULL_LOGGING = TRUE;
STN_TRAN_LOG_DIRECTORIES = "$BUILD/data/";
STN_TRAN_LOG_SIZES = 1000;
CONF

echo "==> starting a scratch stone in $BUILD"
startstone -z "$BUILD/conf/$STONE.conf" -l "$BUILD/log/$STONE.log" "$STONE"
startnetldi -a "$(id -un)" -g -l "$BUILD/log/$NETLDI.log" "$NETLDI"

echo "==> filing Grail in"
export GEMDB_STONE="$STONE" GEMDB_USER=DataCurator GEMDB_PASSWORD=swordfish
export GRAIL_DIR="$REPO/grail"
export PYTHON_PACKAGE_PATH="$REPO/grail/src/python"
export SHIM_LIB_PATH="$REPO/grail/src/c/shim/libcpython_ua.$([ "$(uname -s)" = Darwin ] && echo dylib || echo so)"
export GEMSTONE_NRS_ALL="#netldi:$NETLDI#dir:$BUILD"
( cd "$REPO/grail" && bash "$REPO/resources/install-grail.sh" )

echo "==> stopping cleanly so the extent is consistent"
stopnetldi "$NETLDI" >/dev/null 2>&1 || true
stopstone -t 120 "$STONE" DataCurator swordfish

mkdir -p "$DEST"
cp "$BUILD/data/extent0.dbf" "$DEST/gemdb.dbf"
chmod 644 "$DEST/gemdb.dbf"
cp "$REPO/grail/GRAIL_VERSION" "$DEST/GRAIL_VERSION"
printf 'engine=%s\n' "$VERSION" >> "$DEST/GRAIL_VERSION"

SIZE=$(du -h "$DEST/gemdb.dbf" | cut -f1)
echo "==> wrote $DEST/gemdb.dbf ($SIZE), built against engine $VERSION"
