#!/usr/bin/env bash
#
# Reports whether one registry is serving one target's package for a version.
#
# The target is part of the question, not a detail. GemDB publishes a
# platform-specific .vsix per target, so `(publisher, name, version)` does not
# identify a package the way it does for an extension with one universal
# build -- `(publisher, name, version, targetPlatform)` does. A version can be
# fully live on darwin-arm64 and entirely absent on linux-arm64, which is
# exactly the state a half-finished publish leaves behind, and a check that
# asked only about the version would call that a success.
#
# Deliberately narrow, because the public read APIs are narrow. Neither
# registry exposes a review or scan state to an unauthenticated caller: Open
# VSX's per-version endpoint answers 404 for a target that was never uploaded
# AND for one that landed but has not been activated yet, with nothing in the
# body to tell them apart. So this answers the only question it honestly can --
# is this target's package visible -- and callers must not read `absent` as
# "never published".
#
# The state that distinguishes "landed but inactive" from "never uploaded" is
# observable only from a publish attempt, whose error message says so;
# scripts/publish-to-registry.sh is where that is interpreted.
#
# Prints exactly one of:
#   visible   the registry serves this target's package for this version now
#   absent    it does not (never uploaded, or not yet active)
#   unknown   the query itself failed (network, rate limit, bad JSON)
#
# Exits 0 whenever it produced a state, 2 on usage error. `unknown` is not a
# failure: a flaky query must not be read as a missing release.
#
# Usage: scripts/registry-state.sh <marketplace|openvsx> <target> <version>
# Env:   NAMESPACE (default gemtalksystems), EXTENSION (default gemdb)

set -euo pipefail

if [ "$#" -ne 3 ]; then
    echo "usage: $0 <marketplace|openvsx> <target> <version>   e.g. $0 openvsx darwin-arm64 1.5.0" >&2
    exit 2
fi

registry="$1"
target="$2"
version="$3"
namespace="${NAMESPACE:-gemtalksystems}"
extension="${EXTENSION:-gemdb}"

case "$registry" in
    openvsx)
        # Open VSX addresses a platform-specific package as
        # /api/{namespace}/{extension}/{target}/{version}. 200 means that row is
        # active and downloadable; 404 means it is not being served, for either
        # of the two reasons above. Measured against the live API on
        # 2026-09-11: darwin-arm64 and linux-x64 at 1.4.0 answer 200, a version
        # that does not exist answers 404.
        body=$(curl -s --max-time 30 -w '\n%{http_code}' \
            "https://open-vsx.org/api/${namespace}/${extension}/${target}/${version}" 2>/dev/null) || {
            echo unknown
            exit 0
        }
        code=$(printf '%s' "$body" | tail -1)
        case "$code" in
            200)
                # Guard against a 200 carrying an error document.
                if printf '%s' "$body" | sed '$d' | jq -e '.error // empty' >/dev/null 2>&1; then
                    echo absent
                else
                    echo visible
                fi
                ;;
            404) echo absent ;;
            *) echo unknown ;;
        esac
        ;;
    marketplace)
        # vsce reads the gallery API, which omits a version until it has
        # finished validating. Each row carries its own `targetPlatform`, so the
        # match has to be on the pair rather than on the version alone --
        # `[.versions[].version] | index($v)` would report a version as live on
        # every target the moment any one of them landed.
        if ! json=$(npx --no-install @vscode/vsce show "${namespace}.${extension}" --json 2>/dev/null); then
            echo unknown
            exit 0
        fi
        if printf '%s' "$json" | jq -e --arg v "$version" --arg t "$target" \
            'any(.versions[]; .version == $v and .targetPlatform == $t)' >/dev/null 2>&1; then
            echo visible
        else
            echo absent
        fi
        ;;
    *)
        echo "error: unknown registry '$registry' (expected marketplace or openvsx)." >&2
        exit 2
        ;;
esac
