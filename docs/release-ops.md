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
- npm publication runs on the internal confirmation lane and requires the
  release-scoped `NPM_TOKEN` secret in the `npm-release` environment.
- Keep `NPM_TOKEN` configured while this workflow uses the self-hosted
  confirmation runner. npm trusted publishing requires a GitHub-hosted runner
  and is not a supported authentication path for this release lane.
- The workflow verifies an already-published immutable tarball before retrying,
  so a rerun after a lost registry response does not republish the same version.

## Rollback And Deprecation

- Verify a published package manually with `npm run release:verify:published -- --package <name> --version <version>`.
- Prefer `.github/workflows/deprecate-release.yml` when local npm credentials
  are unavailable. Dispatch it once with `dry_run=true`, then rerun with
  `dry_run=false`; the mutating job requires the `npm-release` environment
  `NPM_TOKEN`.
- Deprecate a bad version or temporary package path from a logged-in machine with `npm run release:deprecate -- --range <version-or-range>`.
- For the broken `@evalops/maestro` releases that reference private workspace
  packages, deprecate range `>=0.10.8 <=0.10.20` with message
  `Broken release metadata references private workspace packages; install @evalops/maestro@latest.`.
- Add `--replacement-package @evalops/maestro` when retiring the temporary namespace, or provide `--message` for a custom rollback notice.
- Use `--dry-run` first to inspect the exact `npm deprecate` command before making registry changes.
