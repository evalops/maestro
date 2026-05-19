# Agent Trajectory Scenarios

Agent trajectory scenarios are the acceptance harness above raw trajectory replay. A scenario names the workflow, threat model, correctness model, research assumptions, human-review labels, Platform trace keys, and assertions that make a replay artifact useful for CI, operators, and future training data.

## Contract

Offline acceptance scenario files use `evalops.maestro.scenario.v1` from `packages/contracts/src/scenario.ts`. Executable scripted replay files use `evalops.maestro.scripted-scenario.v1` from the same contract module.

Required fields:

- `source`: paths to trajectory, replay, score, and optional inspection artifacts. Diff assertions can also point at baseline and candidate trajectory/score artifacts.
- `reviewLabels`: human labels such as `accepted`, `degraded`, `unsafe_input`, `needs_human_review`, `efficiency_regression`, and `platform_promotion_ready`.
- `platform`: the target primitive (`trajectory`, `timeline`, `event_bus`, `artifact_store`, or `standalone`) plus trace join keys. Scenario results always include `maestro.events.eval.scored` as the evidence event type.
- `externalRefs`: optional cross-system IDs that let scenarios consume upstream
  artifacts without copying raw payloads. Slack contract-lab scenarios use this
  to carry Ensemble transcript IDs, Platform trace IDs, work-envelope IDs,
  redacted Slack thread refs, and safe evidence artifact IDs.
- `assumptions`: workflow, correctness model, threat model, and research basis.
- `assertions`: deterministic checks over events, replay deltas, scorer findings, inspection redaction, efficiency budgets, provenance chains, human labels, and trajectory diffs.

Scripted replay scenarios may also include executable assertions:

- `tool_called` and `tool_not_called` check deterministic tool-call intent.
- `file_exists` and `file_contents` check fixture or workspace side effects.
- `audit_event_emitted` checks replay/audit tags declared by the scenario.
- `external.refs` checks that required external ref families and IDs are present
  before a cross-repo scenario can pass.

## Commands

```sh
maestro scenario validate ./test/fixtures/agent-trajectory-scenarios/local-diagnostic-success.json
maestro scenario run ./test/fixtures/agent-trajectory-scenarios/local-diagnostic-success.json --junit ./tmp/local-diagnostic-success.xml
maestro scenario run ./test/fixtures/scripted-replay/basic-tool-call.json --junit ./tmp/basic-tool-call.xml
maestro --replay ./test/fixtures/scripted-replay/basic-tool-call.json
```

`maestro scenario run` exits nonzero when the observed outcome is `fail` for both offline acceptance scenarios and scripted replay scenarios. The fixture checkers allow intentional negative fixtures by requiring `expectedOutcome: "fail"` and verifying that the observed outcome is also `fail`. JUnit output is supported for both scenario families.

`maestro --replay <path|uri>` opens a real agent session using the synthetic `scripted-replay/maestro-replay-v1` model. It accepts local files, HTTPS signed URLs, and `gs://` GCS object URLs readable by `gcloud storage cat`. It sets `MAESTRO_SCENARIO_PATH`, bypasses external model credentials, emits zero-cost model usage, and tags the saved session with a `scenario_replay` custom entry containing `{ replay: true, scenarioId, path }`.
Headless clients receive `executor_type: "replay"` on the initial `ready`
message, giving hosted control planes and TUIs a protocol-level replay badge
without inferring it from model names.

`maestro --record-scenario <path>` records assistant turns from a live session into an executable scripted scenario. It writes text blocks and tool-call blocks in frame order, preserves tool-call ids and inputs, and keeps the file valid after each assistant response so interrupted sessions still leave a usable fixture. Running `maestro --replay <recorded-path> --record-scenario <roundtrip-path>` should produce the same frames modulo timestamp and output filename.

## CI Corpus

`npm run check:agent-trajectory-scenario-fixtures` validates:

- `local-diagnostic-success`: success path with replay, score, inspection redaction, provenance, human labels, diff budget, and efficiency budget.
- `hosted-degraded-recovery`: degraded hosted path with approval, recovery, and human-review labels.
- `codex-subagent-handoff`: Codex parent/child agent-run handoff with spawn/wait tools, child-run scorer, provenance, and Platform trace keys.
- `adversarial-unsafe-tool-negative`: negative safety path that proves privileged edit requests are not silently accepted under an adversarial policy.
- `slack-contract-progress-outcome`: Slack teammate contract-lab path with
  redacted Ensemble transcript refs, Platform trace/work-envelope refs, progress
  reply, memory lifecycle, safe evidence artifact, and final Slack outcome.
- `slack-contract-unsafe-degraded`: Slack teammate contract-lab degraded path
  where missing evidence blocks the unsafe action and produces a useful next
  step instead of silently executing.

These fixtures close the gap between contract replay and product-facing acceptance evidence. Scripted replay then exercises the normal agent runtime with deterministic text/tool-call frames so local sessions, headless harnesses, and future recorders can consume the same evidence vocabulary.

`npm run check:scripted-scenario-fixtures` validates executable scripted replay
fixtures and requires each fixture to carry at least one assertion. The
`npm run check:slack-contract-lab-scenarios` check validates the Slack-specific
external refs, required score assertions, degraded labels, and fixture payload
redaction guardrails. The
`scenario replay` GitHub Actions workflow runs both fixture checkers on PRs that
touch agent/runtime/contract replay surfaces and emits a JUnit smoke artifact
from `maestro scenario run`. The replay gate also runs every checked-in
agent-trajectory and scripted-replay fixture through the public CLI via
`npm run check:scenario-replay-gate -- --junit-dir tmp/scenario-replay`, writes a
summary, and uploads the resulting JUnit XML as the `scenario-replay-*` workflow
artifact.

## Platform Promotion

Until Platform owns cross-run storage, Maestro keeps local scenario result artifacts beside the golden trajectory fixtures. The result shape is intentionally Platform-ready:

- `run.scenarioId` and `run.replay: true` mark deterministic replay sessions.
- `platform.traceJoinKeys` declares the join keys needed for Timeline, ToolExecution, and future trace storage.
- `provenance` enumerates source, decision, and output evidence anchors without exposing raw secrets.
- `counts` carries SLO-style success, failure, latency-adjacent, and efficiency gates.

When Platform takes over corpus storage, these result artifacts should be published as `maestro.events.eval.scored` events and indexed by `sessionId`, `scenarioId`, and evidence anchor ids.
