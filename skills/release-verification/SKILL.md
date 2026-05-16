---
name: release-verification
description: Verify release readiness and post-release health from PRs, CI, tags, deploy evidence, rollback notes, and operator artifacts. Use when the user asks whether a release can ship, has shipped, or is safe to promote.
license: Complete terms in LICENSE.txt
compatibility: "Maestro skill packages with bounded GitHub MCP tools and executable toolbox entries."
allowed-tools:
  - read
  - search
  - bash
builtin-tools:
  - read
  - search
mode: ship
isolatedContext: true
metadata:
  version: "0.1.0"
  category: evalops-operations
  artifactSchema: evalops.maestro.skill.release_verification.v1
---

# Release Verification

Use this skill to prove release state from artifacts, not from branch vibes.

## Workflow

1. Identify the release candidate, target environment, owning repo, and rollback boundary.
2. Load `reference/checklist.md` when the release has deploy, migration, or customer-visible risk.
3. Inspect CI, release notes, tags, deployment references, and outstanding blockers.
4. Separate required evidence from optional confidence checks.
5. Report allowed evidence links or revisions, unavailable sources, blockers, next action, and what was withheld or out of scope.
6. Never call a release shipped until the artifact or deployment state supports it.

## Toolbox

Run `toolbox/release-readiness` to emit the required release-verification report skeleton.

## MCP Scope

The bundled GitHub MCP config is limited to release, workflow, pull request, and check metadata. Use platform or deploy-specific tools only when the runtime grants them separately.
