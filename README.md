# Maestro by EvalOps

[![CI](https://github.com/evalops/maestro/actions/workflows/ci.yml/badge.svg)](https://github.com/evalops/maestro/actions/workflows/ci.yml)

Maestro is a coding agent with multi-model support, featuring terminal (TUI/CLI), web, IDE (VS Code, JetBrains), browser (Conductor), Slack, and GitHub interfaces for AI-assisted development.

---

## For Users

- [Concept](#concept)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [API Keys & Providers](#api-keys)
- [Slash Commands](#slash-commands)
- [Tools Overview](#tools)
- [Hooks](#hooks)
- [Security](#security)
- [Telemetry](#telemetry)

## For Contributors

- [EvalOps Workflows](#evalops-workflows)
- [Building from Source](#from-source-bun--nx)
- [Workspace Commands](#workspace-commands-bun--nx)
- [Full Commands Reference](#full-commands-reference)
- [Maestros & Background Tasks](#maestros-sub-agents)
- [MCP Integration](#adding-your-own-tools)
- [Packages](#packages)
- [Contributing](#contributing)
- [Troubleshooting](#troubleshooting)

---

# For Users

## Concept

Maestro exposes its capabilities through slash commands and git-aware helpers so you can inspect what changed and review it in git. The agent emphasizes explicit tools and visible state over opaque automation.

Choose your interface:
- **Terminal (TUI/CLI)**: Rich interactive terminal interface with keyboard shortcuts, file search, and command palette
- **Web UI**: Modern browser-based interface for those who prefer a graphical environment (core parity; see parity appendix in `docs/WEB_UI.md`)
- **Conductor (Chrome Extension)**: Browser-automation surface that connects to the Maestro web server via the Conductor Bridge (`docs/CONDUCTOR_BRIDGE.md`)
- **VS Code**: Native extension with inline chat, diagnostics integration, and go-to-definition ([VS Code Extension](packages/vscode-extension/README.md))
- **JetBrains IDEs**: Plugin for IntelliJ, WebStorm, PyCharm, and other JetBrains IDEs ([JetBrains Plugin](packages/jetbrains-plugin/README.md))
- **Slack Bot**: Deploy as a Slack bot with Docker sandbox isolation ([`@evalops/slack-agent`](packages/slack-agent/README.md))
- **GitHub Agent**: Autonomous agent that watches repos, implements issues, and creates PRs ([`@evalops/github-agent`](packages/github-agent/README.md))
- **Ambient Agent**: Always-on GitHub daemon that watches repos and ships PRs ([Ambient Maestro design](docs/design/AMBIENT_AGENT.md))
- **Headless**: Scriptable automation for CI/CD and evaluation pipelines

### Why Multiple Interfaces?

The terminal is home for many developers—fast, scriptable, distraction-free. But not every workflow fits a terminal session. Sometimes you're on a call, away from your dev machine, or collaborating with teammates who aren't terminal-native.

**Web UI** lets you access Maestro from any browser. Share a session link with a colleague. Demo a feature without screen-sharing your terminal. Work from a tablet when you're not at your desk.

**IDE extensions** (VS Code, JetBrains) integrate Maestro directly into your editor. Get IDE-aware context—diagnostics, go-to-definition, find references—fed automatically to the agent. No copy-paste, no context switching.

**Slack** meets teams where they already communicate. Deploy a shared coding agent that your whole team can @mention. Queue up tasks asynchronously—ask the bot to run tests while you're in a meeting, check results when you're back. Scheduled tasks, approval workflows, and persistent memory mean the agent can operate as a background teammate rather than a tool you have to babysit.

**GitHub Agent** runs autonomously. Label an issue with `maestro-task` and walk away—it'll implement the feature, run tests, and open a PR. Useful for self-improvement pipelines, batch refactoring, or delegating routine tasks.

**Conductor** brings browser automation to Maestro. The Chrome extension connects to Maestro's web server, giving the agent eyes and hands in the browser—read pages, click elements, fill forms, capture screenshots. Useful for web scraping, testing workflows, or any task that requires interacting with web applications.

Same agent, same tools, same core interaction model—just different surfaces optimized for different contexts.

### Who It's For

Developers who want explicit, scriptable AI assistance with good visibility into what the agent is doing. You value direct commands over hidden heuristics, git-friendly edits over opaque patches, and the ability to inspect actions after the fact.

## Installation

### Bun (recommended)

```bash
bun install -g @evalops/maestro
```

### npm

```bash
npm install -g @evalops/maestro
```

### Nix (with flakes)
```bash
nix run github:evalops/maestro
```

## Quick Start

```bash
# Set your API key
export ANTHROPIC_API_KEY=sk-ant-...

# Start the interactive terminal UI
maestro

# Or start the web UI
maestro web
# Then open http://localhost:8080
```

Once running, chat with the AI: `Create a simple Express server in src/server.ts`. Maestro will read/write files and run shell commands via explicit slash commands.

## API Keys

Maestro supports multiple LLM providers. Set the environment variable for your provider:

```bash
# Anthropic (Claude) - default
export ANTHROPIC_API_KEY=sk-ant-...

# OpenAI (GPT)
export OPENAI_API_KEY=sk-...

# GitHub Copilot (OAuth)
# Run /login github-copilot (device flow) — no API key required
# Tokens are stored in ~/.maestro/oauth.json
# Optional bootstrap: export COPILOT_GITHUB_TOKEN=... or GH_TOKEN=...

# Azure OpenAI (OpenAI-compatible)
export AZURE_OPENAI_API_KEY=...

# Google (Gemini)
export GEMINI_API_KEY=...

# Google Gemini CLI (Cloud Code Assist) - OAuth
# Run /login and select "Google Gemini CLI" (no API key required)
# Optional: export GOOGLE_GEMINI_CLI_TOKEN='{"token":"...","projectId":"..."}'

# Google Antigravity (Sandbox) - OAuth
# Run /login and select "Google Antigravity" (no API key required)
# Optional: export GOOGLE_ANTIGRAVITY_TOKEN='{"token":"...","projectId":"..."}'

# Groq
export GROQ_API_KEY=gsk_...

# Cerebras
export CEREBRAS_API_KEY=...

# xAI (Grok)
export XAI_API_KEY=xai-...

# OpenRouter
export OPENROUTER_API_KEY=sk-or-...

# Exa (for web search - optional)
export EXA_API_KEY=...
```

**Alternative:** Store keys in `~/.maestro/keys.json`:

```json
{
  "anthropic": { "apiKey": "sk-ant-..." },
  "openai": { "apiKey": "sk-..." },
  "azure-openai": { "apiKey": "..." }
}
```

Use `maestro config init` for interactive provider setup, or `--provider` and `--model` flags to switch providers.

**OpenAI-compatible vendors (Azure/OpenRouter/Groq/Cerebras):** define a provider override with `api: "openai-completions"` (or `"openai-responses"` if supported) and a vendor base URL in `~/.maestro/config.json` or `MAESTRO_MODELS_FILE`. See `docs/MODELS.md` for the full schema and `compat` flags.

**GitHub Copilot:** after `/login github-copilot`, select models via `/model` (provider `github-copilot`) or run `maestro --provider github-copilot --model <id>`.

Example `~/.maestro/config.json` to add a short alias:

```json
{
  "aliases": {
    "copilot-fast": "github-copilot/gpt-5-mini"
  }
}
```

## Slash Commands

Every operation is exposed as an explicit slash command. Type `/help` for the full list.

### Essential Commands

| Command | Description |
|---------|-------------|
| `/model` | Switch models mid-session (interactive selector) |
| `/help` | List all available commands |
| `/new` | Start a fresh session |
| `/clear` | Clear context and restart |
| `/export` | Export session to HTML |
| `/quit` | Exit (or Ctrl+C twice) |

### Session Management

| Command | Description |
|---------|-------------|
| `/session` | Show session info, mark favorites, add summaries |
| `/sessions` | List/load saved sessions |
| `/cost` | View usage and cost breakdown |
| `/stats` | Quick health pulse (status + cost) |

### Development

| Command | Description |
|---------|-------------|
| `/diff <path>` | Show git diff for a file |
| `/review` | Git status + diff summary |
| `/undo` | Discard working tree changes |
| `/run` | Execute project scripts |
| `/plan` | Manage todo plans |

### Configuration

| Command | Description |
|---------|-------------|
| `/config` | Show configuration (sources, providers, env) |
| `/diag` | Provider/API diagnostics |
| `/approvals` | Toggle approval modes (auto/prompt/fail) |
| `/thinking` | Adjust reasoning level for supported models |

## Tools

### Built-in Tools

**File Operations:**
- **read** – Read files (text + images), with offset/limit for large files
- **write** – Create/overwrite files
- **edit** – Replace exact text in files
- **list** – List directories with glob filtering
- **search** – Ripgrep-powered search with regex

**Git & Shell:**
- **diff** – Inspect git diffs
- **bash** – Execute shell commands

*Parallelism is native*: you can emit multiple tool calls in one turn and the runtime will execute independent calls concurrently—no separate batch tool required.

**Web & Search** (requires `EXA_API_KEY`):
- **websearch** – Search the web via Exa AI
- **codesearch** – Search GitHub/docs/Stack Overflow
- **webfetch** – Fetch content from URLs

**GitHub** (requires `gh` CLI):
- **gh_pr** – Pull request operations
- **gh_issue** – Issue operations
- **gh_repo** – Repository operations

### API Compatibility Notes

#### OpenAI Responses API (tool schema filtering)

When using an OpenAI **Responses API** model (e.g. `api: "openai-responses"`), tool parameter schemas have stricter requirements than typical Chat Completions-style function calling.

In practice, tool `parameters` often need to be a top-level JSON Schema `object` (the root must not be `anyOf`), and some composition keywords (like `allOf` / `not`) are not supported by Structured Outputs.

Maestro will automatically **filter out tools** whose `parameters` schema uses these JSON Schema keywords at the **top level**:
- `oneOf`, `anyOf`, `allOf`
- `enum`
- `not`

Maestro logs a warning listing filtered tools (see `filterResponsesApiTools()`), but users may still be surprised if an external/MCP tool disappears.

Workaround: wrap the constrained value inside an object:

```json
// ❌ filtered (top-level enum)
{ "enum": ["a", "b", "c"] }

// ✅ compatible (enum nested under properties)
{
  "type": "object",
  "properties": { "value": { "enum": ["a", "b", "c"] } }
}
```

References:
- OpenAI docs: Structured Outputs supported schemas (`https://platform.openai.com/docs/guides/structured-outputs/supported-schemas`)
- OpenAI docs: unsupported keywords (`https://platform.openai.com/docs/guides/structured-outputs/some-type-specific-keywords-are-not-yet-supported`)

#### Reasoning summary & effort (Responses API only)

Maestro enforces these guardrails for OpenAI-compatible providers:

- `reasoningSummary` is only allowed for **Responses API** models (`api: "openai-responses"`) that are marked `reasoning: true`.
- `reasoningEffort` is only sent when `compat.supportsReasoningEffort` is true.
- If you enable these on unsupported models, Maestro fails fast with a clear error.

For OpenAI-compatible vendors, set compat flags explicitly when needed:

```json
{
  "providers": [
    {
      "id": "azure-openai",
      "api": "openai-completions",
      "baseUrl": "https://my-resource.openai.azure.com/openai/deployments/gpt-4/chat/completions?api-version=2024-02-15-preview",
      "models": [
        {
          "id": "gpt-4o",
          "name": "GPT-4o (Azure)",
          "compat": { "supportsReasoningEffort": false }
        }
      ]
    }
  ]
}
```

### Framework Preference

- Set a default stack for new tasks with `/framework <id>` (e.g., `fastapi`, `express`, `node`).
- Scope defaults per user (default) or workspace via `/framework <id> --workspace`; clear with `/framework none`.
- Discover options with `/framework list`.
- Precedence: policy (locked) > policy > env override (`MAESTRO_FRAMEWORK_OVERRIDE`) > env default (`MAESTRO_DEFAULT_FRAMEWORK`) > workspace `.maestro/workspace.json` > user `~/.maestro/default-framework.json` > none.
- Example policy (`~/.maestro/policy.json`):

```json
{
  "framework": { "default": "fastapi", "locked": true }
}
```

### Editor Features

- **Tab completion** for paths
- **Drag & drop** files to insert paths
- **Multi-line paste** with collapsible markers
- **Command palette** via `Ctrl+K`
- **File search** via `@` or `Ctrl+K`

## Security

Maestro ships with a layered security model that balances power with protection:

### Action Firewall (enabled by default)

- **Dangerous command detection** – Blocks or requires approval for `rm -rf`, `mkfs`, `dd if=/dev/zero`, `chmod 000`, and other high-risk patterns
- **Tree-sitter analysis** – Parses bash commands for deeper safety checks beyond regex (detects `sudo`, `git push --force`, command substitution, etc.)
- **System path protection** – Hard blocks modifications to `/etc`, `/usr`, `/var`, `/boot`, `/sys`, `/proc`, `/dev`
- **Workspace containment** – Requires approval for file writes outside the current project or temp directories
- **Trusted paths** – Configure additional allowed paths in `~/.maestro/firewall.json`

### Approval Modes

Control how Maestro handles risky actions via `--approval-mode` or `MAESTRO_APPROVAL_MODE`:

| Mode | Behavior |
|------|----------|
| `prompt` (default) | Ask the user in TUI; fail in headless mode |
| `auto` | Auto-approve all actions (use only in trusted sandboxes) |
| `fail` | Reject all high-risk commands automatically |

### Sandbox Execution

```bash
maestro exec --sandbox default        # Workspace containment + firewall active
maestro exec --sandbox danger-full-access  # Remove guardrails (trusted environments only)
```

Optional Docker sandbox available for stronger isolation (see [docs/SAFETY.md](docs/SAFETY.md) for current status).

### Safe Mode

Enable extra restrictions with `--safe-mode` or `MAESTRO_SAFE_MODE=1`:
- Additional constraints on shell writes
- Shield icon in footer indicates active protection
- Recommended for untrusted environments

See [Safety & Approvals](docs/SAFETY.md) for detailed configuration.

### Maestro Guardian (secrets + CI hygiene)

- **What it does:** Runs Semgrep (`p/secrets` + `p/ci`) plus a git-secrets/trufflehog fallback against staged files before commits/pushes initiated through Maestro.
- **Default:** On. Disable only in trusted environments with `MAESTRO_GUARDIAN=0` or `/guardian disable`.
- **Manual runs:** `/guardian` in the TUI or `bash scripts/guardian.sh --staged`.
- **Pre-commit hook:** `npm run guardian:install-hook` installs `.git/hooks/pre-commit` that points to the same script.

## Hooks

Maestro supports lifecycle hooks for custom validation, logging, and automation. Hooks let you intercept tool calls, inject context, gate permissions, and integrate with external systems.

### Quick Start

```bash
# Via environment variable
export MAESTRO_HOOKS_PRE_TOOL_USE="./scripts/validate-command.sh"
```

Or via `.maestro/hooks.json` (project) or `~/.maestro/hooks.json` (user):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "bash",
        "hooks": [{ "type": "command", "command": "./scripts/validate.sh" }]
      }
    ]
  }
}
```

### Hook Events

| Event | When it fires |
|-------|---------------|
| `PreToolUse` | Before a tool executes (can block or modify input) |
| `PostToolUse` | After successful tool execution |
| `PostToolUseFailure` | After tool execution fails |
| `EvalGate` | After tool execution for scoring/assertions |
| `SessionStart` / `SessionEnd` | Session lifecycle |
| `SubagentStart` / `SubagentStop` | Subagent lifecycle |
| `UserPromptSubmit` | When user submits a prompt |
| `PreCompact` | Before context compaction |
| `PermissionRequest` | When approval is required |
| `Notification` | On various notifications |

### Hook Input/Output

Hooks receive JSON via stdin:

```json
{
  "hook_event_name": "PreToolUse",
  "tool_name": "bash",
  "tool_input": { "command": "rm -rf /tmp/test" },
  "session_id": "abc123",
  "cwd": "/path/to/project",
  "timestamp": "2025-01-15T10:30:00Z"
}
```

And return JSON via stdout:

```json
{
  "continue": true,
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow"
  }
}
```

### Pattern Matching

Matchers support:
- `"*"` – matches all
- `"bash|write|edit"` – matches any listed
- Regular expressions for complex patterns

### Use Cases

- **CI gates**: Block commits without tests passing
- **Audit logging**: Record all tool executions
- **Custom validators**: Enforce project-specific rules
- **Context injection**: Add relevant docs before tool runs
- **Eval pipelines**: Score agent behavior with assertions

## Telemetry

Telemetry is **off by default**. Enable for analytics:

```bash
# Write to local log
export MAESTRO_TELEMETRY=true

# Or stream to endpoint
export MAESTRO_TELEMETRY_ENDPOINT=https://your-endpoint.com/hook
```

Payloads include tool name, success flag, and duration. Transport failures never block workflows.

## Context Files

Maestro loads `AGENT.md` / `AGENTS.md` / `CLAUDE.md` files automatically (with `AGENTS.override.md` taking precedence when present):

1. **Global** (`~/.maestro/agent/AGENT.md`) – personal defaults
2. **Parent directories** – inherited settings
3. **Project root** – most specific wins

Use them for coding conventions, architecture notes, and project-specific instructions.

To append extra instructions without replacing the base system prompt, add:
- **Project:** `.maestro/APPEND_SYSTEM.md`
- **Global:** `~/.maestro/agent/APPEND_SYSTEM.md`
- Or pass `--append-system-prompt <text|file>` on the CLI

---

# For Contributors

## EvalOps Workflows

Maestro is built for automated evaluation pipelines, making it easy to benchmark agent behavior and wire into CI/CD.

### Running Evaluations

```bash
# Build CLI/TUI/Web and run all scenarios
npx nx run maestro:evals --skip-nx-cache
```

**CI note:** Evals are opt-in on pull requests to keep CI fast. Add the `run-evals` label to a PR to trigger the evals workflow.

This executes scenarios defined in `evals/scenarios.json` and reports pass/fail based on stdout assertions.

### Scenario Format

Each scenario specifies a command and expected output patterns:

```json
{
  "scenarios": [
    {
      "name": "help-command",
      "command": "maestro --help",
      "expect": {
        "stdout": ["Usage:", "--provider", "--model"],
        "exitCode": 0
      }
    },
    {
      "name": "version-check",
      "command": "maestro --version",
      "expect": {
        "stdout": ["\\d+\\.\\d+\\.\\d+"],
        "exitCode": 0
      }
    }
  ]
}
```

- **stdout** – Array of regular expressions that must all match
- **exitCode** – Expected process exit code
- **timeout** – Optional timeout in milliseconds

### Telemetry Integration

Stream evaluation results to your analytics pipeline:

```bash
# Write to local log file
export MAESTRO_TELEMETRY=true
export MAESTRO_TELEMETRY_FILE=~/.maestro/telemetry.log

# Or stream to endpoint
export MAESTRO_TELEMETRY_ENDPOINT=https://your-evalops-dashboard.com/ingest

# Control sampling rate (0.0 to 1.0)
export MAESTRO_TELEMETRY_SAMPLE=0.25
```

Payloads include tool name, success flag, duration, and evaluation context. Use `npm run telemetry:report` to summarize success rates and durations from the log.

### Design Principles

- **Slash-command first** – Core actions are explicit and scriptable
- **Git-aware tooling** – Filesystem changes go through git-friendly helpers
- **EvalOps-ready** – Built-in scenario runners and cost tracking
- **Multi-provider support** – Works across Anthropic, OpenAI, Gemini, Groq, and related providers

## Development Services (Docker)

Maestro uses Redis for rate limiting and PostgreSQL for persistence. Start local services with Docker Compose:

```bash
# Start Redis and PostgreSQL
docker compose up -d

# Set environment variables
export MAESTRO_REDIS_URL=redis://localhost:6379
export MAESTRO_DATABASE_URL=postgresql://localhost:5432/maestro?user=maestro&password=maestro

# Verify services are running
docker compose ps
```

### Available Services

| Service | Port | Purpose |
|---------|------|---------|
| Redis | 6379 | Rate limiting, caching |
| PostgreSQL | 5432 | Sessions, webhooks, tokens |

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `MAESTRO_REDIS_URL` | Redis connection URL | (in-memory fallback) |
| `MAESTRO_DATABASE_URL` | PostgreSQL connection URL | (file-based SQLite fallback) |

Without these variables, Maestro falls back to in-memory rate limiting and file-based storage, which works fine for local development.

## From Source (Bun + Nx)

```bash
git clone https://github.com/evalops/maestro.git
cd maestro
bun install
npx nx run maestro:build:all --skip-nx-cache   # Builds CLI, TUI, Web
npm link                                        # Optional: link locally
```

### Binary Compilation
```bash
bun run compile:binary
# Output: dist/maestro-bun
```

### Using the native Bun binary

Build and distribute a single-file executable (no Node or repo needed):

```bash
npm run bun:compile           # emits dist/maestro-bun
chmod +x dist/maestro-bun   # if needed
./dist/maestro-bun --help   # run it
```

Notes:
- Output is a glibc ELF; run on compatible Linux systems.
- If you want tree-sitter bash parsing without the startup warning, keep these alongside the binary (or preserve their relative paths):
  - `node_modules/tree-sitter/prebuilds/linux-x64/tree-sitter.node`
  - `node_modules/tree-sitter-bash/prebuilds/linux-x64/tree-sitter-bash.node`
- Bun’s bytecode mode (`--compile --bytecode`) currently fails on async-heavy bundles; the native binary above is the supported deliverable.

## Workspace Commands (Bun + Nx)

| Command | Purpose |
|---------|---------|
| `bun install` | Install dependencies |
| `bun run bun:lint` | Lint + eval verifier |
| `npx nx run maestro:test --skip-nx-cache` | Full test suite (builds TUI/Web) |
| `bun run bun:test:fast` | Fast local test run (parallel, opt-in via VITEST_FAST) |
| `npx nx run maestro:evals --skip-nx-cache` | Run eval scenarios |
| `bun run --filter @evalops/tui build` | Build TUI package |
| `bun run --filter @evalops/maestro-web build` | Build Web package |
| `bunx vitest --run -t "<test>"` | Run specific tests |

### Nix Hash Auto-Update (CI)

The `Update Nix Hash` workflow runs on pushes to `main` that touch `bun.lockb`, `package.json`, or `package-lock.json`. It commits the new `npmDepsHash` to the `ci/update-nix-hash` branch.

## Full Commands Reference

### All Slash Commands

| Command | Description |
|---------|-------------|
| `/model` | Switch models (interactive) |
| `/thinking` | Adjust reasoning level |
| `/export [file]` | Export to HTML |
| `/help` | List commands |
| `/session` | Session info/favorites/summary |
| `/sessions` | List/load sessions |
| `/history` | Prompt history (recent/search/clear) |
| `/toolhistory` | Tool execution history and stats |
| `/skills` | List or manage skills |
| `/tools` | Show tools + failures |
| `/config` | Configuration details |
| `/limits` | Show configurable runtime limits |
| `/cost` | Usage/cost breakdown |
| `/stats` | Quick health check |
| `/lsp` | Manage Language Server Protocol servers (status/start/stop/restart/detect) |
| `/plan` | Manage todo plans |
| `/git` | Git operations: status, diff, review |
| `/diff <path>` | Git diff |
| `/run` | Run project scripts |
| `/diag` | Provider diagnostics |
| `/report` | Bug/feedback reports |
| `/status` | Health summary |
| `/review` | Git status + diff |
| `/undo` | Discard changes |
| `/new` | Fresh session |
| `/share` | Generate share link |
| `/branch` | Branch from earlier message |
| `/queue` | Manage prompt queue |
| `/about` | Build/env info |
| `/clear` | Clear context |
| `/init` | Create AGENTS.md |
| `/background` | Background task config |
| `/approvals` | Approval mode |
| `/ollama` | Local Ollama control |
| `/update` | Check for updates |
| `/changelog` | Version history |
| `/telemetry` | Telemetry control |
| `/mcp` | MCP server status |
| `/compact` | Summarize old messages |
| `/footer` | Footer style |
| `/compact-tools` | Fold tool outputs |
| `/login` | OAuth authentication |
| `/logout` | Remove credentials |
| `/quit` | Exit |
| `/mention` | List workspace files |

### CLI Options

```bash
maestro [options] [messages...]
```

| Flag | Description |
|------|-------------|
| `--provider <name>` | Provider (anthropic, openai, google, etc.). Default: `anthropic` |
| `--model <id>` | Model ID. Default: `claude-opus-4-6` |
| `--api-key <key>` | Override API key |
| `--system-prompt <text\|file>` | Custom system prompt |
| `--append-system-prompt <text\|file>` | Append instructions to the system prompt |
| `--mode <text\|json\|rpc>` | Output format |
| `--no-session` | Ephemeral run |
| `--session <path>` | Use specific session |
| `-c, --continue` | Resume latest session |
| `-r, --resume` | Interactive session picker |

## Maestros (Sub-Agents)

Maestros are specialized agent profiles with custom system prompts, tool restrictions, and model overrides. They are managed with `/maestro`, and the profile files live in `~/.maestro/composers/` (personal) or `.maestro/composers/` (project-specific).

### Configuration

```yaml
# .maestro/composers/code-reviewer.yaml
name: code-reviewer
description: Focused code review assistant
systemPrompt: |
  You are a senior code reviewer. Focus on:
  - Correctness and edge cases
  - Security vulnerabilities
  - Performance implications
  - Code maintainability
  
  Be concise. Flag issues by severity (critical/warning/suggestion).
  
tools: [read, search, diff, gh_pr]  # Restricted tool set
model: claude-opus-4-6     # Can override default model
triggers:
  keywords: [review, pr, code review]
  files: ["*.ts", "*.tsx", "*.py", "*.go"]
```

### Available Fields

| Field | Description |
|-------|-------------|
| `name` | Unique identifier |
| `description` | Shown in `/maestro list` |
| `systemPrompt` | Custom instructions prepended to context |
| `tools` | Array of allowed tools (omit for all tools) |
| `model` | Override the default model |
| `triggers.keywords` | Auto-activate on these words |
| `triggers.files` | Auto-activate for these file patterns |

### Commands

```bash
/maestro list              # Show available maestros
/maestro activate <name>   # Switch to a maestro
/maestro deactivate        # Return to default agent
```

For heavier delegation patterns (parallel tasks, long-running jobs), spawn a separate `maestro` process or write a helper tool the agent can call via `bash`.

## Background Tasks

The `background_tasks` tool manages long-running processes with lifecycle management, auto-restart, and log persistence.

### Actions

| Action | Description |
|--------|-------------|
| `start` | Launch a background command |
| `stop` | Terminate a running task by ID |
| `list` | View all active tasks with status and resource usage |
| `logs` | Tail task output (default 40 lines, max 200) |

### Example: Dev Server Workflow

```bash
# Start a dev server in the background
maestro "Start the Next.js dev server"
# Agent executes: background_tasks action=start command="npm run dev" cwd="./packages/web"

# Make code changes...

# Check for errors
maestro "Show me the dev server logs"
# Agent executes: background_tasks action=logs taskId="abc123" lines=50

# Stop when done
maestro "Stop all background tasks"
# Agent executes: background_tasks action=stop taskId="abc123"
```

### Start Parameters

```json
{
  "action": "start",
  "command": "npm run dev",
  "cwd": "./packages/web",
  "env": { "PORT": "3001" },
  "shell": true,
  "restart": {
    "maxAttempts": 3,
    "delayMs": 1000,
    "strategy": "exponential",
    "maxDelayMs": 30000,
    "jitterRatio": 0.1
  }
}
```

| Parameter | Description |
|-----------|-------------|
| `command` | Command to run |
| `cwd` | Working directory |
| `env` | Additional environment variables |
| `shell` | Set `true` for pipes/redirects (e.g., `cmd1 \| cmd2`) |
| `restart.maxAttempts` | Max restart attempts on failure (1-5) |
| `restart.delayMs` | Delay between restarts (50-60000ms) |
| `restart.strategy` | `"fixed"` or `"exponential"` backoff |

### Log Storage

- Logs persist to `~/.maestro/logs/background-<taskId>.log`
- Files truncated at 5MB to prevent disk issues
- Tasks auto-cleanup on Maestro exit

## Adding Your Own Tools

Configure MCP servers in `~/.maestro/mcp.json`:

```json
{
  "servers": [
    {
      "name": "my-tools",
      "transport": "stdio",
      "command": "node",
      "args": ["path/to/mcp-server.js"]
    }
  ]
}
```

Tools appear as `mcp__<server>__<tool>`. Use `/mcp` to view status.

## Contributing

```bash
bun install
bunx biome check .                           # lint/format
npx nx run maestro:test --skip-nx-cache     # tests (mirrors CI)
npx nx run maestro:evals --skip-nx-cache    # eval scenarios
```

New commands/features should include tests in `test/`.

## Troubleshooting

### API Key Issues

1. Verify: `echo $ANTHROPIC_API_KEY`
2. Check for typos/whitespace in shell config
3. Restart terminal after setting vars
4. Run `maestro --diag`

### Session Files

Sessions are JSONL in `~/.maestro/agent/sessions/`. Use:
- `maestro --no-session` for fresh starts
- `/export` to save as HTML before archiving

---

## Documentation

- [Architecture Guide](docs/ARCHITECTURE.md)
- [Documentation Index](docs/README.md)
- [Quickstart](docs/QUICKSTART.md)
- [Feature Guide](docs/FEATURES.md)
- [Tools Reference](docs/TOOLS_REFERENCE.md)
- [Safety & Approvals](docs/SAFETY.md)
- [Sessions](docs/SESSIONS.md)
- [Providers & Factory](docs/MODELS.md)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)

### Packages

| Package | Description |
|---------|-------------|
| [`@evalops/ai`](packages/ai/README.md) | Shared AI SDK: model registry, provider transport, agent event streams |
| [`@evalops/tui`](packages/tui/README.md) | Terminal UI library (TypeScript) with differential rendering |
| [`tui-rs`](packages/tui-rs/README.md) | Native Rust TUI - standalone binary with native AI provider integrations |
| [`@evalops/maestro-web`](packages/web/README.md) | Web interface for Maestro |
| [`@evalops/contracts`](packages/contracts/README.md) | Shared TypeScript definitions |
| [`@evalops/slack-agent`](packages/slack-agent/README.md) | Slack bot with Docker sandbox isolation |
| [`@evalops/github-agent`](packages/github-agent/README.md) | Autonomous GitHub agent for self-improvement pipelines |
| [`ambient-agent-rs`](packages/ambient-agent-rs/README.md) | Always-on GitHub agent daemon (Ambient Maestro) |
| [Maestro for VS Code](packages/vscode-extension/README.md) | VS Code extension with inline chat and IDE integration |
| [Maestro for JetBrains](packages/jetbrains-plugin/README.md) | Plugin for IntelliJ, WebStorm, PyCharm, and other JetBrains IDEs |

Doc map (start here): [docs/README.md](docs/README.md) → Quickstart → Feature Guide → Tools Reference → Safety. Web/TUI differences: parity appendix in [docs/WEB_UI.md](docs/WEB_UI.md).

## License

MIT
