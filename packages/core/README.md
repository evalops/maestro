# @evalops/maestro-core

Agent loop, transport, types, and sandbox primitives — the engine behind all Maestro interfaces.

## Install

```bash
npm install @evalops/maestro-core
```

## What's Included

- **Agent** — event-driven LLM interaction loop with streaming, tool execution, and context management
- **ProviderTransport** — multi-provider LLM communication (Anthropic, OpenAI, Google, Groq)
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
