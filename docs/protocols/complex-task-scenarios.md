# Complex Task Scenarios

Maestro carries a deterministic scenario pack for cross-system EvalOps tasks at
`evals/scenarios/complex-task-gauntlet.json`. It is meant for CI and local
replay, not for live mutation by itself.

The pack covers:

- Slack-originated progress audit across Ensemble, Platform, Deploy, Maestro
  internal, and Cerebro.
- Browser and Computer grant handling for authenticated UI or desktop actions.
- GitHub write follow-through with repo-scoped issue evidence.
- Deploy verification with Argo health, immutable image tags, and rollback gate.
- Cerebro memory conflict handling where fresh evidence supersedes stale memory.

The pack is arranged as a regression ladder:

- `smoke`: a minimal cross-system completion loop suitable for quick local
  checks.
- `regression`: deterministic multi-system follow-through checks that should run
  before merging scenario-sensitive changes.
- `gauntlet`: the full connector-heavy safety and deploy verification suite.

## Commands

Validate the pack:

```bash
maestro scenario validate evals/scenarios/complex-task-gauntlet.json
```

Run the deterministic replay and write CI artifacts:

```bash
maestro scenario run evals/scenarios/complex-task-gauntlet.json \
  --junit artifacts/complex-task-gauntlet/junit.xml \
  --report artifacts/complex-task-gauntlet/report.json
```

Run only the local smoke rung:

```bash
maestro scenario run evals/scenarios/complex-task-gauntlet.json --tier smoke
npm run scenario:smoke
```

Run smoke plus regression while skipping the connector-heavy gauntlet rung:

```bash
maestro scenario run evals/scenarios/complex-task-gauntlet.json --max-tier regression
npm run scenario:regression
```

Both commands support `--json`.

## Contract

Every scenario must declare a `tier` of `smoke`, `regression`, or `gauntlet`,
and the default pack must include at least one scenario in each tier. Every
completed scenario must include:

- `trigger.accepted`, `progress`, `artifact.created`, and `completed` events.
- A completion artifact using
  `evalops.complex_task.slack_completion.v1`.
- Observed side effects for the external systems it claims to touch.
- Evidence links that the final Slack answer can cite.
- Forbidden final text checks that prevent "queued" or "will do later" answers
  from passing as completion.

Browser and Computer scenarios must assert `grant.reviewed` before any UI or
desktop capability can be considered safe. Scenarios that intentionally stop for
approval can pass with `finalStatus: "blocked"` when the expected blocker is
present.
