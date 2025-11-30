# Composer by EvalOps

Composer is a deterministic coding agent with multi-model support, featuring both a powerful terminal interface (TUI/CLI) and a modern web UI for AI-assisted development.

---

## For Users

- [Concept](#concept)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [API Keys & Providers](#api-keys)
- [Slash Commands](#slash-commands)
- [Tools Overview](#tools)
- [Security](#security)
- [Telemetry](#telemetry)

## For Contributors

- [EvalOps Workflows](#evalops-workflows)
- [Building from Source](#from-source-bun--nx)
- [Workspace Commands](#workspace-commands-bun--nx)
- [Full Commands Reference](#full-commands-reference)
- [Composers & Background Tasks](#composers-sub-agents)
- [MCP Integration](#adding-your-own-tools)
- [Contributing](#contributing)
- [Troubleshooting](#troubleshooting)

---

# For Users

## Concept

Composer exposes every capability through slash commands and git-aware helpers so you always know what changed and why. The agent is intentionally minimal: no hidden context juggling, no silent retries, just explicit tools you can chain together or script.

Choose your interface:
- **Terminal (TUI/CLI)**: Rich interactive terminal interface with keyboard shortcuts, file search, and command palette
- **Web UI**: Modern browser-based interface for those who prefer a graphical environment
- **Headless**: Scriptable automation for CI/CD and evaluation pipelines

### Who It's For

Developers who want deterministic, scriptable AI assistance with full transparency. You value explicit commands over hidden heuristics, git-friendly edits over opaque patches, and the ability to reason about every action Composer takes.

## Installation

### Bun (recommended)

```bash
bun install -g @evalops/composer
```

### npm

```bash
npm install -g @evalops/composer
```

### Nix (with flakes)
```bash
nix run github:evalops/composer
```

## Quick Start

```bash
# Set your API key
export ANTHROPIC_API_KEY=sk-ant-...

# Start the interactive terminal UI
composer

# Or start the web UI
composer web
# Then open http://localhost:3000
```

Once running, chat with the AI: `Create a simple Express server in src/server.ts`. Composer will read/write files and run shell commands via explicit slash commands.

## API Keys

Composer supports multiple LLM providers. Set the environment variable for your provider:

```bash
# Anthropic (Claude) - default
export ANTHROPIC_API_KEY=sk-ant-...

# OpenAI (GPT)
export OPENAI_API_KEY=sk-...

# Google (Gemini)
export GEMINI_API_KEY=...

# Groq
export GROQ_API_KEY=gsk_...

# xAI (Grok)
export XAI_API_KEY=xai-...

# OpenRouter
export OPENROUTER_API_KEY=sk-or-...

# Exa (for web search - optional)
export EXA_API_KEY=...
```

**Alternative:** Store keys in `~/.composer/keys.json`:

```json
{
  "anthropic": { "apiKey": "sk-ant-..." },
  "openai": { "apiKey": "sk-..." }
}
```

Use `composer config init` for interactive provider setup, or `--provider` and `--model` flags to switch providers.

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
- **batch** – Run multiple read-only tools in parallel

**Web & Search** (requires `EXA_API_KEY`):
- **websearch** – Search the web via Exa AI
- **codesearch** – Search GitHub/docs/Stack Overflow
- **webfetch** – Fetch content from URLs

**GitHub** (requires `gh` CLI):
- **gh_pr** – Pull request operations
- **gh_issue** – Issue operations
- **gh_repo** – Repository operations

### Editor Features

- **Tab completion** for paths
- **Drag & drop** files to insert paths
- **Multi-line paste** with collapsible markers
- **Command palette** via `Ctrl+K`
- **File search** via `@` or `Ctrl+K`

## Security

Composer ships with layered security enabled by default:

**Action Firewall:**
- Blocks dangerous commands (`rm -rf`, `mkfs`, `chmod 000`, etc.)
- Protects system paths (`/etc`, `/usr`, `/var`, `/boot`)
- Requires approval for writes outside your project

**Approval Modes** (`--approval-mode`):
| Mode | Behavior |
|------|----------|
| `prompt` (default) | Ask before risky actions |
| `auto` | Auto-approve (trusted sandboxes only) |
| `fail` | Reject all high-risk commands |

**Safe Mode** (`--safe-mode` or `COMPOSER_SAFE_MODE=1`):
Extra restrictions on shell writes.

See [Safety & Approvals](docs/SAFETY.md) for details.

## Telemetry

Telemetry is **off by default**. Enable for analytics:

```bash
# Write to local log
export COMPOSER_TELEMETRY=true

# Or stream to endpoint
export COMPOSER_TELEMETRY_ENDPOINT=https://your-endpoint.com/hook
```

Payloads include tool name, success flag, and duration. Transport failures never block workflows.

## Context Files

Composer loads `AGENT.md` or `CLAUDE.md` files automatically:

1. **Global** (`~/.composer/agent/AGENT.md`) – personal defaults
2. **Parent directories** – inherited settings
3. **Project root** – most specific wins

Use them for coding conventions, architecture notes, and project-specific instructions.

---

# For Contributors

## EvalOps Workflows

Composer is built for automated evaluation pipelines:

```bash
# Run evaluation scenarios
npx nx run composer:evals --skip-nx-cache
```

- **Customize scenarios:** Add entries to `evals/scenarios.json`
- **Stream telemetry:** Set `COMPOSER_TELEMETRY=true` or `COMPOSER_TELEMETRY_ENDPOINT`

### Design Principles

- **Slash-command first** – All actions are explicit and scriptable
- **Deterministic tooling** – Filesystem changes via git-aware helpers
- **EvalOps-ready** – Built-in scenario runners and cost tracking
- **Provider-agnostic** – Portable across Anthropic, OpenAI, Gemini, Groq, etc.

## From Source (Bun + Nx)

```bash
git clone https://github.com/evalops/composer.git
cd composer
bun install
npx nx run composer:build:all --skip-nx-cache   # Builds CLI, TUI, Web
npm link                                        # Optional: link locally
```

### Binary Compilation
```bash
bun run compile:binary
# Output: dist/composer-bun
```

## Workspace Commands (Bun + Nx)

| Command | Purpose |
|---------|---------|
| `bun install` | Install dependencies |
| `bun run bun:lint` | Lint + eval verifier |
| `npx nx run composer:test --skip-nx-cache` | Full test suite (builds TUI/Web) |
| `npx nx run composer:evals --skip-nx-cache` | Run eval scenarios |
| `bun run --filter @evalops/tui build` | Build TUI package |
| `bun run --filter @evalops/composer-web build` | Build Web package |
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
| `/tools` | Show tools + failures |
| `/config` | Configuration details |
| `/cost` | Usage/cost breakdown |
| `/stats` | Quick health check |
| `/plan` | Manage todo plans |
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
composer [options] [messages...]
```

| Flag | Description |
|------|-------------|
| `--provider <name>` | Provider (anthropic, openai, google, etc.). Default: `anthropic` |
| `--model <id>` | Model ID. Default: `claude-opus-4-5` |
| `--api-key <key>` | Override API key |
| `--system-prompt <text\|file>` | Custom system prompt |
| `--mode <text\|json\|rpc>` | Output format |
| `--no-session` | Ephemeral run |
| `--session <path>` | Use specific session |
| `-c, --continue` | Resume latest session |
| `-r, --resume` | Interactive session picker |

## Composers (Sub-Agents)

Create specialized agent profiles in `~/.composer/composers/` or `.composer/composers/`:

```yaml
# .composer/composers/code-reviewer.yaml
name: code-reviewer
description: Focused code review assistant
systemPrompt: |
  You are a code reviewer. Focus on correctness, security, and maintainability.
tools: [read, search, diff]
model: claude-sonnet-4-5
triggers:
  keywords: [review, pr]
  files: ["*.ts", "*.py"]
```

Commands: `/composer list`, `/composer activate <name>`, `/composer deactivate`

## Background Tasks

The `background_tasks` tool manages long-running processes:

| Action | Description |
|--------|-------------|
| `start` | Launch command (with optional restart policy) |
| `stop` | Terminate by ID |
| `list` | View active tasks |
| `logs` | Tail output (default 40 lines) |

Features: shell mode for pipes, custom cwd/env, restart policies with backoff, log persistence.

## Adding Your Own Tools

Configure MCP servers in `~/.composer/mcp.json`:

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

Tools appear as `mcp_<server>_<tool>`. Use `/mcp` to view status.

## Contributing

```bash
bun install
bunx biome check .                           # lint/format
npx nx run composer:test --skip-nx-cache     # tests (mirrors CI)
npx nx run composer:evals --skip-nx-cache    # eval scenarios
```

New commands/features should include tests in `test/`.

## Troubleshooting

### API Key Issues

1. Verify: `echo $ANTHROPIC_API_KEY`
2. Check for typos/whitespace in shell config
3. Restart terminal after setting vars
4. Run `composer --diag`

### Session Files

Sessions are JSONL in `~/.composer/agent/sessions/`. Use:
- `composer --no-session` for fresh starts
- `/export` to save as HTML before archiving

---

## Documentation

- [Quickstart](docs/QUICKSTART.md)
- [Feature Guide](docs/FEATURES.md)
- [Tools Reference](docs/TOOLS_REFERENCE.md)
- [Safety & Approvals](docs/SAFETY.md)
- [Sessions](docs/SESSIONS.md)
- [Providers & Factory](docs/MODELS.md)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)

## License

MIT
