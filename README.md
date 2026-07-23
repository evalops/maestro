# Maestro

Maestro is EvalOps' native Rust coding agent. One `maestro` executable owns the CLI, interactive terminal UI, headless protocol, hosted runner, and web control plane. Node.js and Bun are not required to run the product.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/evalops/maestro/main/scripts/install.sh | bash
maestro --version
```

Release assets are named `maestro-darwin-arm64`, `maestro-darwin-x64`, `maestro-linux-arm64`, and `maestro-linux-x64`. The npm package contains the same native binaries and a POSIX launcher; it does not execute JavaScript at runtime.

## Use

```sh
maestro                         # interactive TUI
maestro "fix the failing test" # interactive with an initial prompt
maestro exec "summarize this repository"
maestro --headless              # NDJSON protocol over stdio
maestro web --port 3000         # browser UI and HTTP control plane
maestro hosted-runner
```

## Develop

Rust owns every agent/runtime path:

- `packages/maestro-rs` — canonical executable and command dispatch
- `packages/tui-rs` — agent core, providers, tools, TUI, and headless runtime
- `packages/control-plane-rs` — HTTP/SSE/WebSocket control plane

The repository contains no TypeScript source or TypeScript build toolchain. The browser UI is a versioned static asset snapshot served by the Rust control plane; agent execution, protocols, adapters, CLI, and TUI are Rust.

```sh
cargo test --workspace --locked
npm run check:rust-only-runtime
```

See [Architecture](docs/ARCHITECTURE.md), [Quickstart](docs/QUICKSTART.md), and [Web UI](docs/WEB_UI.md).
