# Composer TUI (Rust)

Native terminal UI for Composer, built with Rust using ratatui and crossterm. Inspired by [OpenAI Codex TUI](https://github.com/openai/codex/tree/main/codex-rs).

## Why Rust?

The TypeScript TUI has limitations with SSH sessions where content that scrolls above the viewport becomes inaccessible. This Rust implementation:

1. **Native terminal scrollback**: Pushes content into the terminal's scrollback buffer using ANSI scroll regions (DECSTBM), persisting even over SSH
2. **Differential rendering**: Only sends changed cells, minimizing bytes over slow connections
3. **Native performance**: Rust + crossterm provides reliable terminal handling
4. **Standalone binary**: Single executable with native AI provider integrations - no Node.js runtime required

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Rust TUI Binary (ratatui + crossterm)          │
│  - Native AI client (Anthropic, OpenAI)         │
│  - Tool execution (bash, read, write, etc.)     │
│  - Native terminal rendering                    │
│  - Input handling & key events                  │
│  - Modal system (file search, commands, etc)    │
│  - Session management                           │
│  - Theme support                                │
└─────────────────────────────────────────────────┘
```

This is a **pure Rust implementation** - no subprocess communication, no Node.js dependency.

## Features

- **Native AI Integration**: Direct API calls to Anthropic (Claude) and OpenAI (GPT)
- **Tool Execution**: bash, read, write, edit, glob, grep - all native Rust
- **Chat Interface**: Message rendering with markdown support, syntax highlighting
- **Extended Thinking**: Support for Claude's extended thinking mode (`/thinking`)
- **Slash Commands**: `/help`, `/clear`, `/theme`, `/model`, `/thinking`, `/zen`, etc.
- **Command Palette**: Ctrl+P for fuzzy command search
- **File Search Modal**: `@` for fuzzy file search with workspace indexing
- **Session Management**: Ctrl+O to browse/switch sessions, auto-save
- **Tool Approval**: Interactive approve/deny for tool calls (`/approvals`)
- **Themes**: Built-in themes with custom theme support
- **Multi-line Input**: Shift+Enter for newlines
- **Clipboard Copy/Paste**: Enable with `cargo build --features clipboard`
- **Native Cursor**: Proper terminal cursor positioning (adapted from Codex)

## Building

```bash
cd packages/tui-rs
cargo build --release
```

The binary will be at `target/release/composer-tui`.

## Running

```bash
# Set your API key
export ANTHROPIC_API_KEY=sk-...
# or
export OPENAI_API_KEY=sk-...

# Run with default settings (uses Claude by default)
./target/release/composer-tui

# Specify a model
./target/release/composer-tui --model gpt-4o
./target/release/composer-tui --model claude-sonnet-4-5-20250514

# Resume last session
./target/release/composer-tui --resume
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key (for Claude models) |
| `OPENAI_API_KEY` | OpenAI API key (for GPT models) |
| `COMPOSER_MODEL` | Override default model |

## Conductor Bridge Helpers

The Rust crate exposes helper types for probing a Composer web server bridge:

```rust
use composer_tui::bridge::fetch_bridge_status;

let status = fetch_bridge_status("http://localhost:8080").await?;
println!("Composer version: {:?}", status.version);
```

This is useful for tooling or diagnostics that need to confirm the bridge is
online before connecting from Conductor.

## Module Structure

```
src/
├── agent/           # Native agent implementation
│   ├── native.rs    # Agent loop, tool handling, AI communication
│   └── protocol.rs  # Message types (FromAgent, ToAgent)
├── ai/              # AI provider clients
│   ├── anthropic.rs # Claude API (Messages API)
│   ├── openai.rs    # OpenAI API (Responses API)
│   └── client.rs    # Unified client interface
├── tools/           # Native tool implementations
│   ├── registry.rs  # Tool definitions and execution
│   └── bash.rs      # Shell command execution
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
├── headless/        # Headless mode for scripting
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
├── syntax.rs        # Syntax highlighting (tree-sitter)
├── diff.rs          # Diff display
└── wrapping.rs      # Text wrapping utilities
```

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Enter` | Send message (steer while running) |
| `Alt+Enter` | Queue follow-up (while running) |
| `Shift+Enter` | Insert newline (multi-line input) |
| `Esc` | Cancel/close modal |
| `Ctrl+C` | Interrupt agent / Quit |
| `Ctrl+P` | Command palette |
| `Ctrl+O` | Session switcher |
| `Ctrl+T` | Toggle last tool call details |
| `Tab` | Toggle thinking / Cycle completions |
| `@` | File search (in input) |
| `/` | Slash command (in input) |
| `↑/↓` | Navigate history/lists |
| `g/G` | Jump to top/bottom |

## Slash Commands

| Command | Description |
|---------|-------------|
| `/help` | Show help |
| `/clear` | Clear conversation |
| `/model [name]` | Change or view model |
| `/thinking [level]` | Set thinking level (off/minimal/low/medium/high/max) |
| `/approvals` | Cycle approval mode (YOLO/Selective/Safe) |
| `/zen` | Toggle zen mode (minimal UI) |
| `/theme [name]` | Change theme |
| `/diag` | Show diagnostics |
| `/compact` | Summarize older messages |
| `/mcp` | Show MCP configuration help |

## Status

**Production-ready features:**
- Native AI integration (Anthropic Claude, OpenAI GPT)
- Full tool suite (bash, read, write, edit, glob, grep)
- Extended thinking support
- Streaming responses
- Slash command system with fuzzy matching
- Modal system (file search, commands, sessions, approval)
- Session persistence and management
- Multi-line input with Shift+Enter
- Theme support
- Native cursor positioning

## Credits

Cursor positioning and text area implementation adapted from [OpenAI Codex](https://github.com/openai/codex) (MIT License).
