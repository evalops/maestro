# Event Suppression Pattern

## Overview

When implementing event-emitting classes, there are cases where internal state changes should not trigger external notifications. This document describes the **silent mode** pattern for handling such scenarios.

## The Problem

Consider a scenario where you need to:
1. Clear internal state
2. Restore it from a snapshot
3. Avoid triggering intermediate event notifications

### Anti-Pattern: Unsubscribe/Resubscribe

```typescript
// ❌ DON'T DO THIS
this.unsubscribe();
this.queue.cancelAll();
this.queue.clearActive();
this.unsubscribe = this.queue.subscribe(...);
```

**Problems:**
- Complex subscription management
- Race conditions if events occur between unsubscribe/resubscribe
- Easy to forget to resubscribe
- Brittle and error-prone

## The Solution: Silent Mode Parameter

```typescript
// ✅ DO THIS
this.queue.cancelAll({ silent: true });
```

### Implementation Pattern

```typescript
interface SilentOptions {
  silent?: boolean;
}

class EventEmittingClass {
  private listeners = new Set<(event: Event) => void>();

  /**
   * Performs an operation that may emit events.
   * @param options.silent - When true, suppresses event emissions.
   *                        Useful for internal state cleanup where
   *                        external notifications are not needed.
   */
  operationName(options?: SilentOptions): Result {
    // Perform state change
    const result = this.performStateChange();
    
    // Conditionally emit events
    if (!options?.silent) {
      this.emit({ type: 'operation', result });
    }
    
    return result;
  }

  private emit(event: Event): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
```

## When to Use Silent Mode

### ✅ Good Use Cases

1. **Internal State Restoration**: When restoring from a snapshot without notifying UI
   ```typescript
   // Restoring queued prompts during interrupt
   queue.cancelAll({ silent: true });
   ```

2. **Batch Operations**: When clearing state and emitting one consolidated event
   ```typescript
   // Example: Clear all items silently, then emit single batch event
   const cancelled = queue.cancelAll({ silent: true });
   this.emit({ type: 'batch_complete', count: cancelled.length });
   ```

3. **Testing/Debugging**: When you want to verify behavior without side effects
   ```typescript
   const cancelled = queue.cancelAll({ silent: true });
   expect(cancelled.length).toBe(3);
   ```

### ❌ When NOT to Use

1. **User-Initiated Actions**: User actions should always emit events
2. **Public API Calls**: External callers expect events
3. **Critical State Changes**: Changes that affect system integrity should notify observers

## Real Example: PromptQueue

See `src/tui/prompt-queue.ts`:

```typescript
/**
 * Cancel all pending prompts in the queue.
 * @param options.silent - When true, suppresses cancel event emissions.
 *                        Useful for internal state cleanup (e.g., interrupt restore)
 *                        where external notifications are not needed.
 * @returns Array of cancelled prompt entries
 */
cancelAll(options?: { silent?: boolean }): QueuedPrompt[] {
  const cancelled = [...this.pending];
  this.pending = [];
  
  if (!options?.silent) {
    for (const entry of cancelled) {
      this.emit({ type: "cancel", entry });
    }
  }
  
  return cancelled;
}
```

**Usage in interrupt restore** (`src/tui/tui-renderer.ts`):
```typescript
// Restore queued prompts without triggering cancel notifications
const snapshot = this.promptQueue.getSnapshot();
this.promptQueue.cancelAll({ silent: true });  // Silent cleanup
this.editor.setText(restoredText);
this.notificationView.showToast("Restored N prompts");  // Single notification
```

## Design Principles

1. **Explicit Over Implicit**: Silent mode should be opt-in via explicit parameter
2. **Document the Why**: Always explain in JSDoc comments when/why silent mode is useful
3. **Maintain Consistency**: Return values should be the same whether silent or not
4. **Test Both Modes**: Write tests for both silent and non-silent behavior

## Testing Pattern

```typescript
describe("EventEmitter with silent mode", () => {
  it("emits events by default", () => {
    const events: Event[] = [];
    emitter.subscribe(e => events.push(e));
    
    emitter.operation();
    expect(events.length).toBe(1);
  });

  it("suppresses events in silent mode", () => {
    const events: Event[] = [];
    emitter.subscribe(e => events.push(e));
    
    emitter.operation({ silent: true });
    expect(events.length).toBe(0);
  });

  it("returns same result in both modes", () => {
    const result1 = emitter.operation();
    const result2 = emitter.operation({ silent: true });
    expect(result1).toEqual(result2);
  });
});
```

## When to Add This Pattern

**Don't add it preemptively.** Only add silent mode when you have a concrete use case where:

1. You're doing internal state cleanup/restoration
2. Events would cause unwanted side effects
3. The alternative (unsubscribe/resubscribe) is demonstrably worse

**Follow the principle: Solve real problems, not hypothetical ones.**

## Potential Future Applications

If similar needs arise elsewhere in the codebase, consider the silent mode pattern for:

- **Builder Pattern**: Suppress events during construction, emit once at `build()`
- **Transaction Pattern**: Batch multiple operations, emit once at commit/rollback
- **Command Pattern**: Silent state restoration during undo/redo operations

_Note: These patterns don't currently use silent mode in this codebase. This section describes potential use cases if the need arises._
