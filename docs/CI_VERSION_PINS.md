# CI Version Pins

This repo intentionally pins key toolchain versions so local development and CI behave the same way.

Nav: [Docs index](README.md) · [Contributor Runbook](CONTRIBUTOR_RUNBOOK.md)

## What’s pinned (and where)

- **Single source of truth**
  - `tool-versions.json` is checked in and validated in `bun run bun:lint` to prevent drift.
- **Node.js**
  - Version: `tool-versions.json`.
  - Local: `.node-version` (and `.nvmrc` for nvm users).
  - CI wiring: `.github/actions/setup-bun-nx/action.yml` uses `actions/setup-node` with `node-version-file`.
- **Bun**
  - Version: `tool-versions.json`.
  - CI wiring: `.github/actions/setup-bun-nx/action.yml` input `bun-version` (default value).
- **Semgrep**
  - Version: `tool-versions.json`.
  - CI wiring: `.github/workflows/evals.yml` installs a pinned Semgrep version for Guardian runs.
- **GitHub Actions**
  - Workflows and composite actions pin `uses:` refs to full commit SHAs under `.github/workflows/` and `.github/actions/`.

## Update checklist

### 1) Update Node

1. Update `tool-versions.json` and `.node-version` (and `.nvmrc`).
2. Run:
   - `bun run bun:lint`
   - `npx nx run maestro:test --skip-nx-cache`
3. Open a PR and confirm CI is green.

### 2) Update Bun

1. Update `tool-versions.json` and the default `bun-version` in `.github/actions/setup-bun-nx/action.yml`.
2. Run:
   - `bun run bun:lint`
   - `npx nx run maestro:test --skip-nx-cache`
3. Open a PR and confirm CI is green.

### 3) Update pinned GitHub Actions SHAs

1. Identify the new version tag (example):
   - `gh api repos/actions/setup-node/releases/latest --jq .tag_name`
2. Resolve the tag to a commit SHA (example):
   - `gh api repos/actions/setup-node/git/ref/tags/<tag> --jq .object.sha`
3. Replace the pinned `uses: ...@<sha>` in `.github/workflows/*` and `.github/actions/*`.
4. Run `bun run bun:lint` locally and confirm the `actionlint` workflow is green in CI.

### 4) Update Semgrep

1. Update `tool-versions.json` and the pinned `semgrep==...` version in `.github/workflows/evals.yml`.
2. Open a PR and confirm `evals` is green.
