# Quickstart

Composer CLI ships as a Node/Bun project. The steps below get a contributor
from a fresh clone to running the CLI, TUI, and eval suite.

## Prerequisites

- Node.js 20+ (the repo uses ES modules and top-level `await`)
- npm 9+ (or Bun 1.1+ if you prefer `bun install`)
- Git + a GitHub token if you plan to use the hosted evals/CI

## Install

```bash
git clone https://github.com/evalops/composer-cli.git
cd composer-cli
npm install        # or: bun install
```

Environment variables (API keys, etc.) can be stored in `.env` or exported in
your shell. See the CLI help output for the list of supported keys.

## Build & Run

```bash
npm run build          # emits dist/cli.js
npm run cli -- --help  # run the compiled CLI
```

During development you can use:

- `npm run dev` – watch builds (tsc --watch)
- `npm run cli -- --provider anthropic --model claude-sonnet-4-5 "hello"` – run
  the CLI directly from `dist/cli.js`

## Eval Suite

The eval runner ensures the CLI help text, tools, and telemetry commands behave
as expected.

```bash
npm run evals
```

It automatically rebuilds before executing scenarios. Keep the suite green
before pushing.

## Common Scripts

| Command           | Description                                       |
| ----------------- | ------------------------------------------------- |
| `npm run lint`    | Biome lint/format checks                          |
| `npm run test`    | Vitest suite                                      |
| `npm run build`   | TypeScript build + mark CLI executable            |
| `npm run evals`   | Build + run `scripts/run-evals.js` scenarios      |
| `npm run dev`     | TypeScript watch mode (hot rebuild of `dist/`)    |
| `npm run cli --`  | Convenience wrapper around `node dist/cli.js ...` |

You’re ready to develop once lint/tests/evals pass locally.
