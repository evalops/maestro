# Headless Protocol

Maestro's headless mode is the embedding-oriented JSON-over-stdio protocol used by native TUIs and external control planes such as EvalOps Chat.

The protocol is line-delimited JSON:

- one JSON object per line
- stdin carries control/input messages into Maestro
- stdout carries runtime events out of Maestro
- stderr should be treated as diagnostics only

## Compatibility

The `ready` event includes `protocol_version`. Consumers should treat unknown fields as additive and ignore them unless explicitly required.

Current version:

- `2026-03-30`

## Input Messages

### `init`

Applies runtime configuration before or between prompts.

```json
{
  "type": "init",
  "system_prompt": "You are a release engineer.",
  "append_system_prompt": "Prefer small diffs.",
  "thinking_level": "medium",
  "approval_mode": "prompt"
}
```

Supported fields:

- `system_prompt`
- `append_system_prompt`
- `thinking_level`
- `approval_mode`

### `prompt`

Starts or continues a run.

```json
{
  "type": "prompt",
  "content": "Refactor the auth module",
  "attachments": ["/workspace/src/auth.ts"]
}
```

### `tool_response`

Resolves an approval-gated tool call.

```json
{
  "type": "tool_response",
  "call_id": "call_123",
  "approved": true
}
```

### `interrupt`

Requests that the current run abort cleanly.

### `cancel`

Alias for `interrupt` intended for external control planes.

### `shutdown`

Gracefully terminates the headless process.

## Output Messages

### `ready`

Emitted once at startup.

```json
{
  "type": "ready",
  "protocol_version": "2026-03-30",
  "model": "claude-opus-4-6",
  "provider": "anthropic",
  "session_id": null
}
```

### `session_info`

Describes the current runtime context.

```json
{
  "type": "session_info",
  "session_id": null,
  "cwd": "/workspace",
  "git_branch": "main"
}
```

### `response_start`

Marks the start of an assistant response.

### `response_chunk`

Streams assistant content.

```json
{
  "type": "response_chunk",
  "response_id": "msg_123",
  "content": "Let me inspect the file...",
  "is_thinking": false
}
```

`is_thinking=true` indicates reasoning/thinking output.

### `response_end`

Ends an assistant response and reports usage + execution telemetry.

```json
{
  "type": "response_end",
  "response_id": "msg_123",
  "usage": {
    "input_tokens": 1200,
    "output_tokens": 450,
    "cache_read_tokens": 0,
    "cache_write_tokens": 0,
    "total_tokens": 1650,
    "total_cost_usd": 0.0241,
    "model_id": "claude-opus-4-6",
    "provider": "anthropic"
  },
  "tools_summary": {
    "tools_used": ["read", "bash"],
    "calls_succeeded": 2,
    "calls_failed": 0
  },
  "duration_ms": 3812,
  "ttft_ms": 412
}
```

### `tool_call`

Announces a tool invocation. `requires_approval=true` means the caller must reply with `tool_response`.

### `tool_start`

Marks the start of tool execution.

### `tool_output`

Streams tool output text when available.

### `tool_end`

Marks the end of tool execution.

### `status`

Low-priority human-readable runtime status.

### `error`

Reports a recoverable or fatal error.

```json
{
  "type": "error",
  "message": "Rate limit exceeded",
  "fatal": false,
  "error_type": "transient"
}
```

Supported `error_type` values:

- `transient`
- `fatal`
- `tool`
- `cancelled`
- `protocol`

## Notes for Embedders

- Treat `response_chunk` as append-only.
- Do not require a specific ordering between tool lifecycle events and status events beyond what is explicitly documented.
- Persist `response_end.usage` rather than trying to reconstruct token or cost totals from chunks.
- Prefer `init` over command-line string interpolation when injecting system prompt, approval mode, or thinking configuration.
