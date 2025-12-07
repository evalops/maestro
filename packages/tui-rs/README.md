# Composer TUI (Rust)

Native terminal UI for Composer, built with Rust using ratatui and crossterm. Inspired by [OpenAI Codex TUI](https://github.com/openai/codex/tree/main/codex-rs).

## Why Rust?

The TypeScript TUI has limitations with SSH sessions where content that scrolls above the viewport becomes inaccessible. This Rust implementation:

1. **Native terminal scrollback**: Pushes content into the terminal's scrollback buffer using ANSI scroll regions (DECSTBM), persisting even over SSH
2. **Differential rendering**: Only sends changed cells, minimizing bytes over slow connections
3. **Native performance**: Rust + crossterm provides reliable terminal handling
4. **Standalone binary**: Single executable, no Node.js runtime required for the UI layer

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Node.js Agent (business logic, AI, tools)      │
│  - Spawned as subprocess                        │
│  - Communicates via JSON-RPC stdin/stdout       │
└──────────────────┬──────────────────────────────┘
                   │ Headless Protocol (NDJSON)
                   ▼
┌─────────────────────────────────────────────────┐
│  Rust TUI Binary (ratatui + crossterm)          │
│  - Native terminal rendering                    │
│  - Input handling & key events                  │
│  - Modal system (file search, commands, etc)    │
│  - Session management                           │
│  - Theme support                                │
└─────────────────────────────────────────────────┘
```

## Features

- **Chat Interface**: Message rendering with markdown support, syntax highlighting
- **Slash Commands**: `/help`, `/clear`, `/theme`, `/model`, `/session`, etc.
- **Command Palette**: Ctrl+P for fuzzy command search
- **File Search Modal**: `@` for fuzzy file search with workspace indexing
- **Session Management**: Ctrl+O to browse/switch sessions, auto-save
- **Tool Approval**: Interactive approve/deny for tool calls
- **Themes**: Built-in themes with custom theme support
- **Native Cursor**: Proper terminal cursor positioning (adapted from Codex)

## Building

```bash
cd packages/tui-rs
cargo build --release
```

The binary will be at `target/release/composer-tui`.

## Running

```bash
# Run with default settings
./target/release/composer-tui

# Specify working directory
./target/release/composer-tui --cwd /path/to/project

# Resume last session
./target/release/composer-tui --resume
```

## Module Structure

```
src/
├── agent/           # Node.js subprocess management
│   ├── process.rs   # Spawns and communicates with agent
│   └── protocol.rs  # Message serialization
├── app.rs           # Main application & event loop
├── commands/        # Slash command system
│   ├── registry.rs  # Command registration
│   ├── matcher.rs   # Fuzzy matching & tab completion
│   └── types.rs     # Command definitions
├── components/      # UI widgets (ratatui)
│   ├── message.rs   # Chat view, input, status bar
│   ├── approval.rs  # Tool approval modal
│   ├── command_palette.rs
│   ├── file_search.rs
│   ├── session_switcher.rs
│   └── textarea.rs  # Text input with cursor (from Codex)
├── files/           # Workspace file indexing
│   ├── workspace.rs # File discovery
│   └── search.rs    # Fuzzy file search
├── headless/        # Headless protocol (future)
├── session/         # Session persistence
│   ├── manager.rs   # List/load/save sessions
│   ├── reader.rs    # JSONL parsing
│   └── writer.rs    # JSONL writing
├── terminal/        # Terminal setup & history
│   ├── setup.rs     # Raw mode, alternate screen
│   └── history.rs   # Scrollback buffer management
├── themes/          # Theme system
├── state.rs         # Application state
├── markdown.rs      # Markdown rendering
├── diff.rs          # Diff display
└── wrapping.rs      # Text wrapping utilities
```

## Headless Protocol

Communication with the Node.js agent uses newline-delimited JSON (NDJSON).

### Agent → TUI Messages

- `ready` - Agent initialized
- `response_chunk` - Streaming text response
- `tool_call` - Tool execution request (requires approval)
- `tool_result` - Tool execution result
- `error` - Error occurred
- `done` - Response complete

### TUI → Agent Messages

- `prompt` - User message
- `tool_response` - Approval decision for tool call
- `cancel` - Cancel current operation

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Enter` | Send message |
| `Esc` | Cancel/close modal |
| `Ctrl+C` | Quit |
| `Ctrl+P` | Command palette |
| `Ctrl+O` | Session switcher |
| `@` | File search (in input) |
| `/` | Slash command (in input) |
| `Tab` | Cycle completions |
| `↑/↓` | Navigate history/lists |

## Status

**Production-ready features:**
- Full chat interface with streaming responses
- Slash command system with fuzzy matching
- Modal system (file search, commands, sessions, approval)
- Session persistence and management
- Theme support
- Native cursor positioning

**In progress:**
- Full headless protocol integration
- MCP server support
- Multi-line input with proper wrapping

## Credits

Cursor positioning and text area implementation adapted from [OpenAI Codex](https://github.com/openai/codex) (MIT License).
