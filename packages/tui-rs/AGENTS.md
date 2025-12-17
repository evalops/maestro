# Agent Development Guidelines for tui-rs

This document provides context for AI agents working on the Rust TUI codebase.

## Quick Reference

```bash
# Build
cargo build --release

# Test
cargo test

# Run
./target/release/composer-tui
```

## Architecture Overview

This is a **native Rust TUI** with a fully native agent runtime, AI provider clients, and tool execution. It does **not** require a Node.js subprocess for normal operation. A small Node bridge is used only for optional TypeScript hook execution.

### Key Design Decisions

1. **Native Agent Architecture**: AI communication, tool execution, and streaming live entirely in Rust (`agent/`, `ai/`, `tools/`). This enables a standalone binary and avoids cross-process latency. A Node hook bridge exists only for running TS hooks when enabled.

2. **Cursor Positioning**: Uses native terminal cursor (adapted from OpenAI Codex) rather than inline cursor rendering. See `components/textarea.rs` for the implementation.

3. **Modal System**: Single `ActiveModal` enum in `app.rs` controls which modal is visible. Only one modal can be active at a time.

4. **Session Persistence**: Sessions are JSONL files in `~/.composer/sessions/`. The format matches the TypeScript TUI for compatibility.

### ⚠️ Critical: TypeScript vs Rust Architecture Differences

**Do NOT blindly port TypeScript patterns to Rust.** The architectures are fundamentally different:

| Aspect | TypeScript TUI | Rust TUI |
|--------|---------------|----------|
| **Rendering** | React-like component model with lifecycle hooks | Immediate-mode rendering (Ratatui) - stateless widgets |
| **State** | Distributed across components with subscriptions | Centralized `AppState` struct passed by `&mut` reference |
| **Async** | Event emitters, subscriptions, observers | MPSC channels (`tokio::sync::mpsc`) |
| **Modals** | Lifecycle-based (mount/unmount/dispose) | Enum-based (`ActiveModal`) with direct field access |
| **Updates** | Reactive (state changes trigger re-renders) | Imperative (explicit render calls each frame) |

#### Patterns That Do NOT Apply to Rust TUI

1. **Component Lifecycle Hooks** (`onMount`, `onUnmount`, `dispose`)
   - Ratatui widgets are **stateless** - they render and are discarded each frame
   - State lives in `AppState`, not in components
   - No cleanup callbacks needed - Rust's ownership handles resource cleanup

2. **Subscription/Observer Pattern** (`SubscriptionManager`, event buses)
   - Use MPSC channels instead: `mpsc::UnboundedSender<FromAgent>`
   - State updates go through `AppState::handle_agent_message()`
   - No need to track subscriptions - channels are type-safe and ownership-managed

3. **Distributed Component State**
   - All mutable state lives in `AppState` (see `state.rs`)
   - Components receive state as constructor arguments or render parameters
   - No component-local state that persists across renders

4. **Session Metadata Cache** (for tracking model/thinking level)
   - `SessionInfo` already contains `thinking_level` (see `session/manager.rs:331`)
   - `AppState` has `model: Option<String>` for current model
   - Session headers contain all metadata - just read them

#### How to Properly Extend the Rust TUI

**Adding State:**
```rust
// In state.rs - add to AppState struct
pub struct AppState {
    // ... existing fields
    pub my_new_field: Option<String>,
}

// Initialize in AppState::new()
Self {
    // ... existing fields
    my_new_field: None,
}
```

**Adding a Tool:**
1. Implement in `tools/my_tool.rs`
2. Add to `ToolExecutor` struct in `tools/registry.rs`
3. Add match arm in `ToolExecutor::execute()`
4. Register schema in `ToolRegistry::new()`

**Handling Agent Events:**
```rust
// In state.rs - add match arm to handle_agent_message()
FromAgent::MyNewEvent { data } => {
    self.my_new_field = Some(data);
}
```

**Adding UI Components:**
```rust
// Widgets are stateless - they borrow data and render
pub struct MyWidget<'a> {
    data: &'a str,  // Borrow from AppState
}

impl<'a> Widget for MyWidget<'a> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        // Draw to buffer - widget is consumed
    }
}
```

### Key Files to Read First

Before making changes, understand these foundational files:

| File | Purpose | Read When |
|------|---------|-----------|
| `state.rs` | Central `AppState` struct with all mutable state | Adding any new state or modifying state handling |
| `app.rs` | Main event loop, keyboard handling, modal management | Adding modals, changing input handling |
| `tools/registry.rs` | Tool definitions, schemas, execution dispatch | Adding or modifying tools |
| `agent/native.rs` | Agent lifecycle, tool handling, provider orchestration | Changing agent behavior |
| `agent/protocol.rs` | `FromAgent` enum - all agent→UI events | Adding new agent events |
| `session/manager.rs` | Session CRUD, `SessionInfo` struct | Working with sessions |
| `session/entries.rs` | JSONL entry types (`SessionEntry`, `ThinkingLevel`, etc.) | Modifying session format |
| `components/message.rs` | Chat UI widgets (`ChatView`, `MessageWidget`, etc.) | Changing message rendering |

## Module Guide

### `app.rs` - Main Application
- Event loop, keyboard handling, modal management
- `App::run()` is the main entry point
- `App::render()` draws the UI and positions cursor

### `components/` - UI Widgets
All widgets implement ratatui's `Widget` trait.

- **`message.rs`**: `ChatView`, `ChatInputWidget`, `MessageWidget`, `StatusBarWidget`
- **`approval.rs`**: `ApprovalModal`, `ApprovalController` for tool approval flow
- **`command_palette.rs`**: Ctrl+P command search modal
- **`file_search.rs`**: `@` file search modal
- **`session_switcher.rs`**: Ctrl+O session browser
- **`textarea.rs`**: Text input with cursor positioning (from Codex)

### `commands/` - Slash Commands
- **`registry.rs`**: Command registration and lookup
- **`matcher.rs`**: Fuzzy matching, scoring, tab completion (`SlashCommandMatcher`, `SlashCycleState`)
- **`types.rs`**: `Command`, `CommandContext` definitions

### `agent/` - Native Agent Runtime
- **`native.rs`**: Main agent loop, tool handling, provider orchestration
- **`protocol.rs`**: Internal message/event types for agent state and streaming

### `session/` - Persistence
- **`manager.rs`**: `SessionManager` lists/loads sessions
- **`reader.rs`**: Parses JSONL session files
- **`writer.rs`**: Writes session entries

### `terminal/` - Terminal Setup
- **`setup.rs`**: Raw mode, alternate screen, mouse capture
- **`history.rs`**: Scrollback buffer management

### `state.rs` - Application State
`AppState` holds all UI state: messages, input, cursor, busy flag, etc.

## Common Tasks

### Adding a New Slash Command

1. Add command definition in `commands/registry.rs`:
```rust
Command::new("mycommand", "Description")
    .alias("mc")
    .handler(|ctx| {
        // Implementation
        Ok(())
    })
```

2. Register in `build_command_registry()` function

### Adding a New Modal

1. Create component in `components/my_modal.rs`
2. Add variant to `ActiveModal` enum in `app.rs`
3. Add field to `App` struct
4. Handle in `App::handle_key_event()` and `App::render()`

### Cursor Positioning

Cursor position is calculated in the widget and set via `frame.set_cursor_position()`:

```rust
// In render method
use unicode_width::UnicodeWidthStr;
let col = text[..cursor_pos].width() as u16;
frame.set_cursor_position((area.x + 1 + col, area.y + 1));
```

## Testing

```bash
# Run all tests
cargo test

# Run specific test
cargo test test_name

# Run tests for a module
cargo test commands::
```

## Code Style

- Use `rustfmt` defaults
- Prefer explicit error handling over `.unwrap()`
- Document public APIs with `///` doc comments
- Keep widgets stateless when possible (pass data as constructor args)

## Dependencies

Key crates:
- `ratatui` - Terminal UI framework
- `crossterm` - Cross-platform terminal manipulation
- `unicode-width` - Proper character width calculation
- `textwrap` - Text wrapping
- `serde`/`serde_json` - JSON serialization
- `chrono` - Time handling

## Debugging

```bash
# Build with debug symbols
cargo build

# Run with RUST_BACKTRACE
RUST_BACKTRACE=1 ./target/debug/composer-tui

# Log to file (if logging is enabled)
RUST_LOG=debug ./target/debug/composer-tui 2> debug.log
```

## Known Issues / TODOs

1. Multi-line input doesn't fully support cursor movement across wrapped lines yet
2. Headless protocol integration is partial
3. MCP support exists, but parity and UX with the TypeScript surfaces is still evolving
4. Some dead code warnings for future features (textarea.rs utilities)
