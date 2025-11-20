# Quickstart

Composer ships as a Bun + Nx workspace. The steps below get a contributor
from a fresh clone to running the CLI, TUI, Web UI, and eval suite.

## Prerequisites

- Node.js 20+ (the repo uses ES modules and top-level `await`)
- Bun 1.1+ (recommended) or npm 9+ for install
- Git + a GitHub token if you plan to use the hosted evals/CI

## Install

```bash
git clone https://github.com/evalops/composer.git
cd composer
bun install        # installs workspace deps with Bun
```

Environment variables (API keys, etc.) can be stored in `.env` or exported in
your shell. See the CLI help output for the list of supported keys.

## Build & Run

```bash
npx nx run composer:build --skip-nx-cache  # emits dist/cli.js via Bun
bun run cli -- --help                      # run the compiled CLI
```

During development you can use:

- `npx nx run composer:test --skip-nx-cache` – mirrors CI by building TUI/Web before tests
- `bun run --filter @evalops/tui build` / `bun run --filter @evalops/composer-web build` – package-specific builds
- `bun run dev` – watch builds (tsc --watch)
- `bun run cli -- --provider anthropic --model claude-sonnet-4-5 "hello"` – run
  the CLI directly from `dist/cli.js`

## Eval Suite

The eval runner ensures the CLI help text, tools, and telemetry commands behave
as expected.

```bash
npx nx run composer:evals --skip-nx-cache
```

It automatically rebuilds before executing scenarios. Keep the suite green
before pushing.

## Common Scripts

| Command                                            | Description                                                    |
| -------------------------------------------------- | -------------------------------------------------------------- |
| `bunx biome check .`                               | Biome lint/format checks                                       |
| `npx nx run composer:test --skip-nx-cache`         | Build TUI/Web then run Vitest (CI equivalent)                  |
| `npx nx run composer:build --skip-nx-cache`        | TypeScript build + mark CLI executable                         |
| `npx nx run composer:evals --skip-nx-cache`        | Build + run `scripts/run-evals.js` scenarios                   |
| `bun run --filter @evalops/tui build`              | Package-specific build for TUI                                 |
| `bun run --filter @evalops/composer-web build`     | Package-specific build for Web UI                              |
| `bun run dev`                                      | TypeScript watch mode (hot rebuild of `dist/`)                 |
| `bun run cli --`                                   | Convenience wrapper around `node dist/cli.js ...` using Bun    |

You’re ready to develop once lint/tests/evals pass locally.
