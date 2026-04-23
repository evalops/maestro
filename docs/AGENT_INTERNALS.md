# Agent Internals

This document describes the internal architecture of the Maestro agent system, including the transport layer, tool execution flow, and context management.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         TUI Renderer                            │
│  (User Interface, Command Handling, Session Management)         │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                           Agent                                  │
│  (State Management, Message Orchestration)                       │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      ProviderTransport                           │
│  (LLM Communication, Tool Execution, Session Limits)             │
├─────────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐           │
│  │  Anthropic   │  │   OpenAI     │  │   Google     │           │
│  │   Provider   │  │   Provider   │  │   Provider   │           │
│  └──────────────┘  └──────────────┘  └──────────────┘           │
└─────────────────────────────────────────────────────────────────┘
```

## Local Checkpoint Profiling

Set `MAESTRO_STARTUP_PROFILE=1` to print startup checkpoints such as
`process:start`, `config:loaded`, `tools:prepared`, `mcp:bootstrap_queued`, and
the selected runtime readiness checkpoint. Startup checkpoints include RSS memory
snapshots so cold-start regressions are easier to spot in local or CI logs.

Set `MAESTRO_QUERY_PROFILE=1` to print per-turn checkpoints for prompt handling
and first-token latency. Query profiling records fixed labels only, including
`input:received`, `context:loaded`, `prompt:assembled`, `tools:prepared`,
`model:request:start`, `model:first-token`, and terminal `turn:*` checkpoints.
Profiler detail fields are constrained and redact prompt text, tokens, tool
arguments, message bodies, and other free-form user content.

## Transport Layer (`src/agent/transport.ts`)

The `ProviderTransport` class is the core of the agent's communication layer.

### Key Responsibilities

1. **Credential Resolution**: Resolves API keys/OAuth tokens from multiple sources
2. **Message Streaming**: Streams responses from LLM providers
3. **Tool Execution**: Orchestrates tool calls with approval, hooks, and firewall checks
4. **Session Limits**: Enforces policy-based session limits (tokens, duration)
5. **Rate Limiting**: Prevents doom loops and rate-limits tool calls

### Execution Flow

```
1. Credential Resolution
   └── getAuthContext() → getApiKey() → env vars → stored credentials

2. Message Streaming Loop
   ├── Check session limits (duration, tokens)
   ├── Process queued messages
   ├── Stream from provider (Anthropic/OpenAI/Google)
   │   ├── Handle text deltas
   │   ├── Handle thinking deltas
   │   └── Collect tool calls
   └── Execute tool calls
       ├── Check doom loop prevention
       ├── Check rate limits
       ├── Run PreToolUse hooks
       ├── Run action firewall (safety checks)
       ├── Request user approval if needed
       ├── Execute tool
       ├── Run PostToolUse hooks
       └── Apply workflow state hooks
```

### Error Recovery

The transport layer includes several error recovery mechanisms:

1. **Network-level retries** (`src/providers/network-config.ts`)
   - Configurable retry count and backoff
   - Automatic retry on 429, 5xx status codes
   - Retry on network errors (timeout, connection reset)

2. **Tool execution recovery**
   - Graceful error handling for tool failures
   - Workflow state error handling
   - Audit logging for sensitive tools

3. **Session recovery** (`src/agent/session-recovery.ts`)
   - Automatic session backup
   - Recovery from crashes

## Tool Execution (`src/tools/`)

### Tool Definition Pattern

Tools use the `createTool` DSL from `src/tools/tool-dsl.ts`:

```typescript
export const myTool = createTool<typeof mySchema, MyDetails>({
  name: "my_tool",
  label: "My Tool",
  description: "Does something useful",
  schema: mySchema,
  run: async (params, { respond, signal }) => {
    // Tool implementation
    return respond.text("Result").detail({ ... });
  },
});
```

### Tool Lifecycle Hooks

Hooks can intercept tool execution at key points:

1. **PreToolUse**: Before tool execution, can modify args or block
2. **PostToolUse**: After tool execution, can modify result
3. **Notification**: For informational purposes only

Configure hooks in `.maestro/hooks.json`:

```json
{
  "hooks": [
    {
      "type": "PreToolUse",
      "tool": "bash",
      "command": ["./validate-command.sh", "${command}"]
    }
  ]
}
```

### Tool Result Caching (`src/tools/tool-result-cache.ts`)

Caches tool results for efficiency:
- LRU eviction
- Git SHA tracking for invalidation
- Selective invalidation by tool type

Cache invalidation (`src/tools/cache-invalidation.ts`):
- File watcher integration
- Git state change detection
- Pattern-based full cache clear

## Context Management

### Session State (`src/session/`)

- **SessionManager**: Handles session lifecycle
- **Session metadata**: Model info, timestamps, token usage
- **Session recovery**: Automatic backups, crash recovery

### Context Provider (`src/agent/context-manager.ts`)

Manages conversation context:
- Message history
- Token budget tracking
- Auto-compaction when limits approached

### Workflow State (`src/safety/workflow-state.ts`)

Tracks PII and sensitive data through the conversation:
- Pending PII artifacts
- Redaction tracking
- Egress policy enforcement

## Safety Layer (`src/safety/`)

### Action Firewall (`src/safety/action-firewall.ts`)

Multi-layer security checks:
1. **Firewall rules**: Pattern-based blocking
2. **Semantic judge**: LLM-based content analysis
3. **PII detection**: Sensitive data identification

### Enterprise Policy (`src/safety/policy.ts`)

Enforces organizational policies:
- Tool allowlists/blocklists
- Path restrictions
- Network restrictions (hosts, private IPs)
- Session limits (tokens, duration, concurrent)
- Model restrictions
- Dependency restrictions

Policy file: `~/.maestro/policy.json`

```json
{
  "orgId": "my-org",
  "tools": {
    "blocked": ["bash"]
  },
  "limits": {
    "maxTokensPerSession": 100000,
    "maxSessionDurationMinutes": 60
  }
}
```

## Provider Integration (`src/agent/providers/`)

### Streaming Protocol

Each provider implements the same streaming interface:

```typescript
async function* streamProvider(
  model: Model,
  context: Context,
  options: StreamOptions
): AsyncGenerator<AssistantMessageEvent> {
  // Yields events: start, text_delta, thinking_delta, toolcall_delta, toolcall_end, done, error
}
```

### Provider-Specific Configuration

Network configuration (`~/.maestro/providers.json`):

```json
{
  "anthropic": {
    "timeout": 120000,
    "maxRetries": 3,
    "streamIdleTimeout": 300000
  }
}
```

Environment overrides:
- `MAESTRO_PROVIDER_TIMEOUT_MS`
- `MAESTRO_PROVIDER_MAX_RETRIES`
- `MAESTRO_STREAM_IDLE_TIMEOUT_MS`

## OAuth Integration (`src/oauth/`)

### Supported Providers

1. **Anthropic**: Claude Pro/Max subscriptions
2. **OpenAI**: ChatGPT Plus subscriptions
3. **GitHub Copilot**: GitHub Copilot subscriptions
4. **Google Gemini CLI**: Cloud Code Assist OAuth
5. **Google Antigravity**: Antigravity sandbox OAuth

### Credential Storage

Credentials stored in `~/.maestro/oauth.json`:

```json
{
  "anthropic": {
    "type": "oauth",
    "refresh": "...",
    "access": "...",
    "expires": 1234567890,
    "metadata": { "mode": "pro" }
  }
}
```

### Token Refresh

Automatic token refresh when:
- Token expires or is within 1 minute of expiry
- Refresh fails → credentials removed

## Telemetry & Tracking

### Cost Tracking (`src/tracking/cost-tracker.ts`)

Tracks token usage and costs:
- Per-session usage
- Per-model costs
- Cache hit/miss rates

### Audit Logging (`src/enterprise/audit-integration.ts`)

Enterprise audit trail for:
- Sensitive tool executions
- Policy violations
- Authentication events

## Key Files Reference

| File | Purpose |
|------|---------|
| `src/agent/transport.ts` | Core transport layer |
| `src/agent/agent.ts` | Agent state machine |
| `src/tools/tool-dsl.ts` | Tool definition DSL |
| `src/safety/policy.ts` | Enterprise policy enforcement |
| `src/safety/action-firewall.ts` | Security firewall |
| `src/oauth/index.ts` | OAuth integration |
| `src/providers/network-config.ts` | Network retry configuration |
| `src/session/manager.ts` | Session management |
| `src/cli-tui/tui-renderer.ts` | Terminal UI |
