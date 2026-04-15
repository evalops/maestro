# Context Management System Design

The context management system provides dynamic, extensible system prompt augmentation. It collects context from multiple sources, applies timeouts, and injects relevant information into each LLM request.

## Overview

Context sources provide environment-aware information to the LLM:

- **Todo List**: Current task tracking state
- **Background Tasks**: Running shell processes
- **LSP Diagnostics**: Language server errors/warnings
- **Framework Preferences**: User's preferred tools/frameworks
- **Custom Sources**: Extensible for additional context

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                     AgentContextManager                              │
│                                                                      │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐           │
│  │ TodoContext   │  │ BackgroundTask│  │ LSPContext    │ ...       │
│  │ Source        │  │ ContextSource │  │ Source        │           │
│  └───────┬───────┘  └───────┬───────┘  └───────┬───────┘           │
│          │                  │                  │                    │
│          │     Parallel Execution with Timeouts                     │
│          ▼                  ▼                  ▼                    │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                  Promise.all() with Timeout                  │   │
│  │  - sourceTimeoutMs: 1500 (default)                          │   │
│  │  - maxCharsPerSource: 4000 (default)                        │   │
│  │  - enabledSources: optional filter                          │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                              │                                      │
│                              ▼                                      │
│                    ┌────────────────────┐                          │
│                    │ Combined Prompt    │                          │
│                    │ (joined sections)  │                          │
│                    └────────────────────┘                          │
└─────────────────────────────────────────────────────────────────────┘
```

## Context Source Interface

```typescript
// src/agent/context-manager.ts:36-41
interface AgentContextSource {
  name: string;
  getSystemPromptAdditions(options?: {
    signal?: AbortSignal
  }): Promise<string | null>;
}
```

### Implementation Example

```typescript
class TodoContextSource implements AgentContextSource {
  name = "todo";

  async getSystemPromptAdditions({ signal }) {
    if (signal?.aborted) return null;

    const todos = await this.loadTodos();
    if (!todos.length) return null;

    return `## Current Tasks\n${todos.map(t => `- ${t}`).join("\n")}`;
  }
}
```

## Context Manager Configuration

```typescript
// src/agent/context-manager.ts:43-47
interface AgentContextOptions {
  sourceTimeoutMs?: number;      // Default: 1500ms
  maxCharsPerSource?: number;    // Default: 4000 chars
  enabledSources?: string[] | null;  // Filter by name
}
```

## Load Status Tracking

Each source reports detailed status:

```typescript
// src/agent/context-manager.ts:49-57
interface SourceLoadStatus {
  name: string;
  status: "success" | "timeout" | "error" | "skipped" | "empty";
  durationMs: number;
  error?: string;
  truncated?: boolean;
  originalLength?: number;
}
```

## Context Load Result

```typescript
// src/agent/context-manager.ts:59-66
interface ContextLoadResult {
  prompt: string;                    // Combined prompt text
  sourceStatuses: SourceLoadStatus[];  // Status per source
  totalDurationMs: number;           // Total load time
  successCount: number;              // Sources that succeeded
  failureCount: number;              // Sources that failed/timed out
}
```

## Execution Flow

```
getCombinedSystemPrompt() called
           │
           ▼
┌────────────────────────────────────────┐
│ For each registered source (parallel): │
│                                        │
│   1. Check if source is enabled        │
│   2. Create AbortController            │
│   3. Start timer                       │
│   4. Call getSystemPromptAdditions()   │
│   5. Race against timeout              │
│   6. Truncate if over limit            │
│   7. Record status                     │
└────────────────────────────────────────┘
           │
           ▼
┌────────────────────────────────────────┐
│ Aggregate results:                     │
│                                        │
│   - Filter out null/empty results      │
│   - Join with double newlines          │
│   - Log failures for debugging         │
│   - Return combined prompt + status    │
└────────────────────────────────────────┘
```

## Timeout Handling

```typescript
// src/agent/context-manager.ts:260-280
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  controller: AbortController,
  sourceName: string
): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          // Signal abort to the source
          controller.abort(new ContextTimeoutError(sourceName, timeoutMs));
          reject(new ContextTimeoutError(sourceName, timeoutMs));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}
```

## Content Truncation

```typescript
// src/agent/context-manager.ts:282-290
function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;

  const suffix = `\n\n[truncated ${value.length - maxChars} chars]`;
  const available = Math.max(0, maxChars - suffix.length);
  const head = available > 0 ? value.slice(0, available) : "";

  return `${head}${suffix}`;
}
```

## Slow Source Warning

Sources that take >80% of timeout are logged as warnings:

```typescript
// src/agent/context-manager.ts:147-155
if (durationMs > this.options.sourceTimeoutMs * 0.8) {
  logger.warn(`Context source '${source.name}' is slow`, {
    durationMs,
    timeoutMs: this.options.sourceTimeoutMs,
    percentOfTimeout: Math.round(
      (durationMs / this.options.sourceTimeoutMs) * 100
    )
  });
}
```

## Custom Error Types

```typescript
// src/agent/context-manager.ts:8-34
class ContextTimeoutError extends Error {
  readonly sourceName: string;
  readonly timeoutMs: number;

  constructor(sourceName: string, timeoutMs: number) {
    super(`Context source '${sourceName}' timed out after ${timeoutMs}ms`);
    this.name = "ContextTimeoutError";
    this.sourceName = sourceName;
    this.timeoutMs = timeoutMs;
  }
}

class ContextSourceError extends Error {
  readonly sourceName: string;
  readonly cause: Error | unknown;

  constructor(sourceName: string, cause: Error | unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`Context source '${sourceName}' failed: ${message}`);
    this.name = "ContextSourceError";
    this.sourceName = sourceName;
    this.cause = cause;
  }
}
```

## Source Management

```typescript
// src/agent/context-manager.ts:80-82
addSource(source: AgentContextSource): void {
  this.sources.push(source);
}

// Get list of registered source names
getSourceNames(): string[] {
  return this.sources.map(s => s.name);
}

// Check if a source is enabled
isSourceEnabled(name: string): boolean {
  if (!this.options.enabledSources) return true;
  return this.options.enabledSources.includes(name);
}
```

## Agent Integration

The Agent uses the context manager before each prompt:

```typescript
// src/agent/agent.ts:688-700
let systemPrompt = this._state.systemPrompt;

try {
  const contextAdditions = await this.contextManager.getCombinedSystemPrompt();
  if (contextAdditions) {
    systemPrompt += `\n\n${contextAdditions}`;
  }
} catch (error) {
  logger.warn("Failed to inject environmental context", {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined
  });
}
```

## Built-in Context Sources

### TodoContextSource

Provides current todo list items:

```
## Current Tasks
- [in_progress] Implement user authentication
- [pending] Add unit tests for auth module
- [completed] Set up project structure
```

### BackgroundTaskContextSource

Provides running background task information:

```
## Background Tasks
- Shell #1 (running): npm run dev
- Shell #2 (completed): npm test
```

### LspContextSource

Provides language server diagnostics:

```
## Diagnostics
### src/auth/login.ts
- Line 42: Type 'string' is not assignable to type 'number' (error)
- Line 58: 'user' is declared but never used (warning)
```

### FrameworkPreferenceContext

Provides user's framework preferences:

```
## Framework Preferences
- Testing: vitest
- Styling: tailwind
- State management: zustand
```

## Performance Considerations

1. **Parallel Execution**: All sources run concurrently
2. **Individual Timeouts**: Slow sources don't block others
3. **Graceful Degradation**: Failed sources are logged but don't prevent operation
4. **Truncation**: Large outputs are truncated to prevent token overflow
5. **Caching**: Sources can implement internal caching

## Status Monitoring

The detailed status API enables monitoring:

```typescript
const result = await contextManager.getCombinedSystemPromptWithStatus();

console.log("Context load summary:");
console.log(`  Total time: ${result.totalDurationMs}ms`);
console.log(`  Success: ${result.successCount}`);
console.log(`  Failed: ${result.failureCount}`);

for (const status of result.sourceStatuses) {
  console.log(`  ${status.name}: ${status.status} (${status.durationMs}ms)`);
  if (status.truncated) {
    console.log(`    Truncated from ${status.originalLength} chars`);
  }
  if (status.error) {
    console.log(`    Error: ${status.error}`);
  }
}
```

## Source Filtering

Filter sources by name for specific use cases:

```typescript
// Only enable todo and background task sources
const manager = new AgentContextManager({
  enabledSources: ["todo", "background_tasks"]
});

// Or dynamically check
if (manager.isSourceEnabled("lsp")) {
  // LSP context will be included
}
```

## Related Documentation

- [Agent State Machine](AGENT_STATE_MACHINE.md) - How context is injected
- [Hooks System](HOOKS_SYSTEM.md) - Hook-based context injection
- [Telemetry](TELEMETRY_COST.md) - Context source performance tracking
