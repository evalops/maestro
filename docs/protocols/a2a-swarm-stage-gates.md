# A2A Swarm Stage Gates

`a2a-swarm-stage-gates.json` is the executable goal contract for Platform-backed
Maestro A2A swarm work. It turns "two remote Maestro instances can collaborate"
into ordered evidence gates, with each stage naming the evidence that allows the
next stage to start and the evidence that proves the stage is done.

The manifest is checked by `npm run check:evidence-integrity`, which also runs
from the guardian/precommit path. That keeps the goal honest: an exit gate must
name a production-authoritative source and a concrete verification command,
query, or operator inspection path. Replay fixtures can remain valuable schema
evidence, but they cannot satisfy production exit gates.

## Stages

| Stage | Gate | What It Proves |
| --- | --- | --- |
| 0 | Integrity foundation | Synthetic or fixture-shaped identifiers cannot masquerade as production proof. |
| 1 | Platform identity and topology | Two remote Maestro peers are durable Platform agents with fresh discovery and heartbeat state. |
| 2 | Remote delegation and task control | Maestro A delegates to Maestro B through Platform and observes/controls the resulting A2A task. |
| 3 | Subagent federation | Remote subagent lanes are negotiated, authorized, invoked, and traced through Platform. |
| 4 | Swarm coordination | Multiple Maestro peers split work, hold ownership, recover from failures, and reconcile one outcome. |
| 5 | Production proof and operations | A real repo or deploy workflow resolves to live GitHub, deploy, signature, and Platform trace evidence. |
| 6 | Fleet hardening | Load, chaos, SLO, runbook, quota, and retention evidence make the system operable at fleet scale. |

## Usage

Before promoting a stage, collect the exit evidence named in the manifest and
run:

```sh
npm run check:evidence-integrity
```

For live proof bundles, also run the strict verifier:

```sh
GITHUB_TOKEN="$GITHUB_TOKEN" \
MAESTRO_A2A_LIVE_EVIDENCE_VERIFY_PUBLIC_KEY_FILE=./platform-a2a-live.pub.pem \
npm run platform:a2a-evidence-verify -- \
  tmp/platform-a2a-delegation-live/<run>/evidence.json \
  --require-signature \
  --require-github-dereference \
  --require-discovery-evidence \
  --require-negative-auth-probe
```

The stage is not complete until the evidence resolves in the named system of
record. A pretty bundle with unresolvable identifiers is a failed gate.
