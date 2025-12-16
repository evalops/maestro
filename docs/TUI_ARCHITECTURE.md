# TUI Architecture

This document describes the architecture of Composer's Terminal User Interface, covering both the reusable `@evalops/tui` library and the Composer-specific application layer.

## Overview

The TUI is split into two layers:

```
┌─────────────────────────────────────────────────────────────────────┐
│                    src/cli-tui/ (Application Layer)                  │
│         Composer-specific UI: views, commands, agent integration     │
├─────────────────────────────────────────────────────────────────────┤
│                    packages/tui/ (Library Layer)                     │
│         Reusable: rendering engine, components, terminal abstraction │
└─────────────────────────────────────────────────────────────────────┘
```

- **`packages/tui/`** (~3,400 LOC) - A portable terminal UI library with differential rendering
- **`src/cli-tui/`** (~2,550 LOC main + extracted modules, 100+ files) - Composer's UI built on top of the library

## Library Layer (`@evalops/tui`)

### Component Interface

All components implement a minimal interface:

```typescript
interface Component {
  render(width: number): string[];     // Return lines to display
  handleInput?(data: string): void;    // Optional keyboard handling
  invalidate?(): void;                 // Clear cached state
}
```

Components return an array of strings, each representing a terminal line. The TUI handles wrapping, diffing, and output.

### Built-in Components

| Component | Purpose |
|-----------|---------|
| `Text` | Static or styled text with word wrapping |
| `Editor` | Multi-line text input with cursor, selection, history |
| `Input` | Single-line text input |
| `SelectList` | Arrow-key navigable list with selection |
| `Markdown` | Renders markdown with syntax highlighting |
| `Loader` | Animated spinner with status text |
| `ScrollContainer` | Viewport with scroll position management |
| `Box` | Padding, margins, borders |
| `Column` / `Row` | Vertical/horizontal layout |

### Differential Rendering Pipeline

The core innovation is differential rendering - only changed lines are redrawn:

```
┌──────────────────────────────────────────────────────────────────┐
│ 1. RENDER: Components produce string[] lines                      │
├──────────────────────────────────────────────────────────────────┤
│ 2. WRAP: Lines wrapped to terminal width (cached per width)       │
├──────────────────────────────────────────────────────────────────┤
│ 3. CLIP: If lines > viewport height, keep bottom N (overflow)     │
├──────────────────────────────────────────────────────────────────┤
│ 4. DIFF: Compare newLines vs previousLines                        │
├──────────────────────────────────────────────────────────────────┤
│ 5. OUTPUT: Choose strategy based on what changed                  │
│    - First render: write all lines                                │
│    - Full re-render: clear screen + write all                     │
│    - Differential: move cursor, update only changed lines         │
└──────────────────────────────────────────────────────────────────┘
```

### Render Strategy Selection

```typescript
// Full re-render required when:
const shouldFullRender =
  widthChanged ||           // Terminal resized horizontally
  overflowChanged ||        // Went from non-clipped to clipped (or vice versa)
  lineCountDecreased;       // Fewer lines than before (stale content)
```

**Critical Invariant**: When overflow state changes, line indices shift. `previousLines[0]` might have been "actual line 0" but `newLines[0]` is now "actual line 5" after clipping. Differential rendering would compare wrong content, so we must do a full re-render.

### Terminal Abstraction

```typescript
interface Terminal {
  start(onInput, onResize): void;  // Initialize raw mode
  stop(): void;                     // Restore terminal
  write(data: string): void;        // Raw output
  columns: number;                  // Terminal width
  rows: number;                     // Terminal height
  // ... cursor control, screen clearing
}
```

`ProcessTerminal` implements this for Node.js. Mock implementations enable testing.

### SSH/tmux Optimizations

The TUI detects remote sessions and adjusts behavior:

```typescript
const features = detectTerminalFeatures();

if (features.overSsh) {
  // Disable synchronized output (causes "typed in waves")
  // Increase render throttle to 48ms (reduce repaint storms)
}
```

Detection checks: `SSH_CONNECTION`, `SSH_CLIENT`, `TMUX`, `STY`, `MOSH_*`

### Synchronized Output (DECSET 2026)

When supported, renders are wrapped in sync markers to prevent tearing:

```
\x1b[?2026h  ← Begin synchronized update
... render content ...
\x1b[?2026l  ← End synchronized update
```

The terminal buffers all output until the end marker, then paints atomically.

### Wrap Cache

Line wrapping (handling ANSI codes, Unicode, word boundaries) is expensive. Results are cached:

```typescript
// Cache structure: Map<width, Map<lineContent, wrappedLines[]>>
private wrapCache = new Map<number, Map<string, string[]>>();

// Limits:
// - 500 entries per width
// - Only 3 most recent widths kept
```

## Application Layer (`src/cli-tui/`)

### Key Subsystems

| Directory/File | Purpose |
|----------------|---------|
| `tui-renderer.ts` | Main orchestrator (~2,550 LOC) |
| `tui-renderer/*.ts` | Extracted controllers + setup modules |
| `commands/` | Slash command handling + extracted handlers |
| `commands/grouped/` | Grouped subcommand handlers (/sess, /dx, etc.) |
| `selectors/` | Modal selection UIs (theme, model, etc.) |
| `session/` | Session management views |
| `approval/` | Tool approval modal |
| `loader/` | Startup loader with stages |
| `status/` | Cost, quota, diagnostics views |

### TuiRenderer

The main orchestrator (~2,550 LOC, down from ~3,400) that:
- Creates the TUI instance and terminal
- Manages 40+ specialized views
- Handles slash command dispatch
- Coordinates with the Agent
- Manages modal stack

```typescript
class TuiRenderer {
  private tui: TUI;
  private scrollContainer: ScrollContainer;
  private modalManager: ModalManager;
  private editor: CustomEditor;
  // ... 40+ view instances
  // ... extracted controllers
}
```

### Extracted Controllers

Domain logic has been extracted from TuiRenderer into focused modules:

| Controller | File | Purpose |
|------------|------|---------|
| CompactionController | `tui-renderer/compaction-controller.ts` | Context window compaction |
| SlashHintController | `tui-renderer/slash-hint-controller.ts` | Command autocomplete hints |
| CustomCommandsController | `tui-renderer/custom-commands-controller.ts` | /prompts, /commands |
| BranchController | `tui-renderer/branch-controller.ts` | Session branching |
| ClearController | `tui-renderer/clear-controller.ts` | /clear command |
| UiStateController | `tui-renderer/ui-state-controller.ts` | UI preferences |

### Handler Modules

Stateless command handlers live in `commands/`:

| Handler | File | Commands |
|---------|------|----------|
| SafetyHandlers | `commands/safety-handlers.ts` | /approvals, /plan |
| UtilityHandlers | `commands/utility-handlers.ts` | /copy, /init, /report |
| GuardianHandlers | `commands/guardian-handlers.ts` | /guardian |
| FrameworkHandlers | `commands/framework-handlers.ts` | /framework |
| OtelHandlers | `commands/otel-handlers.ts` | /otel |
| McpHandlers | `commands/mcp-handlers.ts` | /mcp |

See [TUI Controller Extraction Pattern](./patterns/tui-controller-extraction.md) for the extraction methodology.

### Component Hierarchy

```
TUI (root container)
├── ScrollContainer (viewport management)
│   └── messageContainer
│       ├── MessageView (conversation history)
│       ├── StreamingView (current response)
│       ├── ToolExecutionComponent (tool calls)
│       └── LoaderView (startup)
├── Spacer
├── FooterComponent (status line)
└── EditorView (input area)
    └── CustomEditor (with autocomplete)
```

### Modal Stack

Modals (theme selector, approval dialog, etc.) overlay the main content:

```typescript
class ModalManager {
  push(component: Component): void;    // Show modal
  pop(): Component | undefined;        // Dismiss
  replace(component: Component): void; // Swap current
  clear(): void;                       // Dismiss all
}
```

When a modal is active, it receives focus and input. The main content remains rendered but doesn't receive keyboard events.

### Agent Integration

Events flow from Agent to UI via subscription:

```typescript
// In TuiRenderer initialization
agent.on('event', (event: AgentEvent) => {
  agentEventRouter.route(event);
});

// AgentEventRouter dispatches to appropriate views
class AgentEventRouter {
  route(event: AgentEvent) {
    switch (event.type) {
      case 'message': this.messageView.append(event); break;
      case 'tool_call': this.toolView.show(event); break;
      case 'streaming': this.streamingView.update(event); break;
      // ...
    }
  }
}
```

### Slash Commands

Commands are registered in `commands/registry.ts`:

```typescript
// Registration
buildEntry(
  { name: "theme", description: "Change color theme", tags: ["ui"] },
  equals("theme"),
  handlers.theme,
  createContext,
)

// Handler receives context
handleTheme(context: CommandExecutionContext) {
  this.modalManager.push(this.themeSelectorView);
}
```

Commands support:
- Arguments with validation
- Grouped subcommands (`/sess new`, `/sess list`)
- Autocomplete
- Help generation

### Input Flow

```
Keyboard Input
      │
      ▼
Terminal.onInput(data)
      │
      ▼
TUI.handleInput(data)
      │
      ├─── Ctrl+C/Esc? → interruptHandler()
      │
      └─── focusedComponent.handleInput(data)
                  │
                  ▼
           CustomEditor
                  │
                  ├─── Slash command? → dispatch to handler
                  │
                  └─── Normal input → update editor state
```

### Focus Management

Only one component receives input at a time:

```typescript
tui.setFocus(editor);       // Normal mode: editor has focus
tui.setFocus(selectList);   // Modal mode: selector has focus
```

## Key Files Reference

### Library (`packages/tui/src/`)

| File | Purpose |
|------|---------|
| `tui.ts` | TUI class, Container, differential rendering |
| `terminal.ts` | Terminal interface, ProcessTerminal |
| `utils.ts` | ANSI handling, text wrapping, visible width |
| `utils/terminal-features.ts` | SSH/tmux detection |
| `components/editor.ts` | Multi-line editor component |
| `components/scroll-container.ts` | Scrollable viewport |
| `components/select-list.ts` | Selection list |
| `components/markdown.ts` | Markdown renderer |

### Application (`src/cli-tui/`)

| File | Purpose |
|------|---------|
| `tui-renderer.ts` | Main orchestrator |
| `custom-editor.ts` | Editor with Composer-specific bindings |
| `agent-event-router.ts` | Routes agent events to views |
| `modal-manager.ts` | Modal stack management |
| `commands/registry.ts` | Slash command registration |
| `prompt-queue.ts` | Multi-prompt queue handling |

### Extracted Modules (`src/cli-tui/tui-renderer/`)

| File | Purpose |
|------|---------|
| `compaction-controller.ts` | Context window compaction logic |
| `slash-hint-controller.ts` | Command autocomplete and cycling |
| `custom-commands-controller.ts` | User-defined prompts/commands |
| `branch-controller.ts` | Session branching operations |
| `clear-controller.ts` | Conversation clearing |
| `ui-state-controller.ts` | UI preferences (zen, clean, footer) |
| `quick-settings-controller.ts` | Quick settings panel |
| `mcp-events-setup.ts` | MCP event handling setup |

### Handler Modules (`src/cli-tui/commands/`)

| File | Purpose |
|------|---------|
| `safety-handlers.ts` | /approvals, /plan command handlers |
| `utility-handlers.ts` | /copy, /init, /report handlers |
| `guardian-handlers.ts` | /guardian command handler |
| `framework-handlers.ts` | /framework command handler |
| `otel-handlers.ts` | /otel command handler |
| `mcp-handlers.ts` | /mcp command handler |
| `composer-handlers.ts` | /composer config handler |
| `grouped/session-commands.ts` | /sess subcommand routing |
| `grouped/diag-commands.ts` | /dx subcommand routing |

## Performance Characteristics

### Strengths

1. **Differential rendering** - Only changed lines are written
2. **Wrap caching** - Avoids re-processing unchanged lines
3. **Overflow clipping** - Content beyond viewport isn't rendered
4. **SSH throttling** - 48ms minimum between renders over SSH
5. **Interactive priority** - Arrow keys bypass throttle for responsiveness

### Considerations

1. **ScrollContainer history** - Maintains up to 10,000 lines (configurable)
2. **No virtual scrolling** - All history lines are stored in memory
3. **Full re-render on overflow change** - Necessary for correctness

## Testing

The library is testable via mock terminals:

```typescript
import { VirtualTerminal } from "@evalops/tui/testing";

const terminal = new VirtualTerminal(80, 24);
const tui = new TUI(terminal);

// Simulate input
terminal.simulateInput("hello\n");

// Assert rendered output
expect(terminal.getScreen()).toContain("hello");
```

## Extension Points

### Custom Components

Implement the `Component` interface:

```typescript
class MyComponent implements Component {
  render(width: number): string[] {
    return ["Line 1", "Line 2"];
  }

  handleInput(data: string): void {
    // Handle keyboard input when focused
  }
}
```

### Custom Terminal

Implement the `Terminal` interface for different environments (e.g., web terminal, testing).
