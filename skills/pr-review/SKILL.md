---
name: pr-review
description: Review GitHub pull requests for correctness, regressions, missing tests, and merge readiness. Use when the user asks for PR review, review feedback, or a pre-merge risk pass.
license: Complete terms in LICENSE.txt
compatibility: "Maestro skill packages with bounded GitHub MCP tools and executable toolbox entries."
allowed-tools:
  - read
  - search
  - bash
builtin-tools:
  - read
  - search
mode: review
isolatedContext: true
metadata:
  version: "0.1.0"
  category: evalops-operations
  artifactSchema: evalops.maestro.skill.pr_review.v1
---

# PR Review

Use this skill to produce a merge-readiness review, not a broad design memo.

## Workflow

1. Identify the PR, base branch, changed files, linked issue, CI status, and review history.
2. Load `reference/rubric.md` only when you need the detailed severity rubric or checklist.
3. Inspect the changed code and nearby tests. Prefer local repo reads for code and bounded GitHub MCP calls for PR metadata.
4. Lead with findings ordered by severity. Include file and line when the issue is in code.
5. Call out missing tests only when they hide real risk.
6. If no issues are found, say that clearly and name the remaining residual risk.

## Toolbox

Run `toolbox/review-summary` when you need the expected output sections without loading the reference file.

## MCP Scope

The bundled GitHub MCP config exposes only pull-request, review, file, and check metadata needed for review. Do not ask it for broad organization scans from this skill.
