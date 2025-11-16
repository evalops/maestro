# Composer CLI by EvalOps

Composer is a radically simple and opinionated coding agent with multi-model support (including mid-session switching), a powerful headless CLI, and the creature comforts you expect from modern coding copilots.

## Who It's For

Developers who want deterministic, scriptable AI assistance with zero mystery meat. You value explicit commands over hidden heuristics, git-friendly edits over magical patches, and the ability to reason about every action Composer takes. If you prefer tight control, fast iteration, and the option to automate everything, you're in the right place.

## Concept

Composer exposes every capability through slash commands and git-aware helpers so you always know what changed and why. The agent is intentionally minimal: no hidden context juggling, no silent retries, just explicit tools you can chain together or script.

### Design Principles

- **Slash-command first automation.** Everything routes through explicit commands (`/run`, `/config`, etc.) so actions stay reviewable and scriptable.
- **Deterministic tooling.** Composer touches the filesystem only via transparent git-aware helpers, keeping review diffs clean.
- **EvalOps-ready by default.** Built-in scenario runners, telemetry, and cost tracking mean the CLI can drop straight into automated evaluation loops.
- **Provider-agnostic, session-stable.** Multi-model switching and shared context loading ensure prompts stay portable between Anthropic, OpenAI, Gemini, Groq, and more.

### EvalOps Workflows

- **Run automated evaluations:** `npm run evals` builds the CLI and executes the scenarios defined in `evals/scenarios.json`, making it easy to wire Composer into continuous evaluation pipelines.
- **Customize scenarios:** add more entries to `evals/scenarios.json` to benchmark additional commands (each scenario can assert against stdout via regular expressions).
- **Surface telemetry:** set `COMPOSER_TELEMETRY=true` (or point to a custom `COMPOSER_TELEMETRY_ENDPOINT`) to stream tool usage and evaluation outcomes into your EvalOps dashboards.

## Installation

```bash
npm install -g @evalops/composer
```

## Quick Start

```bash
# Set your API key (see API Keys below)
export ANTHROPIC_API_KEY=sk-ant-...

# Start the interactive CLI
composer
```

Once in the CLI, chat with the AI: `Create a simple Express server in src/server.ts`. Composer will read/write files and run shell commands via explicit slash commands.

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
```

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

Display session information and statistics (file path, token counts, etc.).

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

Composer ships with eight core tools:

- **read** – Read file contents (text + images). Supports offset/limit for large files.
- **list** – List directory contents with glob filtering and hidden-file toggles.
- **search** – Ripgrep-backed search with regex, glob filters, and context.
- **diff** – Inspect git diffs (working tree, staged index, revision ranges).
- **bash** – Execute bash commands with optional timeouts.
- **edit** – Replace exact text in a file (fails if multiple matches).
- **write** – Write/overwrite files, creating parent directories as needed.
- **todo** – Manage TodoWrite-style checklists (`~/.composer/todos.json`).

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

### Background Bash

No background bash APIs. Use `tmux`, `screen`, or your terminal emulator to watch long-running commands (and intervene if needed).

## Contributing

Run the same validators Composer uses internally before submitting changes:

```bash
npm install            # one-time
npx biome check .      # lint/format
npm test               # Vitest suite
npm run evals          # optional EvalOps scenarios
```

New slash commands or views should ship with tests in `test/`. Use the eval runner for larger feature work so telemetry scenarios stay honest.

## Planned Features

- **Custom/local models:** Support for Ollama, llama.cpp, vLLM, SGLang, LM Studio via JSON config.
- **Auto-compaction:** Watch the context percentage; ask Composer to summarize to `.md` or switch to a larger-context model.
- **Message queuing:** Engine support exists; UI wiring TBD.
- **Better RPC docs:** Works today; see `test/rpc-example.ts`.
- **Better Markdown/tool rendering** and richer `/export` views.
- **More flicker than Claude Code:** aspirational.

## License

MIT
