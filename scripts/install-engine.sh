#!/bin/bash
# Install the pinned database engine, with no editor in the loop.
#
# The extension downloads and extracts the engine itself on first activation
# (src/engine.ts, which is also the only path a user ever takes). This script
# is the same act for the machines where there is no extension host: CI, and a
# fresh checkout where `bundle:grail`, `bundle:extent` or `test:integration`
# are wanted before the extension has ever run.
#
# It installs to the one place everything else already looks --
# $HOME/GemDB/GemStone64Bit<pinned>-<platform> -- so nothing downstream needs
# configuring: bundle-grail.sh, bundle-extent.sh and the integration fixture
# all default to exactly that path.
#
# Idempotent, in two steps. An engine already installed is left alone. An
# archive already downloaded is reused rather than fetched again, which is what
# makes the download cheap to cache: the archive stays beside the engine (as
# the extension's own download does) instead of being deleted after extraction.
#
# Usage:
#   scripts/install-engine.sh
#
# Environment:
#   GEMDB_ROOT  where the engine and its archive go (default $HOME/GemDB, the
#               `gemdb.rootPath` default in src/config.ts)

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="${GEMDB_ROOT:-$HOME/GemDB}"

# One source of truth, read rather than duplicated: a shim or an extent built
# against a different engine than the extension downloads installs cleanly and
# then fails at run time, so every script in here reads the pin the same way.
VERSION="$(sed -nE "s/^export const PINNED_ENGINE_VERSION = '(.+)';$/\1/p" "$REPO/src/config.ts")"
[ -n "$VERSION" ] || { echo "ERROR: could not read PINNED_ENGINE_VERSION from src/config.ts" >&2; exit 1; }

# The catalog's platform keys, matching platformKey() in src/platform.ts. 1.x
# ships arm64.Darwin only, but the other keys are spelled correctly here for
# the same reason platform.ts spells them: those platforms are a build away,
# not a port.
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)  PLATFORM="arm64.Darwin"  ; ARCHIVE_EXT="dmg" ;;
  Darwin-x86_64) PLATFORM="x86_64.Darwin" ; ARCHIVE_EXT="dmg" ;;
  Linux-aarch64) PLATFORM="arm64.Linux"   ; ARCHIVE_EXT="zip" ;;
  Linux-x86_64)  PLATFORM="x86_64.Linux"  ; ARCHIVE_EXT="zip" ;;
  *) echo "ERROR: unsupported platform $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

DIR_NAME="GemStone64Bit${VERSION}-${PLATFORM}"
DEST="$ROOT/$DIR_NAME"
ARCHIVE="$ROOT/${DIR_NAME}.${ARCHIVE_EXT}"
URL="https://downloads.gemtalksystems.com/platforms/${PLATFORM}/${DIR_NAME}.${ARCHIVE_EXT}"

# `sys/stoned` rather than the directory itself: a half-extracted tree is the
# failure mode worth catching, and it is the same file the integration fixture
# and bundle-extent.sh probe for.
if [ -x "$DEST/sys/stoned" ]; then
  echo "Engine $VERSION is already installed at $DEST"
  exit 0
fi

mkdir -p "$ROOT"

if [ -f "$ARCHIVE" ]; then
  echo "Reusing the archive already downloaded at $ARCHIVE"
else
  echo "Downloading $URL"
  # Downloaded to a temporary name and renamed on success, so an interrupted
  # run cannot leave a partial file that the next run would happily "reuse".
  curl --fail --location --retry 3 --retry-delay 5 --no-progress-meter \
    -o "$ARCHIVE.part" "$URL"
  mv "$ARCHIVE.part" "$ARCHIVE"
fi

echo "Extracting into $ROOT"
if [ "$ARCHIVE_EXT" = "dmg" ]; then
  # Mirrors extractDmg() in src/engine.ts: mount, copy out the one
  # GemStone64Bit* directory the image contains, detach whatever happens.
  MOUNT="$(hdiutil attach -nobrowse -readonly "$ARCHIVE" | grep -o '/Volumes/.*' | tail -1)"
  [ -n "$MOUNT" ] || { echo "ERROR: could not find the mount point for $ARCHIVE" >&2; exit 1; }
  trap 'hdiutil detach "$MOUNT" >/dev/null 2>&1 || true' EXIT
  ENTRY="$(cd "$MOUNT" && ls -d GemStone64Bit* 2>/dev/null | head -1)"
  [ -n "$ENTRY" ] || { echo "ERROR: no engine directory inside $MOUNT" >&2; exit 1; }
  rm -rf "$ROOT/$ENTRY"
  cp -R "$MOUNT/$ENTRY" "$ROOT/$ENTRY"
else
  unzip -o -q "$ARCHIVE" -d "$ROOT"
fi

# The archive's own directory name is trusted no further than this: everything
# downstream resolves $DEST by the pinned version, so a mismatch has to fail
# here rather than as a confusing "no engine at ..." two scripts later.
[ -x "$DEST/sys/stoned" ] || {
  echo "ERROR: expected an engine at $DEST after extracting $ARCHIVE." >&2
  echo "       The archive contained: $(ls "$ROOT" | tr '\n' ' ')" >&2
  exit 1
}

echo "Installed engine $VERSION at $DEST"
