#!/usr/bin/env bash
#
# Waits until both registries are serving every target's package for a version.
#
# Both publish CLIs report success as soon as the *upload* is accepted; the
# package then takes anywhere from a couple of minutes to some tens of minutes
# to appear in a gallery query. Six independent things have to land here --
# three targets on each of two registries -- and any of them can lag the rest,
# so a release is not done when the CLIs say so.
#
# This is a report, not a gate. By the time it runs, the GitHub Release, the tag
# and every upload already exist, so a timeout here withholds nothing and fixes
# nothing; it says the registries are slower than the budget, or that one
# target did not land. Which of those it is, is not knowable from here -- see
# scripts/registry-state.sh.
#
# It uses scripts/registry-state.sh so the wait and any other check share one
# state model and cannot disagree about what "serving" means.
#
# Exits 0 once all six are visible, 1 on timeout.
#
# Usage: scripts/await-published-version.sh <version>
# Env:   NAMESPACE, EXTENSION (passed through to registry-state.sh),
#        TARGETS (space-separated; default is the three shipped targets),
#        TIMEOUT_SECONDS (default 1800), POLL_INTERVAL_SECONDS (default 30)

set -euo pipefail

if [ "$#" -ne 1 ]; then
    echo "usage: $0 <version>   e.g. $0 1.5.0" >&2
    exit 2
fi

version="$1"
timeout_seconds="${TIMEOUT_SECONDS:-1800}"
poll_interval="${POLL_INTERVAL_SECONDS:-30}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Kept in step with the targets in package.json and scripts/package.sh. A
# target missing from this list would be published and then never waited for,
# which is the quiet half of the failure this script exists to make loud.
read -r -a targets <<<"${TARGETS:-darwin-arm64 linux-x64 linux-arm64}"

pending=()
for registry in openvsx marketplace; do
    for target in "${targets[@]}"; do
        pending+=("${registry}/${target}")
    done
done

deadline=$(($(date +%s) + timeout_seconds))

echo "Waiting for ${version} to become queryable on both registries, for all ${#targets[@]} targets"
echo "(timeout ${timeout_seconds}s, polling every ${poll_interval}s)."

while true; do
    still_pending=()
    for pair in "${pending[@]}"; do
        registry="${pair%%/*}"
        target="${pair#*/}"
        if [ "$(bash "$here/registry-state.sh" "$registry" "$target" "$version")" = visible ]; then
            echo "  ${registry}: ${target} is live."
        else
            still_pending+=("$pair")
        fi
    done
    # `${a[@]+"${a[@]}"}` rather than `"${a[@]}"`: under `set -u`, bash 3.2 --
    # which is the bash every macOS ships, and this runs on a developer's Mac
    # as well as on a runner -- treats an empty array as an unbound variable
    # and aborts. Which is precisely the success case here.
    pending=(${still_pending[@]+"${still_pending[@]}"})

    if [ "${#pending[@]}" -eq 0 ]; then
        echo "Both registries are serving ${version} for every target."
        exit 0
    fi

    now=$(date +%s)
    if [ "$now" -ge "$deadline" ]; then
        echo >&2
        echo "error: timed out after ${timeout_seconds}s waiting for ${version}." >&2
        printf '  not serving %s yet\n' "${pending[@]}" >&2
        echo >&2
        # Deliberately does not claim to know why. A target that is not being
        # served may still be activating, or may have been rejected in a
        # server-side scan, and nothing readable from here tells the two apart
        # -- both answer the same 404.
        echo "The publish step reported every upload as accepted, so the version number is" >&2
        echo "already spent either way. What is NOT known from here is whether a registry is" >&2
        echo "still activating a package or has rejected it: the public API answers the same" >&2
        echo "404 for both. Check the registry's own page before doing anything, and do not" >&2
        echo "re-publish this version -- see CONTRIBUTING.md, 'Publishing a release'." >&2
        exit 1
    fi

    remaining=$((deadline - now))
    echo "  ...still waiting (${remaining}s left; ${#pending[@]} of $(( ${#targets[@]} * 2 )) outstanding: ${pending[*]})"
    sleep "$poll_interval"
done
