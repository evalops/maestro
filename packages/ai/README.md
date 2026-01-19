# @evalops/ai

Shared Composer AI SDK providing model registry, provider-agnostic transport, and agent event stream primitives. Used by the CLI, TUI, and web UI.

## Supported Providers

| Provider | Models | Environment Variable |
|----------|--------|---------------------|
| **Anthropic** | Claude 3.5, Claude 4, Sonnet, Opus | `ANTHROPIC_API_KEY` |
| **OpenAI** | GPT-4o, GPT-4o-mini, o1, o3 | `OPENAI_API_KEY` |
| **GitHub Copilot** | OpenAI-compatible models via Copilot | OAuth (`/login github-copilot`) |
| **Google** | Gemini 2.0, Gemini 2.5 | `GOOGLE_API_KEY` |
| **OpenRouter** | OpenAI-compatible aggregator | `OPENROUTER_API_KEY` |
| **Groq** | OpenAI-compatible models | `GROQ_API_KEY` |
| **Cerebras** | OpenAI-compatible models | `CEREBRAS_API_KEY` |
| **AWS Bedrock** | Claude via AWS | AWS credentials |
| **Azure OpenAI** | OpenAI-compatible deployments | `AZURE_OPENAI_API_KEY` |

## Installation

```bash
npm install @evalops/ai
```

## Quick Start

```typescript
import { Agent, ProviderTransport, getModel } from "@evalops/ai";

// Create transport with API key provider
const transport = new ProviderTransport({
  getApiKey: (provider) => {
    if (provider === "anthropic") return process.env.ANTHROPIC_API_KEY;
    if (provider === "openai") return process.env.OPENAI_API_KEY;
  },
});

// Get model configuration (fully typed)
const model = getModel("anthropic", "claude-sonnet-4-5-20250929");

// Create agent
const agent = new Agent({
  transport,
  initialState: {
    model: model!,
    systemPrompt: "You are a helpful assistant.",
    tools: [],
    messages: [],
  },
});

// Subscribe to events for streaming output
agent.subscribe((event) => {
  switch (event.type) {
    case "content_block_delta":
      if (event.delta.type === "text_delta") {
        process.stdout.write(event.delta.text);
      }
      break;
    case "message_end":
      console.log("\n[Done]");
      break;
    case "error":
      console.error("Error:", event.error);
      break;
  }
});

// Send a message
await agent.prompt("Hello, world!");
```

## OAuth Providers (GitHub Copilot)

GitHub Copilot uses OAuth (stored in `~/.composer/oauth.json`). In SDK usage, use
`getAuthContext` to supply the token:

```typescript
import { getOAuthToken } from "@evalops/ai/oauth";

const transport = new ProviderTransport({
  getAuthContext: async (provider) => {
    if (provider === "github-copilot") {
      const token = await getOAuthToken("github-copilot");
      return token
        ? {
            provider,
            token,
            type: "oauth",
            source: "github_copilot_oauth_file",
          }
        : undefined;
    }
  },
});
```

## Subpath Entry Points

`@evalops/ai` is the unified SDK surface for all Composer interfaces. Prefer the
stable subpath entry points (kept inside this package) instead of reaching into
monorepo `src` files:

```typescript
import { Agent } from "@evalops/ai/agent";
import { ProviderTransport } from "@evalops/ai/transport";
import type { AgentEvent, AgentStreamEvent, Message } from "@evalops/ai/types";
import { getModel, getModels } from "@evalops/ai/models";
```

Additional stable namespaces are available for power users, for example:
`@evalops/ai/tools`, `@evalops/ai/hooks`, `@evalops/ai/sandbox`,
`@evalops/ai/telemetry`, `@evalops/ai/oauth`, `@evalops/ai/guardian`,
`@evalops/ai/config`, `@evalops/ai/errors`, `@evalops/ai/lsp`,
`@evalops/ai/ide`, and `@evalops/ai/training`.
Prefer the stable entry points above unless you need something specific; deep
wildcard subpaths are intentionally not exported to keep the SDK surface
predictable.

You can also access these namespaces from the root entry point when you want a
single import surface:

```typescript
import { tools, hooks, config, sandbox } from "@evalops/ai";

const toolList = tools.codingTools;
const hookConfig = hooks.loadHookConfiguration();
const configStore = config.loadConfig();
const sandboxInstance = await sandbox.createSandbox();
```

## Streaming Events

The agent emits events during execution that you can subscribe to:

```typescript
agent.subscribe((event) => {
  switch (event.type) {
    // Message lifecycle
    case "message_start":
      console.log("Assistant is responding...");
      break;
    case "message_update":
      // Partial message available at event.message
      break;
    case "message_end":
      console.log("Response complete:", event.message);
      break;

    // Content streaming
    case "content_block_start":
      console.log(`Content block ${event.index} started`);
      break;
    case "content_block_delta":
      if (event.delta.type === "text_delta") {
        process.stdout.write(event.delta.text);
      } else if (event.delta.type === "thinking_delta") {
        // Extended thinking content
        console.log("[Thinking]", event.delta.thinking);
      }
      break;
    case "content_block_end":
      console.log(`Content block ${event.index} ended`);
      break;

    // Tool execution
    case "tool_execution_start":
      console.log(`Executing tool: ${event.toolName}`);
      break;
    case "tool_execution_end":
      console.log(`Tool result: ${event.result}`);
      break;

    // Turn management
    case "turn_start":
      console.log("Turn started");
      break;
    case "turn_end":
      console.log("Turn ended, stop reason:", event.stopReason);
      break;

    // Errors
    case "error":
      console.error("Error:", event.error);
      break;
  }
});

When you forward events over a transport (SSE/WebSocket), use
`AgentStreamEvent` to include transport-level signals like
`session_update`, `heartbeat`, `aborted`, and `done`.
```

## Tool Calling

Define tools that the agent can use:

```typescript
import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@evalops/ai";

const weatherTool: AgentTool = {
  name: "get_weather",
  description: "Get current weather for a location",
  parameters: Type.Object({
    location: Type.String({ description: "City name" }),
    units: Type.Optional(
      Type.Union([Type.Literal("celsius"), Type.Literal("fahrenheit")])
    ),
  }),
  execute: async (params) => {
    // Your implementation here
    const weather = await fetchWeather(params.location, params.units);
    return { temperature: weather.temp, conditions: weather.conditions };
  },
};

// Add tools to agent
const agent = new Agent({
  transport,
  initialState: {
    model: model!,
    tools: [weatherTool],
    messages: [],
  },
});
```

## Model Discovery

Discover available models programmatically:

```typescript
import { getProviders, getModels, getModel } from "@evalops/ai";

// List all providers
const providers = getProviders();
// ['anthropic', 'openai', 'google', 'bedrock', ...]

// Get all models for a provider
const anthropicModels = getModels("anthropic");
for (const model of anthropicModels) {
  console.log(`${model.id}: context=${model.contextWindow}, reasoning=${model.reasoning}`);
}

// Get a specific model (fully typed)
const claude = getModel("anthropic", "claude-sonnet-4-5-20250929");
if (claude) {
  console.log(`Using ${claude.id} with ${claude.contextWindow} token context`);
}
```

## OpenAI-Compatible Vendors (Compat Flags)

For Azure/OpenRouter/Groq/Cerebras or custom OpenAI-compatible endpoints, set
`compat` overrides in your models config when the defaults do not match the
provider. See `docs/MODELS.md` for the schema and supported compat fields.

## Extended Thinking

For models that support extended thinking (Claude 4, o1, Gemini 2.5):

```typescript
const agent = new Agent({
  transport,
  initialState: {
    model: getModel("anthropic", "claude-sonnet-4-5-20250929")!,
    thinkingLevel: "medium", // off | minimal | low | medium | high | max
    tools: [],
    messages: [],
  },
});

// Subscribe to thinking events
agent.subscribe((event) => {
  if (
    event.type === "content_block_delta" &&
    event.delta.type === "thinking_delta"
  ) {
    console.log("[Thinking]", event.delta.thinking);
  }
});
```

For OpenAI Responses API models that support reasoning, you can also request
`reasoningSummary` (auto/concise/detailed) via `AgentRunConfig`. Composer will
validate that the model is `openai-responses` and marked `reasoning: true`.

## Agent State

Access the agent's current state:

```typescript
const state = agent.state;

console.log("Model:", state.model.id);
console.log("Messages:", state.messages.length);
console.log("Tools:", state.tools.map((t) => t.name));
console.log("Streaming:", state.streaming);
console.log("Thinking level:", state.thinkingLevel);
```

## Message Types

The SDK uses strongly-typed messages:

```typescript
import type {
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  Message,
} from "@evalops/ai";

// User message
const userMsg: UserMessage = {
  role: "user",
  content: "Hello!",
  timestamp: Date.now(),
};

// User message with image
const imageMsg: UserMessage = {
  role: "user",
  content: [
    { type: "text", text: "What's in this image?" },
    { type: "image", source: { type: "base64", data: "...", mediaType: "image/png" } },
  ],
  timestamp: Date.now(),
};

// Assistant message (from LLM response)
const assistantMsg: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "Hello! How can I help?" }],
  usage: { input: 10, output: 8, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
  timestamp: Date.now(),
};

// Tool result
const toolResult: ToolResultMessage = {
  role: "toolResult",
  toolCallId: "call_123",
  toolName: "get_weather",
  content: [{ type: "text", text: "72°F, sunny" }],
  isError: false,
  timestamp: Date.now(),
};
```

## Direct Transport Usage

For lower-level control, use the transport directly:

```typescript
import { ProviderTransport, type AgentRunConfig } from "@evalops/ai";

const transport = new ProviderTransport({
  getApiKey: () => process.env.ANTHROPIC_API_KEY,
});

const config: AgentRunConfig = {
  systemPrompt: "You are helpful.",
  model: getModel("anthropic", "claude-sonnet-4-5-20250929")!,
  tools: [],
};

const messages = [{ role: "user", content: "Hi!", timestamp: Date.now() }];
const userMessage = { role: "user", content: "Hello!", timestamp: Date.now() };

// Stream events directly
for await (const event of transport.run(messages, userMessage, config)) {
  console.log(event.type, event);
}
```

## Error Handling

```typescript
agent.subscribe((event) => {
  if (event.type === "error") {
    if (event.error.code === "rate_limit") {
      console.log("Rate limited, retrying...");
    } else if (event.error.code === "context_overflow") {
      console.log("Context too large, consider compacting");
    } else {
      console.error("Unexpected error:", event.error.message);
    }
  }
});

// Or use try/catch with prompt
try {
  await agent.prompt("Hello!");
} catch (error) {
  console.error("Prompt failed:", error);
}
```

## Type Reference

### Core Types

| Type | Description |
|------|-------------|
| `Agent` | Main class for LLM interactions |
| `AgentState` | Current state of an agent |
| `AgentEvent` | Events emitted during execution |
| `ProviderTransport` | Low-level transport for LLM calls |

### Message Types

| Type | Description |
|------|-------------|
| `Message` | Union of all message types |
| `UserMessage` | Message from user |
| `AssistantMessage` | Response from LLM |
| `ToolResultMessage` | Result from tool execution |

### Content Types

| Type | Description |
|------|-------------|
| `TextContent` | Plain text block |
| `ImageContent` | Base64-encoded image |
| `ThinkingContent` | Extended reasoning trace |
| `ToolCall` | Tool invocation in response |

### Configuration Types

| Type | Description |
|------|-------------|
| `Model` | LLM model configuration |
| `Tool` | Tool definition schema |
| `AgentTool` | Tool with execute function |
| `AgentRunConfig` | Runtime configuration |
| `ThinkingLevel` | Extended thinking level |

## Testing

```bash
npm run test
```

## License

MIT
