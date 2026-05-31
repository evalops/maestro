# PR Review Rubric

## Severity

- Critical: data loss, auth bypass, secret exposure, production outage, or a change that cannot be safely rolled back.
- High: user-visible regression, broken deploy path, incorrect persisted state, race condition, or unhandled error path.
- Medium: missing validation, incomplete migration, flaky workflow, or test gap on changed behavior.
- Low: maintainability issue that is likely to slow future work but does not block merge.

## Review Checklist

1. Confirm the PR changes the behavior it claims to change.
2. Trace changed inputs through persistence, queues, caches, and external APIs.
3. Check rollback and partial-failure behavior.
4. Verify tests exercise the risky branch, not only the happy path.
5. Check docs or operator runbooks when the change affects release, incident, or customer support behavior.

## Output Contract

Write findings first. Each finding should include impact, evidence, and a concrete fix direction. Keep summaries short and put them after findings.
