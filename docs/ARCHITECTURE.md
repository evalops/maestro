# Composer Architecture (High‑Level)

This repo is a Bun + Nx monorepo with multiple user surfaces that all drive the same “Composer” coding agent concept. This document is a quick map of where things live and how the terminal UIs relate.

## Packages and Entrypoints

- `src/` – TypeScript CLI application and core runtime.
  - `src/runtime/agent-runtime.ts` wires the Agent to a renderer and the prompt queue.
  - `src/cli-tui/` is the TypeScript terminal UI app (see below).
- `packages/ai/` – provider clients, model routing, and AI utilities for TS surfaces.
- `packages/slack-agent/` – Slack bot/agent surface.
- `packages/tui/` – reusable TypeScript terminal UI library (`@evalops/tui`).
- `packages/tui-rs/` – standalone Rust TUI binary (`composer-tui`).
- `packages/web/` – web UI surface.
- `packages/contracts/` – shared schemas/types.

## Terminal UIs

### TypeScript CLI TUI (`src/cli-tui`)

Default interactive CLI. Key pieces:

- `src/cli-tui/tui-renderer.ts` – main orchestrator. Subscribes to Agent events, owns high‑level UI state, and coordinates all views/modals.
- Views in `src/cli-tui/**` (message view, tool output view, session view, git view, selectors, etc.) render to the chat container.
- Controllers encapsulate cohesive subsystems so `TuiRenderer` stays thin:
  - `src/cli-tui/queue/queue-controller.ts` + `src/cli-tui/queue/queue-panel-controller.ts`
  - `src/cli-tui/plan/plan-controller.ts`
  - `src/cli-tui/run/run-controller.ts`
  - `src/cli-tui/approval/**`
- `src/cli-tui/modal-manager.ts` manages modal stacking and focus.

Rendering stack:

```
Agent events
  -> AgentEventRouter
    -> TuiRenderer
      -> Views / Controllers
        -> @evalops/tui components
          -> ProcessTerminal (stdout)
```

### TypeScript TUI Library (`packages/tui`)

Reusable low‑level terminal UI toolkit. It provides:

- Differential rendering (`TUI`), wrapping cache, and synchronized output.
- Layout containers (`Container`, `ScrollContainer`) and built‑in widgets (`Text`, `Input`, `Editor`, `SelectList`, etc.).
- Terminal abstraction (`Terminal` / `ProcessTerminal`).

Used by `src/cli-tui` and any other Node/Bun CLIs that want a flicker‑free TUI.

### Rust TUI (`packages/tui-rs`)

Native terminal UI binary built with `ratatui` + `crossterm`.

- **Standalone**: no Node.js subprocess; includes native AI clients and tool execution.
- Designed to preserve terminal scrollback and reduce bytes over SSH.
- Mirrors the TS CLI feature set (sessions, commands, approvals, MCP, tools) but is a separate implementation.

If you’re improving terminal UX over SSH or chasing rendering/perf bugs, check whether the fix belongs in:
- TS library (`packages/tui`) – shared rendering/widget behavior.
- TS CLI (`src/cli-tui`) – orchestration, commands, modals, view logic.
- Rust TUI (`packages/tui-rs`) – native parity features and terminal‑level behavior.

## Adding Slash Commands (TypeScript CLI)

For simple commands:

1. **Define handler type** in `src/cli-tui/commands/types.ts`
2. **Register command** in `src/cli-tui/commands/registry.ts`
3. **Expose builder option** in `src/cli-tui/utils/commands/command-registry-builder.ts`
4. **Wire handler** in `src/cli-tui/tui-renderer.ts`

For selector/modal commands (e.g., `/theme`, `/model`, `/thinking`):

- Add a selector component in `src/cli-tui/selectors/`
- Add a view wrapper if it needs lifecycle management
- Initialize it in `TuiRenderer`’s constructor
- Show it via `this.modalManager.push(component)`

## Contribution Pointers

- Prefer adding small controllers/views over growing `tui-renderer.ts`.
- Put reusable widgets or rendering fixes in `packages/tui`.
- Keep Rust parity changes local to `packages/tui-rs` unless the behavior is shared.

