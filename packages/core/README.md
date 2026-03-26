# @evalops/maestro-core

Agent loop, transport, types, and sandbox primitives — the engine behind all Maestro interfaces.

## Install

```bash
npm install @evalops/maestro-core
```

## What's Included

- **Agent** — event-driven LLM interaction loop with streaming, tool execution, and context management
- **ProviderTransport** — multi-provider LLM communication (Anthropic, OpenAI, Google, Groq, Bedrock)
- **SubagentSpecs** — role-based tool whitelisting (explorer, coder, reviewer, researcher, planner)
- **ContextHandoff** — automatic context overflow detection and session handoff
- **DaytonaSandbox** — remote sandbox execution via Daytona SDK
- **Swarm types** — task scheduling with dependencies for parallel agent execution
- **Background task primitives** — restart policies, status types, health snapshots

## Usage

```typescript
import { Agent, ProviderTransport, getSubagentSpec } from '@evalops/maestro-core'
import { DaytonaSandbox } from '@evalops/maestro-core/sandbox'

// Create a sandbox for isolated execution
const sandbox = await DaytonaSandbox.create({
  apiKey: process.env.DAYTONA_API_KEY,
  language: 'python',
})

// Execute code
const result = await sandbox.exec('echo "hello from Maestro"')
console.log(result.stdout) // "hello from Maestro"

// Clean up
await sandbox.dispose()
```

## Message Types

Maestro uses its own provider-agnostic message format internally. This differs from individual provider APIs (Anthropic, OpenAI, etc.) — the `ProviderTransport` handles translation automatically.

| Maestro Internal | Anthropic API | OpenAI API |
|-----------------|---------------|------------|
| `role: "user"` | `role: "user"` | `role: "user"` |
| `role: "assistant"` | `role: "assistant"` | `role: "assistant"` |
| `role: "toolResult"` | `role: "tool"` | tool results in messages |
| `type: "text"` | `type: "text"` | `content: string` |
| `type: "toolCall"` | `type: "tool_use"` | `tool_calls[]` |
| `type: "thinking"` | `type: "thinking"` | reasoning tokens |

Use the type guards to safely narrow message types:

```typescript
import { isUserMessage, isToolCall, isTextContent } from '@evalops/maestro-core'

if (isUserMessage(msg)) {
  // msg.role === "user"
}

for (const block of msg.content) {
  if (isTextContent(block)) {
    console.log(block.text)
  } else if (isToolCall(block)) {
    console.log(block.name, block.input) // block.type === "toolCall"
  }
}
```

## Subagent Roles

Control which tools each agent role can access:

| Role | Read | Write | Shell | Web | GitHub | MCP | Confirmation |
|------|------|-------|-------|-----|--------|-----|-------------|
| **explorer** | yes | no | no | no | no | no | no |
| **planner** | yes | no | no | no | no | no | no |
| **coder** | yes | yes | yes | no | yes | yes | yes |
| **reviewer** | yes | no | no | yes | no | no | no |
| **researcher** | yes | no | no | yes | no | yes | no |
| **minimal** | yes | no | no | no | no | no | no |

```typescript
import { isToolAllowed, filterToolsForSubagent } from '@evalops/maestro-core'

// Check individual tools
isToolAllowed('bash', 'explorer')   // false
isToolAllowed('bash', 'coder')     // true
isToolAllowed('websearch', 'coder') // false (web is for researchers)

// Filter a tool array by role
const coderTools = filterToolsForSubagent(allTools, 'coder')
```

## DaytonaSandbox

Secure remote code execution via [Daytona](https://daytona.io):

```typescript
import { DaytonaSandbox } from '@evalops/maestro-core/sandbox'

const sandbox = await DaytonaSandbox.create({
  apiKey: 'your-daytona-key',
  language: 'typescript', // python, typescript, javascript
  ephemeral: true,        // auto-delete on dispose
})

// Execute with env vars and working directory
const result = await sandbox.exec('npm test', '/app', {
  NODE_ENV: 'test',
  CI: 'true',
})

// File operations
await sandbox.writeFile('/app/config.json', '{"key": "value"}')
const content = await sandbox.readFile('/app/config.json')
const exists = await sandbox.exists('/app/config.json')
const files = await sandbox.list('/app')
await sandbox.delete('/app/temp', true) // recursive

await sandbox.dispose()
```

## Exports

### Main (`@evalops/maestro-core`)

- `Agent`, `AgentOptions` — agent loop
- `ProviderTransport`, `ProviderTransportOptions` — LLM streaming
- `getSubagentSpec`, `isToolAllowed`, `getAllowedTools`, `filterToolsForSubagent`, `TOOL_CATEGORIES` — role-based access
- `ContextHandoffManager`, `HandoffContext`, `ContextThresholds` — session management
- `isUserMessage`, `isAssistantMessage`, `isToolResultMessage`, `isTextContent`, `isToolCall` — type guards
- `createRestartPolicy`, `canRestart`, `computeRestartDelay`, `incrementAttempts` — restart logic
- `formatTaskSummary`, `formatUsageSummary` — display helpers
- Types: `AgentState`, `AgentEvent`, `AgentRunConfig`, `Message`, `UserMessage`, `AssistantMessage`, `ToolResultMessage`, `TextContent`, `ToolCall`, `SubagentType`, `SubagentSpec`, `RestartPolicy`, `BackgroundTaskStatus`, `BackgroundTaskNotification`, `BackgroundTaskHealth`

### Sandbox (`@evalops/maestro-core/sandbox`)

- `DaytonaSandbox`, `DaytonaSandboxConfig` — Daytona implementation
- `Sandbox`, `ExecResult` — interface types

### Swarm (`@evalops/maestro-core/swarm`)

- `parsePlanContent`, `parsePlanFile` — markdown plan parsing
- Types: `SwarmConfig`, `SwarmState`, `SwarmStatus`, `SwarmEvent`, `SwarmTask`, `SwarmTeammate`, `TeammateStatus`, `ParsedPlan`, `SwarmEventHandler`
