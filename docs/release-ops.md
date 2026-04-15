# Release Ops

## Source Of Truth

- `main` is the release source of truth.
- The public repo owns npm publishing.
- The release workflow publishes `@evalops-jh/maestro` through npm trusted publishing.

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

## PR Automation

- Repos are configured for GitHub-side auto-merge and automatic branch deletion on merge.
- Use `gh pr merge <pr> --auto --merge --repo evalops/maestro` to avoid local worktree branch-switch issues.
