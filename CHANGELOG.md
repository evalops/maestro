# Changelog

All notable changes to this project will be documented here. The format loosely
follows [Keep a Changelog](https://keepachangelog.com/) and adheres to semantic
versioning when releases are cut.

## Unreleased

- Pending changes

## 0.10.0 – 2025-11-18

### Added

- Browser-based Web UI with full Composer core integration, live event streaming, industrial instrument panel theme, and comprehensive settings panel.
- Dedicated `@evalops/tui` package, concurrently-powered dev flows, and a shared tool loop/renderer architecture that can drive both the TUI and the Web UI.
- Expanded slash-command surface area including `/plan`, `/cost`, `/config`, `/telemetry`, `/about`, `/report`, `/share`, `/compact`, `/ollama`, `/update`, and `/exec`, plus richer diagnostics/export tooling.
- GitHub CLI tool suite (`gh_pr`, `gh_issue`, `gh_repo`) with advanced filtering, diff previews, and review helpers, along with Exa-powered `websearch`, `codesearch`, and `webfetch` tools.
- Comprehensive model registry (300+ entries), Google Gemini provider support, CLAUDE OAuth, enhanced provider metadata, and improved telemetry/reporting experiences.

### Changed

- Rebranded the project from "Composer CLI" to simply "Composer", updated documentation (README, Quickstart, Feature Guide, Contributing) and installation instructions, and aligned repo/package names.
- Extracted TUI components into modular views, introduced a refined loader/welcome animation system, and improved bash-mode UX with history, multiline paste, and autocomplete.
- Migrated tools to the new DSL, hardened the agent transport/event pipeline, and refactored exporter infrastructure, session compaction, and diagnostics rendering.
- Overhauled build/test workflows: explicit workspace builds, Bun/NPM alignment, chunked evals across OS matrices, ripgrep installation, and safer CI release gating.

### Fixed

- Stabilized cost-tracker tests (time range filter, cache accounting), resolved session hydration/state issues, and ensured timestamps render in ISO format across UIs.
- Hardened LSP bootstrap/root detection, nix builds, and workspace dependency ordering; reduced test flake by disabling problematic parallelism and organizing imports.
- Updated eval scenarios (including README first-line regex) to reflect the rename, expanded telemetry coverage, and eliminated Anthropic transport duplication bugs.

## 0.9.0 – 2025-01-15

- Baseline release with Composer CLI/TUI, eval suite, and provider registry
- Added telemetry report tooling and mock-agent integration tests

Older history lives in the Git commit log.
