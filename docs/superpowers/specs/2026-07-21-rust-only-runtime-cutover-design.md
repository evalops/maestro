# Rust-Only Maestro Runtime Cutover Design

> **Historical:** This is a dated engineering record from before the Rust-only runtime migration (#3016, #3017, merged 2026-07-22), which deleted Maestro's TypeScript agent runtime and SDK. Paths below reflect the TypeScript tree as it existed at the time and are kept as-written for historical accuracy; do not treat them as live code.


**Date:** 2026-07-21

**Status:** Approved for implementation planning

## Objective

Complete Maestro's TypeScript-to-Rust migration by making Rust the only implementation language for shipped agent execution, command-line behavior, and the web control plane. Delete the internal TypeScript agent SDK and every TypeScript execution fallback. Preserve existing user-visible contracts through language-neutral fixtures and fail closed when native functionality is unavailable.

The existing Rust foundations are authoritative:

- `packages/tui-rs` owns the agent loop, terminal UI, headless protocol, tools, providers, sessions, safety, hooks, skills, and hosted runner.
- `packages/control-plane-rs` owns HTTP, SSE, WebSocket, browser-backend behavior, static asset delivery, sessions, authentication, models, A2A, and direct in-process use of the Rust agent.

This is a hard cutover, not a prolonged dual-runtime migration.

## Scope

### In scope

- Replace the Node `maestro` launcher with a Rust `maestro` binary.
- Make the Rust control plane the backend for `maestro web`.
- Move all LLM execution, provider routing, tools, sessions, safety, policy, telemetry, automations, hooks, background work, and agent lifecycle behavior to Rust.
- Convert Slack, GitHub, IDE, eval, development, and hosted consumers from in-process TypeScript agent construction to Rust control-plane or headless protocol clients.
- Delete `@evalops/ai`, `@evalops/maestro-core`, the root TypeScript agent implementation, and executable TypeScript provider/tool/runtime code after their observable contracts have been captured.
- Complete accepted headless protocol messages and remaining native command parity.
- Preserve legacy session, configuration, and database compatibility through Rust readers and migrations.
- Replace release, installer, smoke, and CI assumptions with native-only artifacts.
- Remove migration flags, fallback branches, ratchet baselines, dead tests, and stale documentation.

### Out of scope

- Rewriting browser-rendered UI code in Rust. The web frontend may remain TypeScript and is served as static assets.
- Rewriting TypeScript IDE or chat-service transport adapters when they contain no agent execution logic.
- Removing generated TypeScript wire types needed by TypeScript frontends or adapters.
- Unrelated package consolidation or feature development.

## Target Architecture

### Native `maestro` binary

A Rust `maestro` binary becomes the canonical installed entrypoint. It owns argument parsing, environment and configuration loading, telemetry startup, authentication helpers, utility command dispatch, interactive TUI startup, print/exec/headless modes, hosted runner startup, and `maestro web`.

The binary routes directly to Rust library APIs. It must not spawn Node or Bun. Process spawning is allowed only for explicit user tools, configured hooks or MCP servers, provider-owned helpers such as the Codex app-server package where required by that provider contract, and other documented external integrations. None may provide an alternate Maestro agent loop.

### Agent runtime

`packages/tui-rs` remains the single agent core. It exposes reusable library interfaces for interactive, print, exec, headless, hosted, Slack, GitHub, IDE, automation, prompt-suggestion, memory, and web turns. All surfaces share the same provider, tool, approval, sandbox, session, telemetry, and hook behavior.

Every accepted headless request receives a real implementation or a typed unsupported-version error. No request is acknowledged and ignored. Capability negotiation advertises only implemented operations.

### Rust web control plane

`packages/control-plane-rs` becomes a reusable library plus the `maestro-control-plane` server binary. The native `maestro web` command starts it in-process. It serves the existing browser bundle and owns all backend routes, including HTTP APIs, SSE, WebSockets, authentication, CSRF/CORS, sessions, sharing, approvals, attachments, models, usage, telemetry, automations, background work, A2A, and persistence.

The control plane invokes `maestro-tui` library APIs directly. It does not spawn a second Maestro runtime process for local turns and never invokes TypeScript agent code.

### TypeScript adapters and contracts

Slack, GitHub, and IDE packages may remain TypeScript only as thin transport and presentation adapters. They submit turns to the Rust control plane or native headless protocol and consume versioned events. They do not import providers, tools, agent classes, model execution, approval engines, session managers, or runtime factories.

Shared TypeScript schemas required by browser or adapter code live in `packages/contracts`. They contain types, validators, and generated protocol descriptors, but no executable agent loop or provider transport.

## Deletion-First Cutover

The implementation sequence intentionally prevents the TypeScript runtime from remaining as a crutch:

1. Capture externally observable behavior in language-neutral fixtures before deleting implementation code. Fixtures cover CLI routing, HTTP, SSE, WebSockets, headless messages, Slack events, provider/model resolution, tools, sessions, approvals, telemetry, persistence, and errors.
2. Delete TypeScript agent, provider, transport, tool-execution, and SDK implementations and their exports. TypeScript compilation failures become the authoritative inventory of remaining consumers.
3. Move shared data-only contracts into `packages/contracts` and convert each consumer to the Rust protocol.
4. Complete the Rust behavior required by the fixtures and consumer inventory.
5. Switch packaging and dispatch to the native `maestro` binary.
6. Delete the Node CLI shim, TypeScript web backend, migration switches, deprecated aliases that select TS behavior, obsolete baselines, and dual-runtime tests.

Compatibility aliases may remain only when they route to the same Rust implementation. No environment variable, command flag, package export, test helper, or hidden endpoint may restore the TypeScript agent.

## Required Parity Work

### Headless and control-plane protocol

- Implement client-side tool results, generic server request responses, utility command start/terminate/stdin/resize, utility file search/read, file watching, and every other accepted `ToAgentMessage` variant.
- Negotiate capabilities from actual handler availability.
- Preserve ordering, correlation identifiers, cancellation, terminal events, error classification, and reconnect/session behavior.
- Return typed protocol errors for unsupported versions or operations.

### Providers and models

- Establish a provider matrix from the deleted SDK behavior and current product configuration.
- Match authentication sources, custom base URLs, OAuth, model aliases, streaming, tool calling, reasoning, usage, rate-limit/error normalization, and compatibility flags.
- Cover Anthropic, OpenAI/Codex, Google/Vertex, Azure, OpenRouter, GitHub Copilot, Bedrock, Groq, Cerebras, xAI, DeepSeek, Moonshot/Kimi, Qwen/DashScope, MiniMax, Z.ai, Mistral, and configured OpenAI-compatible providers used by Maestro.

### Commands and runtime services

- Complete `context` MCP auth-preset, header-helper, and remote-trust metadata behavior.
- Complete `run` legacy entry reconstruction, derived timeline events, and promotion operation expansion.
- Match LSP operations, telemetry/cost reporting, connectors, Guardian/Semgrep policy, enterprise controls, A2A controller behavior, automations, background work, memory, hooks, and session lifecycle behavior.
- Replace TS-only eval and developer utilities with native headless invocations or data-only tooling.

### Slack and other product adapters

- Replace Slack's main-turn, summary, and dashboard `Agent` construction with Rust requests.
- Preserve structured events, tool approval, connector tools, streaming updates, cancellation, conversation context, and error reporting.
- Apply the same rule to any GitHub, IDE, hosted, test, or script consumer found by deletion-driven compilation.

## Data Compatibility and Migration

Rust must read current Maestro session JSONL, configuration files, secrets references, command preferences, usage data, A2A ledgers, and supported database state. Migration tests operate on copies of real legacy fixtures and prove:

- reads do not mutate data;
- upgrades are atomic and recoverable;
- unknown fields are preserved where contracts require forward compatibility;
- invalid or partially written state fails with an actionable error;
- successful migration preserves session history, branching, approvals, usage, and ownership boundaries;
- repeated migration is idempotent.

No destructive in-place migration runs without a backup or atomic replacement strategy.

## Error Handling and Safety

The runtime fails closed. Missing native artifacts, invalid policy state, unavailable providers, unsupported protocol requests, failed migrations, and missing required authentication produce explicit typed errors. They never select a TypeScript fallback.

Security parity includes path containment, shell analysis, sandbox modes, SSRF controls, CORS/CSRF/auth, secret redaction, symlink escape prevention, connector credential scoping, approval modes, enterprise policy, and audit evidence. Rust behavior must meet or strengthen the existing contract; checks may not be weakened to achieve parity.

## Verification Strategy

Every behavior change follows test-first development:

1. Add or identify a fixture/regression test that represents the required contract.
2. Run it against Rust and observe the expected failure.
3. Implement the smallest Rust behavior that satisfies it.
4. Run targeted and adjacent tests until green.
5. Refactor only while tests remain green.

Contract suites compare exact status codes, headers, JSON, SSE, WebSocket events, headless messages, session files, provider routing, approval decisions, tool results, telemetry, and exit codes.

Required final gates are:

- `cargo fmt --check` for every Rust package;
- Clippy with warnings denied;
- all Rust unit, integration, protocol, security, and migration tests;
- browser frontend build and tests;
- TypeScript adapter and generated-contract checks;
- scenario replay and eval suites;
- release packaging and install smokes in an environment without Node or Bun;
- native TUI, exec, headless, web, Slack-turn, session-resume, and upgrade smokes;
- all required GitHub checks green.

Static CI guards reject:

- executable TS imports from deleted SDK/runtime packages;
- `new Agent`, `ProviderTransport`, or TS agent factories outside historical fixtures;
- Node/Bun spawning by shipped Maestro runtime code;
- accepted protocol variants without handlers;
- TypeScript fallback flags or routes;
- release artifacts that require Node/Bun;
- stale documentation claiming dual-runtime support.

## Delivery and Merge

Work lands on one integration branch as small, reviewable commits. Each commit has its own passing targeted tests. The final pull request is ready for review, not a draft, and documents deletions, compatibility, security impact, migration behavior, and verification evidence.

The branch is pushed without rewriting shared history. Review comments and CI failures are fixed with additional commits. The pull request merges only after every required check is green. After merge, `main` is refreshed and its required checks are verified again. Obsolete migration issues are then closed or superseded with links to the merged pull request.

## Completion Criteria

The migration is complete when all of the following are true:

- every Maestro agent turn runs in Rust;
- `maestro`, `maestro web`, TUI, exec, headless, hosted runner, Slack, GitHub, IDE, automation, memory, and prompt-suggestion surfaces have no TS execution path;
- the internal TS agent SDK and implementation are deleted;
- Rust satisfies the captured product contracts and legacy data migrations;
- shipped artifacts run without Node or Bun;
- static guards prevent TS runtime reintroduction;
- repository documentation and issue tracking describe the Rust-only architecture;
- the pull request and post-merge `main` checks are green.
