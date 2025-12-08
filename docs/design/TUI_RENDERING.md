# TUI Rendering Engine Design

The Terminal UI (TUI) is the largest codebase in Composer (~919KB, 147 files), providing an interactive terminal experience with streaming responses, tool visualizations, and modal dialogs.

## Overview

Key capabilities:

- **Differential Rendering**: Efficient screen updates
- **Event-Driven Architecture**: React to agent events in real-time
- **Modal System**: Overlays for approvals, selectors, search
- **Tool Renderers**: Specialized visualization per tool type
- **Command Palette**: Slash commands with autocomplete
- **Session Management**: Session list, switching, branching

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        TUI Architecture                              │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                      TUI Renderer                            │    │
│  │  - Event subscription from Agent                            │    │
│  │  - Screen state management                                  │    │
│  │  - Differential updates                                     │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                              │                                       │
│           ┌──────────────────┼──────────────────┐                   │
│           ▼                  ▼                  ▼                   │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐        │
│  │ Message View   │  │ Tool Output    │  │ Modal Manager  │        │
│  │ - Streaming    │  │ View           │  │ - Approvals    │        │
│  │ - Markdown     │  │ - File diff    │  │ - Selectors    │        │
│  │ - Code blocks  │  │ - Bash output  │  │ - Search       │        │
│  └────────────────┘  └────────────────┘  └────────────────┘        │
│                              │                                       │
│           ┌──────────────────┼──────────────────┐                   │
│           ▼                  ▼                  ▼                   │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐        │
│  │ Command        │  │ Status/Footer  │  │ Session        │        │
│  │ Palette        │  │ - Cost         │  │ Switcher       │        │
│  │ - Autocomplete │  │ - Model        │  │ - List         │        │
│  │ - Hints        │  │ - Context      │  │ - Search       │        │
│  └────────────────┘  └────────────────┘  └────────────────┘        │
└─────────────────────────────────────────────────────────────────────┘
```

## Core Components

### TUI Renderer (`src/cli-tui/tui-renderer.ts`)

The main orchestrator for all TUI operations:

```typescript
class TuiRenderer {
  private agent: Agent;
  private uiState: UIState;
  private modalManager: ModalManager;
  private commandPalette: CommandPalette;
  private sessionManager: SessionManager;

  // Agent event subscription
  constructor(agent: Agent) {
    this.agent = agent;
    this.agent.subscribe(this.handleAgentEvent.bind(this));
  }

  // Main event handler
  private handleAgentEvent(event: AgentEvent): void {
    switch (event.type) {
      case "message_start":
        this.startNewMessage(event.message);
        break;
      case "content_block_delta":
        this.appendContent(event.text);
        break;
      case "tool_execution_start":
        this.showToolExecution(event.toolName, event.toolCallId);
        break;
      case "tool_execution_end":
        this.completeToolExecution(event.toolCallId, event.result);
        break;
      case "message_end":
        this.finalizeMessage(event.message);
        break;
    }
  }
}
```

### UI State (`src/cli-tui/ui-state.ts`)

Centralized state management for the TUI:

```typescript
interface UIState {
  // Display mode
  mode: "chat" | "command" | "search" | "modal";

  // Current view
  scrollPosition: number;
  cursorPosition: { x: number; y: number };

  // Input state
  inputBuffer: string;
  inputHistory: string[];
  historyIndex: number;

  // Streaming state
  isStreaming: boolean;
  partialContent: string;

  // Tool execution
  activeToolCalls: Map<string, ToolCallState>;

  // Modal state
  activeModal: Modal | null;
}
```

## Event-Driven Rendering

### Agent Event Flow

```
┌─────────────┐
│ agent_start │ ──→ Clear previous output, show loading
└──────┬──────┘
       │
       ▼
┌──────────────────┐
│ message_start    │ ──→ Create new message block
└────────┬─────────┘
         │
         ▼
┌──────────────────────┐
│ content_block_delta  │ ──→ Append text, re-render (debounced)
└────────┬─────────────┘     Repeat for each chunk
         │
         ▼
┌────────────────────────┐
│ tool_execution_start   │ ──→ Show tool card with spinner
└────────┬───────────────┘
         │
         ▼
┌──────────────────────┐
│ tool_execution_end   │ ──→ Update tool card with result
└────────┬─────────────┘
         │
         ▼
┌──────────────────┐
│ message_update   │ ──→ Update accumulated content
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ message_end      │ ──→ Finalize message, enable input
└────────┬─────────┘
         │
         ▼
┌─────────────┐
│ agent_end   │ ──→ Reset streaming state, show prompt
└─────────────┘
```

### Differential Rendering

The TUI uses differential updates to minimize screen flicker:

```typescript
class DifferentialRenderer {
  private previousScreen: string[][] = [];
  private currentScreen: string[][] = [];

  render(): void {
    const changes = this.computeDiff();

    for (const change of changes) {
      // Move cursor to changed position
      process.stdout.write(`\x1b[${change.y};${change.x}H`);
      // Write new content
      process.stdout.write(change.content);
    }

    this.previousScreen = this.currentScreen;
  }

  private computeDiff(): Change[] {
    const changes: Change[] = [];

    for (let y = 0; y < this.currentScreen.length; y++) {
      for (let x = 0; x < this.currentScreen[y].length; x++) {
        if (this.currentScreen[y][x] !== this.previousScreen[y]?.[x]) {
          changes.push({ x, y, content: this.currentScreen[y][x] });
        }
      }
    }

    return changes;
  }
}
```

## Tool Renderers

### Tool Renderer Registry

```typescript
// src/cli-tui/tool-renderers/
const toolRenderers: Record<string, ToolRenderer> = {
  read: FileReadRenderer,
  write: FileWriteRenderer,
  edit: FileDiffRenderer,
  bash: BashOutputRenderer,
  search: SearchResultRenderer,
  websearch: WebSearchRenderer,
  todo: TodoRenderer,
  // ... more renderers
};

interface ToolRenderer {
  render(toolCall: ToolCall, result: ToolResult): RenderedOutput;
  renderProgress?(toolCall: ToolCall): RenderedOutput;
}
```

### File Diff Renderer

```typescript
class FileDiffRenderer implements ToolRenderer {
  render(toolCall: ToolCall, result: ToolResult): RenderedOutput {
    const { file_path, old_string, new_string } = toolCall.args;

    return {
      header: `📝 Edit: ${file_path}`,
      body: [
        chalk.red(`- ${old_string}`),
        chalk.green(`+ ${new_string}`)
      ].join("\n"),
      footer: result.isError ? chalk.red("Failed") : chalk.green("Success")
    };
  }
}
```

### Bash Output Renderer

```typescript
class BashOutputRenderer implements ToolRenderer {
  render(toolCall: ToolCall, result: ToolResult): RenderedOutput {
    const { command } = toolCall.args;
    const output = result.content[0]?.text ?? "";

    return {
      header: `$ ${command}`,
      body: this.formatOutput(output),
      footer: result.isError ? chalk.red("Exit code: non-zero") : ""
    };
  }

  private formatOutput(output: string): string {
    // Truncate long output
    const MAX_LINES = 50;
    const lines = output.split("\n");
    if (lines.length > MAX_LINES) {
      return lines.slice(0, MAX_LINES).join("\n")
           + `\n... (${lines.length - MAX_LINES} more lines)`;
    }
    return output;
  }
}
```

## Modal System

### Modal Manager

```typescript
// src/cli-tui/modal-manager.ts
class ModalManager {
  private modalStack: Modal[] = [];

  push(modal: Modal): void {
    this.modalStack.push(modal);
    modal.onMount();
    this.render();
  }

  pop(): Modal | undefined {
    const modal = this.modalStack.pop();
    modal?.onUnmount();
    this.render();
    return modal;
  }

  handleInput(key: KeyPress): void {
    const activeModal = this.modalStack[this.modalStack.length - 1];
    activeModal?.handleInput(key);
  }

  private render(): void {
    // Render all modals in stack order (for transparency/layering)
    for (const modal of this.modalStack) {
      modal.render();
    }
  }
}
```

### Approval Modal

```typescript
// src/cli-tui/approval/approval-modal.ts
class ApprovalModal implements Modal {
  private verdict: ActionFirewallVerdict;
  private resolve: (approved: boolean) => void;

  constructor(verdict: ActionFirewallVerdict) {
    this.verdict = verdict;
  }

  render(): void {
    const box = createBox({
      title: "Approval Required",
      width: 60,
      content: [
        `Tool: ${this.verdict.toolName}`,
        `Reason: ${this.verdict.reason}`,
        "",
        "[Y] Approve  [N] Reject  [A] Always allow"
      ]
    });
    console.log(box);
  }

  handleInput(key: KeyPress): void {
    switch (key.name) {
      case "y":
        this.resolve(true);
        break;
      case "n":
        this.resolve(false);
        break;
      case "a":
        // Add to allowlist
        this.resolve(true);
        break;
    }
  }
}
```

## Command Palette

### Command Registry

```typescript
// src/cli-tui/utils/commands/command-registry-builder.ts
interface Command {
  name: string;
  description: string;
  aliases?: string[];
  handler: (args: string[]) => Promise<void>;
}

const commands: Command[] = [
  { name: "clear", description: "Clear conversation", handler: clearHandler },
  { name: "model", description: "Switch model", handler: modelHandler },
  { name: "session", description: "Session management", handler: sessionHandler },
  { name: "help", description: "Show help", handler: helpHandler },
  // ... many more
];
```

### Autocomplete Provider

```typescript
// src/cli-tui/smart-autocomplete-provider.ts
class SmartAutocompleteProvider {
  getSuggestions(input: string): Suggestion[] {
    if (!input.startsWith("/")) {
      return [];
    }

    const query = input.slice(1).toLowerCase();
    return commands
      .filter(cmd =>
        cmd.name.toLowerCase().startsWith(query) ||
        cmd.aliases?.some(a => a.toLowerCase().startsWith(query))
      )
      .map(cmd => ({
        text: `/${cmd.name}`,
        description: cmd.description
      }));
  }
}
```

### Slash Hint Bar

```typescript
// src/cli-tui/utils/commands/slash-hint-bar.ts
class SlashHintBar {
  render(input: string, suggestions: Suggestion[]): string {
    if (suggestions.length === 0) return "";

    return suggestions
      .slice(0, 5)
      .map((s, i) => i === 0
        ? chalk.inverse(s.text)
        : chalk.dim(s.text)
      )
      .join("  ");
  }
}
```

## Session UI

### Session List

```typescript
// src/cli-tui/session/session-list.ts
class SessionList {
  private sessions: SessionMetadata[] = [];
  private selectedIndex = 0;

  async load(): Promise<void> {
    this.sessions = await this.sessionManager.loadAllSessions();
  }

  render(): string[] {
    return this.sessions.map((session, i) => {
      const selected = i === this.selectedIndex;
      const prefix = selected ? ">" : " ";
      const star = session.favorite ? "★" : " ";
      const date = formatDate(session.modified);

      return `${prefix} ${star} ${date} - ${session.summary}`;
    });
  }

  handleInput(key: KeyPress): void {
    switch (key.name) {
      case "up":
        this.selectedIndex = Math.max(0, this.selectedIndex - 1);
        break;
      case "down":
        this.selectedIndex = Math.min(
          this.sessions.length - 1,
          this.selectedIndex + 1
        );
        break;
      case "enter":
        this.loadSession(this.sessions[this.selectedIndex]);
        break;
    }
  }
}
```

### Session Switcher

```typescript
// src/cli-tui/session/session-switcher.ts
class SessionSwitcher {
  private searchQuery = "";
  private filteredSessions: SessionMetadata[] = [];

  filterSessions(query: string): void {
    this.searchQuery = query;
    this.filteredSessions = this.sessions.filter(session =>
      session.summary.toLowerCase().includes(query.toLowerCase()) ||
      session.allMessagesText.toLowerCase().includes(query.toLowerCase())
    );
  }
}
```

## Footer & Status

### Footer Component

```typescript
// src/cli-tui/footer.ts
class Footer {
  render(state: UIState): string {
    const parts = [
      this.renderModelInfo(),
      this.renderCostInfo(),
      this.renderContextInfo(),
      this.renderShortcuts()
    ];

    return parts.filter(Boolean).join(" │ ");
  }

  private renderModelInfo(): string {
    return `Model: ${this.agent.state.model.name}`;
  }

  private renderCostInfo(): string {
    return `Cost: $${this.telemetry.totalCost.toFixed(4)}`;
  }

  private renderContextInfo(): string {
    const usage = this.contextTracker.getUsage();
    return `Context: ${usage.current}/${usage.max}`;
  }

  private renderShortcuts(): string {
    return "Ctrl+C: Abort │ Ctrl+L: Clear │ /help";
  }
}
```

## Search Interface

### File Search

```typescript
// src/cli-tui/search/file-search.ts
class FileSearch {
  private query = "";
  private results: SearchResult[] = [];
  private selectedIndex = 0;

  async search(query: string): Promise<void> {
    this.query = query;
    this.results = await glob(query, { cwd: process.cwd() });
  }

  render(): string[] {
    const header = `Search: ${this.query}`;
    const results = this.results.map((r, i) =>
      i === this.selectedIndex ? chalk.inverse(r.path) : r.path
    );
    const footer = `${this.results.length} results`;

    return [header, ...results, footer];
  }
}
```

## Input Handling

### Interrupt Controller

```typescript
// src/cli-tui/interrupt-controller.ts
class InterruptController {
  private interruptCount = 0;
  private lastInterruptTime = 0;

  handleInterrupt(): void {
    const now = Date.now();
    const timeSinceLastInterrupt = now - this.lastInterruptTime;

    if (timeSinceLastInterrupt < 500) {
      // Double Ctrl+C - force abort
      this.interruptCount++;
    } else {
      this.interruptCount = 1;
    }

    this.lastInterruptTime = now;

    if (this.interruptCount >= 2) {
      // Hard exit
      process.exit(0);
    } else {
      // Soft abort - keep partial
      this.agent.abortAndKeepPartial();
    }
  }
}
```

### Paste Handler

```typescript
// src/cli-tui/paste/
class PasteHandler {
  detectMultilinePaste(input: string): boolean {
    return input.includes("\n") || input.length > 100;
  }

  handleMultilinePaste(input: string): void {
    // Show confirmation dialog for large pastes
    if (input.length > 10000) {
      this.showPasteConfirmation(input);
    } else {
      this.insertMultiline(input);
    }
  }
}
```

## Performance Optimization

1. **Debounced Rendering**: Content updates batched every 16ms
2. **Viewport Culling**: Only render visible lines
3. **Lazy Loading**: Load session list on demand
4. **String Interning**: Reuse common strings
5. **ANSI Escape Caching**: Cache formatted strings

```typescript
// Debounced render
const debouncedRender = debounce(() => {
  this.render();
}, 16); // ~60fps

// On content update
handleContentDelta(text: string): void {
  this.partialContent += text;
  debouncedRender();
}
```

## Related Documentation

- [Agent State Machine](AGENT_STATE_MACHINE.md) - Event source for TUI
- [Session Persistence](SESSION_PERSISTENCE.md) - Session UI data source
- [Safety & Firewall](SAFETY_FIREWALL.md) - Approval modal integration
