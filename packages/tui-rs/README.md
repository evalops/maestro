# Composer TUI (Rust)

Native terminal UI renderer for Composer, built with Rust using ratatui and crossterm.

## Why Rust?

The TypeScript TUI has limitations with SSH sessions where content that scrolls above the viewport becomes inaccessible. This Rust implementation:

1. **Uses native terminal scrollback**: Pushes content into the terminal's scrollback buffer using ANSI scroll regions (DECSTBM), so it persists even over SSH
2. **Differential rendering**: Only sends changed cells, minimizing bytes over slow connections
3. **Native performance**: Rust + crossterm provides reliable terminal handling

## Architecture

```
┌─────────────────────────────────────────────┐
│  TypeScript (business logic, agent, tools)  │
└──────────────────┬──────────────────────────┘
                   │ JSON-RPC (stdin/stdout)
                   ▼
┌─────────────────────────────────────────────┐
│  Rust TUI Binary (ratatui + crossterm)      │
│  - Receives render tree                     │
│  - Sends input events                       │
│  - Handles scrollback natively              │
└─────────────────────────────────────────────┘
```

## Building

```bash
cd packages/tui-rs
cargo build --release
```

The binary will be at `target/release/composer-tui`.

## Protocol

Communication uses newline-delimited JSON (NDJSON) over stdin/stdout.

### Inbound Messages (TypeScript → Rust)

- `render`: Render a component tree
- `push_history`: Push lines into terminal scrollback
- `resize`: Terminal size changed
- `exit`: Shutdown TUI
- `notify`: Desktop notification

### Outbound Messages (Rust → TypeScript)

- `ready`: TUI initialized with size and capabilities
- `key`: Key press event
- `paste`: Bracketed paste event
- `resized`: Terminal resized
- `focus`: Focus gained/lost
- `exiting`: TUI shutting down
- `error`: Error occurred

## Key Components

- `terminal/history.rs`: ANSI scroll region magic for SSH compatibility
- `protocol/`: IPC message types
- `components/`: Ratatui widgets
- `render.rs`: Converts render tree to widgets
- `app.rs`: Main event loop

## Status

This is a scaffold implementation. To integrate with Composer:

1. Add TypeScript launcher that spawns this binary
2. Wire up render tree generation from existing TUI components
3. Handle input events from the Rust side
