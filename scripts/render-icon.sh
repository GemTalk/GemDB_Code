#!/bin/bash
# Render the Marketplace icon, resources/icon.png, from the brand's dark-mode
# favicon, resources/GemDB_Favicon.png.
#
# The favicon is a raster at roughly 1667 px a side and the brand publishes no
# vector of it, so the PNG is a derived file, and this is how it is derived.
# Regenerate it here rather than by hand.
#
# 256x256, because the Marketplace shows the icon at 128 CSS pixels and a
# 128 px raster is soft on a high-DPI screen. The favicon is a full-bleed tile,
# so there is no margin to add. Its sides differ by a pixel, so it is cropped
# square about its centre before scaling, rather than scaled out of proportion.
#
# The activity-bar icon, resources/gemdb-sidebar.svg, is not generated: it is
# a single-colour redrawing of the gem, resources/GemDB_Icon.svg, and its
# header says how.
#
# Needs sips, which ships with macOS.
#
# Usage:
#   scripts/render-icon.sh

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO/resources/GemDB_Favicon.png"
OUT="$REPO/resources/icon.png"

command -v sips >/dev/null || {
  echo "sips not found; it ships with macOS, so run $0 on a Mac." >&2
  exit 1
}

PAGE=256
read -r SRC_W SRC_H < <(sips -g pixelWidth -g pixelHeight "$SRC" |
  awk '/pixelWidth/ { w = $2 } /pixelHeight/ { h = $2 } END { print w, h }')
SIDE=$((SRC_W < SRC_H ? SRC_W : SRC_H))

sips --cropToHeightWidth "$SIDE" "$SIDE" --resampleHeightWidth "$PAGE" "$PAGE" \
  --setProperty format png "$SRC" --out "$OUT" >/dev/null

echo "Wrote $OUT (${PAGE}x${PAGE}, from a ${SIDE}x${SIDE} crop of ${SRC_W}x${SRC_H})"
