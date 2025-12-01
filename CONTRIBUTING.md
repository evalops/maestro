# Contributing Guide

Thanks for helping build Composer! This document covers the workflow we
expect before opening a PR.

## Prerequisites

- Node.js 20+
- Bun 1.1+ (preferred) or npm 9+
- Git + GitHub account
- Familiarity with TypeScript/ESM and modern CLIs

## Development Workflow

1. **Fork & clone** – `git clone https://github.com/evalops/composer.git`
2. **Install deps** – `bun install`
3. **Create a branch** – `git checkout -b feature/my-change`
4. **Implement + document** – update code + relevant docs (README, docs/*.md, AGENTS.md)
5. **Run checks**:
   ```bash
   bunx biome check .                            # Biome + eval verifier
   npx nx run composer:test --skip-nx-cache      # Builds TUI/Web then runs tests (CI-equivalent)
   npx nx run composer:evals --skip-nx-cache     # Optional eval scenarios
   # If you touched specific packages, build them too:
   bun run --filter @evalops/tui build
   bun run --filter @evalops/composer-web build
   ```
   (CI runs these, but failing locally wastes review cycles.)
   - Security: `bun run guardian` scans staged files with Semgrep + secrets; install a pre-commit hook with `npm run guardian:install-hook`.
6. **Commit** – descriptive message, e.g., `feat: add bash history`
7. **Push & PR** – open a PR against `main`, filling out the template.

### Development Tools

#### VS Code
- Open the workspace and debugging is pre-configured
- Press F5 to start debugging
- Use `.vscode/launch.json` configurations for different scenarios

#### Watch Mode
```bash
bun run dev            # TypeScript watch mode
bun run dev:tui        # TUI dev server
bun run dev:web        # Web dev server
```

#### Testing Individual Files
```bash
bunx vitest --run test/path/to/file.test.ts
bunx vitest --run -t "specific test name"
```

## Code Style

- TypeScript + ES modules (`import ... from "./foo.js"`)
- Prefer async/await over raw Promises
- Use Biome for formatting (`npm run format` if needed)
- Keep comments high-level; avoid narrating obvious code

## Adding Docs

- Quick references live in `docs/`
- Architecture changes update `docs/ARCHITECTURE_DIAGRAM.md`
- User-facing features belong in README or the Feature Guide

## Tests & Evals

- Use Vitest for unit tests
- End-to-end behaviors should be covered by `evals/scenarios.json`
- When changing CLI output, update the expected regexes and re-run `npx nx run composer:evals --skip-nx-cache`

## Releases

Use the versioning scripts for consistent releases:

```bash
bun run version:patch    # 0.10.0 -> 0.10.1
bun run version:minor    # 0.10.0 -> 0.11.0
bun run version:major    # 0.10.0 -> 1.0.0
```

These scripts automatically:
- Update package.json and package-lock.json
- Create CHANGELOG.md entry with timestamp
- Provide next-step instructions for git tag and npm publish

Contributors should not run `npm publish`.

## Communication

- Open an issue for feature ideas or bugs
- Use draft PRs for early feedback
- Follow the project Code of Conduct (mirrors GitHub’s standard)

Thanks again for contributing! 🙌
