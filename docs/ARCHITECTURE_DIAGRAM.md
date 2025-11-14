# Composer CLI - Visual Architecture

## System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                           USER INTERFACE                            │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                      Terminal UI (TUI)                        │  │
│  │  ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐    │  │
│  │  │  Component  │  │   Markdown   │  │  Command Palette │    │  │
│  │  │   System    │  │   Renderer   │  │   & Selectors    │    │  │
│  │  └──────┬──────┘  └──────┬───────┘  └────────┬─────────┘    │  │
│  │         │                │                     │              │  │
│  │         └────────────────┴─────────────────────┘              │  │
│  │                           │                                    │  │
│  │                    ┌──────▼──────┐                            │  │
│  │                    │ TUI Renderer│                            │  │
│  │                    └──────┬──────┘                            │  │
│  └───────────────────────────┼────────────────────────────────────┘  │
└────────────────────────────────┼──────────────────────────────────────┘
                                 │
┌────────────────────────────────▼──────────────────────────────────────┐
│                           AGENT CORE                                  │
│  ┌───────────────────────────────────────────────────────────────┐   │
│  │                      Agent Class                              │   │
│  │  • Event-driven architecture (pub/sub)                        │   │
│  │  • Message queue management                                   │   │
│  │  • State management (model, tools, messages)                  │   │
│  │  • Streaming coordination                                     │   │
│  └────────┬─────────────┬────────────┬──────────────┬────────────┘   │
│           │             │            │              │                 │
│     ┌─────▼─────┐ ┌─────▼─────┐ ┌───▼────┐  ┌──────▼──────┐         │
│     │  System   │ │   Model   │ │ Tools  │  │   Message   │         │
│     │  Prompt   │ │ Selection │ │ Config │  │ Transformer │         │
│     └───────────┘ └─────┬─────┘ └───┬────┘  └─────────────┘         │
└─────────────────────────┼───────────┼────────────────────────────────┘
                          │           │
┌─────────────────────────▼───────────▼────────────────────────────────┐
│                      TRANSPORT LAYER                                  │
│  ┌───────────────────────────────────────────────────────────────┐   │
│  │                  ProviderTransport                            │   │
│  │  • API abstraction                                            │   │
│  │  • Streaming event transformation                             │   │
│  │  • Tool call format conversion                                │   │
│  │  • Usage tracking & cost calculation                          │   │
│  └────────┬────────────────┬────────────────┬─────────────┬──────┘   │
└───────────┼────────────────┼────────────────┼─────────────┼──────────┘
            │                │                │             │
  ┌─────────▼────┐  ┌────────▼────┐  ┌───────▼──────┐  ┌───▼────────┐
  │  Anthropic   │  │   OpenAI    │  │    Google    │  │   Custom   │
  │   Provider   │  │   Provider  │  │   Provider   │  │  Providers │
  │              │  │             │  │              │  │            │
  │ • Claude API │  │ • GPT-4/5   │  │ • Gemini API │  │ • xAI      │
  │ • Messages   │  │ • o1/o3     │  │ • Generative │  │ • Groq     │
  │ • Streaming  │  │ • Responses │  │   AI         │  │ • Cerebras │
  │ • Caching    │  │ • Streaming │  │ • Streaming  │  │ • Custom   │
  └──────────────┘  └─────────────┘  └──────────────┘  └────────────┘
```

## Tool Execution Flow

```
┌──────────────────────────────────────────────────────────────────────┐
│                         TOOL SYSTEM                                  │
└──────────────────────────────────────────────────────────────────────┘

    Agent receives tool calls from LLM
             │
             ▼
    ┌────────────────┐
    │  Tool Router   │──────► Validates tool name exists
    └────────┬───────┘
             │
             ▼
    ┌────────────────┐
    │ Zod Validation │──────► Validates parameters against schema
    └────────┬───────┘
             │
             ▼
    ┌────────────────────────────────────────────────────────────┐
    │                   Tool Execution                           │
    │                                                            │
    │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
    │  │   read   │  │  write   │  │   edit   │  │   list   │  │
    │  ├──────────┤  ├──────────┤  ├──────────┤  ├──────────┤  │
    │  │• File I/O│  │• Create  │  │• Surgical│  │• Glob    │  │
    │  │• Images  │  │• Dirs    │  │  replace │  │• Filter  │  │
    │  └──────────┘  └──────────┘  └──────────┘  └──────────┘  │
    │                                                            │
    │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
    │  │  search  │  │   bash   │  │   diff   │  │   todo   │  │
    │  ├──────────┤  ├──────────┤  ├──────────┤  ├──────────┤  │
    │  │• Ripgrep │  │• Exec    │  │• Git     │  │• Tasks   │  │
    │  │• Context │  │• Timeout │  │• Staged  │  │• Status  │  │
    │  └──────────┘  └──────────┘  └──────────┘  └──────────┘  │
    └────────────────────────┬───────────────────────────────────┘
                             │
                             ▼
                    ┌─────────────────┐
                    │ Tool Result     │
                    │                 │
                    │ • content       │
                    │ • details       │
                    │ • isError       │
                    └────────┬────────┘
                             │
                             ▼
            Return to Agent → Send to LLM → Continue loop
```

## Message Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                        MESSAGE LIFECYCLE                            │
└─────────────────────────────────────────────────────────────────────┘

   User Input
       │
       ▼
   ┌────────────────┐
   │ UserMessage    │
   │ • content      │
   │ • attachments  │
   │ • timestamp    │
   └───────┬────────┘
           │
           ▼
   ┌────────────────────┐
   │ Message Queue      │────► Prevents race conditions
   └────────┬───────────┘
            │
            ▼
   ┌────────────────────┐
   │ Message Transform  │────► Optional: filter/modify history
   └────────┬───────────┘
            │
            ▼
   ┌─────────────────────────────────────────────────────────────┐
   │                    LLM Streaming                            │
   │                                                             │
   │  start → text_start → text_delta... → text_end → tool_call │
   │                                                             │
   │  thinking_start → thinking_delta... → thinking_end          │
   │                                                             │
   │  tool_call_start → tool_call_delta... → tool_call_end       │
   └────────┬────────────────────────────────┬───────────────────┘
            │                                │
            ▼                                ▼
   ┌────────────────┐              ┌─────────────────┐
   │ Text Content   │              │   Tool Calls    │
   │ • Streamed     │              │ • Queued        │
   │ • Displayed    │              │ • Executed      │
   └────────────────┘              └────────┬────────┘
                                            │
                                            ▼
                                   ┌─────────────────┐
                                   │ ToolResultMsg   │
                                   │ • content       │
                                   │ • details       │
                                   │ • isError       │
                                   └────────┬────────┘
                                            │
                                            ▼
                                   ┌─────────────────┐
                                   │ Continue Turn   │────► Loop until stop
                                   └─────────────────┘
```

## Configuration & Data Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                     CONFIGURATION SOURCES                           │
└─────────────────────────────────────────────────────────────────────┘

Environment Variables                  File-based Config
┌───────────────────┐                 ┌────────────────────┐
│ ANTHROPIC_API_KEY │                 │ ~/.composer/       │
│ OPENAI_API_KEY    │                 │  ├─ models.json    │◄──┐
│ GEMINI_API_KEY    │                 │  ├─ sessions/      │   │
│ GROQ_API_KEY      │                 │  └─ .env           │   │
│ XAI_API_KEY       │                 └──────────┬─────────┘   │
│ ...               │                            │             │
└─────────┬─────────┘                            │             │
          │                                      │             │
          └──────────────┬───────────────────────┘             │
                         │                                     │
                         ▼                                     │
              ┌────────────────────┐                           │
              │   Model Registry   │                           │
              │  • Built-in models │                           │
              │  • Custom configs  │                           │
              │  • API key lookup  │                           │
              └──────────┬─────────┘                           │
                         │                                     │
                         ▼                                     │
              ┌────────────────────┐                           │
              │  Provider Factory  │                           │
              │  • Resolve model   │                           │
              │  • Create provider │                           │
              │  • Inject API key  │                           │
              └──────────┬─────────┘                           │
                         │                                     │
                         ▼                                     │
                    Agent uses                                 │
                                                               │
                                                               │
Factory CLI Integration                                        │
┌────────────────────────┐                                     │
│ ~/.factory/            │                                     │
│  ├─ config.json        │─────────────────────────────────────┘
│  └─ settings.json      │     Bidirectional sync
└────────────────────────┘     • Import: Factory → Composer
                               • Export: Composer → Factory
```

## Session Management

```
┌─────────────────────────────────────────────────────────────────────┐
│                      SESSION LIFECYCLE                              │
└─────────────────────────────────────────────────────────────────────┘

    New Session
         │
         ▼
    ┌─────────────────┐
    │ Generate UUID   │
    │ Load context    │
    │ Set system      │
    └────────┬────────┘
             │
             ▼
    ┌─────────────────────────────────────────────┐
    │         Active Session                      │
    │                                             │
    │  Messages ◄──┬──► Agent State               │
    │              │                              │
    │  ┌───────────▼────────┐                    │
    │  │ Message Array      │                    │
    │  │ • UserMessage      │                    │
    │  │ • AssistantMessage │                    │
    │  │ • ToolResultMessage│                    │
    │  └────────────────────┘                    │
    │                                             │
    │  Metadata:                                  │
    │  • Total tokens                             │
    │  • Total cost                               │
    │  • Model changes                            │
    │  • Timestamps                               │
    └─────────────┬───────────────────────────────┘
                  │
                  ▼
         Periodic Auto-save
                  │
                  ▼
    ┌──────────────────────────┐
    │ ~/.composer/sessions/    │
    │   {uuid}.json            │
    │                          │
    │ • Header (metadata)      │
    │ • Messages (full array)  │
    │ • Model history          │
    └────────┬─────────────────┘
             │
             ▼
    ┌──────────────────────────┐
    │  Export Options          │
    │                          │
    │  /export → HTML          │
    │  • Styled                │
    │  • Self-contained        │
    │  • Syntax highlighting   │
    │                          │
    │  /export-text → TXT      │
    │  • Plain text            │
    │  • Timestamped           │
    │  • Tool calls formatted  │
    └──────────────────────────┘
```

## Event Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                       AGENT EVENT SYSTEM                            │
└─────────────────────────────────────────────────────────────────────┘

    Agent.emit(event)
         │
         ├────────────────────────────────────┬───────────────────────┐
         │                                    │                       │
         ▼                                    ▼                       ▼
    ┌─────────────┐                  ┌──────────────┐        ┌──────────────┐
    │ TUI Renderer│                  │  Telemetry   │        │   Session    │
    │             │                  │   Logger     │        │   Manager    │
    │ Updates UI  │                  │              │        │              │
    │ components  │                  │ Records:     │        │ Persists:    │
    │ in real-time│                  │ • Duration   │        │ • Messages   │
    │             │                  │ • Success    │        │ • Metadata   │
    └─────────────┘                  │ • Errors     │        │ • Timestamps │
                                     └──────────────┘        └──────────────┘

Event Types:
┌────────────────────────────────────────────────────────────────────┐
│ Streaming Events                  State Events                     │
│ • text_start / text_delta         • state_update                   │
│ • thinking_start / thinking_delta • model_change                   │
│ • tool_call_start / tool_call_end • system_prompt_change           │
│                                                                    │
│ Tool Events                       Control Events                   │
│ • tool_execution_start            • stream_complete                │
│ • tool_execution_complete         • error                          │
│ • tool_execution_error            • abort                          │
└────────────────────────────────────────────────────────────────────┘
```

## Component Hierarchy

```
┌─────────────────────────────────────────────────────────────────────┐
│                          TUI TREE                                   │
└─────────────────────────────────────────────────────────────────────┘

TUI (Root Container)
 │
 ├─ WelcomeAnimation (on startup)
 │
 ├─ LoaderView (during initialization)
 │
 └─ Main Interface Container
     │
     ├─ Message History (scrollable)
     │   │
     │   ├─ UserMessageComponent
     │   │   ├─ Text (content)
     │   │   └─ Text (attachments preview)
     │   │
     │   ├─ AssistantMessageComponent
     │   │   ├─ Markdown (text content)
     │   │   ├─ Text (thinking blocks)
     │   │   └─ ToolExecutionComponent (per tool call)
     │   │       ├─ Text (tool name + params)
     │   │       ├─ Markdown (result content)
     │   │       └─ Text (execution time)
     │   │
     │   └─ [repeating...]
     │
     ├─ Active Selectors (modal overlays)
     │   │
     │   ├─ ModelSelectorComponent
     │   │   ├─ Input (search box)
     │   │   └─ SelectList (filtered models)
     │   │
     │   ├─ ThinkingSelectorComponent
     │   │   └─ SelectList (thinking levels)
     │   │
     │   ├─ SessionSelectorComponent
     │   │   ├─ Input (search)
     │   │   └─ SelectList (past sessions)
     │   │
     │   ├─ CommandPaletteComponent
     │   │   ├─ Input (command input)
     │   │   └─ SelectList (suggestions)
     │   │
     │   └─ FileSearchComponent
     │       ├─ Input (path/pattern)
     │       └─ SelectList (matching files)
     │
     ├─ Input Area
     │   │
     │   └─ CustomEditor (multi-line, autocomplete)
     │       └─ Autocomplete dropdown
     │           ├─ Slash commands
     │           ├─ File paths
     │           └─ Previous commands
     │
     └─ FooterComponent
         ├─ Text (model info)
         ├─ Text (token usage)
         ├─ Text (cost)
         └─ Text (status indicators)
```

## Data Structures

```
┌─────────────────────────────────────────────────────────────────────┐
│                      KEY DATA STRUCTURES                            │
└─────────────────────────────────────────────────────────────────────┘

AgentState
├─ systemPrompt: string
├─ model: Model<Api>
├─ thinkingLevel: ThinkingLevel
├─ tools: AgentTool[]
├─ messages: AppMessage[]
├─ isStreaming: boolean
├─ streamMessage: AssistantMessage | null
└─ pendingToolCalls: Set<string>

Message Types
├─ UserMessage
│   ├─ role: "user"
│   ├─ content: string | Content[]
│   └─ timestamp: number
│
├─ AssistantMessage
│   ├─ role: "assistant"
│   ├─ content: Content[]
│   ├─ api: Api
│   ├─ provider: Provider
│   ├─ model: string
│   ├─ usage: Usage
│   ├─ stopReason: StopReason
│   └─ timestamp: number
│
└─ ToolResultMessage
    ├─ role: "toolResult"
    ├─ toolCallId: string
    ├─ toolName: string
    ├─ content: Content[]
    ├─ details?: any
    ├─ isError: boolean
    └─ timestamp: number

Content Types
├─ TextContent
│   ├─ type: "text"
│   └─ text: string
│
├─ ThinkingContent
│   ├─ type: "thinking"
│   └─ thinking: string
│
├─ ImageContent
│   ├─ type: "image"
│   ├─ data: string
│   └─ mimeType: string
│
└─ ToolCall
    ├─ type: "toolCall"
    ├─ id: string
    ├─ name: string
    └─ arguments: Record<string, any>

Tool Definition
├─ name: string
├─ label?: string
├─ description: string
├─ parameters: ZodSchema
└─ execute: (id, params, signal) => ToolResult
```

---

## Key Architectural Principles

### 1. **Separation of Concerns**
- Agent logic independent of UI
- Tools isolated from transport
- Providers abstracted behind common interface

### 2. **Type Safety**
- TypeScript throughout
- Zod for runtime validation
- Discriminated unions for type narrowing

### 3. **Event-Driven**
- Reactive UI updates
- Decoupled components
- Easy to add new event listeners

### 4. **Extensibility**
- Plugin-style tools
- Custom provider support
- Configurable transports

### 5. **Graceful Degradation**
- Missing API keys → prompts user
- Stream errors → fallback to error message
- Tool failures → continue with error result

---

## Performance Optimizations

1. **Lazy Loading**
   - Model registry loaded on first use
   - Session files loaded on demand

2. **Incremental Rendering**
   - Only changed components re-rendered
   - Streaming updates don't repaint full screen

3. **Bounded Memory**
   - Terminal buffer size limits
   - No unbounded message accumulation in RAM

4. **Efficient Streaming**
   - Direct SSE → UI pipeline
   - No intermediate buffering

5. **Fast Startup**
   - Minimal initialization
   - Async config loading
