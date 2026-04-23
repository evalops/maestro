# TUI Controller Extraction Pattern

Audience: contributors modularizing TuiRenderer or extracting handlers.
Nav: [Patterns Index](./INDEX.md) · [TUI Architecture](../TUI_ARCHITECTURE.md)

## Overview

TuiRenderer started as a monolithic ~3,400 LOC orchestrator. This pattern describes how to extract focused controllers and handlers from it, reducing coupling while preserving functionality.

**Goal**: Transform TuiRenderer from "does everything" to "coordinates everything" by extracting domain logic into focused modules.

## Current Module Structure

```
src/cli-tui/
├── tui-renderer.ts              # Main orchestrator (~2,550 LOC, down from ~3,400)
├── tui-renderer/                # Extracted controllers
│   ├── compaction-controller.ts # Context window compaction
│   ├── slash-hint-controller.ts # Command autocomplete hints
│   ├── custom-commands-controller.ts # /prompts, /commands
│   ├── branch-controller.ts     # Session branching
│   ├── clear-controller.ts      # /clear command
│   ├── ui-state-controller.ts   # UI preferences (zen, clean, footer)
│   ├── quick-settings-controller.ts # Quick settings panel
│   └── *-setup.ts               # Initialization helpers
└── commands/                    # Handler modules
    ├── command-catalog.ts        # Standalone command metadata
    ├── command-suite-catalog.ts  # Parent command-suite metadata
    ├── command-suite-handlers.ts # Command-suite subcommand routing
    ├── subcommands/              # Shared subcommand definitions
    ├── safety-handlers.ts       # /approvals, /plan
    ├── utility-handlers.ts      # /copy, /init, /report
    ├── guardian-handlers.ts     # /guardian
    ├── framework-handlers.ts    # /framework
    ├── otel-handlers.ts         # /otel
    ├── mcp-handlers.ts          # /mcp
    ├── composer-handlers.ts     # /composer config
```

## Two Extraction Approaches

### 1. Controller Classes (Stateful)

Use when the domain logic:
- Maintains internal state (debounce timers, cache, etc.)
- Has lifecycle methods (dispose, attach/detach)
- Needs multiple related methods

**Example: CompactionController**

```typescript
// compaction-controller.ts
export interface CompactionControllerDeps {
  getAgentState: () => AgentState;
  getSessionId: () => string;
  conversationCompactor: { compactHistory: () => Promise<void>; ... };
  autoCompactionMonitor: { check: () => CompactionStats; ... };
  sessionContext: { recordCompactionArtifact: () => void; };
}

export interface CompactionControllerCallbacks {
  showInfo: (message: string) => void;
  refreshFooterHint: () => void;
  setContextWarningLevel: (level: "none" | "warn" | "danger") => void;
}

export class CompactionController {
  private compactionInProgress = false;  // Internal state

  constructor(options: { deps: ...; callbacks: ... }) { ... }

  async handleCompactCommand(instructions?: string): Promise<void> { ... }
  handleAutocompactCommand(rawInput: string): void { ... }
  async ensureContextBudgetBeforePrompt(): Promise<void> { ... }
}
```

**Usage in TuiRenderer:**

```typescript
this.compactionController = new CompactionController({
  deps: {
    getAgentState: () => this.agent.state,
    getSessionId: () => this.sessionManager.getSessionId(),
    conversationCompactor: this.conversationCompactor,
    autoCompactionMonitor: this.autoCompactionMonitor,
    sessionContext: this.sessionContext,
  },
  callbacks: {
    showInfo: (msg) => this.notificationView.showInfo(msg),
    refreshFooterHint: () => this.refreshFooterHint(),
    setContextWarningLevel: (lvl) => this.footer.setContextWarningLevel(lvl),
  },
});
```

### 2. Handler Functions (Stateless)

Use when the logic:
- Is a single-purpose operation
- Has no internal state
- Maps cleanly to a slash command

**Example: safety-handlers.ts**

```typescript
// safety-handlers.ts
export interface ApprovalService {
  setMode(mode: ApprovalMode): void;
  getMode(): ApprovalMode;
  getPendingRequests(): Array<{ toolName: string; reason?: string }>;
}

export interface SafetyHandlerContext {
  showToast: (message: string, type: "success" | "info") => void;
  refreshFooterHint: () => void;
  addContent: (text: string) => void;
  requestRender: () => void;
}

export function handleApprovalsCommand(
  context: CommandExecutionContext,
  approvalService: ApprovalService,
  handlers: SafetyHandlerContext,
): void {
  // Implementation
}

export function handlePlanModeCommand(
  context: CommandExecutionContext,
  handlers: SafetyHandlerContext,
): void {
  // Implementation
}
```

**Usage in TuiRenderer:**

```typescript
// In command registry
handleApprovals: (ctx) =>
  handleApprovalsCommand(ctx, this.approvalService, {
    showToast: (msg, type) => this.notificationView.showToast(msg, type),
    refreshFooterHint: () => this.refreshFooterHint(),
    addContent: (text) => {
      this.chatContainer.addChild(new Spacer(1));
      this.chatContainer.addChild(new Text(text, 1, 0));
    },
    requestRender: () => this.ui.requestRender(),
  }),
```

## Interface Design Principles

### Deps Interface (Dependencies)

Contains services and data sources the controller needs to read from:

```typescript
interface FooDeps {
  getState: () => State;        // Getter for current state
  service: SomeService;          // Service instance
  config: ConfigObject;          // Configuration
}
```

### Callbacks Interface (Effects)

Contains functions for side effects the controller needs to perform:

```typescript
interface FooCallbacks {
  showInfo: (msg: string) => void;    // Display notification
  requestRender: () => void;          // Trigger UI update
  persist: (data: Data) => void;      // Save to storage
}
```

### Context Interface (Command-specific)

For handler functions, pass the CommandExecutionContext plus domain-specific interfaces:

```typescript
function handleFooCommand(
  context: CommandExecutionContext,  // Standard command context
  deps: FooDeps,                      // Domain dependencies
  callbacks: FooCallbacks,           // Side effects
): void
```

## Extraction Checklist

When extracting a handler or controller:

1. **Identify the domain** - What concept does this code handle?
2. **List dependencies** - What does it read from?
3. **List side effects** - What does it modify or notify?
4. **Choose approach** - Stateful controller or stateless handler?
5. **Define interfaces** - Create Deps/Callbacks/Context types
6. **Extract implementation** - Move code to new file
7. **Update TuiRenderer** - Wire up with callbacks
8. **Update command registry** - Point handlers to new implementation
9. **Remove old code** - Delete from TuiRenderer
10. **Clean up imports** - Remove unused imports from TuiRenderer
11. **Run tests** - Verify nothing broke

## What NOT to Extract

Some code should remain in TuiRenderer:

### 1. Coordination Logic

Code that orchestrates multiple systems:

```typescript
private resetConversation(messages, editorSeed, toast, options) {
  // Touches: sessionManager, agent, sessionContext, toolOutputView,
  // chatContainer, scrollContainer, startupContainer, planView,
  // footer, editor, notificationView
  // This is coordination, not domain logic
}
```

### 2. Thin Delegators

One-liner wrappers add no value as separate modules:

```typescript
// Don't extract - already delegates to view
private handleFooterCommand(ctx) {
  this.uiStateController.handleFooterCommand(ctx, { ... });
}
```

### 3. Tightly Coupled State

Code that needs many internal fields:

```typescript
// Needs: isAgentRunning, agent, sessionManager, chatContainer, etc.
private handleNewChatCommand(ctx) {
  if (this.isAgentRunning) { ... }
  this.resetConversation([]);
}
```

## Migration Progress

| Module | Status | Lines Saved | Notes |
|--------|--------|-------------|-------|
| CompactionController | Done | ~100 | Context compaction |
| SlashHintController | Done | ~80 | Command hints |
| CustomCommandsController | Done | ~60 | /prompts, /commands |
| BranchController | Done | ~50 | Session branching |
| ClearController | Done | ~40 | /clear command |
| UiStateController | Done | ~200 | UI preferences |
| SafetyHandlers | Done | ~60 | /approvals, /plan |
| UtilityHandlers | Done | ~60 | /copy, /init, /report |

**Total reduction**: ~3,400 → ~2,550 LOC (~25%)

## Related Files

- `src/cli-tui/tui-renderer.ts` - Main orchestrator
- `src/cli-tui/commands/types.ts` - CommandExecutionContext definition
- `src/cli-tui/utils/commands/command-registry-builder.ts` - Thin wrapper over the catalog-backed registry
- `docs/TUI_ARCHITECTURE.md` - Overall TUI architecture

## Future Work

Potential further extractions:

1. **AgentEventBridge** - Route agent events to views
2. **InputController** - Keyboard handling and editor coordination
3. **SessionStateController** - Session recovery, branching, export
4. **ModalOrchestrator** - Modal lifecycle management

Each would follow the same pattern: identify domain, define interfaces, extract with callbacks.
