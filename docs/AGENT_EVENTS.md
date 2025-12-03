# Agent Event Reference

Event names emitted by Composer’s agent loop (mirrors web/TUI clients and RPC).

- **agent_start / agent_end** — lifecycle boundaries; `agent_end` includes `aborted` and optional `partialAccepted`.
- **turn_start / turn_end** — each LLM turn; `turn_end` provides the assistant message and any tool results generated in that turn.
- **message_start / message_update / message_end** — streaming lifecycle for a single assistant message. `message_update` carries `assistantMessageEvent` deltas.
- **assistantMessageEvent** (inside `message_update`)  
  - `text_delta` — incremental text.  
  - `thinking_start` / `thinking_delta` / `thinking_end` — streamed thinking blocks.  
  - `toolcall_start` / `toolcall_delta` / `toolcall_end` — streamed tool arguments; `_delta` exposes partial args for progressive UIs.  
  - `done` — final assistant message with usage + stop reason.  
  - `error` — partial assistant message plus error metadata.
- **tool_execution_start / tool_execution_end** — real tool execution lifecycle with resolved args/result and error flag.
- **status** — progress pulses (rare; long-running flows).
- **error** — fatal errors unrelated to message streaming.

Client notes
- Web/TUI should render partial tool arguments from `toolcall_delta` for early visibility, and keep tool state keyed by `toolCallId`.
- When switching providers mid-session, thinking blocks from older providers are converted to `<thinking>...</thinking>` text so all providers can consume the history safely.
