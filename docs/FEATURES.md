# Features

- Native interactive terminal UI and trailing prompts
- Print, exec, JSON output, output schemas, and NDJSON headless protocol
- OpenAI/Codex, Anthropic, Google, Bedrock, Vertex, OpenRouter, and compatible providers
- Built-in filesystem, shell, search, web, browser, document, and delegation tools
- Permission profiles, sandboxing, approvals, hooks, Lua, and WASM extensions
- Persistent sessions, resume/export/import, usage and cost accounting
- Web runtime gateway with SSE/WebSocket chat, automations, A2A, hosted runners, telemetry, and model management
- Scripted scenarios, replay, trajectory evaluation, and protocol conformance
- Slack and GitHub adapters backed by the native runtime gateway

All product execution, browser runtime-gateway, and adapter behavior runs through Rust. The browser client is a checked-in static asset snapshot served by the native runtime gateway.
