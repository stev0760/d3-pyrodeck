#!/bin/sh
# Generate the home-screen icons from the Descent logo font: "D3" in the
# panel's amber on its black. The PNGs are committed (public/icons/); run this
# again after changing the artwork or the theme colours. Needs ImageMagick 7.
set -e
cd "$(dirname "$0")/.."

FONT=packages/client/public/fonts/DESCLOGO.TTF
OUT=packages/client/public/icons
BG='#09090b'   # --background, oklch(0.14 0.005 285)
FG='#ed990e'   # --primary,    oklch(0.75 0.16 70)

mkdir -p "$OUT"

# 512 px master. The glyphs stay inside the central 80 %, the safe zone a
# maskable icon needs, so one file serves both "any" and "maskable".
magick -size 512x512 "xc:$BG" \
  -font "$FONT" -fill "$FG" -gravity center -pointsize 230 -annotate +0+12 "D3" \
  "$OUT/icon-512.png"
magick "$OUT/icon-512.png" -resize 192x192 "$OUT/icon-192.png"
magick "$OUT/icon-512.png" -resize 180x180 "$OUT/apple-touch-icon.png"
magick "$OUT/icon-512.png" -resize 64x64 "$OUT/favicon.png"
ls -l "$OUT"
