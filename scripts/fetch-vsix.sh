#!/bin/bash
# Collect the packages a release publishes, from the CI run that tested them.
#
#   scripts/fetch-vsix.sh [run-id]
#
# GemDB ships one .vsix per platform, and the CPython shim inside each can only
# be compiled on that platform -- so no single machine can build the set. CI
# already does: each integration leg packages its own target and checks it, then
# uploads it as `vsix-<target>`. This brings those exact files down to `dist/`
# so publishing sends the bytes that were tested, rather than a local rebuild
# that was not.
#
# With no argument it uses the newest successful CI run for HEAD, which is the
# commit you are releasing. A run from some other commit is the mistake worth
# preventing here, so a version that disagrees with package.json is refused
# rather than published.
#
# It does not publish. That stays a deliberate command you type, and the exact
# one is printed at the end.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

DIST="$REPO/dist"
EXPECTED_TARGETS=(darwin-arm64 linux-x64 linux-arm64)
VERSION="$(node -p "require('$REPO/package.json').version")"

command -v gh >/dev/null 2>&1 || { echo "ERROR: the GitHub CLI (gh) is needed to download CI artifacts." >&2; exit 1; }

RUN_ID="${1:-}"
if [ -z "$RUN_ID" ]; then
  head_sha="$(git rev-parse HEAD)"
  RUN_ID="$(gh run list --workflow CI --status success --limit 40 \
    --json databaseId,headSha,conclusion \
    --jq "[.[] | select(.headSha == \"$head_sha\")] | first | .databaseId // empty")"
  if [ -z "$RUN_ID" ]; then
    echo "ERROR: no successful CI run found for HEAD ($(git rev-parse --short HEAD))." >&2
    echo "       Push the release commit and let CI finish, or pass a run id explicitly." >&2
    echo "       Recent runs:" >&2
    gh run list --workflow CI --limit 5 >&2
    exit 1
  fi
  echo "Using the successful CI run for HEAD: $RUN_ID"
fi

rm -rf "$DIST"
mkdir -p "$DIST"
echo "Downloading vsix-* artifacts from run $RUN_ID"
gh run download "$RUN_ID" --pattern 'vsix-*' --dir "$DIST"

# gh unpacks each artifact into dist/<artifact-name>/. Flatten, so the publish
# command is one glob rather than three paths.
find "$DIST" -mindepth 2 -name '*.vsix' -exec mv {} "$DIST/" \;
find "$DIST" -mindepth 1 -type d -empty -delete

fail=0
for target in "${EXPECTED_TARGETS[@]}"; do
  vsix="$DIST/gemdb-${target}-${VERSION}.vsix"
  if [ ! -f "$vsix" ]; then
    echo "  MISSING: $(basename "$vsix")" >&2
    # A version mismatch is the likely cause and the dangerous one: artifacts
    # from an older run package an older version, and publishing those ships
    # the wrong code under the new number.
    other="$(ls "$DIST"/gemdb-"${target}"-*.vsix 2>/dev/null | head -1 || true)"
    [ -n "$other" ] && echo "           (run $RUN_ID built $(basename "$other"), but package.json says $VERSION)" >&2
    fail=1
    continue
  fi
  scripts/check-vsix.sh "$vsix"
done

if [ "$fail" -ne 0 ]; then
  echo "ERROR: the run did not produce a checked package for every target at version $VERSION." >&2
  exit 1
fi

echo
echo "Ready in dist/ — $(ls "$DIST"/*.vsix | wc -l | tr -d ' ') packages at version $VERSION:"
ls -1sh "$DIST"/*.vsix | sed 's/^/  /'
cat <<EOF

Install the one for this machine and run it once, then publish both registries:

  npx vsce publish --skip-duplicate --packagePath dist/*.vsix
  npx ovsx publish --skip-duplicate --packagePath dist/*.vsix

--skip-duplicate makes a re-run after a Marketplace timeout safe: targets that
already published are skipped instead of failing the whole command.
EOF
