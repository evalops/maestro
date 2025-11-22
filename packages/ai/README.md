# @evalops/ai

Shared Composer AI SDK that exposes the model registry, provider-agnostic transport, and agent event stream primitives used by the CLI, TUI, and web UI.

## Install

```bash
npm install @evalops/ai
```

## API Surface

- **Models**: `getProviders()`, `getModels(provider)`, `getModel(provider, id)`
- **Transport**: `ProviderTransport` for streaming assistant + tool events
- **Types**: `Model`, `AgentEvent`, `AgentRunConfig`, `Message`, `Tool`, `ToolResultMessage`, `ReasoningEffort`, `ThinkingLevel`, `StreamOptions`

## Quick Start

```typescript
import { ProviderTransport, getModel, type AgentRunConfig } from "@evalops/ai";

const transport = new ProviderTransport({
  getApiKey: () => process.env.OPENAI_API_KEY,
});

const model = getModel("openai", "gpt-4o-mini");
const userMessage = { role: "user", content: "Hello!", timestamp: Date.now() };
const cfg: AgentRunConfig = { systemPrompt: "Be helpful", model!, tools: [] };

for await (const event of transport.run([], userMessage, cfg)) {
  console.log(event);
}
```

## Testing

```bash
npm run test --workspaces --if-present
```

## License

MIT
