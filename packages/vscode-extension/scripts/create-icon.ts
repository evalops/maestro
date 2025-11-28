#!/usr/bin/env bun
/**
 * Creates a placeholder icon for the VS Code extension.
 * For production, replace this with a proper branded icon (128x128 PNG).
 *
 * Run: bun run scripts/create-icon.ts
 */

import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const rootDir = resolve(__dirname, "..");
const mediaDir = join(rootDir, "media");

// Simple SVG icon - Composer logo placeholder
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#6366f1"/>
      <stop offset="100%" style="stop-color:#8b5cf6"/>
    </linearGradient>
  </defs>
  <rect width="128" height="128" rx="24" fill="url(#bg)"/>
  <text x="64" y="80" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="56" font-weight="bold" fill="white">C</text>
</svg>`;

// Write SVG file
const svgPath = join(mediaDir, "icon.svg");
writeFileSync(svgPath, svg);
console.log(`Created: ${svgPath}`);

// Note: For the marketplace, you need a PNG file.
// Convert using: npx svgexport media/icon.svg media/icon.png 128:128
// Or use any image editor to create a proper 128x128 PNG icon.

console.log(`
To create the PNG icon for VS Code marketplace:
  1. Replace media/icon.svg with your branded icon
  2. Convert to PNG: npx svgexport media/icon.svg media/icon.png 128:128
  
Or manually create a 128x128 PNG file at media/icon.png
`);
