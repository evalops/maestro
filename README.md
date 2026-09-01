# Deixic Code

Deixic Code is Deixic's native Rust coding agent. One native runtime owns the
CLI, interactive terminal UI, headless protocol, hosted runner, and web runtime
gateway. Node.js and Bun are not required to run the product. Existing
`maestro` protocols and machine coordinates remain supported compatibility
identifiers.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/evalops/maestro/main/scripts/install.sh | bash
deixic-code --version
```

Opt into a preview channel when you want builds ahead of stable. Alpha tracks
the newest source; beta is deliberately one source commit and one patch line
behind alpha:

```sh
curl -fsSL https://raw.githubusercontent.com/evalops/maestro/main/scripts/install.sh | MAESTRO_INSTALL_CHANNEL=beta bash
curl -fsSL https://raw.githubusercontent.com/evalops/maestro/main/scripts/install.sh | MAESTRO_INSTALL_CHANNEL=alpha bash
npm install -g @evalops/maestro@beta
npm install -g @evalops/maestro@alpha
```

The public repository and `@evalops/maestro` package remain supported
compatibility coordinates during the publication migration. Both install the
canonical `deixic-code` command and the retained `maestro` alias. See the
[compatibility matrix](docs/DEIXIC_CODE_MIGRATION.md).

The installer verifies the release checksum manifest and Cosign signatures when the release provides them, stages binaries and web assets under a versioned data directory, and swaps only the launcher. Set `MAESTRO_REQUIRE_SIGNED_INSTALL=1` to refuse legacy releases without signed metadata.

Installed interactive sessions check for updates on startup and apply newer releases before opening the TUI. The check is bounded and failures never block startup. Set `MAESTRO_AUTO_UPDATE=0` to opt out, `MAESTRO_AUTO_UPDATE=check` to show availability without installing, or use `deixic-code update --check` for an explicit check. Use `deixic-code update --channel beta` or `deixic-code update --channel alpha` for a one-time channel update; channel installers persist that choice for startup checks. Signed-release installs require Cosign verification during automatic updates; global npm and Bun installs update through their original package manager.

Release assets retain the compatibility names `maestro-darwin-arm64`,
`maestro-darwin-x64`, `maestro-linux-arm64`, and `maestro-linux-x64`. The npm
package contains the same native binaries and POSIX launchers; it does not
execute JavaScript at runtime.

## Use

```sh
deixic-code                         # interactive TUI
deixic-code setup                   # check auth/config and show the next setup step
deixic-code "fix the failing test" # interactive with an initial prompt
deixic-code exec "summarize this repository"
deixic-code --headless              # NDJSON protocol over stdio
deixic-code web --port 3000         # browser UI and HTTP runtime gateway
deixic-code hosted-runner
```

## Develop

Rust owns every agent/runtime path:

- `packages/maestro-rs` — compatibility-named executable and canonical command dispatch
- `packages/tui-rs` — agent core, providers, tools, TUI, and headless runtime
- `packages/runtime-gateway-rs` — HTTP/SSE/WebSocket runtime gateway

The repository contains no TypeScript source or TypeScript build toolchain. The browser UI is a versioned static asset snapshot served by the Rust runtime gateway; agent execution, protocols, adapters, CLI, and TUI are Rust.

```sh
cargo test --workspace --locked
npm run check:rust-only-runtime
```

See [Architecture](docs/ARCHITECTURE.md), [Quickstart](docs/QUICKSTART.md), and [Web UI](docs/WEB_UI.md).
