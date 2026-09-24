#!/bin/bash
# Render the Marketplace icon, resources/icon.png, from the mark's vector
# source, resources/GemDB_Icon.svg.
#
# The Marketplace will not take an SVG for `icon`, so the PNG is a derived
# file, and this is how it is derived. Regenerate it here rather than by hand:
# the white bars this replaced were a raster padded out to a square with
# opaque white instead of transparency.
#
# 256x256, because the Marketplace shows the icon at 128 CSS pixels and a
# 128 px raster is soft on a high-DPI screen. Transparent, because the page
# behind it is dark. The mark is 240 px tall, centred, which leaves 8 px of
# margin above and below; its width follows from its aspect ratio.
#
# The activity-bar icon, resources/gemdb-sidebar.svg, is not generated: it is
# a single-colour redrawing of this mark, and its header says how.
#
# Needs rsvg-convert 2.52 or later, for --page-width and friends
# (macOS: `brew install librsvg`; Debian/Ubuntu: `apt install librsvg2-bin`).
#
# Usage:
#   scripts/render-icon.sh

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO/resources/GemDB_Icon.svg"
OUT="$REPO/resources/icon.png"

command -v rsvg-convert >/dev/null || {
  echo "rsvg-convert not found; see the header of $0 for how to install it." >&2
  exit 1
}

PAGE=256
HEIGHT=240
# Width and left offset from the source's viewBox, so the mark stays centred if
# the artwork's proportions ever change.
read -r VB_W VB_H < <(sed -n 's/.*viewBox="[^ ]* [^ ]* \([^ ]*\) \([^"]*\)".*/\1 \2/p' "$SRC")
read -r WIDTH LEFT TOP < <(awk -v w="$VB_W" -v h="$VB_H" -v H="$HEIGHT" -v P="$PAGE" \
  'BEGIN { W = H * w / h; printf "%.2f %.2f %.2f\n", W, (P - W) / 2, (P - H) / 2 }')

rsvg-convert "$SRC" \
  --width "${WIDTH}px" --height "${HEIGHT}px" \
  --page-width "${PAGE}px" --page-height "${PAGE}px" \
  --left "${LEFT}px" --top "${TOP}px" \
  --format png --output "$OUT"

echo "Wrote $OUT (${PAGE}x${PAGE}, mark ${WIDTH}x${HEIGHT} at ${LEFT},${TOP})"
