# Release Ops

## Source Of Truth

- `main` is the release source of truth.
- The public repo owns npm publishing.
- The release workflow currently publishes `@evalops/maestro`.

## Automated Flow

1. Bump the version in a branch with `npm run version:patch|minor|major`.
2. Open and merge the PR into `main`.
3. `.github/workflows/tag-release.yml` creates the missing `vX.Y.Z` tag from `main`.
4. `.github/workflows/release.yml` runs the release quality gate from that tag.
5. The `npm-release` environment gate approves the public publish job.
6. GitHub publishes the npm package and GitHub release artifact.

## Readiness Checks

- `npm run release:check:ci`
  Runs the shared CI-mode release checks used by PR validation.
- `npm run release:check`
  Runs the full release gate locally, including build, runtime-dependency verification, npm audit, and packed CLI smoke test.
- `npm run cutover:check`
  Verifies that root package names and install commands stay centralized in the approved cutover-aware files.

## PR Automation

- Repos are configured for GitHub-side auto-merge and automatic branch deletion on merge.
- Use `gh pr merge <pr> --auto --merge --repo evalops/maestro` to avoid local worktree branch-switch issues.

## Namespace Cutover

- The current published package name comes from `package.json:name`.
- The long-term package target lives in `package.json:maestro.canonicalPackageName`.
- Keep README, JetBrains plugin docs, SDK docs, and release ops text in sync with `npm run metadata:sync`.
- Run `npm run cutover:check` before changing package names or install instructions.
- Use `.github/workflows/verify-published-package.yml` for a manual npm verification run against either the current package metadata or an override package/version during scope recovery.
- npm publishing uses GitHub OIDC trusted publishing when npm has the
  `evalops/maestro` release workflow configured; the EvalOps org `NPM_TOKEN`
  secret remains a temporary fallback during the scope cutover.
- `NPM_PUBLISH_AUTH_MODE` controls the release publish path:
  - `auto` tries npm trusted publishing first, then falls back to `NPM_TOKEN`
    if the npm-side trusted publisher is not configured yet.
  - `trusted` ignores `NPM_TOKEN` and forces npm trusted publishing.
  - `token` requires `NPM_TOKEN` and keeps the legacy fallback explicit.
- After `npm trust github @evalops/maestro --repo evalops/maestro --file release.yml --env npm-release --yes` succeeds and one release verifies, set
  `NPM_PUBLISH_AUTH_MODE=trusted` in the `npm-release` environment and remove
  the release-scoped `NPM_TOKEN`.

## Rollback And Deprecation

- Verify a published package manually with `npm run release:verify:published -- --package <name> --version <version>`.
- Deprecate a bad version or temporary package path from a logged-in machine with `npm run release:deprecate -- --range <version-or-range>`.
- Add `--replacement-package @evalops/maestro` when retiring the temporary namespace, or provide `--message` for a custom rollback notice.
- Use `--dry-run` first to inspect the exact `npm deprecate` command before making registry changes.
