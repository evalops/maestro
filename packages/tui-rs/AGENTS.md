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

This is a **native Rust TUI** that spawns a Node.js agent subprocess for AI interactions. The Rust side handles all terminal rendering, input, and UI state.

### Key Design Decisions

1. **Subprocess Architecture**: The TUI spawns `node` to run the agent, communicating via stdin/stdout JSON-RPC. This keeps AI logic in TypeScript while getting native terminal performance.

2. **Cursor Positioning**: Uses native terminal cursor (adapted from OpenAI Codex) rather than inline cursor rendering. See `components/textarea.rs` for the implementation.

3. **Modal System**: Single `ActiveModal` enum in `app.rs` controls which modal is visible. Only one modal can be active at a time.

4. **Session Persistence**: Sessions are JSONL files in `~/.composer/sessions/`. The format matches the TypeScript TUI for compatibility.

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

### `agent/` - Node.js Subprocess
- **`process.rs`**: `AgentProcess` spawns and communicates with the agent
- **`protocol.rs`**: Message types for agent communication

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
3. MCP server support not yet implemented
4. Some dead code warnings for future features (textarea.rs utilities)
