# Maestro Architecture

Maestro is a multi-surface agent runtime (CLI/TUI, web, IDEs, bots) that shares one event-driven core and pluggable provider/tool layers. This document is a navigation guide for contributors. For deep dives, see the linked [design docs](#key-design-docs).

---

## System Overview

```
┌─────────────────────────────────────────────────────────────┐
│                        SURFACES                              │
│  TUI (native maestro-tui) │  Web UI  │  Slack  │  GitHub     │
│  VS Code │  JetBrains │  Conductor │  Headless │  Ambient  │
└──────┬──────────┬──────────┬──────────┬──────────┬──────────┘
       │          │          │          │          │
       ▼          ▼          ▼          ▼          ▼
┌─────────────────────────────────────────────────────────────┐
│                      AGENT CORE                              │
│  Event-driven LLM loop • Tool execution • Context sources   │
│  System prompt assembly • Message transformation             │
│  Rust NativeAgent / maestro-tui for every product surface    │
└────────────────────────────┬────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────┐
│                    TRANSPORT LAYER                            │
│  Canonical event format: message_start/end, content_block_   │
│  delta, tool_call — all providers normalize to this contract │
├──────────────────────┬──────────────────────────────────────┤
│  First-class adapters│  Aggregator / pass-through            │
│  ─────────────────── │  ──────────────────────               │
│  Anthropic (Claude)  │  OpenRouter                           │
│  OpenAI (GPT/o-*)    │  Azure OpenAI                         │
│  Google (Gemini)     │  AWS Bedrock                          │
│  Groq / xAI          │                                       │
│  Cerebras            │                                       │
└──────────────────────┴──────────────────────────────────────┘
```

First-class adapters have dedicated wire-protocol conversion and testing. Aggregator providers re-use an existing adapter's format (e.g., Azure uses the OpenAI adapter).

Interactive terminal sessions and server agent turns use the **native** Rust agent
inside `maestro-tui` (interactive TUI and `maestro-tui --headless`). The TypeScript
`Agent` class remains available from SDK packages for external embedding only.
See [TypeScript Agent status](#typescript-agent-status).

## TypeScript Agent status

Product agent execution is Rust-only. Web chat, automations, hosted headless,
prompt suggestion, interactive, print, exec, RPC, and hosted-runner paths all
use `maestro-tui`; a missing or failed native process fails closed.

The TypeScript `Agent` and `ProviderTransport` exports remain only as SDK APIs
for external embedding. They are not wired into Maestro product or server
contexts, and no environment variable can re-enable them.

| Layer | Runtime |
|-------|---------|
| Server product surfaces | Native `maestro-tui --headless` only |
| Interactive CLI/TUI | Native `maestro-tui` only |
| SDK packages | TypeScript APIs remain available to external SDK consumers |

Contributors must not add in-process `createAgent` call sites to product code.
Use `NativeHeadlessClient`, `runNativeWebChatTurn`, or
`runNativeBackgroundPrompt`.

### Server agent runtime (native only)

`MAESTRO_TUI_BIN` may override binary resolution. `MAESTRO_NATIVE_MEMORY=0`
disables automatic memory work, but does not select another agent runtime.
Native start and turn failures return errors; there is no fallback or escape
hatch.

Hosted headless keeps connection leases, utility commands, file watches, and
event replay in the Node control plane while the agent loop runs in the Rust
child process. Web SSE/WS chat, scheduled automations, and prompt suggestions
likewise use native headless turns and native background one-shots.

---
## Repository Layout

| Path | Purpose |
|------|---------|
| `src/main.ts` / `src/cli.ts` | **CLI entrypoint** — argument parsing; interactive mode launches native TUI |
| `src/cli/native-tui-launcher.ts` | Resolves and spawns the `maestro-tui` binary (incl. piped `--headless`) |
| `src/server/native-agent-flags.ts` | Native memory scheduling configuration |
| `src/server/native-memory.ts` | Native one-shot durable memory extraction/consolidation coordinators |
| `src/server/native-memory-noop.ts` | No-op auto memory coordinators (`MAESTRO_NATIVE_MEMORY=0`) |
| `src/server/native-background-prompt.ts` | Short-lived native one-shot helper (prompt suggestion, memory, etc.) |
| `src/server/web-native-chat.ts` | Native headless helper for SSE/WS chat |
| `src/server/automations/native-runner.ts` | Native automation turn wrapper |
| `src/server/headless-runtime-service.ts` | Hosted native headless sessions |
| `src/server/headless-native-bridge.ts` | Start + publish bridge for native headless runtime backend |
| `src/server/native-headless-client.ts` | NDJSON client for `maestro-tui --headless` |
| `src/server/native-headless-event-adapter.ts` | Headless protocol → `AgentEvent` adapter for web chat |
| `src/agent/` | TypeScript Agent class, event system, context manager, message transformer |
| `src/tools/` | Tool DSL, built-in tools (read/write/edit/bash/search), tool cache |
| `src/safety/` | Action firewall, approval modes, guardian (Semgrep/secrets) |
| `src/session/` | JSONL session persistence, branching, metadata cache (TS surfaces) |
| `src/server/` | HTTP/WebSocket server for web UI and API surfaces |
| `src/mcp/` | Model Context Protocol client, server management (TS surfaces) |
| `src/hooks/` | Lifecycle hooks (PreToolUse, PostToolUse, etc.) |
| `src/config/` | Configuration loading, framework preferences, model registry |
| `src/workflows/` | Declarative multi-step workflow engine |
| `src/memory/` | Cross-session memory store |
| `src/telemetry/` | Cost tracking, observability, wide events, security events |
| `packages/ai/` | `@evalops/ai` — shared SDK: model registry, transport, agent types |
| `packages/tui-rs/` | **Native** Rust TUI + agent binary (`maestro-tui`); only interactive UI |
| `packages/web/` | `@evalops/maestro-web` — browser UI (Lit, Vite) |
| `packages/contracts/` | `@evalops/contracts` — shared TypeScript definitions |
| `packages/slack-agent/` | Slack bot surface with Docker sandbox |
| `packages/github-agent/` | Autonomous GitHub agent (issue → PR pipeline) |
| `packages/ambient-agent-rs/` | Always-on Rust GitHub daemon |
| `packages/vscode-extension/` | VS Code extension |
| `packages/jetbrains-plugin/` | JetBrains plugin |
| `docs/design/` | Detailed design documents (see [table below](#key-design-docs)) |
| `test/` | Vitest test suite (~4500 tests) |
| `evals/` | Evaluation scenarios (`npx nx run maestro:evals`; CI runs on `run-evals` label) |

> **Removed:** `packages/tui` (`@evalops/tui`) and `src/cli-tui/` (TypeScript TUI)
> were deleted in PR #2891. Do not reintroduce them.

### Surface Entrypoints

| Surface | Entrypoint |
|---------|------------|
| **Native TUI** | `maestro` → `src/cli/native-tui-launcher.ts` → `packages/tui-rs` (`maestro-tui`) |
| **Web UI** | `src/server/` (backend) + `packages/web/` (frontend) |
| **VS Code** | `packages/vscode-extension/` |
| **Slack Bot** | `packages/slack-agent/src/index.ts` |
| **GitHub Agent** | `packages/github-agent/src/index.ts` |
| **Ambient Agent** | `packages/ambient-agent-rs/src/main.rs` |
| **Headless / one-shot** | Native `maestro-tui --headless` |

### Configuration Precedence (highest wins)

1. Environment variables (`ANTHROPIC_API_KEY`, `MAESTRO_SAFE_MODE`, etc.)
2. Project-local `.maestro/` directory (mcp.json, firewall.json, commands/)
3. Project-root `AGENT.md` / `CLAUDE.md`
4. Parent directory `AGENT.md` files (walked upward)
5. Global `~/.maestro/` directory (agent/AGENT.md, mcp.json, firewall.json)

---

## Core Abstractions

### Agent (`src/agent/agent.ts`)

> **Status:** TypeScript `Agent` is retained for external **SDK embedding** only.
> Server and interactive product runtimes use native `maestro-tui`. See
> [TypeScript Agent status](#typescript-agent-status).
> Package exports of `Agent` / `ProviderTransport` are `@deprecated` for server use.

Event-driven LLM interaction loop. Manages conversation state, streams responses, coordinates tool execution, and emits events consumed by all surfaces.

Key state: `messages`, `model`, `tools`, `thinkingLevel`, `isStreaming`, `streamMessage`.

Subscribers receive typed events: `agent_start`, `message_start`, `content_block_delta`, `tool_execution_start/end`, `message_end`, `agent_end`.

#### Event Invariants

These hold across all surfaces and providers:

- `agent_start` emitted exactly once per `Agent.prompt()` call, before any messages
- `message_start` emitted exactly once per message (user or assistant); carries `{role, message_id}`
- `message_end` emitted exactly once per message; this is the **persistence boundary** — session writes flush here
- `content_block_delta` arrives zero or more times between `message_start` and `message_end`; may carry text or thinking blocks
- Tool calls arrive after text deltas within the same assistant message; multiple tool calls may interleave (parallel tool use)
- `tool_execution_start` / `tool_execution_end` bracket each tool invocation; they nest inside the assistant message that requested them
- `agent_end` emitted exactly once, after the final `message_end`, signaling the prompt cycle is complete
- User `message_start`/`message_end` are synthetic (emitted by Agent, not the provider); assistant ones are driven by the provider stream

### Transport (`packages/ai/src/transport.ts`)

Provider-agnostic streaming layer. Converts between each provider's wire protocol (Anthropic Messages, OpenAI Chat/Responses, Google GenerativeAI) and the canonical internal event format described above. Handles usage tracking, cost calculation, and thinking/reasoning block normalization across providers.

### Tools (`src/tools/`)

Safety-gated execution framework. Tools are defined with `createTool()` / `createTextTool()` / `createJsonTool()` using TypeBox schemas and AJV validation. Features: LRU result caching with git-aware invalidation, abort signal support, retry with exponential backoff, and sandbox integration. MCP tools are dynamically loaded as `mcp__<server>__<tool>`.

### Session (`src/session/manager.ts`)

JSONL persistence with buffered writes. Sessions are lazily initialized (file created only after first user + assistant exchange). Supports branching (fork from any message), metadata caching, and crash recovery via `beforeExit`/`SIGINT`/`SIGTERM` flush handlers.

### TUI (`packages/tui-rs/`)

Native `maestro-tui` binary (ratatui + crossterm) with its own agent loop, provider
clients, tools, safety, sessions, MCP, hooks, and skills. No Node subprocess for
interactive turns. See [TUI Architecture](TUI_ARCHITECTURE.md) and
[Native TUI parity](NATIVE_TUI_PARITY.md).

---

## Request Lifecycle

```
User types prompt
       │
       ▼
┌──────────────┐
│ Prompt Queue │ ← Prevents concurrent prompts; supports queue modes
└──────┬───────┘
       │
       ▼
┌──────────────────────────────────────────────────────────┐
│ Agent.prompt()                                            │
│  1. Create UserMessage, append to state.messages         │
│  2. Run messageTransformer (attachments → content blocks) │
│  3. Normalize messages for target provider               │
│  4. Collect context sources (todo, background, LSP, etc.) │
│  5. Inject context into system prompt                    │
│  6. Emit agent_start                                     │
└──────┬───────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────┐
│ Transport.run()                                           │
│  Stream events from LLM provider                         │
│  → content_block_delta (text/thinking)                   │
│  → tool_call (triggers tool execution)                   │
└──────┬───────────────────────────────────────────────────┘
       │
       ▼  (if tool calls)
┌──────────────────────────────────────────────────────────┐
│ Tool Execution                                            │
│  1. Action Firewall validates safety                     │
│  2. PreToolUse hooks fire                                │
│  3. Schema validation (AJV)                              │
│  4. Execute handler (with abort signal, sandbox)         │
│  5. PostToolUse hooks fire                               │
│  6. Tool result → append to messages → continue loop     │
└──────┬───────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────┐
│ Event Subscribers / native UI                             │
│  • Native TUI App → ratatui screen update                │
│  • Session Manager → JSONL persistence                   │
│  • Telemetry → duration, cost, success tracking          │
│  • Web UI → SSE/WebSocket forwarding                     │
└──────────────────────────────────────────────────────────┘
```

The loop continues until the LLM returns `end_turn` (no more tool calls).

### Abort Paths

These are where bugs live. Know the failure modes:

- **Tool schema validation fails** → tool result is an error message; LLM sees it and can retry or report
- **Tool execution throws / times out** → error caught, formatted as tool error result, loop continues
- **Abort signal triggers** (user Ctrl+C, `/steer`) → in-flight tool receives AbortSignal; partial results discarded; `agent_end` still emits
- **Provider stream disconnects** → transport throws; Agent catches, emits `agent_end` with error; exponential backoff on retry if configured
- **Approval required in headless mode** → firewall returns `"fail"` decision; tool result is a rejection message; LLM sees the denial
- **Token budget exceeded** → auto-compaction triggered (older messages summarized); if compaction is disabled, agent emits error and stops
- **PreToolUse hook rejects** → tool execution skipped; rejection reason returned as tool result

---

## Multi-Surface Architecture

All surfaces share the Agent core via different integration patterns:

| Surface | Integration | Notes |
|---------|-------------|-------|
| **Native TUI** (`packages/tui-rs/`) | Standalone — own agent + native provider clients | **Only** interactive terminal UI; no Node subprocess |
| **Web UI** (`packages/web/`) | HTTP/WS — `src/server/` wraps Agent, streams via SSE/WebSocket | Lit components, Vite build |
| **VS Code / JetBrains** | Extension/Plugin — spawns Maestro process, communicates via RPC | IDE-aware context (diagnostics, references) |
| **Slack Bot** (`packages/slack-agent/`) | Docker sandbox — runs Agent in isolated container per request | Async queuing, approval workflows |
| **GitHub Agent** (`packages/github-agent/`) | Headless — label-triggered, runs Agent on issue/PR events | Self-improvement pipelines |
| **Conductor** | Chrome extension — connects to web server via Bridge | Browser automation tools |
| **Ambient Agent** (`packages/ambient-agent-rs/`) | Rust daemon — watches repos, ships PRs autonomously | Always-on GitHub monitoring |

---

## Slash Command System (native TUI)

Interactive slash commands live in the Rust TUI. Register and handle them under
`packages/tui-rs`:

### 1. Command types (`packages/tui-rs/src/commands/types.rs`)

Define `Command` metadata and any context the handler needs.

### 2. Registry (`packages/tui-rs/src/commands/registry.rs`)

Add the command to `build_command_registry()` (name, description, usage, tags).
Fuzzy matching and tab completion are provided by `commands/matcher.rs`.

### 3. Handler (`packages/tui-rs/src/app/command_handlers.rs`)

Wire the command action to App behavior (modals, agent calls, status updates).

### 4. Tests

Cover parsing/dispatch in `commands/registry/tests.rs` and/or `app/tests.rs`.

Selector-style commands (`/model`, `/theme`, `/approvals`) open ratatui components
under `packages/tui-rs/src/components/`. See [TUI Architecture](TUI_ARCHITECTURE.md).

> **Historical:** The TS catalog/adapter pattern under `src/cli-tui/commands/` was
> removed with the TypeScript TUI (PR #2891).

---

## Safety & Approvals

```
Tool Call
    │
    ▼
┌──────────────────┐
│ Action Firewall   │ ← Intercepts every tool request
│  • Path traversal │
│  • System paths   │    Hard-blocks: /etc, /usr, /var, /boot, /sys
│  • Destructive    │    Detects: rm -rf, mkfs, dd, chmod 000
│  • Tree-sitter    │    Parses bash for sudo, force-push, etc.
│  • Workspace      │    Requires approval for writes outside project
└──────┬───────────┘
       │
       ▼
┌──────────────────┐
│ Approval Mode     │
│  prompt (default) │ ← Ask user in TUI; fail in headless
│  auto             │ ← Auto-approve (trusted sandboxes only)
│  fail             │ ← Reject all high-risk commands
└──────┬───────────┘
       │
       ▼
┌──────────────────┐
│ Guardian          │ ← Semgrep (p/secrets + p/ci) on staged files
│  Pre-commit gate  │   Runs before git commits/pushes from Maestro
└──────────────────┘
```

### Trust Boundaries

- **Workspace** = the project root directory (detected via `.git`, `package.json`, etc.). File writes inside workspace are allowed; writes outside require explicit approval. Additional trusted paths can be added via `containment.trustedPaths` in `~/.maestro/firewall.json`.
- **Trusted sandbox** for `auto` mode = environments where a human is not present to approve (Docker containers, CI runners). The Slack bot's Docker sandbox uses `auto` because each request runs in an isolated container. IDE surfaces (VS Code, JetBrains) default to `prompt`.
- **MCP tools are third-party.** They go through the same firewall and approval pipeline as built-in tools. An MCP tool calling `bash` still triggers destructive-command detection. MCP servers do *not* inherit `process.env` by default (only `PATH`, `HOME`, `USER`, `SHELL`, `TERM`).
- **`MAESTRO_SAFE_MODE=1`** enables safe mode globally: all mutations require approval regardless of other settings.

---

## Key Design Docs

All located in `docs/design/`. Start with Agent State Machine for the core event flow.

| Document | Description |
|----------|-------------|
| [Agent State Machine](design/AGENT_STATE_MACHINE.md) | Event-driven LLM loop, prompt execution, state management |
| [Tool System](design/TOOL_SYSTEM.md) | Tool DSL, validation, caching, retry, sandbox |
| [Context Management](design/CONTEXT_MANAGEMENT.md) | Token budgeting, context sources, auto-compaction |
| [Session Persistence](design/SESSION_PERSISTENCE.md) | JSONL storage, buffered writes, branching, crash recovery |
| [TUI Architecture](TUI_ARCHITECTURE.md) | Native maestro-tui overview (current) |
| [Native TUI parity](NATIVE_TUI_PARITY.md) | Feature checklist vs removed TS interactive agent |
| [TUI Rendering](design/TUI_RENDERING.md) | **Historical** TS differential-rendering design (pre-#2891) |
| [Web UI Architecture](design/WEB_UI_ARCHITECTURE.md) | Browser interface, SSE/WebSocket, Lit components |
| [Safety & Firewall](design/SAFETY_FIREWALL.md) | Rule-based enforcement, dangerous command detection |
| [Hooks System](design/HOOKS_SYSTEM.md) | PreToolUse/PostToolUse lifecycle, external integrations |
| [MCP Integration](design/MCP_INTEGRATION.md) | Model Context Protocol, dynamic tool loading |
| [LSP Integration](design/LSP_INTEGRATION.md) | Language Server Protocol for IDE features |
| [OAuth & Authentication](design/OAUTH_AUTHENTICATION.md) | Multi-provider OAuth, token management |
| [Database & Persistence](design/DATABASE_PERSISTENCE.md) | Schema, migrations, encryption |
| [Enterprise RBAC](design/ENTERPRISE_RBAC.md) | Role-based access, audit logging, multi-tenancy |
| [Telemetry & Cost](design/TELEMETRY_COST.md) | Usage tracking, cost calculation, analytics |
| [Ambient Agent](design/AMBIENT_AGENT.md) | Always-on GitHub agent daemon |
| [Session Hub](design/SESSION_HUB_DO.md) | DigitalOcean-hosted session infrastructure ("DO" = DigitalOcean) |
| [Design Index](design/INDEX.md) | Full index with reading order |

---

## Common Edit Patterns

Quick reference for "where do I change X?"

| Task | Files to touch |
|------|----------------|
| **Add a slash command (TUI)** | `packages/tui-rs/src/commands/{types,registry}.rs` → `app/command_handlers.rs` → tests |
| **Add a built-in tool (TS surfaces)** | Create in `src/tools/`, register in tool list, add test in `test/tools/` |
| **Add a built-in tool (native TUI)** | `packages/tui-rs/src/tools/` + registry |
| **Add an MCP server** | `~/.maestro/mcp.json` or `.maestro/mcp.json` — tools auto-register as `mcp__<server>__<tool>` |
| **Add a provider (TS)** | Transport adapter in `packages/ai/`, model entries in registry, compat flags if needed |
| **Add a provider (native)** | Client under `packages/tui-rs/src/ai/` |
| **Add a context source (TS)** | Implement `AgentContextSource`, register in `AgentContextManager` |
| **Add a TUI modal/selector** | Component in `packages/tui-rs/src/components/`, wire from App / commands |
| **Add a lifecycle hook** | TS: hook types + agent/tool executor; native: `packages/tui-rs/src/hooks/` |
| **Fix terminal rendering** | `packages/tui-rs` only (TS TUI removed) |
| **Add a web API endpoint** | Route in `src/server/`, handler using shared Agent, update `packages/web/` if UI needed |
| **Run tests** | `npx nx run maestro:test --skip-nx-cache` (full) or `bunx vitest --run -t "name"` (targeted); `bun run tui-rs:test` for native |
| **Lint** | `bun run bun:lint` (Biome + eval verifier) |

---

## First Contribution

Get a local build running and make a visible change in under 10 minutes:

```bash
# 1. Install and verify
bun install
npx nx run maestro:test --skip-nx-cache   # ~4500 tests, should all pass

# 2. See what you're working with
npx nx graph --focus maestro               # dependency visualization

# 3. Make a change — pick one:
#    a) Edit a native TUI string: grep for "Maestro" in packages/tui-rs/src and change it
#    b) Add a toy tool: create src/tools/clock.ts that returns Date.now()
#    c) Add a slash command /ping in packages/tui-rs commands/registry + handlers

# 4. Verify
bun run bun:lint
bunx vitest --run -t "your test name"
# if you touched packages/tui-rs:
bun run tui-rs:check
```

---

*See also: [README.md](../README.md) · [CLAUDE.md](../CLAUDE.md) · [Contributing](../CONTRIBUTING.md) · [Architecture Diagrams](ARCHITECTURE_DIAGRAM.md)*
