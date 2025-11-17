# Feature Guide

Composer ships with both an interactive TUI and a non-interactive CLI mode. This
guide highlights the affordances that new users often miss.

## Interactive TUI

Launch the TUI by running `composer` with no messages (or `npm run cli --` from
source). The layout is split into four areas:

1. **Chat timeline** – user/assistant messages, tool outputs, and system notes.
2. **Status rail** – shows the current loader stage (Planning → Tool → Responding),
   streaming deltas, and a subtle three-dot activity indicator.
3. **Editor input** – multi-line editor with autocomplete, slash command hints,
   and keyboard shortcuts (Ctrl+K palette, `@` file search, Shift+Enter newline).
4. **Footer** – cwd, token usage, queued prompts, plan hints, and bash mode state.

### Slash Commands

Type `/` in the editor to see completions. Common commands:

- `/plan` – open or update the TODO/plan view (stored in `~/.composer/todos.json`)
- `/queue` – inspect/cancel queued prompts when the agent is busy
- `/run <script>` – run `npm run <script>` and stream the output in chat
- `/sessions` – list or load session transcripts
- `/why` – quick explanation of the agent’s last decision

Commands are discoverable via Ctrl+K (palette) or the inline autocomplete list.

### Bash Mode

Prefix a message with `!` to enter persistent bash mode. While active:

- Inputs go straight to your shell (`cd` is handled as a builtin that tracks cwd)
- Output appears in a framed “bash” block with exit code and cwd
- Up/Down arrow keys cycle command history; Shift+Enter inserts literal newlines
- Type `exit`, `quit`, or `leave` to return to normal chat

The footer shows “Bash mode active — type exit to leave” so you always know
which context you’re in.

### Tool Output Viewer

When the agent invokes tools (read/list/diff/etc.), each call renders as an
expandable “Tool · name” block. Multiple calls of the same tool are indexed,
and status updates (approval pending, errors) are surfaced inline.

## CLI Mode

Pass one or more messages on the command line:

```bash
composer "Read package.json" "Summarize dependencies"
```

Key switches:

- `--help`, `--mode json`, `--mode rpc`
- `--provider`, `--model`, `--api-key`
- `--continue`, `--session`, `--no-session`
- `--approval-mode prompt|auto|fail`

Environment variables (`GEMINI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
etc.) control provider access without embedding keys in CLI flags.

## Prompt Queue

When the agent is busy, additional prompts are enqueued. The footer shows the
count (“2 prompts queued”), and `/queue` lists, cancels, or reprioritizes the
pending items. Bash mode bypasses the queue to provide immediate shell access.

## Telemetry & Diagnostics

- `npm run telemetry:report` (or `/telemetry`) summarizes tool success rates per
  log file.
- `/diagnostics` aggregates pending tool approvals, git status, telemetry state,
  and model configuration in a single panel.

Keep this guide handy when onboarding teammates so they can discover the TUI’s
power-user features quickly.
