# Public Mirror CI Incident Chain (2026-07-23/24)

Postmortem and playbook for the `public-mirror-drift-audit` failure chain that
wedged public-mirror sync between 2026-07-16 and 2026-07-24. The audit failed
8 of 9 scheduled runs between 2026-07-16 and 2026-07-23. Each failure had a
distinct root cause; all are fixed as of 2026-07-24.

## Root Causes and Fixes

### 1. Silent 45-minute hangs in `apt-get update`

Two CI jobs — integration (run 30032961767) and evals (run 30032961846) —
hung for 45 minutes inside `setup-rust` → `ensure-ripgrep` → `apt-get update`
when `azure.archive.ubuntu.com` black-holed connections. Apt's defaults
(120s per fetch, retries per index) spun silently with no output until the
job timeout killed the run.

Fix: bound apt with `Acquire::http::Timeout=10`, `Acquire::https::Timeout=10`,
`Acquire::Retries=1` in `ensure-ripgrep`, `shellcheck.yml`, and
`integration.yml` ([#3048](https://github.com/evalops/maestro-internal/pull/3048)).

### 2. Required check never reported on sync PRs

The required check `actionlint` was path-filtered on `pull_request` in
`evalops/maestro`. Sync PRs — whose projection strips workflow files — never
matched the filter, so the context was never reported:
`mergeStateStatus: BLOCKED` with all *reported* checks green, forever.
Auto-merge wedged; public PRs [#868](https://github.com/evalops/maestro/pull/868)
and [#870](https://github.com/evalops/maestro/pull/870) needed admin merges.

Fix: remove the PR path filter so actionlint runs on every pull request
([evalops/maestro#871](https://github.com/evalops/maestro/pull/871)).

**Invariant: required checks must always be reportable.** A required check
that any PR class can skip reporting is a wedge, not a gate.

### 3. `packages/web/dist` never reached the public mirror

`packages/web/dist` was added to `PUBLIC_INCLUDE_OVERRIDES` in
[#3030](https://github.com/evalops/maestro-internal/pull/3030), but both
mirror workflows staged with plain `git add` / `git add -A`, which silently
skip untracked ignored files (`dist/` is in `.gitignore`). Result: permanent
10-file drift.

Fix: `git add -f packages/web/dist` in the sync workflow
([#3049](https://github.com/evalops/maestro-internal/pull/3049)).

### 4. Sync workflow raced a merge

The sync workflow failed pushing with "stale info" (run 30057210742) when it
raced a merge on the public repo. Fix: debounce added
([#3056](https://github.com/evalops/maestro-internal/pull/3056)).

### 5. `label-run-evals` 403 on `addLabels`

The advisory labeling job lacked `pull-requests: write` and 403'd on
`addLabels`. Fixes: grant the permission
([#3054](https://github.com/evalops/maestro-internal/pull/3054)) and make
advisory jobs fail open
([#3055](https://github.com/evalops/maestro-internal/pull/3055)).

### 6. Duplicate `public-source-provenance` runs (known cosmetic artifact)

Sync PRs recur with two `public-source-provenance` runs ~1s apart. The
concurrency-cancelled loser leaves a CANCELLED required check on the PR;
rerunning the cancelled run clears it. No fix planned — cosmetic.

## Resolution

The audit went green after sync PR
[evalops/maestro#870](https://github.com/evalops/maestro/pull/870) merged
(`d29f071d`) with 0-file drift, verified by a local run of
`scripts/check-public-mirror-drift.mjs`.

## Playbook: Symptom → Diagnosis

- **45-minute stall with no log output** — suspect a network wait. Check for
  `apt-get` (or any fetch) without bounded timeouts; look for
  `Acquire::*::Timeout`/`Retries` settings in the step.
- **`mergeStateStatus: BLOCKED` with all checks green** — a required context
  is *absent*, not failing. Compare the branch-protection required contexts
  against the commit's actual status rollup and find the missing context.
- **Permanent small-file drift in the mirror** — check `git add` behavior
  against `.gitignore`: plain `git add`/`git add -A` silently skip untracked
  ignored files. Use `git add -f` for include-override paths.
- **Cancelled required check from a duplicate run** — rerun the cancelled
  run; the rerun re-reports the context and clears the block.

## Prevention

- `scripts/check-required-status-checks.mjs` — invariant lint enforcing that
  required checks are always reportable (see branch
  `ci/required-check-invariant` / `.github/workflows/required-checks-invariant.yml`).
- Bounded network timeouts everywhere: `Acquire::http(s)::Timeout=10`,
  `Acquire::Retries=1` in setup actions and workflows that call apt.
- Advisory jobs fail open — they must never block the merge lane
  ([#3055](https://github.com/evalops/maestro-internal/pull/3055)).
- Sync debounce to absorb merge races
  ([#3056](https://github.com/evalops/maestro-internal/pull/3056)).
- Scheduled-failure watchdog: alert on consecutive scheduled-run failures so
  an 8-of-9 streak is caught on day one, not day eight.
