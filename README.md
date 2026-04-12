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
- [Tools](#tools)
- [Hooks](#hooks)
- [Security](#security)
- [Telemetry](#telemetry)

## For Contributors

- [EvalOps Workflows](#evalops-workflows)
- [Development Services (Docker)](#development-services-docker)
- [Building from Source](#from-source-bun--nx)
- [Workspace Commands](#workspace-commands-bun--nx)
- [Maestros & Background Tasks](#maestros-sub-agents)
- [MCP Integration](#adding-your-own-tools)
- [Packages](#packages)
- [Contributing](#contributing)
- [Troubleshooting](#troubleshooting)

---

# For Users

## Concept

Maestro is a coding agent that reads and writes files, runs shell commands, searches code, and interacts with git and GitHub on your behalf. It supports multiple LLM providers (Anthropic, OpenAI, Google, Groq, and others) and runs across several interfaces — from an interactive terminal to a web UI to IDE extensions. Every action the agent takes is visible: you see the tool calls, approve risky operations, and review changes in git before committing.

Choose your interface:

| Interface | Description |
|-----------|-------------|
| [Terminal (TUI/CLI)](docs/FEATURES.md) | Interactive terminal with keyboard shortcuts, file search, and command palette |
| [Web UI](docs/WEB_UI.md) | Browser-based interface with core feature parity |
| [Conductor](docs/CONDUCTOR_BRIDGE.md) | Chrome extension for browser automation via the Maestro web server |
| [VS Code](packages/vscode-extension/README.md) | Extension with inline chat, diagnostics integration, and go-to-definition |
| [JetBrains](packages/jetbrains-plugin/README.md) | Plugin for IntelliJ, WebStorm, PyCharm, and other JetBrains IDEs |
| [Slack Bot](packages/slack-agent/README.md) | Deployable Slack bot with Docker sandbox isolation |
| [GitHub Agent](packages/github-agent/README.md) | Label-driven issue work and PR creation |
| [Ambient Agent](docs/design/AMBIENT_AGENT.md) | Long-running daemon for repository monitoring and PR generation |
| Headless | [Scriptable automation for CI/CD and evaluation pipelines](docs/protocols/headless.md) |

### Who It's For

Developers who want AI assistance they can see and control. The terminal is the primary interface; the web UI, IDE extensions, Slack bot, and GitHub agent cover workflows where a terminal isn't the best fit. All interfaces share the same runtime, tools, and security model.

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

# EvalOps Managed Gateway (OAuth)
# Run /login and select "EvalOps Managed"
# Required: export MAESTRO_EVALOPS_ORG_ID=org_...
# Optional: export MAESTRO_IDENTITY_URL=https://identity.internal.evalops
# Tokens are stored in ~/.maestro/oauth.json, refresh automatically, and logout attempts remote refresh-token revocation
# Optional managed runtime selection:
#   export MAESTRO_EVALOPS_PROVIDER=openai|openrouter|anthropic
#   export MAESTRO_EVALOPS_ENVIRONMENT=prod
#   export MAESTRO_EVALOPS_CREDENTIAL_NAME=team-default
#   export MAESTRO_EVALOPS_TEAM_ID=team_...

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

### Managed EvalOps Gateway

Maestro also supports a managed control-plane path through EvalOps. In this
mode, Maestro authenticates with `/login evalops` and sends provider refs to
`llm-gateway` instead of using raw vendor keys directly.

Current managed provider aliases:

- `evalops`
  - OpenAI Responses compatibility through the gateway
- `evalops-azure-openai`
  - Azure OpenAI chat-completions compatibility through the gateway
- `evalops-cerebras`
  - Cerebras chat-completions compatibility through the gateway
- `evalops-cohere`
  - Cohere chat-completions compatibility through the gateway
- `evalops-fireworks`
  - Fireworks chat-completions compatibility through the gateway
- `evalops-google`
  - Google Gemini chat-completions compatibility through the gateway
- `evalops-databricks`
  - Databricks chat-completions compatibility through the gateway
- `evalops-deepseek`
  - DeepSeek chat-completions compatibility through the gateway
- `evalops-groq`
  - Groq chat-completions compatibility through the gateway
- `evalops-perplexity`
  - Perplexity chat-completions compatibility through the gateway
- `evalops-together`
  - Together chat-completions compatibility through the gateway
- `evalops-mistral`
  - Mistral chat-completions compatibility through the gateway
- `evalops-xai`
  - xAI chat-completions compatibility through the gateway
- `evalops-anthropic`
  - Anthropic Messages compatibility through the gateway
- `evalops-openrouter`
  - OpenRouter chat-completions compatibility through the gateway

Typical setup:

```bash
export MAESTRO_EVALOPS_ORG_ID=org_123
export MAESTRO_LLM_GATEWAY_URL=http://127.0.0.1:8081/v1
maestro config init --preset evalops-anthropic
```

Then authenticate:

```bash
/login evalops
```

In managed mode:

- Maestro sends `Authorization: Bearer <EvalOps token>` to the gateway
- Maestro includes `X-Organization-ID`
- Maestro sends `provider_ref` metadata instead of a raw vendor key
- the gateway resolves the provider ref through the access plane

This is the intended path for org-managed Azure OpenAI, Google Gemini, Anthropic, OpenAI, and OpenRouter
credentials.

### Durable Memory Service

Maestro can also mirror automatic durable memories to the shared EvalOps
`memory` service and use that service for prompt-time durable recall while still
keeping local session-memory snapshots.

Typical setup:

```bash
export MAESTRO_MEMORY_BASE=http://127.0.0.1:8082
export MAESTRO_EVALOPS_ORG_ID=org_123
/login evalops
```

Optional overrides:

- `MAESTRO_MEMORY_ACCESS_TOKEN`
  - explicit bearer token for the memory service instead of reusing EvalOps OAuth
- `MAESTRO_MEMORY_TEAM_ID`
  - scopes durable memories to a team when the service expects team-level writes

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

| Command | Description |
|---------|-------------|
| `/model` | Switch models (interactive selector) |
| `/thinking` | Adjust reasoning level |
| `/help` | List all available commands |
| `/new` | Start a fresh session |
| `/clear` | Clear context and restart |
| `/export [file] [html|text|json|jsonl]` | Export session to HTML, text, JSON, or JSONL |
| `/import session <file.json\|file.jsonl>` | Import a portable JSON or JSONL session into the current workspace |
| `/quit` | Exit (or Ctrl+C twice) |
| `/session` | Session info, favorites, and summaries |
| `/sessions` | List/load saved sessions |
| `/cost` | Usage and cost breakdown |
| `/stats` | Quick health check |
| `/diff <path>` | Show git diff for a file |
| `/review` | Git status + diff summary |
| `/undo` | Discard working tree changes |
| `/run` | Execute project scripts |
| `/plan` | Manage todo plans |
| `/config` | Show configuration |
| `/diag` | Provider/API diagnostics |
| `/approvals` | Toggle approval modes (auto/prompt/fail) |
| `/login` | OAuth authentication |

See the [full commands reference](#full-commands-reference) in the contributor section for the complete list.

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

For OpenAI Responses API models, Maestro automatically filters tools with unsupported top-level JSON Schema keywords (`oneOf`, `anyOf`, `allOf`, `enum`, `not`). Wrap constrained values inside an object to work around this. See `docs/MODELS.md` for details on compat flags, reasoning summary/effort settings, and provider overrides.

### Framework Preference

Set a default stack for new tasks with `/framework <id>` (e.g., `fastapi`, `express`, `node`). Scope per user or workspace via `--workspace`; clear with `/framework none`. Discover options with `/framework list`.

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

Maestro supports lifecycle hooks for custom validation, logging, and automation. Hooks intercept tool calls, inject context, gate permissions, and integrate with external systems.

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

Hooks receive JSON via stdin and return JSON via stdout. Matchers support `"*"` (all), `"bash|write|edit"` (any listed), and regular expressions.

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

Stream evaluation telemetry with `MAESTRO_TELEMETRY=true` and `MAESTRO_TELEMETRY_ENDPOINT`. Use `npm run telemetry:report` to summarize success rates from the log. See [Telemetry](#telemetry) for details.

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

Build a single-file executable (no Node or repo needed):

```bash
bun run compile:binary        # emits dist/maestro-bun
chmod +x dist/maestro-bun    # if needed
./dist/maestro-bun --help    # run it
```

Notes:
- Output is a glibc ELF; run on compatible Linux systems.
- For tree-sitter bash parsing without the startup warning, keep these alongside the binary:
  - `node_modules/tree-sitter/prebuilds/linux-x64/tree-sitter.node`
  - `node_modules/tree-sitter-bash/prebuilds/linux-x64/tree-sitter-bash.node`

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
| `/export [file] [html|text|json|jsonl]` | Export to HTML, text, JSON, or JSONL |
| `/import session <file.json\|file.jsonl>` | Import a portable JSON or JSONL session |
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

Maestros are specialized agent profiles with custom system prompts, tool restrictions, and model overrides. Profile files live in `~/.maestro/composers/` (personal) or `.maestro/composers/` (project-specific).

```yaml
# .maestro/composers/code-reviewer.yaml
name: code-reviewer
description: Focused code review assistant
systemPrompt: |
  You are a senior code reviewer. Be concise.
  Flag issues by severity (critical/warning/suggestion).
tools: [read, search, diff, gh_pr]
model: claude-opus-4-6
triggers:
  keywords: [review, pr, code review]
  files: ["*.ts", "*.tsx", "*.py", "*.go"]
```

```bash
/maestro list              # Show available maestros
/maestro activate <name>   # Switch to a maestro
/maestro deactivate        # Return to default agent
```

## Background Tasks

The `background_tasks` tool manages long-running processes (dev servers, file watchers, tunnels) with lifecycle management, auto-restart, and log persistence.

| Action | Description |
|--------|-------------|
| `start` | Launch a background command (supports `cwd`, `env`, `shell`, and `restart` policy) |
| `stop` | Terminate a running task by ID |
| `list` | View all active tasks with status and resource usage |
| `logs` | Tail task output (default 40 lines, max 200) |

Logs persist to `~/.maestro/logs/background-<taskId>.log` (truncated at 5MB). Tasks auto-cleanup on exit.

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
- `/export session-archive.jsonl jsonl` to preserve the full append-only session log
- `/export session-archive.json json` for a portable wrapped archive

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
| [`@evalops/maestro-core`](packages/core/README.md) | Agent loop, transport, types, and sandbox primitives — the engine behind all interfaces |
| [`@evalops/ai`](packages/ai/README.md) | Shared AI SDK: model registry, provider transport, agent event streams |
| [`@evalops/contracts`](packages/contracts/README.md) | Shared TypeScript definitions for frontend/backend integration |
| [`@evalops/tui`](packages/tui/README.md) | Terminal UI library (TypeScript) with differential rendering |
| [`tui-rs`](packages/tui-rs/README.md) | Native Rust TUI — standalone binary with native AI provider integrations |
| [`@evalops/maestro-web`](packages/web/README.md) | Browser-based web interface |
| [`@evalops/maestro-desktop`](packages/desktop/README.md) | Electron desktop app |
| [`maestro-vscode`](packages/vscode-extension/README.md) | VS Code extension with inline chat and IDE integration |
| [`maestro-jetbrains`](packages/jetbrains-plugin/README.md) | Plugin for IntelliJ, WebStorm, PyCharm, and other JetBrains IDEs |
| [`@evalops/slack-agent`](packages/slack-agent/README.md) | Slack bot with Docker sandbox isolation |
| [`@evalops/slack-agent-ui`](packages/slack-agent-ui) | Dashboard UI for the Slack agent (connector management, OAuth flows) |
| [`@evalops/github-agent`](packages/github-agent/README.md) | GitHub automation agent for issue-driven workflows |
| [`ambient-agent-rs`](packages/ambient-agent-rs/README.md) | Long-running GitHub agent daemon (Ambient Maestro, Rust) |
| [`@evalops/governance`](packages/governance) | Safety pipeline, firewall, and policy enforcement for MCP-compatible agents |
| [`@evalops/governance-mcp-server`](packages/governance-mcp-server) | MCP server exposing governance tools (firewall, policy, credential scanning) |

## License

MIT
