#Requires -Version 5.1
#
# Maestro installer stub for Windows (PowerShell)
#
# Native Windows release binary assets are not the primary distribution path yet.
# Use npm/Bun or download assets from GitHub Releases.
#
# Usage:
#   irm https://raw.githubusercontent.com/evalops/maestro/main/scripts/install.ps1 | iex
#

$ErrorActionPreference = 'Stop'

Write-Host "Maestro Windows install" -ForegroundColor Cyan
Write-Host ""
Write-Host "Windows does not yet have a dedicated one-line binary installer matching the macOS/Linux assets."
Write-Host "Use one of the supported paths below."
Write-Host ""

Write-Host "Option 1 — npm (recommended on Windows today)" -ForegroundColor Green
Write-Host "  npm install -g @evalops/maestro"
Write-Host "  (ships platform maestro-tui under vendor/maestro-tui for native TUI/web)"
Write-Host ""

Write-Host "Option 2 — Bun" -ForegroundColor Green
Write-Host "  bun install -g @evalops/maestro"
Write-Host ""

Write-Host "Option 3 — GitHub release assets" -ForegroundColor Green
Write-Host "  Browse: https://github.com/evalops/maestro/releases/latest"
Write-Host "  macOS/Linux: maestro-<platform> and maestro-tui-<platform>"
Write-Host "  Prefer npm/Bun on Windows until a windows-* release asset is published."
Write-Host ""

Write-Host "After install, verify with:" -ForegroundColor Cyan
Write-Host "  maestro --version"
Write-Host ""
Write-Host "Native interactive TUI and default web chat need maestro-tui."
Write-Host "npm/Bun installs include vendor/maestro-tui; override with MAESTRO_TUI_BIN if needed."
Write-Host ""
Write-Host "Auth (Codex subscription models):"
Write-Host "  maestro codex login"
Write-Host ""

exit 0
