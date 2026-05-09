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

Both commands support `--json`.

## Contract

Every completed scenario must include:

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
