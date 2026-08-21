#!/bin/bash
# Check that a packaged .vsix contains the things a working install needs.
#
#   scripts/check-vsix.sh [path/to/extension.vsix]
#
# A release here ships a database and a compiled Python runtime, not just the
# code to build them, and both are gitignored build artifacts. So the ways a
# .vsix goes wrong are not compile errors: it packages cleanly from a tree where
# `bundle:grail` was never run, or was run on the wrong platform, or where
# `bundle:extent` predates the last change -- and the result installs fine and
# then fails at the first `import`. CONTRIBUTING.md answers that with "install
# the .vsix and run it once", which is still the real test; this is the cheap
# check that runs first, in CI and before publishing.
#
# The negative assertions matter as much as the positive ones: .vscodeignore
# deliberately ships exactly ONE of koffi's 18 platform binaries, and a filter
# that stops working silently adds ~26 MB of binaries that can never load.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The platform 1.x ships. This must agree with isSupportedPlatform() in
# src/platform.ts, `--target darwin-arm64` in package.json, and the koffi
# filter in .vscodeignore -- adding a platform means adding it in all four.
PLATFORM_KEY="arm64.Darwin"
KOFFI_KEY="darwin_arm64"

VSIX="${1:-}"
if [ -z "$VSIX" ]; then
  # Newest first, so a stale .vsix from an earlier version is never the one
  # checked while a fresh one sits beside it.
  VSIX="$(ls -t "$REPO"/*.vsix 2>/dev/null | head -1 || true)"
  [ -n "$VSIX" ] || { echo "ERROR: no .vsix found in $REPO. Run 'npm run package' first." >&2; exit 1; }
fi
[ -f "$VSIX" ] || { echo "ERROR: no such file: $VSIX" >&2; exit 1; }

LISTING="$(unzip -Z1 "$VSIX")"

# Everything a user needs for the extension to work at all. Each entry is an
# exact path inside the archive, with the reason it has to be there.
REQUIRED=(
  "extension/package.json|the manifest"
  "extension/out/extension.js|the extension bundle"
  "extension/out/gemdb-shell.js|the GemDB Shell, staged to <rootPath>/bin at run time"
  "extension/extent/gemdb.dbf|the preloaded database"
  "extension/grail/GRAIL_VERSION|the Grail payload"
  "extension/grail/prebuilt/$PLATFORM_KEY/libcpython_ua.dylib|the CPython shim for $PLATFORM_KEY"
  "extension/grail/scripts/grail.tpz|the Grail scripts the installer drives"
  "extension/node_modules/koffi/build/koffi/$KOFFI_KEY/koffi.node|the native FFI addon"
  "extension/resources/install-grail.sh|the installer the extension runs"
  "extension/resources/setSharedMemoryDarwin.sh|the shared-memory script the sudo prompt runs"
)

missing=0
for entry in "${REQUIRED[@]}"; do
  path="${entry%%|*}"
  why="${entry#*|}"
  if ! grep -qxF "$path" <<<"$LISTING"; then
    echo "  MISSING: $path -- $why" >&2
    missing=$((missing + 1))
  fi
done

# Things that must NOT be there. Each is a grep -E pattern over the listing,
# with what shipping it would mean.
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

# grep -E has no negative lookahead, so the koffi check is done by subtraction:
# every platform directory except this build's is unwanted.
koffi_others="$(grep -E '^extension/node_modules/koffi/build/koffi/' <<<"$LISTING" |
  grep -vE "^extension/node_modules/koffi/build/koffi/$KOFFI_KEY/" || true)"
if [ -n "$koffi_others" ]; then
  echo "  UNWANTED: koffi binaries for other platforms (~26 MB that can never load):" >&2
  head -3 <<<"$koffi_others" | sed 's/^/      /' >&2
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
  [ "$missing" -eq 0 ] || echo "       A missing artifact usually means 'npm run bundle:grail' or 'npm run bundle:extent' was not run." >&2
  exit 1
fi

echo "The .vsix carries everything a working install needs."
