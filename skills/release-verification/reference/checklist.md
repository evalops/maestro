# Release Verification Checklist

## Required Evidence

- Candidate revision, tag, or build receipt.
- Required CI checks and their final states.
- Deployment target and environment ownership.
- Migration, feature flag, or config changes.
- Rollback path and rollback owner.
- Known customer or operator impact.

## Report Shape

Use this order:

1. Decision: ready, blocked, already promoted, or needs more evidence.
2. Evidence: links, revisions, check names, and artifact IDs that are safe to cite.
3. Unavailable sources: what could not be verified and why.
4. Blockers: only blockers that change the release decision.
5. Next action: the smallest action that moves the release forward.
6. Withheld or out of scope: customer data, internal handles, or evidence that should stay in durable runtime state.
