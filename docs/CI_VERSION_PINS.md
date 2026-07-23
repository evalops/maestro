# CI Version Pins

This repository pins key development and CI tools so local and hosted checks resolve the same inputs.

Nav: [Docs index](README.md) · [Contributor Runbook](CONTRIBUTOR_RUNBOOK.md)

## What is pinned

- **Node.js**: `tool-versions.json`, `.node-version`, and `.nvmrc`. Node runs packaging and repository-check scripts; it is not required by the shipped runtime.
- **Rust dependencies**: Cargo lockfiles are committed and CI uses `--locked`.
- **GitHub Actions**: every `uses:` reference under `.github/workflows` and `.github/actions` is pinned to a full commit SHA.

## Update checklist

### Node.js

1. Update `tool-versions.json`, `.node-version`, and `.nvmrc` together.
2. Run `node scripts/verify-tool-versions.js`, `npm run check`, and `npm test`.
3. Confirm the native and actionlint CI lanes are green.

### Rust dependencies

1. Make the narrowest intended Cargo update.
2. Run `npm run check`, workspace Clippy with warnings denied, and `npm test`.
3. Review the lockfile diff for unexpected packages or native system dependencies.

### GitHub Actions

1. Resolve the desired release tag to a commit SHA.
2. Replace the pinned `uses: ...@<sha>` reference.
3. Run actionlint and confirm the actionlint workflow is green.
