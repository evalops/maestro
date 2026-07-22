# TUI Architecture (Native maestro-tui)

Audience: contributors working on the interactive terminal UI.  
Nav: [Docs index](README.md) · [Architecture](ARCHITECTURE.md) · [Native TUI parity](NATIVE_TUI_PARITY.md) · [Prompt Queue](PROMPT_QUEUE.md)

> **Historical note:** The TypeScript TUI (`packages/tui`, `src/cli-tui`) was removed in
> PR [#2891](https://github.com/evalops/maestro-internal/pull/2891). Interactive mode is
> **native-only**: the CLI hands off to the `maestro-tui` binary built from
> `packages/tui-rs`. Headless, one-shot, and RPC paths are also native via
> `maestro-tui`.
>
> **Server runtime complete:** Web SSE/WS chat, automations, hosted headless, and
> prompt suggestion require `maestro-tui --headless`. A missing or failed native
> process fails closed. TS `Agent` remains for external SDK embedding only — see
> [ARCHITECTURE.md — TypeScript Agent status](ARCHITECTURE.md#typescript-agent-status)
> and [Native TUI parity — Server runtime](NATIVE_TUI_PARITY.md#server-runtime-complete).

## Overview

`maestro-tui` is a standalone Rust binary (ratatui + crossterm) with its own agent
loop, provider clients, tools, safety stack, sessions, hooks, MCP, and skills. It does
**not** spawn Node for the agent runtime.

```
┌─────────────────────────────────────────────────────────────────────┐
│  CLI (`maestro` / `src/main.ts`)                                     │
│  Interactive mode → launchNativeTui() → maestro-tui binary           │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  packages/tui-rs  (binary: maestro-tui)                              │
│  main.rs → App (event loop) → NativeAgent + components + session     │
└─────────────────────────────────────────────────────────────────────┘
```

Resolution order for the binary (see `src/cli/native-tui-launcher.ts`):

1. `MAESTRO_TUI_BIN`
2. Packaged `vendor/maestro-tui/<platform>-<arch>/maestro-tui`
3. `maestro-tui` on `PATH`
4. Dev fallback: `packages/tui-rs/target/{release,debug}/maestro-tui`

Install notes:

- **npm/Bun** — `package.json` `files` includes `vendor/maestro-tui`; release
  packaging materializes per-platform binaries before `npm pack`.
- **One-line installer** — installs both `maestro` and `maestro-tui` onto PATH.
- **Web server** — on boot, logs an error when the binary cannot be resolved
  (`src/server/maestro-tui-boot-check.ts`).

Build from a checkout:

```bash
bun run tui-rs:build
# or
cargo build --release --manifest-path packages/tui-rs/Cargo.toml
```

Deep module docs live in [`packages/tui-rs/ARCHITECTURE.md`](../packages/tui-rs/ARCHITECTURE.md)
and [`packages/tui-rs/README.md`](../packages/tui-rs/README.md).

## High-level layout

```
packages/tui-rs/src/
├── main.rs                 # CLI entry (clap), provider/model inference, launch App
├── app.rs / app/           # Event loop, input, command handlers, prompt queue
├── state.rs                # Messages, UI state, approval/sandbox modes
├── agent/                  # NativeAgent, protocol, compaction, safety hooks
├── ai/                     # Provider clients (Anthropic, OpenAI, Google, …)
├── tools/                  # Built-in tools + registry/executor
├── commands/               # Slash-command registry, matcher, types
├── components/             # ratatui widgets (chat, approval, selectors, input)
├── session/                # JSONL persistence, branching, resume
├── mcp/                    # MCP client (stdio / HTTP / SSE)
├── hooks/                  # Rust / Lua / WASM hooks + optional Node bridge
├── skills/                 # Skill loader + registry
├── safety/                 # Firewall, path containment, safe mode
├── sandbox.rs              # OS sandbox (Seatbelt / Landlock+seccomp)
├── headless/               # Headless protocol + remote attach
├── terminal/               # Raw mode, events, scrollback
├── files/                  # Workspace index + fuzzy search
└── hosted_runner/          # Hosted runner surface
```

## Core subsystems

### App & event loop (`app.rs`)

`App` owns terminal setup, the main async loop, modal focus, slash-command dispatch,
and communication with `NativeAgent`. Input routes through focused components
(editor, selectors, approval modal, command palette).

### Native agent (`agent/`)

`NativeAgent` / `NativeAgentRunner` run the tool loop without a Node subprocess:

- Streams from native AI clients (`ai/`)
- Executes tools via `tools/` registry
- Applies firewall / approval / sandbox policy
- Emits UI-facing agent protocol messages (`agent/protocol.rs`)
- Compacts context (`agent/compaction.rs`, default auto-threshold ~85%)

### Rendering (`components/`, ratatui)

Widgets include chat/message view, multi-line textarea, approval modal, file search,
session switcher, model/theme selectors, command palette, status/thinking indicators.
Terminal history uses ANSI scroll regions for SSH-friendly scrollback
(`terminal/history.rs`).

### Slash commands (`commands/`)

Commands are registered in `commands/registry.rs` with fuzzy matching and tab
completion in `commands/matcher.rs`. Adding a command:

1. Define metadata / handler wiring in `commands/registry.rs` (and types in `commands/types.rs`)
2. Implement behavior in `app/command_handlers.rs` or a focused handler module
3. Add or update tests under `commands/registry/tests.rs` / `app/tests.rs`

Common commands: `/help`, `/clear`, `/model`, `/thinking`, `/approvals`, `/theme`,
`/mcp`, `/compact`, `/queue`, `/diag`. See [Features](FEATURES.md) and package README.

### Prompt queue (`app/prompt_queue.rs`)

FIFO follow-up and steer queues while a turn is running (Enter to steer, Alt+Enter to
queue). Modes and capacity are enforced in-app. Details: [Prompt Queue](PROMPT_QUEUE.md).

### Sessions (`session/`)

JSONL sessions under `~/.maestro/` (with legacy composer-home compatibility where
implemented). Resume via `maestro --resume` / `maestro-tui --resume` or continue last
session with `--continue`. Branching and export live alongside manager/reader/writer.

### MCP, hooks, skills, safety

| Area | Location | Notes |
|------|----------|--------|
| MCP | `mcp/` | Stdio, HTTP, SSE; config from `~/.maestro/mcp.json` and project paths (plus legacy composer paths) |
| Hooks | `hooks/` | Native / Lua / WASM; optional TypeScript IPC bridge |
| Skills | `skills/` | Loaded at startup into system prompt |
| Approvals | `components/approval.rs`, `state` | YOLO / Selective / Safe |
| Firewall | `safety/` | Bash analysis, path containment, safe mode |
| Sandbox | `sandbox.rs` | macOS Seatbelt; Linux Landlock + seccomp |

Parity status vs the former TS interactive agent: [NATIVE_TUI_PARITY.md](NATIVE_TUI_PARITY.md).

### Headless & hosted

`headless/` implements the framed headless protocol (shared contracts with the TS
surface). `hosted_runner/` supports remote/hosted continuity. See
[Headless protocol](protocols/headless.md) and design docs under `docs/design/`.

## Launch paths

| Path | Entrypoint | Runtime |
|------|------------|---------|
| Interactive TUI | `maestro` → `launchNativeTui` → `maestro-tui` | Rust agent |
| One-shot / headless / RPC | `src/main.ts` agent bootstrap | TypeScript agent |
| Direct native binary | `packages/tui-rs/target/release/maestro-tui` or packaged vendor binary | Rust agent |

## Build & test

```bash
bun run tui-rs:build          # release binary
bun run tui-rs:build:debug    # debug binary
bun run tui-rs:check          # cargo check
bun run tui-rs:test           # cargo test
bun run start:native          # run release binary from checkout
```

## Related docs

- [packages/tui-rs/ARCHITECTURE.md](../packages/tui-rs/ARCHITECTURE.md) — module deep dive
- [packages/tui-rs/README.md](../packages/tui-rs/README.md) — build, shortcuts, slash commands
- [Native TUI parity](NATIVE_TUI_PARITY.md) — feature checklist vs removed TS TUI
- [Prompt Queue](PROMPT_QUEUE.md) — queue / steer / follow-up behavior
- [Safety](SAFETY.md) · [Threat Model](THREAT_MODEL.md) · [Sessions](SESSIONS.md)
