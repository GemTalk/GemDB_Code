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
# On success, stdout is exactly one line per package -- `result: published`,
# `result: already-published` or `result: awaiting-activation` -- in the order
# the packages were given, so a caller can read the outcomes with `$(...)`.
# Everything else, including the CLI's own output and the prose explaining a
# result, goes to stderr. Exits non-zero only when a package is genuinely not
# up.
#
# Given ONE package, the exit status is the CLI's own, so a caller can still
# tell a transport error from a rejection -- which is what a retry of a single
# target wants to know. Given several, there is no single status to report and
# a failure exits 1; the per-package `result:` lines and the summary carry the
# detail instead.
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

    echo "Publishing $(basename "$vsix") to $registry..." >&2

    # The message has to be captured to be classified, but capturing it alone
    # would lose it exactly when it matters most: the publish steps run under
    # `timeout-minutes`, and a hung CLI is killed by the runner, so a plain
    # `$(...)` would leave the log with the line above and nothing else -- no
    # CLI output at all -- in the one case where the CLI's own words are the
    # only evidence of whether the upload went out. `tee` to stderr keeps the
    # log live and still yields the text to classify.
    #
    # `$?` is the CLI's status, not tee's, because of the `pipefail` at the top:
    # `set +e` turns off errexit and leaves pipefail alone. ${PIPESTATUS[0]}
    # would NOT work here -- the pipeline runs inside the command
    # substitution's own subshell, so the parent's PIPESTATUS is that of the
    # assignment itself and always reads 0.
    #
    # `&& ... || ...` rather than a `set +e` / `set -e` pair, because toggling
    # errexit inside a function LEAKS: restoring it here re-armed it before the
    # return, so the caller's own `set +e` no longer covered the call and the
    # loop below exited at the first failing package instead of attempting the
    # rest -- the exact opposite of what this script is for. A command on the
    # left of `||` is exempt from errexit, so nothing has to be toggled at all.
    local output status
    output=$("${cmd[@]}" 2>&1 | tee /dev/stderr) && status=0 || status=$?

    if [ "$status" -eq 0 ]; then
        echo "result: published"
        return 0
    fi

    # Order matters: the inactive message also contains "is already published",
    # so the more specific case is tested first.
    if printf '%s' "$output" | grep -qiF "isn't active and therefore not visible"; then
        echo "result: awaiting-activation"
        echo "  Already uploaded and waiting for the registry to activate it. That is not a" >&2
        echo "  failure, and re-publishing cannot fix it -- the identity is taken." >&2
        return 0
    fi

    if printf '%s' "$output" | grep -qiE "is already published|already exists"; then
        echo "result: already-published"
        echo "  Already on $registry; nothing to do." >&2
        return 0
    fi

    echo "result: FAILED"
    return "$status"
}

# Progress and summary go to stderr, so stdout stays exactly one `result:` line
# per package and the header's promise is literally true.
failed=()
# The CLI's status for the one failure, kept only while there is exactly one --
# see the header. Flattening every failure to 1 would throw away the only thing
# that distinguishes a 500 from a rejection.
last_status=1
for vsix in "$@"; do
    echo >&2
    # Captured straight off the call, for the same reason as above -- and note
    # that inside an `if ! publish_one ...` the `$?` a `then` branch sees is
    # the negation's, which is always 0.
    publish_one "$vsix" && rc=0 || rc=$?
    if [ "$rc" -ne 0 ]; then
        failed+=("$(basename "$vsix")")
        last_status=$rc
    fi
done

echo >&2
if [ "${#failed[@]}" -eq 0 ]; then
    echo "All $# package(s) are up on $registry." >&2
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

if [ "${#failed[@]}" -eq 1 ] && [ "$#" -eq 1 ]; then
    exit "$last_status"
fi
exit 1
