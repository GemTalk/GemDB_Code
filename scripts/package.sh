#!/bin/bash
# Package the extension, and never leave a .vsix unchecked.
#
#   npm run package            # the target matching this machine
#   npm run package:all        # all three targets (needs all three shims)
#   scripts/package.sh linux-x64 [more targets...]
#
# GemDB ships platform-specific packages, so the Marketplace offers each machine
# only the build that can work on it. The risk that comes with that is quiet: a
# cross-target `vsce package` succeeds on a tree that has never built the shim
# for the target being packaged, and the result installs perfectly and fails at
# the first `import`. So every package here is immediately handed to
# check-vsix.sh, which knows what each target must carry.
#
# All three shims ride along in every package (276 KB each). Pruning the tree
# per target would save a fraction of a megabyte and cost a
# move-package-restore dance around build artifacts; .vscodeignore makes the
# same trade for koffi's binaries.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

ALL_TARGETS=(darwin-arm64 linux-x64 linux-arm64)

# The target for the machine running this, using the same two facts
# isSupportedPlatform() reads. Intel macOS is deliberately absent: no shim is
# built for it (see src/platform.ts).
this_machine_target() {
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64)  echo darwin-arm64 ;;
    Linux-x86_64)  echo linux-x64 ;;
    Linux-aarch64) echo linux-arm64 ;;
    *) return 1 ;;
  esac
}

TARGETS=()
if [ $# -eq 0 ]; then
  if ! target="$(this_machine_target)"; then
    echo "ERROR: $(uname -s)-$(uname -m) is not a target this extension ships." >&2
    echo "       Name a target explicitly, or use --all: ${ALL_TARGETS[*]}" >&2
    exit 1
  fi
  TARGETS=("$target")
else
  for arg in "$@"; do
    case "$arg" in
      --all) TARGETS=("${ALL_TARGETS[@]}") ;;
      -*) echo "ERROR: unknown option $arg" >&2; exit 1 ;;
      *) TARGETS+=("$arg") ;;
    esac
  done
fi

# One bundle for every target: out/*.js is platform-neutral, and vsce's
# `vscode:prepublish` would otherwise rebuild it once per target for nothing.
echo "== Bundling"
npm run --silent bundle

for target in "${TARGETS[@]}"; do
  echo
  echo "== Packaging $target"
  npx --no-install vsce package --target "$target"
  # vsce writes gemdb-<target>-<version>.vsix; check-vsix.sh reads the target
  # back out of that name rather than being told twice.
  version="$(node -p "require('$REPO/package.json').version")"
  scripts/check-vsix.sh "$REPO/gemdb-${target}-${version}.vsix"
done

echo
echo "Packaged and checked: ${TARGETS[*]}"
