# Getting Started

Maestro is a coding agent for real software work. The interactive surface is a native terminal UI (`maestro-tui`) that can inspect code, edit files, run shell commands, and stream tool use with approvals and sandbox controls.

---

## Install

One-line install (macOS / Linux):

```bash
curl -fsSL https://raw.githubusercontent.com/evalops/maestro/main/scripts/install.sh | bash
```

Package managers (contributors and source workflows):

```bash
npm install -g @evalops/maestro
```

Nix:

```bash
nix run github:evalops/maestro
```

Verify:

```bash
maestro --version
```

See the root [README Install section](../../../../README.md#install) for manual release binary downloads.

From a source checkout you must build the native TUI before interactive use:

```bash
npm install
npm run tui-rs:build
# optional: export MAESTRO_TUI_BIN=target/release/maestro-tui
```

---

## First launch

```bash
maestro
```

Or with an initial prompt (opens the TUI and submits once the agent is ready):

```bash
maestro "Audit this repository and suggest the next refactor"
```

Other common entrypoints:

```bash
maestro "…"                 # interactive TUI with trailing prompt
maestro web                 # browser UI on http://localhost:8080
maestro --resume            # interactive session picker
maestro --continue          # resume most recent session for this cwd
```

---

## Authenticate

Default path for Codex subscription models:

```bash
maestro codex login
```

Bare `maestro` defaults toward `openai-codex/gpt-5.5` when Codex auth is available. You can also set provider API keys (for example `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) or store keys in `~/.maestro/keys.json`. See [Authentication](02-authentication.md).

---

## Basic interaction

The TUI has a chat timeline, status/footer badges, and a multi-line editor:

- Type a message and press `Enter` to send.
- Press `Shift+Enter` for a newline.
- Type `/` for slash commands (see [Slash Commands](04-slash-commands.md)).
- Type `@` for fuzzy file search.
- Prefix a line with `!` for persistent bash mode, or `!! cmd` for a one-off shell command.

While the agent is running:

- `Enter` steers the current turn.
- `Alt+Enter` queues a follow-up.
- `Ctrl+C` interrupts / quits according to context.

---

## Modes at a glance

| Mode | How | Behavior |
|------|-----|----------|
| Normal | default | Selective approvals for risky tools |
| Plan | `/plan` or Shift+Tab cycle | Prefer a plan before mutating tools |
| Always-approve | `/always-approve` (`/yolo`) | Auto-approve tool executions |
| Ask-all | `/ask` | Require approval for all tools |
| Auto (selective) | `/auto` | Safe tools free, risky tools prompt |

See [Plan Mode](10-plan-mode.md) and [Sandbox and Safety](12-sandbox-and-safety.md).

---

## Next steps

1. [Authentication](02-authentication.md)
2. [Keyboard Shortcuts](03-keyboard-shortcuts.md)
3. [Slash Commands](04-slash-commands.md)
4. [Configuration](05-configuration.md)
