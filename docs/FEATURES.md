# Feature Guide

Audience: users exploring TUI/CLI flows; skim first.  
Nav: [Docs index](README.md) · [Quickstart](QUICKSTART.md) · [Tools Reference](TOOLS_REFERENCE.md) · [Web UI](WEB_UI.md)

This guide highlights Composer’s user-facing capabilities across the TUI, CLI, and Web UI. Keep the [Tools Reference](TOOLS_REFERENCE.md) open for full slash command syntax.

Navigation: [Interfaces](#interfaces) · [TUI essentials](#tui-essentials) · [CLI mode](#cli-mode) · [Prompt queue](#prompt-queue) · [Background tasks](#background-tasks) · [Telemetry & diagnostics](#telemetry--diagnostics)

## Interfaces
- **TUI** — launch `composer` with no arguments (or `bun run cli --` from source). Rich editor, slash command palette, and footer telemetry.
- **CLI** — pass one or more messages as arguments (`composer "Read package.json" "Summarize dependencies"`). Supports JSON/RPC output for automation.
- **Web UI** — start with `composer web`; see [Web UI Guide](WEB_UI.md) for parity notes and shortcuts.

## TUI essentials
The layout has four regions: chat timeline, status indicators, editor input, and footer. Key workflows:

### Slash commands
Type `/` in the editor for completions. Highlights:
- `/plan` — open or update the TODO/plan view (persists with the session).
- `/run <script>` — run workspace scripts with streamed output.
- `/sessions` — list or load transcripts; format details live in [Sessions](SESSIONS.md).
- `/report` — collect info for bug reports or feedback.
- **Prompt templates** — drop markdown files into `.composer/prompts/*.md` (project) or `~/.composer/prompts/*.md` (user), then run them via `/prompts <name> …` or directly as `/<name> …` (if the name doesn’t collide with a built-in command). Markdown files in `.composer/commands/*.md` are also treated as prompt templates.

See [Tools Reference](TOOLS_REFERENCE.md) for every command and flag. Availability by surface (TUI vs Web) is summarized in [Web UI Guide](WEB_UI.md#parity-appendix).

### Editor + navigation
- Multi-line editor with autocomplete, slash hints, and keyboard shortcuts (Ctrl+K palette, `@` file search, Shift+Enter newline).
- Footer shows cwd, token usage, prompt queue depth, plan hints, and bash mode state.
- Use `/files` or `@` search to jump to files without leaving the chat.

### Bash mode
Prefix a message with `!` to enter persistent bash mode.
- Inputs go straight to your shell (`cd` is handled as a builtin that tracks cwd).
- Output appears in a framed “bash” block with exit code and cwd.
- Up/Down arrow keys cycle command history; Shift+Enter inserts literal newlines.
- Type `exit`, `quit`, or `leave` to return to normal chat. The footer shows “Bash mode active — type exit to leave.”

## CLI mode
- Supports `--mode json` and `--mode rpc` for scripting, plus provider/model flags (`--provider`, `--model`, `--api-key`).
- `--continue`, `--session`, and `--no-session` align with the session model described in [Sessions](SESSIONS.md).
- Approval behavior follows [Safety](SAFETY.md) (`--approval-mode prompt|auto|fail`).
- Use `/framework <id>` to set a default stack (`fastapi`, `express`, `node`); add `--workspace` to scope it to the current repo; `/framework none` clears. Precedence: policy (locked) > policy > env override > env default > workspace `.composer/workspace.json` > user `~/.composer/default-framework.json` > none.

## Prompt queue
When the agent is busy, additional prompts are enqueued. The footer shows the count (“2 prompts queued”), and `/queue` lists, cancels, or reprioritizes pending items. Bash mode bypasses the queue for immediate shell access. Details: [Prompt Queue](PROMPT_QUEUE.md).

## Background tasks
- Run long commands with `/background_tasks action=start …`; check `/background_tasks action=list` or `/background_tasks action=logs` without leaving chat.
- Health telemetry feeds the footer and diagnostics view, showing recent failures, restarts, and limit breaches.
- User controls live in `~/.composer/agent/background-settings.json` (or a custom path via `COMPOSER_BACKGROUND_SETTINGS`).
- Secrets in summaries/log previews are redacted automatically; avoid putting raw tokens directly in commands.

## Telemetry & diagnostics
- `npm run telemetry:report` (or `/telemetry`) summarizes tool success rates per log file.
- `/diag` (or `/diagnostics`) aggregates pending approvals, git status, telemetry state, and model configuration in a single panel.
- Use [Safety](SAFETY.md) for firewall, sandboxing, and approval flows; pair with [Models](MODELS.md) to understand provider defaults and overrides.

Keep this guide handy when onboarding teammates so they can discover the TUI’s power-user features quickly.

For lower-level component APIs, see `packages/tui/README.md`.
