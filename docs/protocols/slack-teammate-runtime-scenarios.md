# Slack Teammate Runtime Scenarios

Issue: https://github.com/evalops/maestro-internal/issues/2021

Maestro's role in Slack teammate runtime scenarios is to turn redacted Slack
teammate outcomes into deterministic scenario and trajectory coverage. Platform
owns Slack ingress, runtime rendering, work-envelope state, trace joins, and
evidence contracts. Maestro owns the offline scenario pack that keeps the
teammate path replayable and scoreable without a live model provider or raw
Slack payloads.

## Current Harness Mapping

The existing Maestro trajectory stack already gives the runtime most of the
needed primitives:

| Runtime need | Maestro primitive | Notes |
| --- | --- | --- |
| Preserve Slack thread shape without raw content | `evalops.maestro.agent-trajectory.v1` events | Events keep stable IDs, phases, actors, visibility, safe summaries, and evidence anchors. Raw Slack text stays out of the artifact. |
| Replay a long-horizon teammate path | `evalops.maestro.agent-trajectory-replay.v1` | Replay reports preserve deterministic deltas, tool-call lifecycle, and phase summaries. |
| Score progress, evidence, memory, and final outcome | `evalops.maestro.agent-trajectory-score.v1` | Deterministic findings name the gate, event IDs, remediation, and evidence anchors. |
| Produce operator-review evidence | `evalops.maestro.agent-trajectory-inspection.v1` | Inspection artifacts expose redacted timeline items, events, score findings, and final answer jump targets. |
| Promote to release-gating scenarios | `evalops.maestro.scenario.v1` | Scenario files add workflow assumptions, threat model, human labels, Platform trace joins, assertions, result JSON, and JUnit. |

This slice extends the scenario contract with `externalRefs` so a fixture can
carry actual redacted cross-system IDs:

- `platformSlackEventIds`: governed Platform Slack event or source-record IDs.
- `platformTraceIds`: Platform or OpenTelemetry trace IDs.
- `platformWorkEnvelopeIds`: stable Slack work-envelope IDs.
- `slackThreadRefs`: redacted workspace/channel/thread references.
- `evidenceArtifactIds`: VFS or artifact IDs that point to safe evidence bundles.

The new `external.refs` assertion proves those references are present before a
scenario can pass. It lets Maestro consume Platform Slack event IDs and Platform
trace/work-envelope IDs without copying raw transcript text, tool arguments, or
model output into the fixture.

## Fixture Strategy

The initial corpus adds two fixtures:

| Fixture | Purpose | Expected outcome |
| --- | --- | --- |
| `slack-teammate-progress-outcome` | Long-horizon Slack teammate path with ingress, progress reply, memory lifecycle, evidence artifact, and final answer. | `pass` |
| `slack-teammate-unsafe-degraded` | Unsafe or under-evidenced Slack action request that must block, explain the degraded state, and provide a useful next action. | `pass` |

The degraded fixture is expected to pass because the harness is validating the
correct blocked behavior, not rewarding the unsafe request. It carries
`degraded`, `unsafe_input`, and `needs_human_review` labels so downstream
training or release gates can distinguish it from a clean success.

## Privacy And Security Boundary

Slack teammate runtime fixtures must not include:

- raw Slack message text;
- customer names, emails, secrets, tokens, private keys, or connector payloads;
- raw prompts, model responses, tool arguments, tool outputs, shell output, or
  file bytes;
- VFS artifact bytes or raw artifact URIs outside explicitly safe evidence IDs.

The fixture summaries are intentionally product-safe paraphrases. Platform owns
permissioned access to raw Slack event history and evidence records; Maestro
only carries IDs and redacted evidence anchors needed for replay, scorecards,
and release gates.

## Promotion Path

1. Platform imports and redacts representative Slack threads, then emits
   governed Slack event IDs.
2. Platform joins Slack ingress, AgentRun, tool execution, memory, evidence, and
   rendering into trace/work-envelope IDs.
3. Maestro scenario fixtures consume those IDs through `externalRefs`, replay
   the expected event trajectory, and score deterministic outcome gates.
4. Cerebro indexes the score/result artifacts for queryable evidence.
5. Deploy runs the canonical suite in shadow mode first, then gates promotion
   once false-positive review is complete.

The current fixtures are deliberately small. They are the schema and regression
seed; the full runtime still needs the governed 100-thread train/dev/holdout
corpus and production shadow-mode comparison before release enforcement.
