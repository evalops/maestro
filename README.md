# Maestro

Maestro is EvalOps' native Rust coding agent. One `maestro` executable owns the CLI, interactive terminal UI, headless protocol, hosted runner, and web runtime gateway. Node.js and Bun are not required to run the product.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/evalops/maestro/main/scripts/install.sh | bash
maestro --version
```

The installer verifies the release checksum manifest and Cosign signatures when the release provides them, stages binaries and web assets under a versioned data directory, and swaps only the launcher. Set `MAESTRO_REQUIRE_SIGNED_INSTALL=1` to refuse legacy releases without signed metadata.

Release assets are named `maestro-darwin-arm64`, `maestro-darwin-x64`, `maestro-linux-arm64`, and `maestro-linux-x64`. The npm package contains the same native binaries and a POSIX launcher; it does not execute JavaScript at runtime.

## Use

```sh
maestro                         # interactive TUI
maestro setup                   # check auth/config and show the next setup step
maestro "fix the failing test" # interactive with an initial prompt
maestro exec "summarize this repository"
maestro --headless              # NDJSON protocol over stdio
maestro web --port 3000         # browser UI and HTTP runtime gateway
maestro hosted-runner
```

## Develop

Rust owns every agent/runtime path:

- `packages/maestro-rs` — canonical executable and command dispatch
- `packages/tui-rs` — agent core, providers, tools, TUI, and headless runtime
- `packages/runtime-gateway-rs` — HTTP/SSE/WebSocket runtime gateway

The repository contains no TypeScript source or TypeScript build toolchain. The browser UI is a versioned static asset snapshot served by the Rust runtime gateway; agent execution, protocols, adapters, CLI, and TUI are Rust.

```sh
cargo test --workspace --locked
npm run check:rust-only-runtime
```

See [Architecture](docs/ARCHITECTURE.md), [Quickstart](docs/QUICKSTART.md), and [Web UI](docs/WEB_UI.md).
