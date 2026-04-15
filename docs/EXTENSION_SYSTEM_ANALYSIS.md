# Extension System Analysis for Issue #851

## Current State (What Maestro Already Has)

### ✅ TypeScript Hook Loading (src/hooks/typescript-loader.ts)
- [x] jiti-based dynamic TypeScript loading (no compilation needed)
- [x] Hook discovery in `~/.maestro/hooks/` and `.maestro/hooks/`
- [x] Extension factory pattern: `export default function(api: HookAPI) { ... }`
- [x] Event handler registration via `api.on(event, handler)`
- [x] Message injection via `api.send()` and `api.sendMessage()`
- [x] Session-persistent state via `api.appendEntry()`
- [x] Custom message renderers via `api.registerMessageRenderer()`
- [x] Slash command registration via `api.registerCommand()`
- [x] UI context for interactive hooks (select, confirm, input, notify, editor)
- [x] Hook timeout handling (30s default)
- [x] Error isolation (hook errors logged but non-fatal)

### ✅ Lifecycle Events (src/hooks/types.ts)
- [x] `PreToolUse` - Before tool execution (can block)
- [x] `PostToolUse` - After successful tool execution
- [x] `PostToolUseFailure` - After tool execution fails
- [x] `EvalGate` - For scoring/assertions
- [x] `SessionStart` / `SessionEnd` - Session lifecycle
- [x] `SubagentStart` / `SubagentStop` - Subagent lifecycle
- [x] `UserPromptSubmit` - When user submits a prompt
- [x] `PreMessage` / `PostMessage` - Before/after LLM messages
- [x] `PreCompact` - Before context compaction
- [x] `PermissionRequest` - When approval is required
- [x] `Notification` - On various notifications
- [x] `OnError` - When an error occurs
- [x] `Overflow` - When context overflow detected
- [x] `Branch` - Session tree navigation

### ✅ Existing HookAPI Methods
```typescript
interface HookAPI {
  on<E extends HookEventType>(event: E, handler: HookHandler): void;
  send(text: string, attachments?: HookAttachment[]): void;
  sendMessage<T>(message: Pick<HookMessage<T>, "customType" | "content" | "display" | "details">, triggerTurn?: boolean): void;
  appendEntry<T>(customType: string, data: T): void;
  registerMessageRenderer<T>(customType: string, renderer: HookMessageRenderer<T>): void;
  registerCommand(name: string, options: {
    description?: string;
    handler: (args: string, ctx: HookCommandContext) => Promise<void>;
  }): void;
}
```

## Missing Features from Issue #851

### ❌ Dynamic Tool Registration
**Requirement**: Extensions should be able to register new tools at runtime
```typescript
api.registerTool({
  name: "my_tool",
  description: "...",
  parameters: Type.Object({ ... }), // TypeBox
  execute: async (id, params, signal, onUpdate) => { ... },
});
```

**Implementation Plan**:
1. Add `registerTool()` method to HookAPI
2. Store registered tools in LoadedTypeScriptHook
3. Inject registered tools into Agent's tool list
4. Handle tool namespacing (e.g., `hook:my_tool` to avoid conflicts)

### ❌ Tool Filtering / Active Tools
**Requirement**: Extensions should be able to control which tools are active
```typescript
api.setActiveTools(["read", "write", "my_tool"]);
```

**Implementation Plan**:
1. Add `setActiveTools()` method to HookAPI
2. Store active tool list in extension context
3. Filter Agent's tools based on active list before each prompt
4. Support wildcard patterns (e.g., `"file:*"` for all file tools)

### ❌ Keyboard Shortcut Registration
**Requirement**: Extensions should be able to register keyboard shortcuts (TUI only)
```typescript
api.registerShortcut(Key.ctrl("m"), {
  description: "Run my command",
  handler: async (ctx) => { ... }
});
```

**Implementation Plan**:
1. Add `registerShortcut()` method to HookAPI
2. Store shortcuts in LoadedTypeScriptHook
3. Integrate with TUI's key handler
4. Support Key builder API (Key.ctrl(), Key.alt(), Key.meta())

### ⚠️ Event Lifecycle Ordering
**From Issue**: `tool_call` event should fire AFTER `message_end`
**Current State**: Need to verify event ordering in transport.ts
**Action**: Audit current event sequence and document/fix if needed

### ⚠️ Tool Result Chaining
**From Issue**: `tool_result` handlers should chain like middleware
**Current State**: Hook handlers execute sequentially
**Action**: Verify handlers can modify tool results and pass to next handler

## Implementation Priority

### Phase 1: Dynamic Tool Registration (HIGH)
- Most requested feature
- Enables custom tools without forking
- Foundation for ecosystem growth

### Phase 2: Tool Filtering (MEDIUM)
- Useful for permission gating
- Allows extensions to restrict tool usage
- Complements safety features

### Phase 3: Keyboard Shortcuts (LOW)
- TUI-only feature
- Nice-to-have for power users
- Can be added later without breaking changes

## Testing Strategy

### Unit Tests
- Test tool registration and retrieval
- Test tool filtering logic
- Test shortcut registration
- Test event handler chaining

### Integration Tests
- Load extension that registers a tool
- Execute registered tool from agent
- Filter tools and verify only allowed tools available
- Test tool result modification via hooks

### Example Extensions (for docs/examples)
1. **permission-gate.ts** - Blocks dangerous bash commands
2. **git-checkpoint.ts** - Auto-commits before destructive ops
3. **custom-search.ts** - Registers a custom search tool
4. **keyboard-macro.ts** - Registers keyboard shortcuts

## Documentation Needed

1. Extension development guide (docs/EXTENSIONS.md)
2. HookAPI reference documentation
3. Example extensions with comments
4. Migration guide from hooks.json to extensions
5. Best practices for extension development

## Breaking Changes

**None expected** - This is purely additive:
- Existing hooks.json configs continue to work
- Existing TypeScript hooks continue to work
- New API methods are optional additions to HookAPI
