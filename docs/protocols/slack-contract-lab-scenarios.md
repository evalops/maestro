# Slack Contract Lab Scenarios

Issue: https://github.com/evalops/maestro-internal/issues/2021

Maestro's role in the Slack Teammate Evidence-to-Outcome Contract Lab is to turn
redacted Slack transcript outcomes into deterministic scenario and trajectory
evidence. Ensemble remains the owner of Slack ingress, rendering, and transcript
import. Platform remains the owner of AgentRuntime, work-envelope, trace, and
evidence contracts. Maestro owns the offline scenario pack that proves a Slack
teammate path can be replayed and scored without a live model provider or raw
Slack payloads.

## Current Harness Mapping

The existing Maestro trajectory stack already gives the contract lab most of the
needed primitives:

| Contract lab need | Maestro primitive | Notes |
| --- | --- | --- |
| Preserve Slack thread shape without raw content | `evalops.maestro.agent-trajectory.v1` events | Events keep stable IDs, phases, actors, visibility, safe summaries, and evidence anchors. Raw Slack text stays out of the artifact. |
| Replay a long-horizon teammate path | `evalops.maestro.agent-trajectory-replay.v1` | Replay reports preserve deterministic deltas, tool-call lifecycle, and phase summaries. |
| Score progress, evidence, memory, and final outcome | `evalops.maestro.agent-trajectory-score.v1` | Deterministic findings name the gate, event IDs, remediation, and evidence anchors. |
| Produce operator-review evidence | `evalops.maestro.agent-trajectory-inspection.v1` | Inspection artifacts expose redacted timeline items, events, score findings, and final answer jump targets. |
| Promote to release-gating scenarios | `evalops.maestro.scenario.v1` | Scenario files add workflow assumptions, threat model, human labels, Platform trace joins, assertions, result JSON, and JUnit. |

This slice extends the scenario contract with `externalRefs` so a fixture can
carry actual redacted cross-system IDs:

- `ensembleTranscriptIds`: governed transcript fixture IDs from Ensemble.
- `platformTraceIds`: Platform or OpenTelemetry trace IDs.
- `platformWorkEnvelopeIds`: stable Slack work-envelope IDs.
- `slackThreadRefs`: redacted workspace/channel/thread references.
- `evidenceArtifactIds`: VFS or artifact IDs that point to safe evidence bundles.

The new `external.refs` assertion proves those references are present before a
scenario can pass. It lets Maestro consume Ensemble transcript IDs and Platform
trace/work-envelope IDs without copying raw transcript text, tool arguments, or
model output into the fixture.

## Fixture Strategy

The initial corpus adds two fixtures:

| Fixture | Purpose | Expected outcome |
| --- | --- | --- |
| `slack-contract-progress-outcome` | Long-horizon Slack teammate path with ingress, progress reply, memory lifecycle, evidence artifact, and final answer. | `pass` |
| `slack-contract-unsafe-degraded` | Unsafe or under-evidenced Slack action request that must block, explain the degraded state, and provide a useful next action. | `pass` |

The degraded fixture is expected to pass because the harness is validating the
correct blocked behavior, not rewarding the unsafe request. It carries
`degraded`, `unsafe_input`, and `needs_human_review` labels so downstream
training or release gates can distinguish it from a clean success.

## Privacy And Security Boundary

Slack contract-lab fixtures must not include:

- raw Slack message text;
- customer names, emails, secrets, tokens, private keys, or connector payloads;
- raw prompts, model responses, tool arguments, tool outputs, shell output, or
  file bytes;
- VFS artifact bytes or raw artifact URIs outside explicitly safe evidence IDs.

The fixture summaries are intentionally product-safe paraphrases. The source
transcript importer and Platform evidence broker own permissioned access to raw
data; Maestro only carries IDs and redacted evidence anchors needed for replay,
scorecards, and release gates.

## Promotion Path

1. Ensemble imports and redacts representative Slack threads, then emits
   governed transcript IDs.
2. Platform joins Slack ingress, AgentRun, tool execution, memory, evidence, and
   rendering into trace/work-envelope IDs.
3. Maestro scenario fixtures consume those IDs through `externalRefs`, replay
   the expected event trajectory, and score deterministic outcome gates.
4. Cerebro indexes the score/result artifacts for queryable evidence.
5. Deploy runs the canonical suite in shadow mode first, then gates promotion
   once false-positive review is complete.

The current fixtures are deliberately small. They are the schema and regression
seed; the full contract lab still needs the governed 100-thread train/dev/holdout
corpus and production shadow-mode comparison before release enforcement.
