#!/usr/bin/env bash
#
# Launch GemDB from this working copy in an editor that has never seen it: a
# throwaway profile (no settings, no extensions, none of GemDB's global storage)
# and, unless told otherwise, an empty root path. What opens is a brand-new
# user's first run — the unattended setup, the engine download, the demo.
#
# Why a script and not only the "Run GemDB (clean profile)" launch config: F5
# opens the development window inside the VS Code already running, which can
# switch profiles but not data directories, and shares the real ~/GemDB. This
# starts a separate editor instance on a --user-data-dir of its own, so global
# storage is empty by construction rather than by deleting anything, and seeds
# that profile's settings with a gemdb.rootPath of its own.
#
# The root path is what isolates the database too, not just the files:
# engineEnvironment() sets GEMSTONE_GLOBAL_DIR to it, so the stone and NetLDI
# write their lock files there and `gslist` in the fresh window sees only its
# own `gemdb` and `gemdbldi`, never the ones under ~/GemDB. Shared memory is
# the exception — it is machine-wide, so a machine that has had it raised
# stays raised, and the fresh window will not ask. Run
# scripts/unset-os-config.sh first to replay that prompt as well. Not measured:
# whether two stones fit in shared memory raised for one, if your own ~/GemDB
# stone is running at the same time.
#
# Usage:
#   npm run dev:fresh                         # empty root path: full first run
#   npm run dev:fresh -- /path/to/folder      # ...opening a folder
#   npm run dev:fresh:cached-engine           # empty root path, no download
#   npm run dev:fresh:keep-root               # fresh profile, your real ~/GemDB
#
# --cached-engine skips the network, not the install. engine.ts reuses an
# archive it finds in the root path (and deletes it after extracting), so the
# archive is fetched once into $GEMDB_DEV_CACHE (default ~/.cache/gemdb-dev)
# and copied into each fresh root path; extraction, database creation and Grail
# still run as a user's would.
#
# The profile and the root path live under $TMPDIR and are not cleaned up: a
# database's files are worth having after a failure, and the OS clears $TMPDIR
# on its own. Remove them by hand with the paths printed at launch.
#
# GEMDB_DEV_EDITOR_CLI overrides which editor CLI to launch; needed when `code`
# on your PATH is a wrapper that passes a --user-data-dir of its own.
#
# For live reload, run `npm run watch` in another terminal and reload the window
# (Cmd+R / "Developer: Reload Window") after edits.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

KEEP_ROOT="${GEMDB_DEV_KEEP_ROOT:-}"
CACHED_ENGINE="${GEMDB_DEV_CACHED_ENGINE:-}"
WORKSPACE_ARG=""
for arg in "$@"; do
  case "$arg" in
    --keep-root) KEEP_ROOT=1 ;;
    --cached-engine) CACHED_ENGINE=1 ;;
    -*) echo "Unknown option: $arg" >&2; exit 1 ;;
    *) WORKSPACE_ARG="$arg" ;;
  esac
done
if [ -n "$KEEP_ROOT" ] && [ -n "$CACHED_ENGINE" ]; then
  echo "--keep-root and --cached-engine do not combine: the real root path already has its engine." >&2
  exit 1
fi

EDITOR_CLI="${GEMDB_DEV_EDITOR_CLI:-}"
if [ -z "$EDITOR_CLI" ]; then
  for c in code code-insiders codium; do
    if command -v "$c" >/dev/null 2>&1; then EDITOR_CLI="$c"; break; fi
  done
fi
if [ -z "$EDITOR_CLI" ]; then
  echo "No editor CLI (code/codium) on PATH." >&2
  echo "In VS Code: Cmd+Shift+P -> 'Shell Command: Install 'code' command in PATH'." >&2
  exit 1
fi

# The editor dies on a duplicate --user-data-dir before it draws anything, so
# refuse when the CLI adds one of its own. Ask it rather than read it: VS Code's
# own bin/code mentions the flag in a root check but never passes one.
if PROBE=$("$EDITOR_CLI" --user-data-dir="${TMPDIR:-/tmp}/gemdb-dev-probe.$$" --version 2>&1) &&
  printf '%s' "$PROBE" | grep -q "defined more than once"; then
  echo "$EDITOR_CLI passes a --user-data-dir of its own, and this script passes one too." >&2
  echo "Point GEMDB_DEV_EDITOR_CLI at the real launcher, which forwards arguments untouched." >&2
  exit 1
fi

if [ ! -f out/extension.js ]; then
  echo "out/ not built - bundling (use 'npm run watch' for live reload)..."
  node esbuild.mjs
fi
# Warn rather than rebuild: with `npm run watch` running, out/ is current and a
# second build would race it. An mtime heuristic, so it can be wrong either way.
newer="$(find src -name '*.ts' -not -path '*/__tests__/*' -newer out/extension.js -print -quit 2>/dev/null)"
if [ -n "$newer" ]; then
  echo ""
  echo "WARNING: out/extension.js may be stale - $newer is newer."
  echo "Run 'npm run watch', or 'node esbuild.mjs' once."
  echo ""
fi

# Grail is what makes a cell run, so without it the window would install
# cleanly and fail at the first `import` — the failure this flags early.
if [ ! -f grail/GRAIL_VERSION ]; then
  echo "WARNING: grail/ is not assembled; Python will not install. Run 'npm run bundle:grail'." >&2
fi

PROFILE="$(mktemp -d "${TMPDIR:-/tmp}/gemdb-dev.XXXXXX")"
WORKSPACE="${WORKSPACE_ARG:-$(mktemp -d "${TMPDIR:-/tmp}/gemdb-ws.XXXXXX")}"
USER_SETTINGS_DIR="$PROFILE/user-data/User"
mkdir -p "$USER_SETTINGS_DIR"

if [ -n "$KEEP_ROOT" ]; then
  ROOT_DESC="your real gemdb.rootPath (default ~/GemDB)"
else
  # Under the profile, so one directory holds everything a run left behind.
  ROOT="$PROFILE/gemdb-root"
  mkdir -p "$ROOT"
  # User settings rather than the workspace's: gemdb.rootPath is machine-scoped,
  # and VS Code ignores a machine setting in a workspace's settings.json.
  printf '{\n  "gemdb.rootPath": "%s"\n}\n' "$ROOT" >"$USER_SETTINGS_DIR/settings.json"
  ROOT_DESC="$ROOT (empty)"

  if [ -n "$CACHED_ENGINE" ]; then
    # The same pin, platform key and URL as install-engine.sh and engine.ts.
    VERSION="$(sed -nE "s/^export const PINNED_ENGINE_VERSION = '(.+)';$/\1/p" src/config.ts)"
    [ -n "$VERSION" ] || { echo "Could not read PINNED_ENGINE_VERSION from src/config.ts" >&2; exit 1; }
    case "$(uname -s)-$(uname -m)" in
      Darwin-arm64) PLATFORM="arm64.Darwin" ; EXT="dmg" ;;
      Linux-aarch64) PLATFORM="arm64.Linux" ; EXT="zip" ;;
      Linux-x86_64) PLATFORM="x86_64.Linux" ; EXT="zip" ;;
      *) echo "Unsupported platform $(uname -s)-$(uname -m)" >&2; exit 1 ;;
    esac
    ARCHIVE_NAME="GemStone64Bit${VERSION}-${PLATFORM}.${EXT}"
    CACHE="${GEMDB_DEV_CACHE:-$HOME/.cache/gemdb-dev}"
    mkdir -p "$CACHE"
    if [ ! -f "$CACHE/$ARCHIVE_NAME" ]; then
      echo "Caching $ARCHIVE_NAME in $CACHE (once per pin)..."
      # Into a .part first, so an interrupted download is never mistaken for an
      # archive by the next run.
      curl -fL --progress-bar -o "$CACHE/$ARCHIVE_NAME.part" \
        "https://dl.gemdb.com/${VERSION}/${ARCHIVE_NAME}"
      mv "$CACHE/$ARCHIVE_NAME.part" "$CACHE/$ARCHIVE_NAME"
    fi
    # A clone on APFS (-c), so a run costs no disk until the extension deletes it.
    cp -c "$CACHE/$ARCHIVE_NAME" "$ROOT/" 2>/dev/null || cp "$CACHE/$ARCHIVE_NAME" "$ROOT/"
    ROOT_DESC="$ROOT (engine archive seeded from $CACHE)"
  fi
fi

echo "Launching $EDITOR_CLI with a fresh profile:"
echo "  extension : $REPO (branch $(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?'))"
echo "  profile   : $PROFILE"
echo "  root path : $ROOT_DESC"
echo "  workspace : $WORKSPACE"

# No --disable-workspace-trust, unlike Jasper's equivalent: GemDB runs in
# Restricted Mode, and a fresh window is where that path should be seen working.
exec "$EDITOR_CLI" \
  --extensionDevelopmentPath="$REPO" \
  --user-data-dir="$PROFILE/user-data" \
  --extensions-dir="$PROFILE/extensions" \
  --password-store=basic \
  --new-window \
  "$WORKSPACE"
