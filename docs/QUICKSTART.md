# Quickstart

Audience: contributors setting up the repo.  
Nav: [Docs index](README.md) · [Features](FEATURES.md) · [Tools Reference](TOOLS_REFERENCE.md) · [Safety](SAFETY.md)

Contents: [Prerequisites](#prerequisites) · [Install](#install) · [Configure keys](#configure-keys) · [Build & Run](#build--run) · [Validate](#validate) · [Common Scripts](#common-scripts) · [Next Steps](#next-steps)

Maestro is a Bun + Nx workspace. Follow this path to go from a fresh clone to a working CLI/TUI/Web build.

Doc conventions:
- Audience: contributors. For feature usage see [Feature Guide](FEATURES.md); for tools see [Tools Reference](TOOLS_REFERENCE.md).
- Defaults: provider/model default to `claude-opus-4-6` unless overridden.
- Build targets: `maestro:build` = CLI only; `maestro:build:all` = CLI + Web packages; native TUI is `bun run tui-rs:build`.

## Prerequisites
- Node.js 20+ (ES modules + top-level `await`)
- Bun 1.1+ (recommended) or npm 9+ for install
- Rust toolchain (stable) if you build the native TUI from source
- Git + a GitHub token if you plan to run the hosted evals/CI
- Optional: [MCP Guide](MCP_GUIDE.md) if you need Model Context Protocol servers

## Install
```bash
git clone https://github.com/evalops/maestro.git
cd maestro
bun install        # installs workspace deps with Bun
```

## Configure auth
Sign in with ChatGPT for the default Codex subscription models:

```bash
maestro codex login
```

If Codex is already signed in, `maestro codex login` reports that account
instead of starting a second flow. Use `maestro codex login --force` to refresh
the sign-in, or `maestro codex login --device-auth` on a remote/headless
machine. Published installs run this through Maestro's packaged `@openai/codex`
app-server; source checkouts also work with a `codex` binary on `PATH`.

You can also store provider environment variables in `.env` or export them in your shell (see `maestro --help` for supported keys). Examples:
```bash
export OPENAI_API_KEY=sk-...
export ANTHROPIC_API_KEY=sk-ant-...
```

You can also keep keys in `~/.maestro/keys.json`; see [Sessions](SESSIONS.md) for how the client resolves config files and per-workspace overrides.

## Build & Run
```bash
npx nx run maestro:build --skip-nx-cache      # CLI-only build (fast path)
# or when you need Web (and related package) artifacts too
npx nx run maestro:build:all --skip-nx-cache

# Native interactive TUI (required for `maestro` with no one-shot prompt)
bun run tui-rs:build
# cargo build --release --manifest-path packages/tui-rs/Cargo.toml

bun run cli -- --help                          # run the compiled CLI
```

Interactive `maestro` hands off to the `maestro-tui` binary (see
[TUI Architecture](TUI_ARCHITECTURE.md)). In a checkout, build `packages/tui-rs`
first or set `MAESTRO_TUI_BIN` to a built binary.

During development you can use:
- `npx nx run maestro:test --skip-nx-cache` – mirrors CI (builds deps, then Vitest)
- `bun run tui-rs:build` / `bun run tui-rs:test` – native TUI build and Cargo tests
- `bun run --filter @evalops/maestro-web build` – Web package build
- `bun run dev` – optional watch mode (tsc --watch) for inner-loop work
- `bun run cli -- --provider openai-codex --model gpt-5.5 "hello"` – run the CLI directly from `dist/cli.js` with the default Codex model example
- `bun run start:native` – run `packages/tui-rs/target/release/maestro-tui` after a release build

## Validate
Use these checks before opening a PR:
```bash
bunx biome check .                             # lint/format
npx nx run maestro:test --skip-nx-cache       # builds + Vitest (CI equivalent)
npx nx run maestro:evals --skip-nx-cache      # rebuild + eval scenarios
```

If you touch a specific package, pair the workspace checks with `bun run tui-rs:build`
or `bun run --filter @evalops/maestro-web build` for that target.

## Common Scripts
| Command                                            | Description                                                    |
| -------------------------------------------------- | -------------------------------------------------------------- |
| `bunx biome check .`                               | Biome lint/format checks                                       |
| `npx nx run maestro:test --skip-nx-cache`         | Build deps then run Vitest (CI equivalent)                     |
| `npx nx run maestro:build --skip-nx-cache`        | CLI-only build + mark CLI executable                           |
| `npx nx run maestro:build:all --skip-nx-cache`    | Full JS stack build (CLI + Web packages; not Cargo)            |
| `npx nx run maestro:evals --skip-nx-cache`        | Build + run `scripts/run-evals.js` scenarios                   |
| `bun run tui-rs:build`                             | Release build of native `maestro-tui`                          |
| `bun run tui-rs:build:debug`                       | Debug build of native TUI                                      |
| `bun run tui-rs:check` / `bun run tui-rs:test`     | `cargo check` / `cargo test` for `packages/tui-rs`             |
| `bun run --filter @evalops/maestro-web build`     | Package-specific build for Web UI                              |
| `bun run dev`                                      | TypeScript watch mode (hot rebuild of `dist/`)                 |
| `bun run cli --`                                   | Convenience wrapper around `node dist/cli.js ...` using Bun    |

## Next Steps
- Explore the [Feature Guide](FEATURES.md) for TUI/CLI workflows.
- Keep [Tools Reference](TOOLS_REFERENCE.md) handy while running slash commands.
- Review [Safety](SAFETY.md) and [Prompt Queue](PROMPT_QUEUE.md) to understand approvals and job flow.
- Check [Web UI Guide](WEB_UI.md) for browser usage and parity notes.
