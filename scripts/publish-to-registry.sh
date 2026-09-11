#!/usr/bin/env bash
#
# Publishes already-built .vsix packages to one registry, one at a time, and
# decides what each outcome actually means.
#
# The decision is the point of this script. Both registries are immutable per
# (publisher, name, version, targetPlatform): a package identity, once taken,
# can never be reused -- even deleting a version leaves it reserved. So a
# re-run after a partial failure must treat "this one is already there" as
# success rather than as an error, or the only way out of a half-finished
# release is to burn the next version number too.
#
# `--skip-duplicate` gets that right for one of the two ways a package can
# already be there, and wrong for the other. ovsx's check is literally
#
#     err.message.endsWith('is already published.')      (ovsx/lib/publish.js)
#
# but a package that landed and has NOT been activated yet reports
#
#     ...is already published, but currently isn't active and therefore not visible.
#
# which does not match that suffix, so ovsx fails hard. That inactive window is
# the normal state for the first minutes after an upload, so it is precisely
# the state a re-run meets, and precisely where --skip-duplicate stops working.
# Both spellings are treated as success here; the flag stays on as a backstop
# for the race between a state check and the upload.
#
# One invocation per package, in a loop, rather than one invocation given every
# package: `vsce publish --packagePath a.vsix b.vsix` is a single command whose
# failure on the second package tells you nothing about the first and leaves
# the third unattempted. GemDB ships three, so that matters three ways. Every
# package is attempted even after one fails, and the failures are reported
# together at the end -- the same reasoning that puts the two registries in
# separate jobs.
#
# Prints one of `published`, `already-published`, `awaiting-activation` per
# package. Exits non-zero only when a package is genuinely not up.
#
# Usage: scripts/publish-to-registry.sh <marketplace|openvsx> <vsix>...
# Env:   VSCE_PAT (marketplace) or OVSX_PAT (openvsx)

set -euo pipefail

if [ "$#" -lt 2 ]; then
    echo "usage: $0 <marketplace|openvsx> <vsix>..." >&2
    exit 2
fi

registry="$1"
shift

case "$registry" in
    marketplace | openvsx) ;;
    *)
        echo "error: unknown registry '$registry' (expected marketplace or openvsx)." >&2
        exit 2
        ;;
esac

for vsix in "$@"; do
    if [ ! -f "$vsix" ]; then
        echo "error: $vsix not found." >&2
        exit 2
    fi
done

# Publish one package. Returns 0 when the package is up, whether this call put
# it there or found it already there.
publish_one() {
    local vsix="$1"
    local -a cmd
    case "$registry" in
        marketplace) cmd=(npx --no-install @vscode/vsce publish --packagePath "$vsix" --skip-duplicate) ;;
        openvsx) cmd=(npx --no-install ovsx publish --packagePath "$vsix" --skip-duplicate) ;;
    esac

    echo "Publishing $(basename "$vsix") to $registry..."

    # Capture rather than stream so the message can be classified; echo it back
    # either way, so the log still shows exactly what the CLI said.
    local output status
    set +e
    output=$("${cmd[@]}" 2>&1)
    status=$?
    set -e

    printf '%s\n' "$output"

    if [ "$status" -eq 0 ]; then
        echo "result: published"
        return 0
    fi

    # Order matters: the inactive message also contains "is already published",
    # so the more specific case is tested first.
    if printf '%s' "$output" | grep -qiF "isn't active and therefore not visible"; then
        echo "result: awaiting-activation"
        echo "  Already uploaded and waiting for the registry to activate it. That is not a"
        echo "  failure, and re-publishing cannot fix it -- the identity is taken."
        return 0
    fi

    if printf '%s' "$output" | grep -qiE "is already published|already exists"; then
        echo "result: already-published"
        echo "  Already on $registry; nothing to do."
        return 0
    fi

    echo "result: FAILED" >&2
    return "$status"
}

failed=()
for vsix in "$@"; do
    echo
    if ! publish_one "$vsix"; then
        failed+=("$(basename "$vsix")")
    fi
done

echo
if [ "${#failed[@]}" -eq 0 ]; then
    echo "All $# package(s) are up on $registry."
    exit 0
fi

echo "error: $registry did not accept ${#failed[@]} of $# package(s):" >&2
printf '  %s\n' "${failed[@]}" >&2
echo >&2
echo "Both registries are immutable per (publisher, name, version, target), so if any" >&2
echo "part of an upload landed, that identity is spent: fix forward with the next patch" >&2
echo "version rather than retrying this one. The packages that DID publish above are" >&2
echo "already live and must not be republished. See CONTRIBUTING.md, 'Publishing a" >&2
echo "release'." >&2
exit 1
