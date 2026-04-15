#!/bin/bash
# Generate a simple placeholder icon for the VS Code extension
# Requires: imagemagick (convert) or inkscape for SVG to PNG conversion

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MEDIA_DIR="$SCRIPT_DIR/../media"

# Create SVG icon
cat > "$MEDIA_DIR/icon.svg" << 'EOF'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#6366f1"/>
      <stop offset="100%" style="stop-color:#8b5cf6"/>
    </linearGradient>
  </defs>
  <rect width="128" height="128" rx="24" fill="url(#bg)"/>
  <text x="64" y="80" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="56" font-weight="bold" fill="white">C</text>
</svg>
EOF

echo "Created: $MEDIA_DIR/icon.svg"

# Convert to PNG using available tool
if command -v convert &> /dev/null; then
    convert -background none "$MEDIA_DIR/icon.svg" -resize 128x128 "$MEDIA_DIR/icon.png"
    echo "Created: $MEDIA_DIR/icon.png (using ImageMagick)"
elif command -v inkscape &> /dev/null; then
    inkscape "$MEDIA_DIR/icon.svg" --export-filename="$MEDIA_DIR/icon.png" --export-width=128 --export-height=128
    echo "Created: $MEDIA_DIR/icon.png (using Inkscape)"
elif command -v rsvg-convert &> /dev/null; then
    rsvg-convert -w 128 -h 128 "$MEDIA_DIR/icon.svg" -o "$MEDIA_DIR/icon.png"
    echo "Created: $MEDIA_DIR/icon.png (using rsvg-convert)"
else
    echo "Warning: No SVG to PNG converter found."
    echo "Install one of: imagemagick, inkscape, or librsvg"
    echo "Or manually convert icon.svg to icon.png (128x128)"
    exit 1
fi
