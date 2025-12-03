# Agent State Machine Design

The Agent is the central orchestrator for all LLM interactions in Composer. It implements an event-driven architecture that enables real-time streaming, concurrent tool execution, and extensible transport layers.

## Overview

The Agent class (`src/agent/agent.ts`) manages:

- **Conversation State**: Message history, model selection, tools
- **Streaming**: Real-time response delivery via events
- **Tool Execution**: Coordinated execution of LLM-requested operations
- **Provider Abstraction**: Unified interface across LLM providers
- **Context Injection**: Dynamic system prompt augmentation

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              Agent                                       │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────────────────────┐ │
│  │   State     │  │  Transport   │  │     Context Sources             │ │
│  │ - messages  │  │ - Anthropic  │  │ - TodoContextSource             │ │
│  │ - model     │  │ - OpenAI     │  │ - BackgroundTaskContextSource   │ │
│  │ - tools     │  │ - Google     │  │ - LspContextSource              │ │
│  │ - streaming │  │ - Custom     │  │ - FrameworkPreferenceContext    │ │
│  └─────────────┘  └──────────────┘  └─────────────────────────────────┘ │
│         │                │                         │                     │
│         ▼                ▼                         ▼                     │
│  ┌─────────────────────────────────────────────────────────────────────┐│
│  │                     Event Emitter                                   ││
│  │  message_start, message_update, message_end, tool_execution_*       ││
│  └─────────────────────────────────────────────────────────────────────┘│
│                                 │                                        │
└─────────────────────────────────┼────────────────────────────────────────┘
                                  ▼
                         ┌───────────────────┐
                         │    Subscribers    │
                         │  - TUI Renderer   │
                         │  - Session Mgr    │
                         │  - JSONL Writer   │
                         └───────────────────┘
```

## Agent State

```typescript
// src/agent/types.ts
interface AgentState {
  // Core configuration
  systemPrompt: string;
  model: Model<Api>;
  thinkingLevel: ThinkingLevel;
  tools: AgentTool[];

  // Conversation
  messages: AppMessage[];

  // Streaming state
  isStreaming: boolean;
  streamMessage: AssistantMessage | null;
  pendingToolCalls: Map<string, { toolName: string }>;

  // Optional features
  sandbox?: Sandbox;
  sandboxMode: SandboxMode | null;
  sandboxEnabled: boolean;

  // User context
  user?: { id: string; orgId: string };
  session?: { id: string };

  // Error state
  error?: string;

  // Queue behavior
  queueMode: "all" | "one";
}
```

## Event Flow

When `agent.prompt()` is called, events are emitted in this sequence:

```
┌─────────────┐
│ agent_start │  ← Signals beginning of prompt cycle
└──────┬──────┘
       │
       ▼
┌──────────────────┐
│ message_start    │  ← New assistant message being constructed
└────────┬─────────┘
         │
         ▼
┌──────────────────────┐
│ content_block_delta  │  ← Streaming text/thinking content (repeated)
└────────┬─────────────┘
         │
         ▼
┌────────────────────────┐
│ tool_execution_start   │  ← Tool call initiated (if tools used)
└────────┬───────────────┘
         │
         ▼
┌──────────────────────┐
│ tool_execution_end   │  ← Tool call completed
└────────┬─────────────┘
         │
         ▼
┌──────────────────┐
│ message_update   │  ← Partial message with accumulated content
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ message_end      │  ← Complete assistant message
└────────┬─────────┘
         │
         ▼
┌─────────────┐
│ agent_end   │  ← Prompt cycle completed
└─────────────┘
```

## Message Transformation Pipeline

Messages are transformed before being sent to the LLM:

```
┌─────────────────┐
│  App Messages   │  Internal format with attachments, metadata
└────────┬────────┘
         │
         ▼
┌─────────────────────┐
│ Message Transform   │  Convert attachments to content blocks
│ - Images → base64   │
│ - Docs → text       │
└────────┬────────────┘
         │
         ▼
┌─────────────────────────┐
│ Provider Normalization  │  Adapt to target provider's format
│ - Thinking blocks       │
│ - Tool call format      │
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│ System Prompt Injection │  Add context from context sources
└────────┬────────────────┘
         │
         ▼
┌─────────────────┐
│  LLM Messages   │  Provider-ready format
└─────────────────┘
```

### Default Message Transformer

```typescript
// src/agent/agent.ts:124-178
function defaultMessageTransformer(messages: AppMessage[]): Message[] {
  return messages
    // Filter to roles LLM understands
    .filter(m => ["user", "assistant", "toolResult"].includes(m.role))
    .map(message => {
      if (message.role !== "user") return message;

      // Handle attachments
      const { attachments, ...rest } = message;
      if (!attachments?.length) return rest;

      // Expand attachments into content array
      const content = Array.isArray(rest.content)
        ? [...rest.content]
        : [{ type: "text", text: rest.content }];

      for (const attachment of attachments) {
        if (attachment.type === "image") {
          content.push({
            type: "image",
            data: attachment.content,
            mimeType: attachment.mimeType
          });
        } else if (attachment.type === "document") {
          content.push({
            type: "text",
            text: `\n\n[Document: ${attachment.fileName}]\n${attachment.extractedText}`
          });
        }
      }

      return { ...rest, content };
    });
}
```

### Provider Normalization

When switching between providers mid-session, thinking blocks need conversion:

```typescript
// src/agent/agent.ts:228-250
function normalizeMessagesForProvider(
  messages: Message[],
  targetModel: Model<Api>
): Message[] {
  return messages.map(msg => {
    if (msg.role !== "assistant") return msg;

    // Skip if same provider
    if (msg.provider === targetModel.provider) return msg;

    // Convert thinking blocks to text
    const content = msg.content.map(block => {
      if (block.type === "thinking") {
        return {
          type: "text",
          text: `<thinking>${block.thinking}</thinking>`
        };
      }
      return block;
    });

    return { ...msg, content };
  });
}
```

## Thinking/Reasoning Support

The agent supports extended thinking for compatible models:

| Level | Description | Mapped Effort |
|-------|-------------|---------------|
| `off` | No extended thinking | `undefined` |
| `minimal` | Brief chain-of-thought | `minimal` |
| `low` | Short reasoning steps | `low` |
| `medium` | Moderate reasoning depth | `medium` |
| `high` | Deep reasoning with exploration | `high` |
| `max` | Maximum reasoning effort | `high` |

```typescript
// src/agent/agent.ts:189-205
function mapThinkingLevel(level: ThinkingLevel): ReasoningEffort | undefined {
  switch (level) {
    case "off": return undefined;
    case "minimal": return "minimal";
    case "low": return "low";
    case "medium": return "medium";
    case "high":
    case "max": return "high";
    default: return undefined;
  }
}
```

## Context Sources

The `AgentContextManager` collects context from multiple sources and injects them into the system prompt:

```typescript
// src/agent/context-manager.ts
interface AgentContextSource {
  name: string;
  getSystemPromptAdditions(options?: { signal?: AbortSignal }): Promise<string | null>;
}

// Built-in context sources:
// - TodoContextSource: Current todo list items
// - BackgroundTaskContextSource: Running background tasks
// - LspContextSource: Language server diagnostics
// - FrameworkPreferenceContext: User's framework preferences
```

### Context Loading with Timeout

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

## Abort and Partial Handling

### abort()

Cancels current request and discards partial response:

```typescript
// src/agent/agent.ts:529-534
abort(): void {
  if (this.abortController) {
    this.abortController.abort();
    this.abortController = undefined;
  }
}
```

### abortAndKeepPartial()

Cancels but preserves partial content:

```typescript
// src/agent/agent.ts:554-588
abortAndKeepPartial(): AppMessage | null {
  const partialMessage = this._state.streamMessage;

  if (partialMessage?.role === "assistant" && this.abortController) {
    // Mark as interrupted
    const savedMessage: AssistantMessage = {
      ...partialMessage,
      stopReason: "aborted"
    };

    // Add to history before aborting
    this._state.messages = [...this._state.messages, savedMessage];
    this._state.streamMessage = null;
    this._partialAccepted = savedMessage;

    this.abort();
    return savedMessage;
  }

  this.abort();
  return null;
}
```

## Message Queue

Messages can be queued for batch processing:

```typescript
// src/agent/agent.ts:298-299
private messageQueue: Array<QueuedMessage<AppMessage>> = [];
private queueMode: "all" | "one" = "all";

// Queue modes:
// - "all": Drain entire queue each turn
// - "one": Process one message per turn

async queueMessage(m: AppMessage): Promise<void> {
  const transformed = await this.messageTransformer([m]);
  this.messageQueue.push({
    original: m,
    llm: transformed[0]
  });
}
```

## Prompt Execution

The main `prompt()` method orchestrates the entire interaction:

```typescript
// src/agent/agent.ts:642-775
async prompt(input: string, attachments?: Attachment[]): Promise<void> {
  // 1. Prevent concurrent prompts
  if (this.runningPrompt) {
    throw new Error("A prompt is already in progress");
  }

  // 2. Set up abort controller
  const abortController = new AbortController();
  this.abortController = abortController;

  // 3. Add user message
  const userMessage = {
    role: "user",
    content: input,
    attachments,
    timestamp: Date.now()
  };
  this._state.messages = [...this._state.messages, userMessage];

  // 4. Transform messages
  const transformedMessages = await this.messageTransformer(this._state.messages);
  const messagesToSend = normalizeMessagesForProvider(
    transformedMessages,
    this._state.model
  );

  // 5. Inject context
  let systemPrompt = this._state.systemPrompt;
  const contextAdditions = await this.contextManager.getCombinedSystemPrompt();
  if (contextAdditions) {
    systemPrompt += `\n\n${contextAdditions}`;
  }

  // 6. Stream response from transport
  this.emit({ type: "agent_start" });

  for await (const event of this.transport.run(
    messagesToSend,
    userMessage,
    runConfig,
    abortController.signal
  )) {
    // Handle events...
    this.emit(event);
  }

  // 7. Cleanup
  this.emit({ type: "agent_end", messages: this._state.messages });
}
```

## Subscription Pattern

Subscribers receive all agent events:

```typescript
// src/agent/agent.ts:390-396
subscribe(fn: (e: AgentEvent) => void): () => void {
  this.listeners.push(fn);
  return () => {
    const idx = this.listeners.indexOf(fn);
    if (idx >= 0) this.listeners.splice(idx, 1);
  };
}

// Usage
const unsubscribe = agent.subscribe(event => {
  if (event.type === "content_block_delta") {
    process.stdout.write(event.text);
  }
});
```

## State Management

### Setters

```typescript
setSystemPrompt(v: string): void;
setModel(m: Model<Api>): void;
setThinkingLevel(l: ThinkingLevel): void;
setTools(t: AgentTool[]): void;
setUser(user: AgentState["user"]): void;
setSession(session: AgentState["session"]): void;
setQueueMode(mode: "all" | "one"): void;
```

### Message Operations

```typescript
replaceMessages(ms: AppMessage[]): void;  // Replace all
appendMessage(m: AppMessage): void;       // Add one
clearMessages(): void;                    // Clear all
```

### Reset

```typescript
// src/agent/agent.ts:604-616
reset(): void {
  this._state.messages = [];
  this._state.isStreaming = false;
  this._state.streamMessage = null;
  this._state.pendingToolCalls.clear();
  this._state.error = undefined;
  this.messageQueue = [];
  this.abortController = undefined;
  // Note: Listeners are preserved for TUI updates
}
```

## Summary Generation

Generate a summary using the agent without affecting main conversation:

```typescript
// src/agent/agent.ts:804-855
async generateSummary(
  history: Message[],
  prompt: string,
  systemPrompt = "",
  modelOverride?: Model<Api>
): Promise<AssistantMessage> {
  const summaryModel = modelOverride ?? this._state.model;

  const userMessage = {
    role: "user",
    content: [{ type: "text", text: prompt }],
    timestamp: Date.now()
  };

  const runMessages = [...history, userMessage];

  // Run without tools
  for await (const event of this.transport.run(
    runMessages,
    userMessage,
    { systemPrompt, tools: [], model: summaryModel },
    controller.signal
  )) {
    if (event.type === "message_end") {
      return event.message;
    }
  }
}
```

## Error Handling

The agent captures errors in state and emits appropriate events:

```typescript
try {
  // ... execution
} catch (error) {
  if (error instanceof Error && error.name === "AbortError") {
    aborted = true;
  } else {
    this._state.error = error instanceof Error ? error.message : String(error);
    throw error;
  }
} finally {
  this._state.isStreaming = false;
  this.emit({
    type: "agent_end",
    messages: this._state.messages,
    aborted,
    partialAccepted
  });
}
```

## Related Documentation

- [Tool System Architecture](TOOL_SYSTEM.md) - Tool execution details
- [Context Management](CONTEXT_MANAGEMENT.md) - Context source system
- [Session Persistence](SESSION_PERSISTENCE.md) - Message persistence
- [TUI Rendering](TUI_RENDERING.md) - Event-driven UI updates
