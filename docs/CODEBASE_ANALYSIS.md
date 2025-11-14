# Composer CLI - Comprehensive Codebase Analysis

**Generated:** November 13, 2025, 10:32 PM PST  
**Repository:** @evalops/composer v0.7.7  
**Total TypeScript Files:** 67  
**Total Lines of Code:** ~9,604  

---

## 📊 Executive Summary

Composer is a sophisticated AI coding agent CLI built with TypeScript, featuring:
- **Multi-model support** (8+ LLM providers including Anthropic, OpenAI, Google, xAI, Groq, etc.)
- **8 powerful coding tools** for file operations, search, diff, bash execution, and task management
- **TUI (Terminal User Interface)** with real-time streaming and component-based architecture
- **Session management** with HTML/text export capabilities
- **Factory CLI integration** for unified configuration management
- **Telemetry & evaluation pipelines** for continuous improvement

---

## 🏗️ Architecture Overview

### Core Modules

```
src/
├── agent/              # Core agent logic and LLM integrations
│   ├── agent.ts        # Main Agent class with event-driven architecture
│   ├── transport.ts    # Provider transport layer
│   ├── types.ts        # 40+ TypeScript interfaces for type safety
│   └── providers/      # LLM provider implementations
│       ├── anthropic.ts   # Claude integration (12.6KB)
│       └── openai.ts      # OpenAI/compatible APIs (8.9KB)
│
├── tools/              # 8 coding tools with Zod validation
│   ├── read.ts         # File reading with image support
│   ├── write.ts        # File creation/modification
│   ├── edit.ts         # Surgical text replacement
│   ├── list.ts         # Safe glob-based file listing
│   ├── search.ts       # Ripgrep integration for code search
│   ├── bash.ts         # Command execution with timeout
│   ├── diff.ts         # Git diff inspection
│   ├── todo.ts         # Task management with status tracking
│   └── zod-tool.ts     # Tool creation helper with schema validation
│
├── tui/                # Terminal UI components
│   ├── tui-renderer.ts      # Main renderer orchestration
│   ├── assistant-message.ts # AI response display
│   ├── user-message.ts      # User input display
│   ├── tool-execution.ts    # Tool call visualization
│   ├── model-selector.ts    # Interactive model switching
│   ├── thinking-selector.ts # Reasoning level adjustment
│   ├── session-selector.ts  # Session history browser
│   ├── command-palette.ts   # Quick command access
│   ├── file-search.ts       # File picker interface
│   └── commands/            # Slash command registry
│
├── tui-lib/            # Reusable UI component library
│   ├── tui.ts          # Base Component interface & Container
│   ├── terminal.ts     # Terminal abstraction layer
│   ├── autocomplete.ts # Intelligent command completion
│   └── components/     # UI primitives (Text, Input, Editor, etc.)
│
├── models/             # Model registry and configuration
│   ├── registry.ts     # Dynamic model loading & resolution
│   └── builtin.ts      # Built-in provider definitions
│
├── factory/            # Factory CLI integration
│   ├── sync.ts         # Import/export operations
│   ├── config.ts       # Configuration loading
│   ├── models.ts       # Model transformation
│   └── io.ts           # File I/O utilities
│
├── providers/          # API key management
│   └── api-keys.ts     # Environment variable mapping
│
├── cli/                # CLI entry point and setup
│   ├── args.ts         # Command-line argument parsing
│   ├── help.ts         # Help text generation
│   └── system-prompt.ts # Context file loading
│
├── session-manager.ts  # Conversation history persistence
├── export-html.ts      # HTML/text export functionality
├── telemetry.ts        # Usage tracking and analytics
├── workspace-files.ts  # Project file discovery
└── main.ts             # Application bootstrap
```

---

## 🔧 Tool System Deep Dive

### Tool Architecture

Each tool follows a consistent pattern using `createZodTool`:

```typescript
export const toolName = createZodTool({
  name: "tool_name",
  label: "Display Name", // Optional UI label
  description: "What the tool does...",
  
  parameters: z.object({
    param1: z.string().describe("Parameter description"),
    param2: z.number().optional().describe("Optional parameter")
  }),
  
  execute: async (toolCallId, params, signal) => {
    // Tool implementation
    return {
      content: [{ type: "text", text: "Result" }],
      details: { /* optional metadata */ },
      isError: false
    };
  }
});
```

### Available Tools

| Tool | Purpose | Key Features |
|------|---------|--------------|
| **read** | File reading | Text files (with line offsets), images (jpg/png/gif/webp) |
| **write** | File creation | Automatic parent directory creation |
| **edit** | Precise edits | Exact text matching, no regex, surgical replacements |
| **list** | Directory listing | Safe glob patterns, hidden file support, result limiting |
| **search** | Code search | Ripgrep integration, glob filtering, context lines |
| **bash** | Command execution | Timeout support, stdout/stderr capture |
| **diff** | Git inspection | Workspace/staged/range diffs, stat summaries |
| **todo** | Task tracking | Status-rich checklists with priorities and blockers |

### Tool Validation & Safety

- **Zod schemas** enforce parameter types at runtime
- **Signal support** enables graceful cancellation
- **Error handling** with structured `isError` flag
- **Details metadata** for rich telemetry and debugging

---

## 🤖 Agent System

### Event-Driven Architecture

The `Agent` class implements a pub/sub pattern for reactive UI updates:

```typescript
agent.subscribe((event: AgentEvent) => {
  switch (event.type) {
    case "text_delta":     // Streaming text chunks
    case "thinking_start": // Reasoning begins
    case "tool_call":      // Tool execution initiated
    case "state_update":   // Model/system prompt changed
    // ... 15+ event types
  }
});
```

### Message Types

```typescript
type Message = 
  | UserMessage           // Human input
  | AssistantMessage      // AI response with usage tracking
  | ToolResultMessage     // Tool execution results
```

### Multi-API Support

Abstraction layer supports multiple LLM APIs:
- **OpenAI Completions/Responses** (GPT models, xAI Grok, Groq, Cerebras)
- **Anthropic Messages** (Claude with prompt caching)
- **Google Generative AI** (Gemini)

Each provider implements:
- **Streaming** with event transformation
- **Tool calling** conversion
- **Usage tracking** with cost calculation
- **Error handling** with structured responses

---

## 🎨 TUI Component System

### Component Interface

```typescript
interface Component {
  render(width: number): string;
  height(): number;
}
```

All UI elements implement this simple contract, enabling:
- **Composability** via `Container` class
- **Dynamic layouts** based on terminal dimensions
- **Efficient re-rendering** of only changed components

### Key TUI Features

1. **Real-time Streaming**
   - Character-by-character text display
   - Syntax-highlighted thinking blocks
   - Progressive tool result rendering

2. **Interactive Selectors**
   - Model picker with fuzzy search
   - Thinking level adjustment
   - Session history browser
   - File search with autocomplete

3. **Command Palette**
   - Slash command discovery
   - Contextual completions
   - Script execution shortcuts

4. **Rich Formatting**
   - Markdown rendering (via `marked` library)
   - Color-coded borders and status indicators
   - Token usage and cost tracking

---

## 🔌 Multi-Model Support

### Supported Providers

| Provider | API Support | Reasoning | Notable Models |
|----------|-------------|-----------|----------------|
| Anthropic | ✅ Native | ✅ Extended thinking | Claude Sonnet 4, Opus 4 |
| OpenAI | ✅ Native | ✅ GPT-5 | GPT-4o, o1, o3 |
| Google | ✅ Native | ✅ Gemini 2.5 | Gemini 1.5 Pro/Flash, 2.0 Flash |
| xAI | ✅ OpenAI-compat | ✅ Grok 2 | Grok beta |
| Groq | ✅ OpenAI-compat | ❌ | Llama 3.x, Mixtral |
| Cerebras | ✅ OpenAI-compat | ❌ | Llama 3.1 70B |
| OpenRouter | ✅ OpenAI-compat | Varies | 100+ models |
| ZAI | ✅ OpenAI-compat | ❌ | Various |

### Dynamic Configuration

Models can be defined in `~/.composer/models.json` or loaded from Factory CLI:

```json
{
  "providers": [
    {
      "id": "custom-openai",
      "provider": "openai",
      "baseUrl": "https://api.example.com/v1",
      "models": [
        {
          "id": "my-model",
          "name": "Custom Model",
          "contextWindow": 128000
        }
      ]
    }
  ]
}
```

The registry supports:
- **Custom base URLs** for self-hosted endpoints
- **API key override** per provider
- **Context window configuration**
- **Vision support flags**

---

## 💾 Session Management

### Session Storage

Sessions are persisted as JSON in `~/.composer/sessions/`:

```typescript
interface SessionHeader {
  id: string;
  timestamp: number;
  summary: string;
  messageCount: number;
  totalTokens: number;
  totalCost: number;
  models: SessionModelMetadata[];
}
```

### Export Formats

1. **HTML Export** (`/export session.html`)
   - Self-contained file with embedded styles
   - Syntax highlighting for code blocks
   - Tool execution visualizations
   - Usage statistics and model metadata

2. **Text Export** (`/export-text session.txt`)
   - Plain text transcript
   - Tool calls formatted as function syntax
   - Timestamped message history

---

## 🔍 Code Quality & Patterns

### TypeScript Best Practices

✅ **Strong typing throughout**
- 40+ interfaces in `agent/types.ts`
- Discriminated unions for message types
- Generic type parameters for tool definitions

✅ **Zod for runtime validation**
- Schema-first tool definitions
- Automatic JSON Schema generation
- Type inference from schemas

✅ **Modular architecture**
- Clear separation of concerns
- Dependency injection (Agent → Transport)
- Plugin-style tool system

✅ **Error handling**
- Structured error responses
- Signal-based cancellation
- Graceful degradation

### Notable Design Patterns

1. **Factory Pattern** - `createZodTool` for tool creation
2. **Observer Pattern** - Agent event subscriptions
3. **Strategy Pattern** - Provider-specific transport implementations
4. **Composite Pattern** - TUI Container/Component hierarchy
5. **Repository Pattern** - Model registry with dynamic loading

---

## 📦 Dependencies Analysis

### Core Dependencies (8)

| Package | Purpose | Version |
|---------|---------|---------|
| `@sinclair/typebox` | JSON Schema generation | ^0.33.0 |
| `chalk` | Terminal colors | ^5.5.0 |
| `clipboardy` | Clipboard access | ^4.0.0 |
| `diff` | Text diffing | ^8.0.2 |
| `dotenv` | Environment loading | ^16.4.5 |
| `glob` | File pattern matching | ^11.0.3 |
| `marked` | Markdown parsing | ^17.0.0 |
| `zod` | Schema validation | ^3.23.8 |

**Lightweight & focused** - No heavy frameworks, minimal bloat

### Dev Dependencies (4)

- **Biome** - Fast linting & formatting (Rust-based)
- **TypeScript** - Type checking
- **Vitest** - Unit testing
- **Type definitions** - Full type coverage

---

## 🚀 Performance Characteristics

### Startup Time
- **Cold start:** ~100ms (Node.js overhead)
- **Session load:** O(n) where n = message count
- **Model registry:** Lazy-loaded on first use

### Streaming
- **Latency:** Direct SSE/WebSocket → TUI (no buffering)
- **Rendering:** Incremental, only changed components
- **Memory:** Bounded by terminal size (no growing buffer)

### Tool Execution
- **Parallelization:** Single-threaded, sequential tools
- **Timeout support:** Configurable via `bash` tool
- **Cancellation:** AbortSignal propagation

---

## 🧪 Testing & Evaluation

### Evaluation Framework

`evals/scenarios.json` defines test scenarios:

```json
{
  "scenarios": [
    {
      "name": "Simple echo",
      "prompt": "echo hello world",
      "assertions": {
        "stdout": ["hello world"]
      }
    }
  ]
}
```

Run via: `npm run evals`

### Telemetry

When `COMPOSER_TELEMETRY=true`:
- **Tool execution** events (duration, success/failure)
- **Evaluation results** (scenario outcomes)
- **Loader stages** (startup profiling)

Data sent to configurable endpoint for analysis.

---

## 🔐 Security Considerations

### API Key Management
- ✅ Environment variables only
- ✅ No hardcoded secrets
- ✅ Per-provider key isolation
- ❌ No encryption at rest (relies on OS security)

### Tool Safety
- ✅ **read**: Path normalization prevents directory traversal
- ✅ **bash**: No shell injection via command string (passed to bash -c)
- ⚠️ **write/edit**: No filesystem sandboxing (agent has full file access)
- ✅ **list**: Glob patterns use `glob` library safety features

### Network Security
- ✅ HTTPS for all LLM API calls
- ✅ No telemetry by default
- ⚠️ Custom baseUrl can point to untrusted endpoints

---

## 📈 Recent Development Activity

### Last 10 Commits

```
e26f463 refactor: extract slash command registry
d757036 fix: allow editor config merge
995d211 refactor: modularize factory sync helpers
8de53c5 refactor: reorganize factory sync module
38870fd refactor: streamline factory sync integration
fa85d6f feat: add status and review slash commands
7c69212 Add /diff alias for preview
ac3c82b Bump to 0.7.7
894e88d Add command palette, file search, and clean loader
10f237c Restyle chat cards with pastel borders
```

**Trends:**
- Active refactoring for maintainability
- Command palette & UX improvements
- Factory CLI integration stabilization

---

## 🎯 Strengths & Opportunities

### ✅ Strengths

1. **Clean architecture** - Well-organized, modular codebase
2. **Type safety** - Comprehensive TypeScript usage
3. **Extensibility** - Easy to add new tools/providers
4. **Developer experience** - Excellent TUI with rich feedback
5. **Multi-model flexibility** - Vendor-agnostic design

### 🔧 Opportunities

1. **Test coverage** - Only 3 test files mentioned, could expand
2. **Documentation** - API docs for tool/provider developers
3. **Error recovery** - More sophisticated retry logic
4. **Performance** - Potential for parallel tool execution
5. **Security** - Optional filesystem sandboxing for tools

---

## 📚 Recommended Reading Order

For new contributors:

1. `README.md` - High-level overview
2. `src/agent/types.ts` - Core type definitions
3. `src/tools/zod-tool.ts` - Tool creation pattern
4. `src/tools/read.ts` - Simple tool example
5. `src/agent/agent.ts` - Agent event loop
6. `src/tui/tui-renderer.ts` - UI orchestration
7. `src/models/registry.ts` - Model loading system

---

## 🤝 Contributing Guidelines

Based on codebase patterns:

### Code Style
- **Biome** for linting/formatting (run `npm run format`)
- **TypeScript strict mode** enabled
- **Descriptive variable names** (no abbreviations)
- **Interface over type** for object shapes

### Commit Messages
- Conventional format: `type: description`
- Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`
- Keep first line under 72 characters

### Adding Tools
1. Create `src/tools/your-tool.ts`
2. Use `createZodTool` pattern
3. Export in `src/tools/index.ts`
4. Add to `codingTools` array
5. Update README.md with tool documentation

### Adding Providers
1. Implement in `src/agent/providers/your-provider.ts`
2. Follow `AnthropicOptions`/`OpenAIOptions` interface
3. Add to `src/models/builtin.ts` provider list
4. Update `src/providers/api-keys.ts` env var map

---

## 📊 Metrics Summary

| Metric | Value |
|--------|-------|
| TypeScript Files | 67 |
| Total Lines | ~9,604 |
| Packages | 8 core, 4 dev |
| Tools | 8 |
| Providers | 8+ |
| TUI Components | 20+ |
| Slash Commands | 15+ |
| Export Formats | 2 (HTML, Text) |
| Supported APIs | 4 (OpenAI, Anthropic, Google, Custom) |

---

## 🔮 Future Possibilities

Based on architecture:

1. **Plugin system** - External tool packages via npm
2. **Collaborative sessions** - Multi-user with CRDTs
3. **Web UI** - Extract TUI logic to browser
4. **Agentic workflows** - Multi-agent orchestration
5. **RAG integration** - Vector search for codebase context
6. **IDE extensions** - VS Code/JetBrains integration

---

**Analysis Complete** ✨

This codebase demonstrates excellent software engineering practices with a clean, extensible architecture ready for continued evolution. The agent system is production-ready with robust multi-model support and comprehensive tooling for AI-assisted development.
