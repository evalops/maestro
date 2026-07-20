# Feature Guide

Maestro provides a capability dial (`low`, `medium`, `high`, and `ultra`) backed by versioned agent profiles. Legacy `free`, `rush`, `smart`, `custom`, and `frontier` names remain available as migration aliases. See [Agent Profiles](AGENT_PROFILES.md).

Audience: users exploring TUI/CLI flows; skim first.  
Nav: [Docs index](README.md) · [Quickstart](QUICKSTART.md) · [Tools Reference](TOOLS_REFERENCE.md) · [Web UI](WEB_UI.md)

This guide highlights Maestro’s user-facing capabilities across the TUI, CLI, and Web UI. Keep the [Tools Reference](TOOLS_REFERENCE.md) open for full slash command syntax.

Navigation: [Interfaces](#interfaces) · [TUI essentials](#tui-essentials) · [CLI mode](#cli-mode) · [Prompt queue](#prompt-queue) · [Background tasks](#background-tasks) · [Telemetry & diagnostics](#telemetry--diagnostics)

## Interfaces
- **TUI** — launch `maestro` with no arguments (or `bun run cli --` from source). Rich editor, slash command palette, and footer telemetry.
- **CLI** — pass one or more messages as arguments (`maestro "Read package.json" "Summarize dependencies"`). Supports JSON/RPC output for automation.
- **Web UI** — start with `maestro web`; see [Web UI Guide](WEB_UI.md) for parity notes and shortcuts.
- **Conductor (Chrome extension)** — browser-automation surface that connects to the Maestro web server via the Conductor Bridge (`CONDUCTOR_BRIDGE.md`).
- **Ambient Agent** — always-on GitHub daemon that watches repos and ships PRs (see [Ambient Agent Design](design/AMBIENT_AGENT.md)).

## TUI essentials
The layout has four regions: chat timeline, status indicators, editor input, and footer. Key workflows:

### Slash commands
Type `/` in the editor for completions. Highlights:
- `/plan` — open or update the TODO/plan view (persists with the session).
- `/run <script>` — run workspace scripts with streamed output.
- `/sessions` — list or load transcripts; format details live in [Sessions](SESSIONS.md).
- `/report` — collect info for bug reports or feedback.
- **Prompt templates & skills as slash commands** (Grok-style) — drop markdown into `.maestro/prompts/*.md` or `.maestro/commands/*.md` (and `~/.maestro/…`), or a skill at `.maestro/skills/<name>/SKILL.md`. Invoke with `/<name> …`. Built-in commands always win on name collision.
- **Trailing prompt** — `maestro "fix the bug"` / `maestro-tui "fix the bug"` opens the interactive TUI and submits that prompt once the agent is ready.
- **Session UX** — `/new` (alias `/clear`) starts a fresh session; `/fork` branches the transcript into a new session; `/rewind [n]` drops the last N user turns and rebuilds agent history.
- **Modes** — Shift+Tab cycles Normal → Plan → Always-approve. Shortcuts: `/plan`, `/auto`, `/always-approve`, `/ask`.
- **Worktrees** — `maestro --worktree[=name] "…"` creates/reuses a git worktree under `.maestro/worktrees/` then launches the native TUI.
- **Native print / single-shot** — `maestro "x" --mode text|json`, non-TTY pipes, and simple `maestro exec "x"` run via `maestro-tui --print` (Rust agent). Complex exec (`--output-schema`) stays on TS for now.
- **Native CLI helpers** — `maestro status|cost|sessions|hooks` early-exit to `maestro-tui` subcommands (no Node agent bootstrap).
- **Native trailing prompts** — In a TTY, `maestro "fix the bug"` hands off to `maestro-tui` (not the TypeScript single-shot agent). Use `--mode text` / `--mode json` for scripted single-shot on TS.
- **`/tools`**, **`/memory`**, **`/continue`** — real native handlers (tool list, local memory status, resume last session).


See [Tools Reference](TOOLS_REFERENCE.md) for every command and flag. Availability by surface (TUI vs Web) is summarized in [Web UI Guide](WEB_UI.md#parity-appendix).

### Editor + navigation
- Multi-line editor with autocomplete, slash hints, and keyboard shortcuts (Ctrl+K palette, `@` file search, Shift+Enter newline).
- Footer shows cwd, token usage, prompt queue depth, plan hints, and bash mode state.
- Use `/files` or `@` search to jump to files without leaving the chat.

### Footer badges
Runtime badges condense environment + agent state into quick signals:
- `approvals:auto|prompt|fail`, `sandbox:default|danger-full-access`, `queue:all(2)`, `alerts:3`
- `think:medium`, `mcp:2(14)`, `bg:1!1`, `motion:reduced`, `compact:auto`
- `env:docker|podman|wsl|ssh|flatpak|musl`, `term:tmux|screen|jetbrains`

### Accessibility / reduced motion
- Set `MAESTRO_REDUCED_MOTION=1` to reduce animated UI elements (auto-enabled by default on SSH/tmux/screen).
- Set `MAESTRO_DISABLE_ANIMATIONS=1` to hard-disable all TUI animations (spinners, typing dots, shimmer effects).

### Bash mode
Prefix a message with `!` to enter persistent bash mode.
- Inputs go straight to your shell (`cd` is handled as a builtin that tracks cwd).
- Output appears in a framed “bash” block with exit code and cwd.
- Up/Down arrow keys cycle command history; Shift+Enter inserts literal newlines.
- Type `exit`, `quit`, or `leave` to return to normal chat. The footer shows “Bash mode active — type exit to leave.”
- Use `!! <command>` for a one-off shell command without entering bash mode.

## CLI mode
- Supports `--mode json` and `--mode rpc` for scripting, plus provider/model flags (`--provider`, `--model`, `--api-key`).
- `--continue`, `--session`, and `--no-session` align with the session model described in [Sessions](SESSIONS.md).
- Approval behavior follows [Safety](SAFETY.md) (`--approval-mode prompt|auto|fail`).
- Use `/framework <id>` to set a default stack (`fastapi`, `express`, `node`); add `--workspace` to scope it to the current repo; `/framework none` clears. Precedence: policy (locked) > policy > env override > env default > workspace `.maestro/workspace.json` > user `~/.maestro/default-framework.json` > none.

## Prompt queue
When the agent is busy, additional prompts are enqueued. The footer shows the count (“2 prompts queued”), and `/queue` lists, cancels, or reprioritizes pending items. Bash mode bypasses the queue for immediate shell access. Details: [Prompt Queue](PROMPT_QUEUE.md).
Use `/steer <message>` to interrupt the current run and push a new prompt to the front of the queue.

## Background tasks
- Run long commands with `/background_tasks action=start …`; check `/background_tasks action=list` or `/background_tasks action=logs` without leaving chat.
- Health telemetry feeds the footer and diagnostics view, showing recent failures, restarts, and limit breaches.
- User controls live in `~/.maestro/agent/background-settings.json` (or a custom path via `MAESTRO_BACKGROUND_SETTINGS`).
- Secrets in summaries/log previews are redacted automatically; avoid putting raw tokens directly in commands.

## Telemetry & diagnostics
- `npm run telemetry:report` (or `/telemetry`) summarizes tool success rates per log file.
- `maestro value` summarizes customer-facing value, trust cards, durable handoffs, open work, multi-agent A2A coordination, workflow opportunities, memory provenance, and admin-control gaps from local evidence; add `--write` to persist JSON, Markdown, and a hash manifest.
- `/diag` (or `/diagnostics`) aggregates pending approvals, git status, telemetry state, and model configuration in a single panel.
- Use [Safety](SAFETY.md) for firewall, sandboxing, and approval flows; pair with [Models](MODELS.md) to understand provider defaults and overrides.

Keep this guide handy when onboarding teammates so they can discover the TUI’s power-user features quickly.

For native TUI architecture, shortcuts, and slash commands, see
[TUI Architecture](TUI_ARCHITECTURE.md) and
[`packages/tui-rs/README.md`](../packages/tui-rs/README.md).
