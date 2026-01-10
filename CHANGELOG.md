# Changelog

All notable changes to this project will be documented here. The format loosely
follows [Keep a Changelog](https://keepachangelog.com/) and adheres to semantic
versioning when releases are cut.

## Unreleased

### Added

- **Jupyter Notebook Support**: New `notebook_edit` tool for editing `.ipynb` files at the cell level with `replace`, `insert`, and `delete` modes. The `read` tool now displays notebooks with formatted cell output.
- **PDF Reading**: The `read` tool now extracts and displays text content from PDF files using `pdf-parse`.
- **Image Processing with Sharp**: Optional `sharp` dependency for automatic image optimization before sending to LLMs. Reduces token usage by resizing large images and compressing screenshots.
- **System Reminder Injection**: New `SystemReminderManager` for injecting contextual reminders (e.g., todo list prompts, read-before-edit hints) into conversations via `<system-reminder>` tags.
- **Structured Questions**: New `ask_user` tool for gathering user input with predefined options (2-4 choices per question, multi-select support, automatic "Other" option).
- **SDK Tool Types**: Exported TypeBox schemas and TypeScript types for all built-in tools via `@evalops/composer/sdk-tools` for external SDK consumers.
- **Agent Resume Capability**: New `AgentTranscript` system for persisting and resuming agent executions, with `FileTranscriptStore` and `MemoryTranscriptStore` implementations.
- **Auto-Compaction System**: New `AutoCompactionMonitor` that automatically triggers conversation compaction when context window usage exceeds configurable thresholds. Environment variables: `COMPOSER_AUTOCOMPACT_PCT` (default: 85), `COMPOSER_AUTOCOMPACT_ENABLED`, `COMPOSER_AUTOCOMPACT_MIN_MESSAGES`.
- **Git State Tracking**: Extended git utilities with `getGitState()`, `getCommitSha()`, `getCurrentBranch()`, `isDirtyWorkingTree()`, and `getAheadBehind()` for comprehensive repository state tracking.
- **Business Telemetry Metrics**: New telemetry events for session tracking (`session.count`, `session.duration`), token usage (`tokens.input`, `tokens.output`, `tokens.cache_read`, `tokens.cache_write`), cost tracking (`cost.usd`), compaction events, and model switches.
- **Sandbox Violation Tracking**: New `recordSandboxViolation()` function for security auditing of blocked, warned, and allowed sandbox events.
- **Plan Mode Persistence**: New plan mode system with `enterPlanMode()`, `exitPlanMode()`, `writePlanFile()`, and file-based state persistence. Plan files are stored in `.composer/plans/` with session and git state metadata.
- **Session Auto-Recovery**: New `SessionRecoveryManager` for automatic session backup and recovery. Includes periodic backups, recovery from crashes, and cleanup of expired backups. Environment variables: `COMPOSER_SESSION_RECOVERY_ENABLED`, `COMPOSER_SESSION_BACKUP_DIR`, `COMPOSER_SESSION_BACKUP_INTERVAL`.
- **IDE Auto-Connect**: New `IDEAutoConnectManager` that detects and tracks running IDEs (VS Code, Cursor, Windsurf, JetBrains IDEs, Vim, Neovim, Emacs, Sublime, Zed). Environment variables: `COMPOSER_IDE_AUTOCONNECT`, `COMPOSER_IDE_SCAN_PORTS`, `COMPOSER_IDE_TIMEOUT`.
- `COMPOSER_TRUST_PROXY` environment variable to trust `X-Forwarded-For` headers for rate limiting when behind a reverse proxy.
- `COMPOSER_TRUST_PROXY_HOPS` environment variable (default: 1) to configure number of trusted proxy hops for multi-proxy setups.

### Changed

- **BREAKING**: Removed legacy Anthropic OAuth fallback (`anthropic-oauth.json`). Users must re-authenticate using the new OAuth system (`oauth.json`) via `composer anthropic login`. The legacy credential file is no longer read.
- **BREAKING**: Rate limiting now uses `socket.remoteAddress` by default instead of `X-Forwarded-For`. Deployments behind reverse proxies (nginx, CloudFlare, load balancers) must set `COMPOSER_TRUST_PROXY=true` to correctly identify client IPs.
- Enabled strict `noExplicitAny` linting rule in biome.json (changed from warn to error).
- Standardized `@sinclair/typebox` dependency to `^0.34.0` across all packages.

### Deprecated

The following APIs are deprecated and will be removed in a future release:

**Agent API:**
- `Agent.setQueueMode()` → Use `setSteeringMode()`/`setFollowUpMode()` instead
- `Agent.queueMessage()` → Use `steer()`/`followUp()` instead
- `AgentState.queueMode` → Use `steeringMode`/`followUpMode` instead
- `AgentOptions.getQueuedMessages` → Use `getSteeringMessages()`/`getFollowUpMessages()` instead

**Skills API:**
- `SkillFrontmatter.tags` → Use `metadata` instead
- `SkillFrontmatter.author` → Use `metadata.author` instead
- `SkillFrontmatter.version` → Use `metadata.version` instead
- `SkillFrontmatter.triggers` → Use `description` for trigger keywords instead
- `getSkillsSummary()` → Use `skillsToPrompt()` for XML format

**Modal API:**
- `Modal.onClose` → Use `dispose()` instead
- `Modal.onMount` → Use `mount()` instead
- `Modal.onUnmount` → Use `unmount()` instead

**Utilities:**
- `ConcurrencySlots` → Use `ConcurrencyManager` from `src/utils/concurrency-manager.ts`

### Fixed

- Added error handling for middleware chain execution to prevent unhandled promise rejections from crashing the server.
- Fixed `requestContextStorage.run()` not being awaited, which could cause unhandled promise rejections.
- Improved X-Forwarded-For parsing to read from right-to-left, preventing IP spoofing attacks.
- Added IPv6 normalization for consistent rate limiting (strips `::ffff:` prefix from IPv4-mapped addresses).
- Added validation for empty X-Forwarded-For headers to prevent grouping under empty string.

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
