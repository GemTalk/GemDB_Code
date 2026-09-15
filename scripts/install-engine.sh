#!/bin/bash
# Install the pinned database engine, with no editor in the loop.
#
# The extension downloads and extracts the engine itself on first activation
# (src/engine.ts, which is also the only path a user ever takes). This script
# is the same act for the machines where there is no extension host: CI, and a
# fresh checkout where `bundle:grail`, `test:extent` or `test:integration`
# are wanted before the extension has ever run.
#
# It installs to the one place everything else already looks --
# $HOME/GemDB/GemStone64Bit<pinned>-<platform> -- so nothing downstream needs
# configuring: bundle-grail.sh, build-test-extent.sh and the integration fixture
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

# The platform keys, matching platformKey() in src/platform.ts. These three are
# the whole list: they are what dl.gemdb.com publishes an engine for, and what
# CI builds a Grail shim on.
#
# Intel macOS is deliberately absent and is not coming. No engine is published
# for it at 4.0 -- the catalog's historical `i386.Darwin` spelling has no
# counterpart here -- so there is nothing to download even before the question
# of building its shim arises.
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)  PLATFORM="arm64.Darwin"  ; ARCHIVE_EXT="dmg" ;;
  Linux-aarch64) PLATFORM="arm64.Linux"   ; ARCHIVE_EXT="zip" ;;
  Linux-x86_64)  PLATFORM="x86_64.Linux"  ; ARCHIVE_EXT="zip" ;;
  *) echo "ERROR: unsupported platform $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

DIR_NAME="GemStone64Bit${VERSION}-${PLATFORM}"
DEST="$ROOT/$DIR_NAME"
ARCHIVE="$ROOT/${DIR_NAME}.${ARCHIVE_EXT}"
# Laid out by version, not by platform -- see CATALOG_BASE in src/engine.ts.
URL="https://dl.gemdb.com/${VERSION}/${DIR_NAME}.${ARCHIVE_EXT}"

# Say which half of "download failed" actually failed.
#
# Retries cannot fix a name that does not resolve, and the two look identical
# in a log: `curl: (6) Could not resolve host` repeated once per attempt reads
# exactly like a flaky network, so the reflex is to re-run the job. Measured on
# 2026-09-15, when that reflex cost an hour: dl.gemdb.com resolves from ns1 and
# answers NXDOMAIN, authoritatively, from ns2.commonhouse.net -- the other
# nameserver for the zone, whose copy is stale and missing the `dl` record.
# gemdb.com and www.gemdb.com are on both. So roughly half of the world's
# resolvers get "no such host", and because the zone's SOA sets the negative
# cache TTL to 86400, each one holds that answer for up to a DAY. Two CI
# re-runs four minutes apart failed identically while the Linux legs, on a
# resolver that had asked ns1, downloaded the same file fine.
#
# Nothing in this repository can fix that -- it is the zone's to fix -- but a
# run that says so costs no one the hour.
diagnose_download_failure() {
  # 6 is curl's CURLE_COULDNT_RESOLVE_HOST.
  [ "${1:-0}" -eq 6 ] || return 0
  host="${URL#https://}"
  host="${host%%/*}"
  {
    echo
    echo "That is a DNS failure, not a slow or flaky download: the name"
    echo "  $host"
    echo "did not resolve. Re-running will not help if the zone is serving"
    echo "inconsistent answers -- a negative answer is cached by the resolver,"
    echo "for as long as the zone's SOA says, regardless of how many times you"
    echo "ask. Check whether the nameservers agree:"
    echo
    echo "  for ns in \$(dig +short \$(echo $host | cut -d. -f2-) NS); do"
    echo "    echo \"\$ns: \$(dig +short @\$ns $host)\""
    echo "  done"
    echo
    echo "If one answers and another does not, that stale nameserver is the"
    echo "bug, and every user installing GemDB behind the wrong resolver hits"
    echo "it too -- src/engine.ts downloads from the same host."
  } >&2
}

# `sys/stoned` rather than the directory itself: a half-extracted tree is the
# failure mode worth catching, and it is the same file the integration fixture
# and build-test-extent.sh probe for.
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
  #
  # --retry-all-errors because curl's default retry set is narrow: without it a
  # 500 from the CDN, a connection reset mid-transfer, or a refused connection
  # is a hard failure on the first try. --connect-timeout bounds a black-holed
  # SYN, which otherwise sits for the OS default (~75s on macOS, ~130s on
  # Linux) before the first retry even begins. Five retries five seconds apart
  # is ~25s of patience rather than ~15s; the point is not the extra ten
  # seconds but that every class of transient error now gets them.
  #
  # `&& status=0 || status=$?` rather than `if ! curl ...; then status=$?`:
  # inside the negation the `$?` a `then` branch reads is the NEGATION's, which
  # is always 0 -- so that spelling both lost the reason for the failure and
  # made the script exit 0 on a download that never happened. Measured here,
  # and the same trap is written up in publish-to-registry.sh. A command on the
  # left of `||` is exempt from errexit, so nothing has to be toggled.
  curl --fail --location --retry 5 --retry-delay 5 --retry-all-errors \
    --connect-timeout 20 --no-progress-meter -o "$ARCHIVE.part" "$URL" &&
    status=0 || status=$?
  if [ "$status" -ne 0 ]; then
    rm -f "$ARCHIVE.part"
    diagnose_download_failure "$status"
    echo "ERROR: could not download $URL (curl exit $status)." >&2
    exit "$status"
  fi
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
