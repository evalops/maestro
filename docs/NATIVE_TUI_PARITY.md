# Native Runtime Parity

The Rust cutover is complete. The canonical `maestro` binary covers interactive TUI, print/exec, structured output, headless protocol, hosted runner, web chat, sessions, providers, tools, approvals, hooks, replay/scenarios, A2A, automations, telemetry, and model management.

Parity is protected by Rust unit and integration suites, native trajectory fixtures, the scenario replay gate, control-plane web-contract tests, adapter suites, and a static guard that rejects TypeScript source.

Any new product behavior must be implemented in the Rust crates. TypeScript source and a TypeScript build toolchain are not part of the repository.
