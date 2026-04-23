# Public Tree Mirror Boundary

The sanitized public-tree mirror is the source-control contract
between `evalops/maestro-internal` and `evalops/maestro`. This document tracks
the files and directories that still require special handling while the
public-tree mirror runs on every push to internal `main`.

Related:

- `scripts/prepare-public-release-mirror.mjs`
- `.github/public-release-mirror.exclude`
- `.github/workflows/sync-public-release-mirror.yml`
- `evalops/maestro-internal#1425`

## Current Public-Owned Boundary

The following paths are intentionally preserved from the public checkout during
public-tree generation. They stay in `.github/public-release-mirror.exclude`
until they are either folded back into internal or explicitly declared to
remain public-only.

### Public CI and publishing workflows

- `.github/workflows/**`
- `.github/workflows/public-release-mirror.yml`
- `.github/workflows/sync-public-release-mirror.yml`
- `.github/release-mirror-manifest.json`
- `.github/public-release-mirror.exclude`

These remain public-owned because `evalops/maestro` still controls its own CI,
registry verification, and trusted-publishing rollout. The sanitizer must not
wipe those files while the public repo continues to publish independently.

### Public-only release and registry helpers

- `scripts/configure-npm-trusted-publisher.mjs`
- `scripts/deprecate-release.js`
- `scripts/smoke-registry-install.js`
- `scripts/validate-public-package-deps.js`

These scripts support public-package publishing and registry checks that do not
yet have a single shared home in internal.

### Internal-only docs that should not leak into the public repo

- `docs/release-ops.md`
- `docs/internal/**`

These are intentionally excluded from the generated public tree.

### Local and operator noise

- `.git/**`
- `node_modules/**`
- `dist/**`
- `coverage/**`
- `tmp/**`
- `.env`
- `.env.*`
- `.maestro/**`
- `.cursor/**`
- `AGENTS.md`
- `CLAUDE.md`

These are not product surfaces; they are excluded so the generator can run
against an existing checkout without destroying local state.

## Validation Path

`sync-public-release-mirror` prepares the public-tree mirror on every push to
internal `main` by running:

```sh
node scripts/prepare-public-release-mirror.mjs \
  --source "$PWD" \
  --target /path/to/evalops/maestro
```

The workflow first runs the same command in `--check` mode to write a step
summary, then mutates a public checkout, pushes `sync/public-release-mirror`,
and opens or updates the stable public mirror PR. The report lists:

- files that would be copied or updated
- stale files that would be deleted
- the resolved public package name

The workflow writes those counts and a sample file list to the GitHub step
summary so each sync PR shows the size and shape of the public-tree update.

## Operating Rules

1. Land public-facing source changes in `evalops/maestro-internal` first.
2. Let the `sync-public-release-mirror` workflow update the stable public PR.
3. Keep public-owned CI and trusted-publishing workflows excluded from the
   generated tree unless ownership deliberately moves back into internal.
4. Treat a failed mirror sync as a release-blocking bridge failure; do not
   backfill public directly except for emergency recovery.
