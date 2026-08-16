# Architecture

Maestro has one product runtime: the canonical Rust `maestro` executable.

```text
CLI / TUI / headless / hosted runner ─┐
                                      ├─ packages/maestro-rs
Browser / Slack / GitHub adapters ─HTTP─ packages/runtime-gateway-rs
                                      └─ packages/tui-rs agent core
```

`packages/maestro-rs` classifies commands and invokes Rust libraries in-process. `packages/tui-rs` owns providers, model routing, tools, permissions, sessions, hooks, the terminal UI, and the headless protocol. `packages/runtime-gateway-rs` owns HTTP, SSE, WebSocket, A2A, automation, session, telemetry, and static-web routes.

The browser UI and service adapters may use TypeScript as presentation or transport code. They do not construct agents, load providers, or provide execution fallbacks. They call the Rust runtime gateway.

Release artifacts contain a single native executable per supported platform. The npm package's `bin/maestro` is a shell selector for the packaged executable and requires no Node.js or Bun runtime.
