# Headless Protocol Reference

Maestro's headless mode is the embedding-oriented JSON-over-stdio contract used
by native TUIs and external control planes such as EvalOps Chat.

Transport rules:

- stdin carries one JSON object per line into Maestro
- stdout emits one JSON object per line back to the client
- stderr is diagnostics only and is not part of the protocol contract
- startup failures should emit a fatal `error` protocol message on stdout when
  the headless transport has been requested, with human diagnostics on stderr

## Compatibility

The protocol is versioned. The runtime sends the version in `ready` and
`hello_ok`, and clients may send their version in `hello`.

Current version: `2026-04-02`

Source of truth:

- generated constants: [packages/contracts/src/headless-protocol-generated.ts](../../packages/contracts/src/headless-protocol-generated.ts)
- runtime message shapes: [src/cli/headless-protocol.ts](../../src/cli/headless-protocol.ts)
- transport implementation: [src/cli/headless.ts](../../src/cli/headless.ts)

Compatibility expectations:

- treat unknown fields as additive
- reject unknown message `type` values unless your client intentionally ignores them
- compare `protocol_version` during handshake when you require exact compatibility

## Handshake

Typical controller flow:

1. Client starts Maestro in headless mode.
2. Client sends `hello`.
3. Maestro replies with `hello_ok`.
4. Maestro emits `ready`.
5. Client optionally sends `init`.
6. Client sends `prompt`.

Minimal hello:

```json
{
  "type": "hello",
  "protocol_version": "2026-04-02",
  "client_info": {
    "name": "evalops-chat",
    "version": "0.1.0"
  },
  "role": "controller"
}
```

Handshake acknowledgement:

```json
{
  "type": "hello_ok",
  "protocol_version": "2026-04-02",
  "connection_id": "conn_123",
  "client_protocol_version": "2026-04-02",
  "role": "controller"
}
```

Initial runtime state:

```json
{
  "type": "ready",
  "protocol_version": "2026-04-02",
  "model": "claude-opus-4-6",
  "provider": "anthropic",
  "session_id": null
}
```

## Roles, Capabilities, And Notifications

Connection roles:

- `controller`
  - may send prompts, approvals, utility commands, and shutdown
- `viewer`
  - read-only subscriber role

Negotiated client capabilities in `hello.capabilities`:

- `server_requests`
  - supported request classes for approval and control-plane callbacks
- `utility_operations`
  - `command_exec`, `file_search`, `file_watch`, `file_read`
- `raw_agent_events`
  - opt into raw internal agent events

Optional notification opt-outs in `hello.opt_out_notifications`:

- `status`
- `heartbeat`
- `connection_info`
- `compaction`

## Client To Maestro Messages

### Run Control

- `hello`
  - handshake and capability negotiation
- `init`
  - runtime configuration such as `system_prompt`, `append_system_prompt`,
    `thinking_level`, and `approval_mode`
- `prompt`
  - starts or continues a run; supports `attachments`
- `interrupt`
  - requests clean cancellation of the active run
- `cancel`
  - alias for `interrupt`
- `shutdown`
  - graceful process termination

### Approval And Callback Responses

- `tool_response`
  - resolves a legacy approval-gated tool call via `call_id`
- `client_tool_result`
  - returns structured content for a client-executed tool
- `server_request_response`
  - resolves a `server_request` using `request_id` and `request_type`

Supported `server_request_response.request_type` values:

- `approval`
- `client_tool`
- `mcp_elicitation`
- `user_input`
- `tool_retry`

### Utility Operations

- `utility_command_start`
- `utility_command_terminate`
- `utility_command_stdin`
- `utility_command_resize`
- `utility_file_search`
- `utility_file_read`
- `utility_file_watch_start`
- `utility_file_watch_stop`

## Maestro To Client Messages

### Session And Connection State

- `hello_ok`
  - handshake acknowledgement
- `ready`
  - runtime-ready event with protocol version and active model/provider
- `session_info`
  - current `session_id`, `cwd`, and `git_branch`
- `connection_info`
  - current connection graph, controller lease, and subscriber state
- `compaction`
  - session compaction summary and token counts

### Assistant Response Lifecycle

- `response_start`
- `response_chunk`
  - streamed text or thinking; `is_thinking=true` marks reasoning content
- `response_end`
  - final usage and execution telemetry

`response_end` is the authoritative place to read:

- `usage`
  - `input_tokens`
  - `output_tokens`
  - `cache_read_tokens`
  - `cache_write_tokens`
  - `total_tokens`
  - `total_cost_usd`
  - `model_id`
  - `provider`
- `tools_summary`
  - `tools_used`
  - `calls_succeeded`
  - `calls_failed`
  - `summary_labels`
- `duration_ms`
- `ttft_ms`

### Tool And Server Request Lifecycle

- `tool_call`
- `tool_start`
- `tool_output`
- `tool_end`
- `client_tool_request`
- `server_request`
- `server_request_resolved`

Supported `server_request.resolution` values:

- `approved`
- `denied`
- `completed`
- `failed`
- `answered`
- `retried`
- `skipped`
- `aborted`
- `cancelled`

Supported `server_request.resolved_by` values:

- `user`
- `policy`
- `client`
- `runtime`

Supported `server_request_response.decision_action` values for tool retries:

- `retry`
- `skip`
- `abort`

### Utility Operation Events

- `utility_command_started`
- `utility_command_resized`
- `utility_command_output`
- `utility_command_exited`
- `utility_file_search_results`
- `utility_file_read_result`
- `utility_file_watch_started`
- `utility_file_watch_event`
- `utility_file_watch_stopped`

### Status And Diagnostics

- `status`
  - human-readable runtime status
- `error`
  - recoverable or fatal error classification
- `raw_agent_event`
  - full internal agent event stream when the client negotiated
    `raw_agent_events=true`

Supported `error_type` values:

- `transient`
- `fatal`
- `tool`
- `cancelled`
- `protocol`

## Embedder Notes

- Treat `response_chunk` as append-only.
- Persist `response_end.usage` and `response_end.tools_summary` instead of
  reconstructing totals from streamed chunks.
- Use `init` instead of shell-interpolating system prompts or approval mode.
- Viewer connections are intentionally limited; use `controller` for active
  orchestration.
- Prefer `server_request` / `server_request_response` for new control-plane
  integrations. `tool_call` / `tool_response` remains for legacy approval
  compatibility.

## Platform Event Bus

Managed EvalOps deployments can mirror the headless runtime surface onto the
shared platform event bus without enabling user training telemetry. Set
`MAESTRO_EVENT_BUS_URL` or `EVALOPS_NATS_URL` to publish typed CloudEvents to
JetStream subjects that match platform's `maestro.*` event catalog.

The shared publisher lives in `@evalops/ai/telemetry` and currently emits:

- `maestro.sessions.session.started|suspended|resumed|closed`
- `maestro.events.approval_hit`
- `maestro.events.sandbox_violation`
- `maestro.events.firewall_block`
- `maestro.events.tool_call.attempted|completed`
- `maestro.events.prompt_variant.selected`
- `maestro.events.skill.invoked|succeeded|failed`
- `maestro.events.eval.scored`

`MAESTRO_TELEMETRY` continues to control local training and diagnostic
telemetry. Audit-bus publishing is controlled separately with
`MAESTRO_EVENT_BUS`; set it to `0` or `false` to suppress bus writes even when
managed EvalOps routing is active.

For the larger remote-attach and control-plane architecture, see the companion
design document: [docs/design/HEADLESS_CONTROL_PLANE.md](../design/HEADLESS_CONTROL_PLANE.md).
