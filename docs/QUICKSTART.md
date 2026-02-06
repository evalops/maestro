# Quickstart

Audience: contributors setting up the repo.  
Nav: [Docs index](README.md) · [Features](FEATURES.md) · [Tools Reference](TOOLS_REFERENCE.md) · [Safety](SAFETY.md)

Contents: [Prerequisites](#prerequisites) · [Install](#install) · [Configure keys](#configure-keys) · [Build & Run](#build--run) · [Validate](#validate) · [Common Scripts](#common-scripts) · [Next Steps](#next-steps)

Composer is a Bun + Nx workspace. Follow this path to go from a fresh clone to a working CLI/TUI/Web build.

Doc conventions:
- Audience: contributors. For feature usage see [Feature Guide](FEATURES.md); for tools see [Tools Reference](TOOLS_REFERENCE.md).
- Defaults: provider/model default to `claude-opus-4-6` unless overridden.
- Build targets: `composer:build` = CLI only; `composer:build:all` = CLI + TUI + Web.

## Prerequisites
- Node.js 20+ (ES modules + top-level `await`)
- Bun 1.1+ (recommended) or npm 9+ for install
- Git + a GitHub token if you plan to run the hosted evals/CI
- Optional: [MCP Guide](MCP_GUIDE.md) if you need Model Context Protocol servers

## Install
```bash
git clone https://github.com/evalops/composer.git
cd composer
bun install        # installs workspace deps with Bun
```

## Configure keys
Store provider environment variables in `.env` or export them in your shell (see `composer --help` for supported keys). Examples:
```bash
export ANTHROPIC_API_KEY=sk-ant-...
export OPENAI_API_KEY=sk-...
```

You can also keep keys in `~/.composer/keys.json`; see [Sessions](SESSIONS.md) for how the client resolves config files and per-workspace overrides.

## Build & Run
```bash
npx nx run composer:build --skip-nx-cache      # CLI-only build (fast path)
# or when you need TUI + Web artifacts too
npx nx run composer:build:all --skip-nx-cache

bun run cli -- --help                          # run the compiled CLI
```

During development you can use:
- `npx nx run composer:test --skip-nx-cache` – mirrors CI by building TUI/Web before tests
- `bun run --filter @evalops/tui build` / `bun run --filter @evalops/composer-web build` – package-specific builds
- `bun run dev` – optional watch mode (tsc --watch) for inner-loop work
- `bun run cli -- --provider anthropic --model claude-opus-4-6 "hello"` – run the CLI directly from `dist/cli.js` with the canonical model example

## Validate
Use these checks before opening a PR:
```bash
bunx biome check .                             # lint/format
npx nx run composer:test --skip-nx-cache       # builds + Vitest (CI equivalent)
npx nx run composer:evals --skip-nx-cache      # rebuild + eval scenarios
```

If you touch a specific package, pair the workspace checks with `bun run --filter @evalops/tui build` or `bun run --filter @evalops/composer-web build` for that target.

## Common Scripts
| Command                                            | Description                                                    |
| -------------------------------------------------- | -------------------------------------------------------------- |
| `bunx biome check .`                               | Biome lint/format checks                                       |
| `npx nx run composer:test --skip-nx-cache`         | Build TUI/Web then run Vitest (CI equivalent)                  |
| `npx nx run composer:build --skip-nx-cache`        | CLI-only build + mark CLI executable                           |
| `npx nx run composer:build:all --skip-nx-cache`    | Full stack build (CLI + TUI + Web)                             |
| `npx nx run composer:evals --skip-nx-cache`        | Build + run `scripts/run-evals.js` scenarios                   |
| `bun run --filter @evalops/tui build`              | Package-specific build for TUI                                 |
| `bun run --filter @evalops/composer-web build`     | Package-specific build for Web UI                              |
| `bun run dev`                                      | TypeScript watch mode (hot rebuild of `dist/`)                 |
| `bun run cli --`                                   | Convenience wrapper around `node dist/cli.js ...` using Bun    |

## Next Steps
- Explore the [Feature Guide](FEATURES.md) for TUI/CLI workflows.
- Keep [Tools Reference](TOOLS_REFERENCE.md) handy while running slash commands.
- Review [Safety](SAFETY.md) and [Prompt Queue](PROMPT_QUEUE.md) to understand approvals and job flow.
- Check [Web UI Guide](WEB_UI.md) for browser usage and parity notes.
