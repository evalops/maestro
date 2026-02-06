# Composer Architecture

Composer is a multi-surface agent runtime (CLI/TUI, web, IDEs, bots) that shares one event-driven core and pluggable provider/tool layers. This document is a navigation guide for contributors. For deep dives, see the linked [design docs](#key-design-docs).

---

## System Overview

```
┌─────────────────────────────────────────────────────────────┐
│                        SURFACES                              │
│  TUI (TS)  │  Web UI  │  Slack  │  GitHub  │  Conductor    │
│  TUI (Rust)│  VS Code │  JetBrains │  Headless │  Ambient  │
└──────┬──────────┬──────────┬──────────┬──────────┬──────────┘
       │          │          │          │          │
       ▼          ▼          ▼          ▼          ▼
┌─────────────────────────────────────────────────────────────┐
│                      AGENT CORE                              │
│  Event-driven LLM loop • Tool execution • Context sources   │
│  System prompt assembly • Message transformation             │
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

Every surface shares the same Agent core, tool set, and safety layers.

---

## Repository Layout

| Path | Purpose |
|------|---------|
| `src/cli.ts` | **CLI entrypoint** — argument parsing, launches TUI or headless |
| `src/agent/` | Agent class, event system, context manager, message transformer |
| `src/cli-tui/` | TypeScript TUI: renderer, commands, modals, controllers, selectors |
| `src/tools/` | Tool DSL, built-in tools (read/write/edit/bash/search), tool cache |
| `src/safety/` | Action firewall, approval modes, guardian (Semgrep/secrets) |
| `src/session/` | JSONL session persistence, branching, metadata cache |
| `src/server/` | HTTP/WebSocket server for web UI and API surfaces |
| `src/mcp/` | Model Context Protocol client, server management |
| `src/hooks/` | Lifecycle hooks (PreToolUse, PostToolUse, etc.) |
| `src/config/` | Configuration loading, framework preferences, model registry |
| `src/workflows/` | Declarative multi-step workflow engine |
| `src/memory/` | Cross-session memory store |
| `src/telemetry/` | Cost tracking, observability, wide events, security events |
| `packages/ai/` | `@evalops/ai` — shared SDK: model registry, transport, agent types |
| `packages/tui/` | `@evalops/tui` — terminal UI library: differential rendering, widgets |
| `packages/tui-rs/` | Native Rust TUI binary (standalone, no Node subprocess) |
| `packages/web/` | `@evalops/composer-web` — browser UI (Lit, Vite) |
| `packages/contracts/` | `@evalops/contracts` — shared TypeScript definitions |
| `packages/slack-agent/` | Slack bot surface with Docker sandbox |
| `packages/github-agent/` | Autonomous GitHub agent (issue → PR pipeline) |
| `packages/ambient-agent-rs/` | Always-on Rust GitHub daemon |
| `packages/vscode-extension/` | VS Code extension |
| `packages/jetbrains-plugin/` | JetBrains plugin |
| `docs/design/` | 17 detailed design documents (see [table below](#key-design-docs)) |
| `test/` | Vitest test suite (~4500 tests) |
| `evals/` | Evaluation scenarios (`npx nx run composer:evals`; CI runs on `run-evals` label) |

### Surface Entrypoints

| Surface | Entrypoint |
|---------|------------|
| **TS TUI** | `src/cli.ts` → `src/cli-tui/tui-renderer.ts` |
| **Rust TUI** | `packages/tui-rs/src/main.rs` |
| **Web UI** | `src/server/` (backend) + `packages/web/` (frontend) |
| **VS Code** | `packages/vscode-extension/` |
| **Slack Bot** | `packages/slack-agent/src/index.ts` |
| **GitHub Agent** | `packages/github-agent/src/index.ts` |
| **Ambient Agent** | `packages/ambient-agent-rs/src/main.rs` |

### Configuration Precedence (highest wins)

1. Environment variables (`ANTHROPIC_API_KEY`, `COMPOSER_SAFE_MODE`, etc.)
2. Project-local `.composer/` directory (mcp.json, firewall.json, commands/)
3. Project-root `AGENT.md` / `CLAUDE.md`
4. Parent directory `AGENT.md` files (walked upward)
5. Global `~/.composer/` directory (agent/AGENT.md, mcp.json, firewall.json)

---

## Core Abstractions

### Agent (`src/agent/agent.ts`)

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

### TUI (`src/cli-tui/`, `packages/tui/`)

Differential rendering engine that minimizes terminal writes. `TuiRenderer` subscribes to Agent events, delegates to views (message, tool output), controllers (queue, plan, approval), and modals (selectors, command palette). The `@evalops/tui` library provides the low-level rendering pipeline, widgets, and synchronized output.

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
│ Event Subscribers                                         │
│  • TUI Renderer → differential screen update             │
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
| **TS TUI** (`src/cli-tui/`) | Direct — `TuiRenderer` subscribes to `Agent.subscribe()` | Main interactive surface |
| **Rust TUI** (`packages/tui-rs/`) | Standalone — own agent + native provider clients | No Node subprocess; mirrors TS feature set |
| **Web UI** (`packages/web/`) | HTTP/WS — `src/server/` wraps Agent, streams via SSE/WebSocket | Lit components, Vite build |
| **VS Code / JetBrains** | Extension/Plugin — spawns Composer process, communicates via RPC | IDE-aware context (diagnostics, references) |
| **Slack Bot** (`packages/slack-agent/`) | Docker sandbox — runs Agent in isolated container per request | Async queuing, approval workflows |
| **GitHub Agent** (`packages/github-agent/`) | Headless — label-triggered, runs Agent on issue/PR events | Self-improvement pipelines |
| **Conductor** | Chrome extension — connects to web server via Bridge | Browser automation tools |
| **Ambient Agent** (`packages/ambient-agent-rs/`) | Rust daemon — watches repos, ships PRs autonomously | Always-on GitHub monitoring |

---

## Slash Command System

Commands follow a 4-file registration pattern. This ceremony exists because the typed registry is shared across surfaces and prevents runtime drift between command definitions and handler implementations. Each file has a single responsibility:

### 1. Define handler type (`src/cli-tui/commands/types.ts`)

```typescript
export interface CommandHandlers {
  myCommand(context: CommandExecutionContext): void;
}
```

### 2. Register command (`src/cli-tui/commands/registry.ts`)

```typescript
buildEntry(
  { name: "mycommand", description: "...", usage: "/mycommand [args]", tags: ["ui"] },
  withArgs("mycommand"),  // or equals("mycommand") for no-args commands
  handlers.myCommand,
  createContext,
),
```

### 3. Add builder option (`src/cli-tui/utils/commands/command-registry-builder.ts`)

```typescript
// Add to CommandRegistryOptions interface + wire in buildCommandRegistry()
handleMyCommand: (context: CommandExecutionContext) => void;
```

### 4. Wire handler (`src/cli-tui/tui-renderer.ts`)

```typescript
handleMyCommand: (context) => this.doSomething(),
```

**Grouped commands** (e.g., `/ss`, `/diag`, `/cfg`, `/tools`) route subcommands through a single handler factory in `src/cli-tui/commands/grouped/`. **Selector commands** (e.g., `/model`, `/theme`) push a modal via `modalManager.push(component)`.

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
│  Pre-commit gate  │   Runs before git commits/pushes from Composer
└──────────────────┘
```

### Trust Boundaries

- **Workspace** = the project root directory (detected via `.git`, `package.json`, etc.). File writes inside workspace are allowed; writes outside require explicit approval. Additional trusted paths can be added via `containment.trustedPaths` in `~/.composer/firewall.json`.
- **Trusted sandbox** for `auto` mode = environments where a human is not present to approve (Docker containers, CI runners). The Slack bot's Docker sandbox uses `auto` because each request runs in an isolated container. IDE surfaces (VS Code, JetBrains) default to `prompt`.
- **MCP tools are third-party.** They go through the same firewall and approval pipeline as built-in tools. An MCP tool calling `bash` still triggers destructive-command detection. MCP servers do *not* inherit `process.env` by default (only `PATH`, `HOME`, `USER`, `SHELL`, `TERM`).
- **`COMPOSER_SAFE_MODE=1`** enables safe mode globally: all mutations require approval regardless of other settings.

---

## Key Design Docs

All located in `docs/design/`. Start with Agent State Machine for the core event flow.

| Document | Description |
|----------|-------------|
| [Agent State Machine](design/AGENT_STATE_MACHINE.md) | Event-driven LLM loop, prompt execution, state management |
| [Tool System](design/TOOL_SYSTEM.md) | Tool DSL, validation, caching, retry, sandbox |
| [Context Management](design/CONTEXT_MANAGEMENT.md) | Token budgeting, context sources, auto-compaction |
| [Session Persistence](design/SESSION_PERSISTENCE.md) | JSONL storage, buffered writes, branching, crash recovery |
| [TUI Rendering](design/TUI_RENDERING.md) | Differential rendering, event-driven UI, modal system |
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
| **Add a slash command** | `commands/types.ts` → `commands/registry.ts` → `command-registry-builder.ts` → `tui-renderer.ts` |
| **Add a built-in tool** | Create in `src/tools/`, register in tool list, add test in `test/tools/` |
| **Add an MCP server** | `~/.composer/mcp.json` or `.composer/mcp.json` — tools auto-register as `mcp__<server>__<tool>` |
| **Add a provider** | Transport adapter in `packages/ai/`, model entries in registry, compat flags if needed |
| **Add a context source** | Implement `AgentContextSource`, register in `AgentContextManager` |
| **Add a TUI modal/selector** | Component in `src/cli-tui/selectors/`, view wrapper, init in `TuiRenderer`, push via `modalManager` |
| **Add a lifecycle hook** | Define event in hook types, emit from agent/tool executor, document in hooks config |
| **Add a grouped subcommand** | Handler in `src/cli-tui/commands/grouped/`, subcommand constant, wire in parent factory |
| **Fix terminal rendering** | Check if fix belongs in `packages/tui` (library), `src/cli-tui` (app), or `packages/tui-rs` (Rust) |
| **Add a web API endpoint** | Route in `src/server/`, handler using shared Agent, update `packages/web/` if UI needed |
| **Run tests** | `npx nx run composer:test --skip-nx-cache` (full) or `bunx vitest --run -t "name"` (targeted) |
| **Lint** | `bun run bun:lint` (Biome + eval verifier) |

---

## First Contribution

Get a local build running and make a visible change in under 10 minutes:

```bash
# 1. Install and verify
bun install
npx nx run composer:test --skip-nx-cache   # ~4500 tests, should all pass

# 2. See what you're working with
npx nx graph --focus composer               # dependency visualization

# 3. Make a change — pick one:
#    a) Edit a TUI string: grep for "Composer" in src/cli-tui/ and change it
#    b) Add a toy tool: create src/tools/clock.ts that returns Date.now()
#    c) Add a slash command /ping: follow the 4-file pattern above

# 4. Verify
bun run bun:lint
bunx vitest --run -t "your test name"
```

---

*See also: [README.md](../README.md) · [CLAUDE.md](../CLAUDE.md) · [Contributing](../CONTRIBUTING.md) · [Architecture Diagrams](ARCHITECTURE_DIAGRAM.md)*
