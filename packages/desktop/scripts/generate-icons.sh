#!/bin/bash

# Icon Generation Script for Composer Desktop
# Generates all required icon formats from SVG source
#
# Requirements:
#   - ImageMagick (brew install imagemagick)
#   - iconutil (comes with macOS)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ASSETS_DIR="$SCRIPT_DIR/../assets"
ICON_SVG="$ASSETS_DIR/icon.svg"
DMG_BG_SVG="$ASSETS_DIR/dmg-background.svg"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}🎨 Generating Composer Desktop icons...${NC}"

# Check for required tools
if ! command -v magick &> /dev/null && ! command -v convert &> /dev/null; then
    echo -e "${RED}Error: ImageMagick is required but not installed.${NC}"
    echo -e "${YELLOW}Install with: brew install imagemagick${NC}"
    exit 1
fi

# Use magick if available (ImageMagick 7), otherwise fall back to convert (ImageMagick 6)
if command -v magick &> /dev/null; then
    CONVERT="magick"
else
    CONVERT="convert"
fi

# Create temporary directory for iconset
ICONSET_DIR="$ASSETS_DIR/icon.iconset"
rm -rf "$ICONSET_DIR"
mkdir -p "$ICONSET_DIR"

echo "📐 Generating PNG icons at multiple resolutions..."

# Generate all required icon sizes for macOS iconset
# Format: icon_WxH.png and icon_WxH@2x.png
for size in 16 32 128 256 512; do
    echo "  - ${size}x${size}"
    $CONVERT -background none -density 300 "$ICON_SVG" -resize "${size}x${size}" "$ICONSET_DIR/icon_${size}x${size}.png"

    # Generate @2x version
    double=$((size * 2))
    echo "  - ${size}x${size}@2x (${double}x${double})"
    $CONVERT -background none -density 300 "$ICON_SVG" -resize "${double}x${double}" "$ICONSET_DIR/icon_${size}x${size}@2x.png"
done

echo -e "${GREEN}✓ PNG icons generated${NC}"

# Generate .icns file for macOS
echo "🍎 Creating macOS .icns file..."
if command -v iconutil &> /dev/null; then
    iconutil -c icns "$ICONSET_DIR" -o "$ASSETS_DIR/icon.icns"
    echo -e "${GREEN}✓ icon.icns created${NC}"
else
    echo -e "${YELLOW}⚠ iconutil not found (macOS only). Skipping .icns generation.${NC}"
fi

# Generate standalone PNG for Linux (512x512)
echo "🐧 Creating Linux icon..."
$CONVERT -background none -density 300 "$ICON_SVG" -resize "512x512" "$ASSETS_DIR/icon.png"
echo -e "${GREEN}✓ icon.png created (512x512)${NC}"

# Generate .ico file for Windows
echo "🪟 Creating Windows .ico file..."
$CONVERT "$ASSETS_DIR/icon.png" -define icon:auto-resize=256,128,64,48,32,16 "$ASSETS_DIR/icon.ico"
echo -e "${GREEN}✓ icon.ico created${NC}"

# Generate DMG background images
echo "💿 Creating DMG background images..."

# Standard resolution (540x380)
$CONVERT -background none -density 150 "$DMG_BG_SVG" -resize "540x380" "$ASSETS_DIR/dmg-background.png"
echo -e "${GREEN}✓ dmg-background.png created (540x380)${NC}"

# Retina resolution (1080x760)
$CONVERT -background none -density 300 "$DMG_BG_SVG" -resize "1080x760" "$ASSETS_DIR/dmg-background@2x.png"
echo -e "${GREEN}✓ dmg-background@2x.png created (1080x760)${NC}"

# Cleanup temporary iconset directory
rm -rf "$ICONSET_DIR"

echo ""
echo -e "${GREEN}✅ All icons generated successfully!${NC}"
echo ""
echo "Generated files:"
ls -la "$ASSETS_DIR"/*.icns "$ASSETS_DIR"/*.ico "$ASSETS_DIR"/*.png 2>/dev/null || true
