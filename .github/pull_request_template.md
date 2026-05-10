## Summary
<!-- 1-3 bullet points describing the change -->

## Checklist

- [ ] `make lint` (or `bun run bun:lint`)
- [ ] `make test` (or `npx nx run maestro:test --skip-nx-cache`)
- [ ] Built any touched packages (e.g., `make build-all`)
- [ ] If this PR adds or promotes user-visible behavior, explain the staged-rollout choice (or why staging is unnecessary).

## Optional

- [ ] Add the `run-evals` label to run evals on this PR (otherwise evals are skipped on PRs).
- [ ] Add the `skip-integration` label to skip integration tests when appropriate (include justification in the PR body).
- [ ] If skipping CI validators (`[skip ci]`, `[skip nix]`), explain why below.
