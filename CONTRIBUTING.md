# Contributing Guide

Thanks for helping build Composer CLI! This document covers the workflow we
expect before opening a PR.

## Prerequisites

- Node.js 20+, npm 9+ (or Bun 1.1+)
- Git + GitHub account
- Familiarity with TypeScript/ESM and modern CLIs

## Development Workflow

1. **Fork & clone** – `git clone https://github.com/evalops/composer-cli.git`
2. **Install deps** – `npm install`
3. **Create a branch** – `git checkout -b feature/my-change`
4. **Implement + document** – update code + relevant docs (README, docs/*.md)
5. **Run checks**:
   ```bash
   npm run lint
   npm run test
   npm run evals
   ```
   (CI also runs these, but failing locally wastes review cycles.)
6. **Commit** – descriptive message, e.g., `feat: add bash history`
7. **Push & PR** – open a PR against `main`, filling out the template.

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
- When changing CLI output, update the expected regexes and re-run `npm run evals`

## Releases

Maintainers bump `package.json` + `CHANGELOG.md`, tag, and publish. Contributors
do not run `npm publish`.

## Communication

- Open an issue for feature ideas or bugs
- Use draft PRs for early feedback
- Follow the project Code of Conduct (mirrors GitHub’s standard)

Thanks again for contributing! 🙌
