# Composer by EvalOps

Composer is a deterministic coding agent with multi-model support, featuring both a powerful terminal interface (TUI/CLI) and a modern web UI for AI-assisted development.

## Documentation

- [Quickstart](docs/QUICKSTART.md) – install, build, and eval instructions
- [Feature Guide](docs/FEATURES.md) – TUI/CLI walkthrough, bash mode, prompt queue
- [Tools Reference](docs/TOOLS_REFERENCE.md) – detailed list of built-in tools
- [Safety & Approvals](docs/SAFETY.md) – action firewall rules, safe mode, approvals
- [Sessions](docs/SESSIONS.md) – JSONL format, continuation/resume flags
- [Prompt Queue](docs/PROMPT_QUEUE.md) – how prompts are queued and loader stages update
- [Providers & Factory](docs/MODELS.md) – model registry resolution and factory sync
- [Contributing](CONTRIBUTING.md) – workflow, coding standards, release steps
- [Changelog](CHANGELOG.md) – notable fixes and features per release

## Concept

Composer exposes every capability through slash commands and git-aware helpers so you always know what changed and why. The agent is intentionally minimal: no hidden context juggling, no silent retries, just explicit tools you can chain together or script.

Choose your interface:
- **Terminal (TUI/CLI)**: Rich interactive terminal interface with keyboard shortcuts, file search, and command palette
- **Web UI**: Modern browser-based interface for those who prefer a graphical environment
- **Headless**: Scriptable automation for CI/CD and evaluation pipelines

## Who It's For

Developers who want deterministic, scriptable AI assistance with zero mystery meat. You value explicit commands over hidden heuristics, git-friendly edits over magical patches, and the ability to reason about every action Composer takes. If you prefer tight control, fast iteration, and the option to automate everything, you're in the right place.

### Design Principles

- **Slash-command first automation.** Everything routes through explicit commands (`/run`, `/config`, etc.) so actions stay reviewable and scriptable.
- **Deterministic tooling.** Composer touches the filesystem only via transparent git-aware helpers, keeping review diffs clean.
- **EvalOps-ready by default.** Built-in scenario runners, telemetry, and cost tracking mean the CLI can drop straight into automated evaluation loops.
- **Provider-agnostic, session-stable.** Multi-model switching and shared context loading ensure prompts stay portable between Anthropic, OpenAI, Gemini, Groq, and more.

### EvalOps Workflows

- **Run automated evaluations:** `npx nx run composer:evals --skip-nx-cache` builds the CLI/TUI/Web targets with Bun and executes the scenarios defined in `evals/scenarios.json`, making it easy to wire Composer into continuous evaluation pipelines.
- **Customize scenarios:** add more entries to `evals/scenarios.json` to benchmark additional commands (each scenario can assert against stdout via regular expressions).
- **Surface telemetry:** set `COMPOSER_TELEMETRY=true` (or point to a custom `COMPOSER_TELEMETRY_ENDPOINT`) to stream tool usage and evaluation outcomes into your EvalOps dashboards.

## Installation

### Bun (default)

```bash
bun install -g @evalops/composer
```

### npm (alternative)

```bash
npm install -g @evalops/composer
```

### Nix (with flakes)
```bash
nix run github:evalops/composer
# Or add to your flake.nix
```

### From Source (Bun + Nx)
```bash
git clone https://github.com/evalops/composer.git
cd composer
bun install
npx nx run composer:build:all --skip-nx-cache   # Builds CLI, TUI, Web
npm link                                        # Optional: link the CLI locally
```

#### Binary Compilation (Bun)
```bash
git clone https://github.com/evalops/composer.git
cd composer
bun install
bun run compile:binary
# Binary available at dist/composer-bun
```

### Workspace Commands (Bun + Nx)

- Install deps: `bun install`
- Lint + eval verifier: `bun run bun:lint`
- Full test suite (builds TUI/Web): `npx nx run composer:test --skip-nx-cache`
- Package builds: `bun run --filter @evalops/tui build` and `bun run --filter @evalops/composer-web build`
- Targeted tests: `bunx vitest --run -t "<test name>"`

### Nix hash auto-update (CI)
- The `Update Nix Hash` workflow runs on pushes to `main` that touch `bun.lockb`, `package.json`, or `package-lock.json`.
- It commits the new `npmDepsHash` and force-pushes to the `ci/update-nix-hash` branch (no PR is created). If you need the updated hash, merge or cherry-pick that branch.
- If the workflow fails, rerun after rebasing onto `main`; org PR permissions are no longer required because no PR is opened automatically.

### Composer 2.9 security blocking (heads-up)
- Composer 2.9 (released November 19, 2025) now blocks insecure/abandoned versions by default during `update`/`require`, separate from `composer audit`.
- Disable blocking with `--no-security-blocking` or `"config": { "audit": { "block-insecure": false } }`; `--no-audit` / `COMPOSER_NO_AUDIT` only disables the audit report, not blocking.
- Use `"audit.ignore"` entries with `apply: "audit" | "block" | "all"` to scope ignores; advisory IDs (or CVE IDs since 2.9.2) work for both audit and blocking.
- If you must allow abandoned packages, set `"audit": { "block-abandoned": false }` or add `"ignore-abandoned"` entries (also supports `apply` scoping).

## Quick Start

```bash
# Set your API key (see API Keys below)
export ANTHROPIC_API_KEY=sk-ant-...

# Start the interactive terminal UI
composer

# Or start the web UI
composer web
# Then open http://localhost:3000 in your browser
```

Once in the interface, chat with the AI: `Create a simple Express server in src/server.ts`. Composer will read/write files and run shell commands via explicit slash commands.

### API Keys

Composer supports multiple LLM providers. Set the environment variable for the provider you want to use:

```bash
# Anthropic (Claude)
export ANTHROPIC_API_KEY=sk-ant-...
# Or use OAuth token (retrieved via: claude setup-token)
export ANTHROPIC_OAUTH_TOKEN=...

# OpenAI (GPT)
export OPENAI_API_KEY=sk-...

# Google (Gemini)
export GEMINI_API_KEY=...

# Groq
export GROQ_API_KEY=gsk_...

# Cerebras
export CEREBRAS_API_KEY=csk-...

# xAI (Grok)
export XAI_API_KEY=xai-...

# OpenRouter
export OPENROUTER_API_KEY=sk-or-...

# ZAI
export ZAI_API_KEY=...

# Exa (for web search tools - optional)
export EXA_API_KEY=...  # Get yours at https://dashboard.exa.ai/api-keys
```

## Providers

Composer supports Anthropic, OpenAI, Google (Gemini), xAI (Grok), Groq, Cerebras, OpenRouter, and ZAI. Set the appropriate API key environment variable (see API Keys section), then use `--provider` and `--model` flags to select your provider and model. Sessions remember the provider/model pair for seamless continuations.

For detailed provider configuration, including OpenRouter integration and custom endpoints, see [Providers & Factory](docs/MODELS.md).

> **Factory CLI users:** Run `npm run factory:import` / `npm run factory:export` or use `/import factory` inside the TUI whenever you want to sync providers and settings—otherwise Composer stays fully standalone.

## Slash Commands

This CLI doesn't hide behaviors behind fuzzy chat. Every operation is exposed as an explicit slash command—the covenant is that if the agent can do it, you can run it yourself.

### /model

Switch models mid-session via an interactive selector (search by provider or model, arrow keys to navigate, Enter to select).

### /thinking

Adjust thinking/reasoning level for supported models (Claude Sonnet 4, GPT-5, Gemini 2.5).

### /export [filename]

Export the current session to a self-contained HTML file.

```
/export
/export my-session.html
```

### /help

List available slash commands.

### /session

Display session information (file path, token counts, etc.), mark the current
session as a favorite, or attach a manual summary without touching the JSONL.

```
/session                         # show session stats
/session favorite                # star the current session
/session unfavorite              # remove the star
/session summary "Fixed build"   # add a manual summary entry
```

### /sessions

List or load saved sessions by index and manage their metadata.

```
/sessions list text              # show the latest sessions inline
/sessions load 2                 # load session #2
/sessions favorite 1             # mark a saved session as favorite
/sessions unfavorite 1           # remove a favorite flag
/sessions summarize 3            # generate an AI summary for a session
```

### /tools

Show registered tools plus recent failures. Use `clear` to rotate the failure log.

### /config [summary|sources|providers|env|files]

Render validation, sources, providers, env vars, or file references without chaining commands.

```
/config
/config sources
/config providers
/config env
/config files
```

### /cost [period|breakdown|clear|help]

Display usage summaries, provider/model breakdowns, or reset local tracking data.

```
/cost today
/cost breakdown week
/cost clear
/cost help
```

### /stats

Run `/status` plus `/cost today` together for a quick health pulse.

```
/stats
```

### /plan

Inspect plans created via the `todo` tool. Show all goals or a specific one.

```
/plan                                   # list all plans
/plan <goal>                            # show plan details
/plan new <goal>                        # create a plan
/plan add <goal> :: <task> [:: priority] # add a task
/plan complete <goal> :: <task number|id> # mark done
/plan clear <goal>                      # delete a plan
/plan clear all                         # delete all plans
```

### /preview

Preview a git diff without leaving the TUI.

### /run

Execute project scripts (delegates to `npm run`).

### /diag

Display provider/API key diagnostics plus telemetry/health info. Append `copy` to send the report to your clipboard.

### /bug

Copy session details and log paths for bug reports.

### /why

Summarize the most recent user question, assistant reply, and tools invoked.

### /status

Show a quick health summary (model, thinking level, git status, plan stats, telemetry) without running the heavier diagnostics report.

### /review

Print a review-friendly snapshot of `git status` plus `git diff --stat` before diving deeper.

### /undo

Discard working tree changes in one or more files via git checkout.

### /feedback

Copy a feedback template (session/model metadata included) to your clipboard.

### /mention

List workspace files (filtered by an optional query) so you can quickly grab `@path` references.

## Tools

### Built-in Tools

Composer ships with core tools for file operations, git, web search, and GitHub automation:

**File & Code Operations:**
- **batch** – Execute multiple independent tools in parallel (1-10 tools) to reduce latency.
- **read** – Read file contents (text + images). Supports offset/limit for large files.
- **list** – List directory contents with glob filtering and hidden-file toggles.
- **search** – Ripgrep-backed search with regex, glob filters, and context.
- **edit** – Replace exact text in a file (fails if multiple matches).
- **write** – Write/overwrite files, creating parent directories as needed.

**Git & Version Control:**
- **diff** – Inspect git diffs (working tree, staged index, revision ranges).
- **bash** – Execute bash commands with optional timeouts.
- **background_tasks** – Run long-running processes in the background with lifecycle management.

**Task Management:**
- **todo** – Manage TodoWrite-style checklists (`~/.composer/todos.json`).

**Web & Search:**
- **websearch** – Search the web via Exa AI for real-time information (requires `EXA_API_KEY`).
- **codesearch** – Search GitHub/docs/Stack Overflow for code examples via Exa Code (requires `EXA_API_KEY`).
- **webfetch** – Fetch and extract content from specific URLs via Exa (requires `EXA_API_KEY`).

**GitHub CLI Tools** (requires `gh` CLI installed and authenticated):
- **gh_pr** – Pull request operations (create, checkout, view, list, comment)
- **gh_issue** – Issue operations (create, view, list, comment, close)
- **gh_repo** – Repository operations (view, fork, clone)

Install GitHub CLI: `brew install gh` (macOS) or visit [cli.github.com](https://cli.github.com)

**Batch Tool:** Read-only actions (`view`, `list`) are safe to batch. Do NOT batch mutations (`create`, `comment`, `close`, `checkout`) as order and outcome matter.

Examples:
```
Create PR:     {action: "create", title: "Fix bug", body: "Details"}
Checkout PR:   {action: "checkout", number: 123}
Create issue:  {action: "create", title: "Bug report", labels: ["bug"]}
List issues:   {action: "list", state: "open", author: "username"}
```

### CLI Helpers

Use Composer's CLI commands to inspect your model registry:

- `composer models list` – grouped list of every registered model (built-in + custom). Add `--provider openrouter` to filter.
- `composer models providers` – summarize providers, API key env vars, and base URLs so you know which endpoints are wired up.

### Adding Your Own Tools

Composer does not implement MCP. To extend it:

1. Create a simple CLI tool (any language).
2. Document it in a README.
3. Tell the agent to read that README (or reference it from `AGENT.md`).

### Editor Features

- **Path completion:** Tab through relative/absolute paths, with arrow navigation.
- **File drag & drop:** Drop files onto the terminal to insert paths.
- **Multi-line paste:** Pasted blocks collapse into `[paste #123 <N> lines]` markers, but full content is sent.
- **Command palette:** `Ctrl+K` opens a searchable list of slash commands.
- **File search:** Type `@` (or `Ctrl+K` → File Search) for fuzzy find.
- **Keyboard shortcuts:** `Ctrl+K`, `Ctrl+C`, Tab, Enter, Shift+Enter, arrow keys, `Ctrl+A/E`, etc.

### Web UI

Start the web interface for a browser-based experience:

```bash
composer web
# Or with custom port
composer web --port 3001
```

The web UI provides:
- **Modern Interface**: Clean, responsive design optimized for AI-assisted development
- **Real-time Updates**: Live streaming of AI responses and tool executions
- **Session Management**: Load, save, and switch between sessions seamlessly
- **All CLI Features**: Full access to slash commands, file operations, and git integration
- **Multi-user Ready**: Run on a server and access from any device (authentication not included)

Development mode (auto-reload):
```bash
npm run web:dev
```

### CLI Options

```bash
composer [options] [messages...]
```

Key flags:

- `--provider <name>` – Provider (`anthropic`, `openai`, `google`, `xai`, `groq`, `cerebras`, `openrouter`, `zai`). Default `anthropic`.
- `--model <id>` – Model ID. Default `claude-sonnet-4-5`.
- `--api-key <key>` – Override environment variables.
- `--system-prompt <text|file>` – Inline prompt or file reference.
- `--mode <text|json|rpc>` – Control output format / RPC integration.
- `--no-session` – Ephemeral run.
- `--session <path>` – Use a specific session file.
- `--continue/-c`, `--resume/-r`, `--help/-h` – Session helpers and docs.

### Session Management

Sessions live under `~/.composer/agent/sessions/` as JSONL. Use:

- `composer --continue` (or `-c`) – resume the latest session.
- `composer --resume` (or `-r`) – interactive session selector.
- `composer --no-session` – run without saving.
- `composer --session /path/file.jsonl` – resume a specific session.

### Image Support

Pass image paths directly (e.g., `What is in this screenshot? /path/to/image.png`). Composer encodes `.jpg/.jpeg/.png/.gif/.webp` and attaches them for vision-capable models.

## Context

Composer automatically loads `AGENT.md`/`CLAUDE.md` files when starting new sessions so you can layer global, repo, and subdirectory guidance.

1. **Global** (`~/.composer/agent/AGENT.md`) – personal defaults.
2. **Parent directories** – the agent walks up the tree, applying each file.
3. **Project root** – the most specific context wins.

Use them for coding conventions, architecture notes, commands, testing instructions, etc. `AGENT.md` takes precedence over `CLAUDE.md` when both exist.

## Telemetry

Telemetry is off by default. Enable it when you want EvalOps analytics:

- `COMPOSER_TELEMETRY=true` – write events to `~/.composer/telemetry.log` (or `COMPOSER_TELEMETRY_FILE`).
- `COMPOSER_TELEMETRY_ENDPOINT=https://example.com/hook` – stream events to your ingestion endpoint.
- `COMPOSER_TELEMETRY_SAMPLE=0.25` – sample rate control (set to `0` to disable while leaving config in place).
- `npm run telemetry:report` – summarize success rates + durations from the log.

Payloads capture tool name, success flag, duration, and evaluation context. Transport failures are ignored so telemetry never blocks day-to-day workflows.

## Philosophy

### Security (YOLO by default)

Composer runs with full trust: no prompts for permission, no command filtering, no sandboxing. It can read/write/delete anything your user can. If you need guardrails, run inside a VM/container or fork the CLI and add them. Otherwise, embrace the YOLO mode and proceed at your own risk.

### Sub-Agents

Composer will not grow built-in sub-agents. If you need delegation, spawn another `composer` process or write a small helper tool + README the agent can call. Direct execution with full context beats lossy hand-offs.

### Background Tasks

Composer supports managed background processes via the `background_tasks` tool:
- **Start/stop** long-running commands (dev servers, watchers, tunnels)
- **View logs** and task status with real-time monitoring
- **Auto-restart** on failure with configurable retry policies
- **Clean shutdown** on exit with automatic cleanup

Actions available:
- `start` – Launch a background command with optional restart policy
- `stop` – Terminate a running task by ID
- `list` – View all active background tasks
- `logs` – Tail task output (default 40 lines, max 200)

Example workflow:
```bash
# Start a dev server
composer "Start the dev server in the background"
# Agent uses: background_tasks action=start command="npm run dev"

# Make code changes, then check logs
composer "Show me the last 20 lines of the dev server logs"

# Stop when done
composer "Stop all background tasks"
```

Features:
- **Shell mode** – Use `shell: true` for pipes/redirects (e.g., `cmd1 | cmd2`)
- **Working directory** – Set custom `cwd` per task
- **Environment variables** – Pass custom `env` vars
- **Restart policies** – Configure max attempts, delays, exponential backoff, and jitter
- **Log management** – Stores logs to `~/.composer/logs/` for persistence
- **Resource tracking** – Monitor CPU and memory usage

For interactive monitoring outside Composer, use `tmux` or `screen`.

## Contributing

Run the same validators Composer uses internally before submitting changes:

```bash
bun install                                  # one-time
bunx biome check .                           # lint/format (Biome + eval verifier)
npx nx run composer:test --skip-nx-cache     # builds TUI/Web + runs tests (mirrors CI)
npx nx run composer:evals --skip-nx-cache    # optional EvalOps scenarios
# If you touched a package directly, also build it:
bun run --filter @evalops/tui build
bun run --filter @evalops/composer-web build
```

New slash commands or views should ship with tests in `test/`. Use the eval runner for larger feature work so telemetry scenarios stay honest.

## Troubleshooting

### Missing or Invalid API Keys

If you see authentication errors:

1. Verify your API key is correctly set: `echo $ANTHROPIC_API_KEY` (or the relevant provider variable)
2. Check for typos or extra whitespace in your `.bashrc`/`.zshrc`
3. Restart your terminal after setting environment variables
4. Use `composer --diag` to verify provider configuration

### Session Files

Sessions are stored as JSONL in `~/.composer/agent/sessions/`. Each message appends to the file, so sessions can grow large over time. You can:

- Start fresh with `composer --no-session`
- Archive old sessions by moving them out of the sessions directory
- Use `/export` to save sessions as standalone HTML before archiving

## License

MIT
