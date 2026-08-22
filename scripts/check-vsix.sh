#!/bin/bash
# Check that a packaged .vsix contains the things a working install needs.
#
#   scripts/check-vsix.sh [path/to/extension.vsix] [--target <vsce-target>]
#
# A release here ships a database and a compiled Python runtime, not just the
# code to build them, and both are gitignored build artifacts. So the ways a
# .vsix goes wrong are not compile errors: it packages cleanly from a tree where
# `bundle:grail` was never run, or was run on a different platform than the
# target being packaged, or where `bundle:extent` predates the last change --
# and the result installs fine and then fails at the first `import`.
# CONTRIBUTING.md answers that with "install the .vsix and run it once", which
# is still the real test; this is the cheap check that runs first, in CI and
# before publishing.
#
# The per-target check matters more now that one source tree produces several
# .vsix files. `vsce package --target linux-x64` run on a tree that has never
# built a Linux shim packages happily and ships a Linux user something that
# cannot import; the only thing standing between that and the Marketplace is
# this script, which is why scripts/package.sh refuses to leave a .vsix
# unchecked.
#
# The negative assertions matter as much as the positive ones: .vscodeignore
# ships koffi binaries for the supported platforms only, and a filter that stops
# working silently adds ~21 MB of binaries that can never load.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

VSIX=""
TARGET=""
while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="${2:-}"; shift 2 ;;
    --target=*) TARGET="${1#*=}"; shift ;;
    -*) echo "ERROR: unknown option $1" >&2; exit 1 ;;
    *) VSIX="$1"; shift ;;
  esac
done

if [ -z "$VSIX" ]; then
  # Newest first, so a stale .vsix from an earlier version is never the one
  # checked while a fresh one sits beside it.
  VSIX="$(ls -t "$REPO"/*.vsix 2>/dev/null | head -1 || true)"
  [ -n "$VSIX" ] || { echo "ERROR: no .vsix found in $REPO. Run 'npm run package' first." >&2; exit 1; }
fi
[ -f "$VSIX" ] || { echo "ERROR: no such file: $VSIX" >&2; exit 1; }

# vsce names a platform-specific package `gemdb-<target>-<version>.vsix`, so the
# target is carried by the artifact itself. Reading it from the filename means
# checking a .vsix cannot silently check it against the wrong platform's
# expectations -- which is the whole point when one tree produces three.
if [ -z "$TARGET" ]; then
  base="$(basename "$VSIX")"
  TARGET="$(sed -nE 's/^gemdb-(.+)-[0-9]+\.[0-9]+\.[0-9]+\.vsix$/\1/p' <<<"$base")"
  [ -n "$TARGET" ] || {
    echo "ERROR: could not read the target from '$base'." >&2
    echo "       Expected gemdb-<target>-<version>.vsix; pass --target to override." >&2
    exit 1
  }
fi

# The three columns that vary per target: the engine/shim platform key, koffi's
# own triplet, and the shared-library suffix. Must agree with platformKey() and
# sharedLibraryExtension() in src/platform.ts, the koffi list in .vscodeignore,
# and the targets in package.json.
case "$TARGET" in
  darwin-arm64) PLATFORM_KEY="arm64.Darwin"  ; KOFFI_KEY="darwin_arm64" ; LIB_EXT="dylib" ;;
  linux-x64)    PLATFORM_KEY="x86_64.Linux"  ; KOFFI_KEY="linux_x64"    ; LIB_EXT="so"    ;;
  linux-arm64)  PLATFORM_KEY="arm64.Linux"   ; KOFFI_KEY="linux_arm64"  ; LIB_EXT="so"    ;;
  *)
    echo "ERROR: '$TARGET' is not a target this extension ships." >&2
    echo "       Known: darwin-arm64, linux-x64, linux-arm64." >&2
    echo "       Adding one means updating isSupportedPlatform(), .vscodeignore," >&2
    echo "       package.json's package:* targets, and this case statement." >&2
    exit 1 ;;
esac

echo "Checking $(basename "$VSIX") as $TARGET ($PLATFORM_KEY)"
LISTING="$(unzip -Z1 "$VSIX")"

# Everything a user needs for the extension to work at all. Each entry is an
# exact path inside the archive, with the reason it has to be there.
REQUIRED=(
  "extension/package.json|the manifest"
  "extension/out/extension.js|the extension bundle"
  "extension/out/gemdb-shell.js|the GemDB Shell, staged to <rootPath>/bin at run time"
  "extension/extent/gemdb.dbf|the preloaded database (portable across platforms)"
  "extension/grail/GRAIL_VERSION|the Grail payload"
  "extension/grail/prebuilt/$PLATFORM_KEY/libcpython_ua.$LIB_EXT|the CPython shim for $PLATFORM_KEY"
  "extension/grail/scripts/grail.tpz|the Grail scripts the installer drives"
  "extension/node_modules/koffi/build/koffi/$KOFFI_KEY/koffi.node|the native FFI addon for $TARGET"
  "extension/resources/install-grail.sh|the installer the extension runs"
)

# Platform-specific extras: the OS-configuration script this target's users are
# asked to run under sudo. Shipping the wrong one is a first run that cannot
# raise shared memory.
case "$TARGET" in
  darwin-*) REQUIRED+=("extension/resources/setSharedMemoryDarwin.sh|the shared-memory script for macOS") ;;
  linux-*)  REQUIRED+=("extension/resources/setSharedMemoryLinux.sh|the shared-memory script for Linux")
            REQUIRED+=("extension/resources/setRemoveIPC.sh|the RemoveIPC script systemd hosts need") ;;
esac

missing=0
for entry in "${REQUIRED[@]}"; do
  path="${entry%%|*}"
  why="${entry#*|}"
  if ! grep -qxF "$path" <<<"$LISTING"; then
    echo "  MISSING: $path -- $why" >&2
    missing=$((missing + 1))
  fi
done

unwanted=0
check_absent() {
  local pattern="$1" why="$2" hits
  hits="$(grep -cE "$pattern" <<<"$LISTING" || true)"
  if [ "$hits" -ne 0 ]; then
    echo "  UNWANTED: $hits entr(y/ies) matching $pattern -- $why" >&2
    grep -E "$pattern" <<<"$LISTING" | head -3 | sed 's/^/      /' >&2
    unwanted=$((unwanted + 1))
  fi
}

# A shim for another SUPPORTED platform is expected, not a fault: a shim is
# 276 KB, so all three ride along in every target rather than pruning the tree
# per package (the same trade .vscodeignore makes for koffi, and it avoids
# moving build artifacts around mid-package). What must be true is that the
# target's OWN shim is there, which REQUIRED above asserts, and that nothing
# outside the supported set crept in.
shim_extra="$(grep -E '^extension/grail/prebuilt/[^/]+/' <<<"$LISTING" |
  sed -E 's|^extension/grail/prebuilt/([^/]+)/.*|\1|' | sort -u |
  grep -vE '^(arm64\.Darwin|x86_64\.Linux|arm64\.Linux)$' || true)"
if [ -n "$shim_extra" ]; then
  echo "  UNWANTED: shim(s) for platforms this release does not support: $(tr '\n' ' ' <<<"$shim_extra")" >&2
  echo "      Either widen isSupportedPlatform() and this script, or remove the stale prebuilt/ directory." >&2
  unwanted=$((unwanted + 1))
fi

# grep -E has no negative lookahead, so the koffi check is done by subtraction.
# Same reasoning as the shims: other supported platforms' koffi binaries are
# expected, since one static .vscodeignore serves every target (see the note
# there). Only binaries outside the supported set are wasted weight.
koffi_extra="$(grep -E '^extension/node_modules/koffi/build/koffi/' <<<"$LISTING" |
  sed -E 's|^(extension/node_modules/koffi/build/koffi/[^/]+)/.*|\1|' | sort -u |
  grep -vE "/(darwin_arm64|linux_x64|linux_arm64)$" || true)"
if [ -n "$koffi_extra" ]; then
  echo "  UNWANTED: koffi binaries outside the supported set (~1.5 MB each that can never load):" >&2
  head -3 <<<"$koffi_extra" | sed 's/^/      /' >&2
  unwanted=$((unwanted + 1))
fi

check_absent '^extension/src/' "the sources are build inputs, not payload"
check_absent '\.map$' "source maps belong in a debug build, not a release"
check_absent '^extension/grail/\.git' "a whole Grail clone would ship"
check_absent '^extension/grail/\.topazini' "stray topaz credentials"

size_mb=$(( $(wc -c <"$VSIX") / 1024 / 1024 ))
echo "$(basename "$VSIX"): $(wc -l <<<"$LISTING" | tr -d ' ') files, ${size_mb} MB"

if [ "$missing" -ne 0 ] || [ "$unwanted" -ne 0 ]; then
  echo "ERROR: $missing required path(s) missing, $unwanted unwanted group(s) present." >&2
  [ "$missing" -eq 0 ] || echo "       A missing artifact usually means 'npm run bundle:grail' was not run on $PLATFORM_KEY, or 'npm run bundle:extent' was never run." >&2
  exit 1
fi

echo "The .vsix carries everything a working $TARGET install needs."
