---
name: install-code-review
description: Install automated Maestro code review in a GitHub repository's CI — add a pull_request workflow that runs `maestro exec` and posts a merge-readiness review as a PR comment. Use when the user wants to set up automated PR review, wire Maestro into CI/CD, or "install code review".
license: Complete terms in LICENSE.txt
compatibility: "Maestro skill packages with write/bash access to a checked-out GitHub repository."
allowed-tools:
  - read
  - write
  - bash
builtin-tools:
  - read
  - write
mode: build
metadata:
  version: "0.1.0"
  category: evalops-operations
  artifactSchema: evalops.maestro.skill.install_code_review.v1
---

# Install Code Review

Wire Maestro into a repository's CI so every pull request gets an automated
merge-readiness review. Use the published generator exports
(`buildMaestroReviewWorkflow` / `writeMaestroReviewWorkflow`) so installs work
in arbitrary repositories, not just in the Maestro monorepo. In this monorepo,
the same implementation also lives at
`packages/github-agent/src/workflows/maestro-review-workflow.ts` and is
re-exported by `@evalops/github-agent`.

## Workflow

1. **Confirm the target.** Verify you are in a Git repository with a GitHub
   remote, and that `.github/workflows/` is the right place (some repos vendor
   workflows elsewhere). Confirm the default branch.
2. **Choose options.** Ask only what you cannot infer: the model provider
   (default inferred from the provider secret/env name, otherwise `anthropic`),
   provider API key secret name (default inferred from the provider runtime env
   var), and, if the user wants a pinned model, the model id. Pass
   `maestroPackage` from `MAESTRO_PACKAGE_NAME` when set, otherwise use the
   default `maestro` package, and Node to 20. For custom providers, set the runtime
   API-key environment variable explicitly if it is not the provider id
   uppercased with `_API_KEY` appended.
3. **Write the workflow.** Generate `.github/workflows/maestro-review.yml` from
   the published generator (do not hand-roll the YAML — use the generator so the
   file is deterministic and reviews cleanly). The workflow triggers on
   `pull_request` (opened, synchronize, reopened), runs `maestro exec` with the
   `pr-review` skill, and posts the result with `gh pr comment`.
4. **Document the secret.** Tell the user exactly which repository secret to add
   (the API key), which runtime env var the workflow maps it to, and that the
   workflow uses the built-in `GITHUB_TOKEN` for the PR comment. Do not write any
   secret value into the repo.
5. **Land it.** Create a branch, commit the workflow, and open a PR titled
   "Install Maestro code review" — never commit the workflow directly to the
   default branch. Summarize what was added and the one secret the user must
   set for it to run.

## Output

Report the workflow path written, the required secret name, the trigger events,
and the PR you opened. If the repo already has a `maestro-review.yml`, show the
diff and ask before overwriting.

## Guardrails

- Request only the permissions the job needs: `contents: read` and
  `pull-requests: write`.
- Never embed an API key in the workflow or commit a token.
- Keep the review step non-interactive (`maestro exec`); never assume a TTY in
  CI.
