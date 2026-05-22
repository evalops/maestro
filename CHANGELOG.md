# Changelog

All notable changes to this project will be documented here. The format loosely
follows [Keep a Changelog](https://keepachangelog.com/) and adheres to semantic
versioning when releases are cut.

## Unreleased

### Added

- Added a weekly internal patch-release cadence that opens or refreshes release
  PRs with generated changelog entries from commits since the latest semver tag.

### Changed

- Release version bumps now include the generated changelog entry in the PR body
  and keep scheduled public runs inert so public publishing stays downstream of
  the internal source-of-truth release.

## [0.10.20] - 2026-05-22

### Changed

- Add Platform A2A control and evidence guardrails (#2065). <!-- maestro-release-note:a174de22308e -->
- Skip TS checks for Rust-only PRs (#2078). <!-- maestro-release-note:de04550846b8 -->
- Fix public mirror review blockers (#2074). <!-- maestro-release-note:5075220752bf -->
- Expose tool scheduling diagnostics (#2072). <!-- maestro-release-note:3613ab6e7a64 -->
- Report avoidable tool serialization (#2071). <!-- maestro-release-note:c1ffa9e1f331 -->
- Recognize EvalOps platform base URL aliases (#2063). <!-- maestro-release-note:341c3e6ae5ed -->
- Skip rust setup for workflow-only tui checks (#2069). <!-- maestro-release-note:6ae0842947a7 -->
- Scope rust hook coverage (#2066). <!-- maestro-release-note:5e5d9cf3e02b -->
- Add next wave tool scheduling gates (#2064). <!-- maestro-release-note:5b3b061e2b3d -->
- Log control-plane startup on stdout (#2062). <!-- maestro-release-note:cd1f81614933 -->
- Parallelize read-only tool waves (#2061). <!-- maestro-release-note:03f8a287b9c1 -->
- Run authorship labeler on owned ci (#2059). <!-- maestro-release-note:3b71c588b1b8 -->

### Fixed

- Publish Maestro's runtime workspace packages before the public root package so
  Bun and npm resolvers can install `@evalops/maestro` without registry 404s.
- Run nix hash updater on hosted runner (#2082). <!-- maestro-release-note:2ae7fb184dfc -->
- Support Anthropic Opus 4.7 runtime (#2076). <!-- maestro-release-note:d047c05f1a4d -->
- Reject unsafe trusted runner roots (#2077). <!-- maestro-release-note:caa544bc2dae -->
- Preserve tool concurrency cap (#2073). <!-- maestro-release-note:c5811f2dc910 -->
- Support split-stream structured logs (#2060). <!-- maestro-release-note:4ab6fac8eb1d -->

## [0.10.19] - 2026-05-18

### Added

- Enrich Codex subagent work graph edges. <!-- maestro-release-note:59b55a277ef8 -->
- Route swarm subagents by mode (#2015). <!-- maestro-release-note:d0b8837d307a -->
- Render codex subagent edge metadata (#1990). <!-- maestro-release-note:0cca67ca6d7d -->
- Add agent operating plane telemetry context (#1987). <!-- maestro-release-note:4d878c0f2b26 -->
- Add OSS skill publish install contract (#1984). <!-- maestro-release-note:e46cde8187e7 -->
- Add first-party operational skill packages (#1982). <!-- maestro-release-note:e1493a309a14 -->
- Add local AgentRuntime ledger projection (#1974). <!-- maestro-release-note:972982cfe11c -->
- Continue actionable A2A tasks. <!-- maestro-release-note:7654da2213df -->
- Record subagent delegations (#1954). <!-- maestro-release-note:87787f61a321 -->
- Enroll Maestro runtime errors in Sentry (#1923). <!-- maestro-release-note:e703acc96af6 -->
- Add Fermata LLM rubric suite option (#1919). <!-- maestro-release-note:aa71028c5b73 -->
- Enforce staged rollout surfaces (#1883). <!-- maestro-release-note:6065a68afc07 -->

### Changed

- Add Platform-backed A2A peer discovery (#2019). <!-- maestro-release-note:6d3578ea6a9a -->
- [maestro] Add regular release cadence (#2016). <!-- maestro-release-note:12093787b18e -->
- Record Platform drain evidence for hosted runners (#2018). <!-- maestro-release-note:761c4b2a09db -->
- A2a: advertise governed subagent skills (#2013). <!-- maestro-release-note:722ef3cd5a07 -->
- Dispatch Maestro image sync after publish (#2011). <!-- maestro-release-note:02f18d7976f9 -->
- A2a: ack Platform push callbacks in Rust control plane (#2008). <!-- maestro-release-note:7472e65f26bd -->
- Expose operating-plane value proof in CLI (#2007). <!-- maestro-release-note:2d67d5abe37a -->
- Summarize operating plane value proof (#2006). <!-- maestro-release-note:e3c41b9e6755 -->
- Add operating plane lookup client (#2005). <!-- maestro-release-note:d64692df1988 -->
- A2a: receive Platform push callbacks (#2003). <!-- maestro-release-note:a3e9b6e79333 -->
- Managed gateway: emit AgentRuntime ledger metadata (#2002). <!-- maestro-release-note:0f40f79bf4d6 -->
- Fix A2A push config identity (#2001). <!-- maestro-release-note:fbff816deb01 -->

### Fixed

- Preserve distinct request metadata ids (#2014). <!-- maestro-release-note:432f3080cfaa -->
- Forward managed gateway thread metadata (#2012). <!-- maestro-release-note:f21816d1134f -->
- Keep spawned subagent work active (#2010). <!-- maestro-release-note:54efa3fb9373 -->
- Accept platform A2A push callbacks (#2009). <!-- maestro-release-note:19a53943d816 -->
- Redact A2A push secrets in task responses (#2000). <!-- maestro-release-note:3e37808837fc -->
- Share codex subagent protocol constants (#1993). <!-- maestro-release-note:d4e8036240e6 -->
- Unwrap A2A JSON-RPC stream envelopes (#1991). <!-- maestro-release-note:b3cfc7d93a6c -->
- Avoid CRLF SSE boundary backtracking (#1992). <!-- maestro-release-note:544634f0f393 -->
- Propagate A2A ledger aborts (#1983). <!-- maestro-release-note:0172f46663e0 -->
- Recover stale A2A ledger locks within one attempt (#1981). <!-- maestro-release-note:bb0e5e8cca80 -->
- Preserve repeated A2A reply turns. <!-- maestro-release-note:21c8e17c0fe0 -->
- Skip terminal A2A refreshes (#1976). <!-- maestro-release-note:2e0eed9390f5 -->

## [0.10.18] - 2026-05-06

### Added

### Changed

### Fixed


## [0.10.17] - 2026-05-06

### Added

### Changed

### Fixed


## [0.10.16] - 2026-05-06

### Added

### Changed

### Fixed


## [0.10.15] - 2026-05-06

### Added

- Added any-agent EvalOps control-plane profile metadata for managed runtime, MCP/OTLP shims, durable memory mode, and runtime ownership across the CLI bootstrap flow, managed context, MCP plugin headers, and Rust event bus extensions.

### Changed

- Published the public package/release train with the any-agent registry wiring that landed through the internal source-of-truth mirror.

### Fixed


## [0.10.14] - 2026-05-06

### Added

### Changed

### Fixed


## [0.10.13] - 2026-05-06

### Added

### Changed

### Fixed


## [0.10.12] - 2026-05-05

### Added

### Changed

### Fixed


## [0.10.11] - 2026-05-04

### Added

### Changed

### Fixed


## [0.10.10] - 2026-05-03

### Added

### Changed

### Fixed


## [0.10.9] - 2026-05-03

### Added

### Changed

### Fixed


## [0.10.8] - 2026-04-22

### Changed

- Bumped OpenTelemetry runtime instrumentation packages to clear the release audit gate.

### Fixed

- Forced transitive Hono installs to the patched JSX SSR handling release.

## [0.10.7] - 2026-04-22

### Added

- Added an npm token fallback for the release workflow while the `@evalops/maestro`
  trusted publisher is configured.

### Changed

- Moved the public package namespace from `@evalops-jh/maestro` to
  `@evalops/maestro` and updated install references.

## [0.10.6] - 2026-04-15

### Changed

- Rebundled Google provider runtime dependencies into the built CLI and provider artifacts so installs no longer need the Google SDKs as direct runtime package requirements.

### Fixed

- Removed the unused root `better-sqlite3` dependency from the published package and eliminated the remaining install-time deprecation warnings from `prebuild-install` and `node-domexception`.
- Hardened runtime dependency verification so bundled code comments do not produce false positives during release validation.

## [0.10.5] - 2026-04-15

### Changed

- Tightened shared Bun cache keying in CI and release workflows to use exact, versioned cache hits instead of broad fallback restores.

### Fixed

- Prevented stale Bun cache restores on Linux release runners from causing `bun install --frozen-lockfile` to rewrite state and fail the publish pipeline.

## [0.10.4] - 2026-04-15

### Changed

- Updated GitHub Actions pins to current Node 24-compatible releases and replaced the deprecated cache action in shared CI/release setup.
- Refreshed direct runtime dependencies including `glob`, `otplib`, `@google/genai`, `google-auth-library`, and `better-sqlite3`.

### Fixed

- Migrated TOTP generation and verification to `otplib` v13 while preserving Maestro's existing 6-digit, 30-second, one-step drift behavior.
- Removed the package's direct install-time deprecation warnings from outdated `glob` and `otplib` releases.

## [0.10.3] - 2026-04-15

### Fixed

- Treat `tree-sitter` and `tree-sitter-bash` as optional install-time dependencies so Linux/Node 24 consumers can install Maestro even when native parser bindings are unavailable.

## [0.10.2] - 2026-04-15

### Fixed

- Cut the follow-up release after the initial trusted publishing migration.

## [0.10.1] - 2026-04-15

### Changed

- Switched npm release automation for `@evalops-jh/maestro` to GitHub trusted publishing via OIDC.

### Fixed

- Replaced published `workspace:*` internal dependency specifiers with concrete package versions in release manifests.
- Removed the need for a stored GitHub Actions npm token during package publication.

## Legacy Unreleased Notes

### Added

- **Jupyter Notebook Support**: New `notebook_edit` tool for editing `.ipynb` files at the cell level with `replace`, `insert`, and `delete` modes. The `read` tool now displays notebooks with formatted cell output.
- **PDF Reading**: The `read` tool now extracts and displays text content from PDF files using `pdf-parse`.
- **Image Processing with Sharp**: Optional `sharp` dependency for automatic image optimization before sending to LLMs. Reduces token usage by resizing large images and compressing screenshots.
- **System Reminder Injection**: New `SystemReminderManager` for injecting contextual reminders (e.g., todo list prompts, read-before-edit hints) into conversations via `<system-reminder>` tags.
- **Structured Questions**: New `ask_user` tool for gathering user input with predefined options (2-4 choices per question, multi-select support, automatic "Other" option).
- **SDK Tool Types**: Exported TypeBox schemas and TypeScript types for all built-in tools via `@evalops/composer/sdk-tools` for external SDK consumers.
- **Agent Resume Capability**: New `AgentTranscript` system for persisting and resuming agent executions, with `FileTranscriptStore` and `MemoryTranscriptStore` implementations.
- **Auto-Compaction System**: New `AutoCompactionMonitor` that automatically triggers conversation compaction when context window usage exceeds configurable thresholds. Environment variables: `MAESTRO_AUTOCOMPACT_PCT` (default: 85), `MAESTRO_AUTOCOMPACT_ENABLED`, `MAESTRO_AUTOCOMPACT_MIN_MESSAGES`.
- **Git State Tracking**: Extended git utilities with `getGitState()`, `getCommitSha()`, `getCurrentBranch()`, `isDirtyWorkingTree()`, and `getAheadBehind()` for comprehensive repository state tracking.
- **Business Telemetry Metrics**: New telemetry events for session tracking (`session.count`, `session.duration`), token usage (`tokens.input`, `tokens.output`, `tokens.cache_read`, `tokens.cache_write`), cost tracking (`cost.usd`), compaction events, and model switches.
- **Sandbox Violation Tracking**: New `recordSandboxViolation()` function for security auditing of blocked, warned, and allowed sandbox events.
- **Plan Mode Persistence**: New plan mode system with `enterPlanMode()`, `exitPlanMode()`, `writePlanFile()`, and file-based state persistence. Plan files are stored in `.maestro/plans/` with session and git state metadata.
- **Session Auto-Recovery**: New `SessionRecoveryManager` for automatic session backup and recovery. Includes periodic backups, recovery from crashes, and cleanup of expired backups. Environment variables: `MAESTRO_SESSION_RECOVERY_ENABLED`, `MAESTRO_SESSION_BACKUP_DIR`, `MAESTRO_SESSION_BACKUP_INTERVAL`.
- **IDE Auto-Connect**: New `IDEAutoConnectManager` that detects and tracks running IDEs (VS Code, Cursor, Windsurf, JetBrains IDEs, Vim, Neovim, Emacs, Sublime, Zed). Environment variables: `MAESTRO_IDE_AUTOCONNECT`, `MAESTRO_IDE_SCAN_PORTS`, `MAESTRO_IDE_TIMEOUT`.
- `MAESTRO_TRUST_PROXY` environment variable to trust `X-Forwarded-For` headers for rate limiting when behind a reverse proxy.
- `MAESTRO_TRUST_PROXY_HOPS` environment variable (default: 1) to configure number of trusted proxy hops for multi-proxy setups.

### Changed

- **BREAKING**: Removed legacy Anthropic OAuth fallback (`anthropic-oauth.json`). Users must re-authenticate using the new OAuth system (`oauth.json`) via `maestro anthropic login`. The legacy credential file is no longer read.
- **BREAKING**: Rate limiting now uses `socket.remoteAddress` by default instead of `X-Forwarded-For`. Deployments behind reverse proxies (nginx, CloudFlare, load balancers) must set `MAESTRO_TRUST_PROXY=true` to correctly identify client IPs.
- Enabled strict `noExplicitAny` linting rule in biome.json (changed from warn to error).
- Standardized `@sinclair/typebox` dependency to `^0.34.0` across all packages.
- Updated GitHub Actions pins to current Node 24-compatible releases and replaced the deprecated cache action in shared CI/release setup.
- Refreshed direct runtime dependencies including `glob`, `otplib`, `@google/genai`, and `better-sqlite3`.

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
- Treat `tree-sitter` and `tree-sitter-bash` as optional install-time dependencies so Linux/Node 24 users can install Maestro even when native parser bindings are unavailable.
- Migrated TOTP generation and verification to `otplib` v13 while preserving Maestro's existing 6-digit, 30-second, one-step drift behavior.
- Rebundled Google provider runtime dependencies into the built CLI/provider artifacts and removed the unused root `better-sqlite3` dependency to keep installs quieter and the published runtime surface tighter.

## 0.10.0 – 2025-11-18

### Added

- Browser-based Web UI with full Maestro core integration, live event streaming, industrial instrument panel theme, and comprehensive settings panel.
- Dedicated `@evalops/tui` package, concurrently-powered dev flows, and a shared tool loop/renderer architecture that can drive both the TUI and the Web UI.
- Expanded slash-command surface area including `/plan`, `/cost`, `/config`, `/telemetry`, `/about`, `/report`, `/share`, `/compact`, `/ollama`, `/update`, and `/exec`, plus richer diagnostics/export tooling.
- GitHub CLI tool suite (`gh_pr`, `gh_issue`, `gh_repo`) with advanced filtering, diff previews, and review helpers, along with Exa-powered `websearch`, `codesearch`, and `webfetch` tools.
- Comprehensive model registry (300+ entries), Google Gemini provider support, CLAUDE OAuth, enhanced provider metadata, and improved telemetry/reporting experiences.

### Changed

- Rebranded the project from "Maestro CLI" to simply "Maestro", updated documentation (README, Quickstart, Feature Guide, Contributing) and installation instructions, and aligned repo/package names.
- Extracted TUI components into modular views, introduced a refined loader/welcome animation system, and improved bash-mode UX with history, multiline paste, and autocomplete.
- Migrated tools to the new DSL, hardened the agent transport/event pipeline, and refactored exporter infrastructure, session compaction, and diagnostics rendering.
- Overhauled build/test workflows: explicit workspace builds, Bun/NPM alignment, chunked evals across OS matrices, ripgrep installation, and safer CI release gating.

### Fixed

- Stabilized cost-tracker tests (time range filter, cache accounting), resolved session hydration/state issues, and ensured timestamps render in ISO format across UIs.
- Hardened LSP bootstrap/root detection, nix builds, and workspace dependency ordering; reduced test flake by disabling problematic parallelism and organizing imports.
- Updated eval scenarios (including README first-line regex) to reflect the rename, expanded telemetry coverage, and eliminated Anthropic transport duplication bugs.

## 0.9.0 – 2025-01-15

- Baseline release with Maestro CLI/TUI, eval suite, and provider registry
- Added telemetry report tooling and mock-agent integration tests

Older history lives in the Git commit log.
