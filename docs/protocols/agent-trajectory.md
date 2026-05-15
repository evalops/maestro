# Agent Trajectory Contract

`evalops.maestro.agent-trajectory.v1` is the portable flight-recorder envelope
for scoring, replay, and cross-service evidence joins. It is derived from the
product-safe run timeline rather than raw session JSONL, so downstream evals can
grade what the agent did without ingesting raw prompts, command strings, diffs,
or secret-bearing tool payloads.

The first implementation ships in `maestro run inspect <session-id> --json` as
`trajectory`. That makes the contract immediately usable for offline fixtures,
CI drift checks, and Platform promotion work without requiring hosted-runtime
changes first.

## Why This Shape

The current industry pattern is converging on four primitives:

- trace-first agent execution, where every LLM call, tool call, wait, and
  observation has stable IDs;
- checkpoint or time-travel replay, where debugging starts from a known runtime
  state rather than a best-effort transcript;
- trajectory-level scoring, where evals inspect the path an agent took instead
  of only the final answer;
- executable benchmark environments, where tests can replay actions against a
  controlled filesystem, browser, API, or sandbox.

Maestro already has the local ingredients: append-only session logs, headless
event replay, pending-request waits, governed tool metadata, context manifests,
and a product-safe run timeline. The trajectory envelope is the normal form
that lets those pieces feed EvalOps-wide replay and scoring.

## Envelope

```json
{
	"schemaVersion": "evalops.maestro.agent-trajectory.v1",
	"run": {
		"id": "session_123",
		"sessionId": "session_123",
		"source": "local",
		"generatedAt": "2026-05-09T16:00:08.000Z",
		"platformBacked": false
	},
	"counts": {
		"events": 14,
		"evidenceAnchors": 20,
		"byKind": { "tool": 6 },
		"byPhase": { "act": 3 },
		"byStatus": { "completed": 8 }
	},
	"events": []
}
```

Each event has:

- stable `id`, monotonic `sequence`, and original `timestamp`;
- `kind`, `phase`, `actor`, `type`, `status`, `visibility`, and `source`;
- bounded `title`, optional redacted `summary`, and optional `toolName`;
- `relatedIds` for joins;
- `evidence` anchors for timeline, tool-call, tool-execution, approval,
  pending-request, artifact, and parent/child agent-run IDs.

The event does not carry raw tool arguments, raw command output, raw diffs,
environment variables, or full message content. Those belong behind explicit
artifact/trace permissions and redaction policies.

## Kind And Phase Mapping

| Timeline family | Trajectory kind | Phase |
|---|---|---|
| `session.*` | `session` | `setup` |
| `message.user` | `message` | `observe` |
| `message.assistant` | `message` | `think` |
| `tool.requested` | `tool` | `act` |
| `tool.completed`, `tool.failed` | `tool` | `verify` |
| `file.changed`, `diagnostic.delta` | `evidence` | `verify` |
| `policy.decision` | `governance` | `govern` |
| `wait.pending` | `wait` | `wait` |
| `agent.run.started` | `agent` | `act` |
| `agent.run.completed`, `agent.run.failed` | `agent` | `verify` |
| `artifact.linked` | `artifact` | `verify` |
| `compaction.*`, `branch.*`, `model.*`, `thinking.*` | `context` | `setup` |

The mapping is intentionally coarse. Eval scorers should depend on stable
agent semantics like "requested tool", "observed result", "hit policy", and
"produced evidence", not on presentation-specific timeline titles.

## Implementation Roadmap

### Phase 1: Local trajectory export

- Emit `trajectory` from `maestro run inspect --json`.
- Keep fixture normalization independent, so existing replay fixtures do not
  drift unless the timeline itself changes.
- Add focused tests that prove tool calls, evidence anchors, phases, and counts
  are stable.

This phase is implemented by `src/server/agent-trajectory.ts`.

### Phase 2: Golden trajectory corpus

- Add `.trajectory.json` golden files beside session replay fixtures.
- Cover local JSONL sessions, legacy migrated sessions, governed tool denials,
  pending user input, MCP elicitation, compaction, diagnostic deltas, and
  artifact links.
- Add a checker that fails when trajectory shape drifts without an explicit
  fixture update.

The corpus is implemented by `scripts/check-agent-trajectory-fixtures.ts` and
wired into `lint:evals`. It checks both session replay fixtures and explicit
timeline fixtures so the contract can cover local JSONL reconstruction and
hosted/platform-backed run shapes. The checker also runs deterministic
integrity validation from `src/server/agent-trajectory-validation.ts`,
including count consistency, monotonic sequences, evidence anchors, and
tool-result ordering.

Current fixture coverage:

| Fixture | Source | Coverage |
|---|---|---|
| `session-replay/legacy-compacted-mcp-session.jsonl` | local session replay | legacy migration, MCP context, tool requests/results, file evidence, branch summaries, compaction |
| `session-replay/local-diagnostic-artifact-session.jsonl` | local session replay | governed outcome metadata, approval evidence, diagnostic deltas, artifact links, failed evidence status |
| `agent-trajectory/hosted-governed-recovery.timeline.json` | platform timeline | hosted/platform-backed run, approval wait, MCP elicitation wait, policy decision, failed tool result, recovery event, artifact, terminal runtime event |
| `agent-trajectory/codex-subagent-handoff.timeline.json` | platform timeline | Codex subagent spawn/wait provider tools, parent/child agent-run evidence, child-run completion scorer |

This gives the initial corpus coverage for every current trajectory phase:
`setup`, `observe`, `think`, `act`, `verify`, `govern`, `wait`, `recover`, and
`finish`. Product-facing backlog language may call these context, plan, act,
observe, recover, and finalize; the wire contract keeps the stable enum names
above.

### Phase 3: Deterministic replay harness

- Replay a trajectory against a frozen workspace and controlled tool adapters.
- Reconstruct user-visible outcome, tool sequence, policy waits, and evidence
  artifacts.
- Report deltas by phase: missing observation, wrong tool intent, failed
  evidence production, policy mismatch, or terminal outcome mismatch.

The initial replay harness is implemented by
`src/server/agent-trajectory-replay.ts` and checked by
`scripts/check-agent-trajectory-replay-fixtures.ts`. It performs a deterministic
contract replay over the golden corpus: trajectory validation, phase summaries,
tool-call lifecycle reconstruction, optional expected terminal tool status, and
required artifact checks. The checker writes `.trajectory-replay.json` goldens
beside the source fixtures and is wired into `lint:evals`.

This is intentionally the first replay layer. It does not yet hydrate a real
workspace or execute sandboxed tools; those adapters should plug into the same
`expectedTools` comparison path once frozen workspace/tool fixtures exist.

### Phase 4: Platform promotion

- Promote the same envelope into Platform as the semantic layer above raw
  event ingest and below product timeline views.
- Join `toolCallId`, `toolExecutionId`, `approvalRequestId`, `pendingRequestId`,
  `artifactId`, `agentRunId`, `traceId`, and `remoteRunnerSessionId`.
- Preserve Maestro-local ownership until Platform can represent replay,
  checkpoint, artifact, approval, and child-run semantics without lossy joins.

### Phase 5: Trajectory scorers

- Add deterministic scorers for required-tool-use, forbidden-tool-use,
  missing-approval, stale-context, artifact completeness, recovery behavior,
  and excessive wait/retry loops.
- Add LLM-as-judge only as an explanation layer over deterministic facts, not
  as the primary pass/fail mechanism.
- Attach scorer outputs to EvalOps evidence so regressions can be triaged from
  the same event IDs.

The initial scorer engine is implemented by
`src/server/agent-trajectory-scorers.ts` and checked by
`scripts/check-agent-trajectory-score-fixtures.ts`. Rules are deterministic and
config-driven: required/forbidden event selectors, terminal tool status,
required artifact evidence, approval-before-tool-result, recovery-after-failed
tool, child-run completion, and final evidence coverage. Fixture score reports
are emitted as `.trajectory-score.json` files and wired into `lint:evals`.

LLM-as-judge remains out of the pass/fail path. It can be added later as an
explanation layer over these stable rule ids, event ids, and evidence anchors.

### Phase 6: Replay lab

- Build an operator UI that shows final answer, trajectory, tool evidence,
  checkpoints, and scorer deltas side by side.
- Support jumping from a failed scorer to the exact trajectory event and its
  redacted source timeline item.
- Add "branch from event" only after checkpoint restore is fully permissioned
  and auditable.

The initial replay lab surface is implemented as
`evalops.maestro.agent-trajectory-inspection.v1` by
`src/server/agent-trajectory-inspection.ts`. `maestro run inspect --json`
includes `trajectoryReplay`, `trajectoryScore`, and `trajectoryInspection` so a
reviewer can inspect the redacted timeline item, trajectory event, replay delta,
and scorer finding from one JSON artifact. The inspection report deliberately
keeps raw prompts, raw tool arguments, raw tool outputs, full file diffs,
timeline metadata values, and secrets out of the artifact; it preserves stable
IDs, summaries, metadata keys, and redacted evidence anchors for jumping back to
permissioned source systems.

Fixture inspection reports are checked by
`scripts/check-agent-trajectory-inspection-fixtures.ts` and emitted as
`.trajectory-inspection.json` files beside the existing trajectory, replay, and
score goldens.

### Phase 7: Scenario acceptance harness

- Promote trajectory, replay, score, and inspection artifacts into versioned
  scenario files with workflow, correctness, threat-model, and research
  assumptions.
- Require human-review labels, Platform trace join keys, provenance chains,
  efficiency budgets, diff budgets, and adversarial negative fixtures before a
  scenario can become release-gating evidence.
- Keep the runner offline and deterministic so CI can validate scenarios without
  a live model provider.

The initial scenario harness is implemented by
`src/server/agent-trajectory-scenarios.ts` and exposed through
`maestro scenario validate <path>` and `maestro scenario run <path>`. The
contract lives in `packages/contracts/src/scenario.ts`, fixtures live in
`test/fixtures/agent-trajectory-scenarios`, and
`scripts/check-agent-trajectory-scenario-fixtures.ts` keeps scenario result and
JUnit artifacts stable. See `docs/protocols/agent-trajectory-scenarios.md` for
the scenario contract and Platform promotion path.

Executable replay is exposed separately through `maestro --replay <path>` and
`MAESTRO_SCENARIO_PATH`. That path selects the synthetic
`scripted-replay/maestro-replay-v1` model, bypasses external credentials, emits
zero-cost deterministic model events, and tags the session with
`scenario_replay` metadata so later CI and Platform consumers can distinguish
scripted runs from live-model runs.

Scenario recording is exposed through `maestro --record-scenario <path>`. The
recorder captures assistant text/tool-call frames during the normal runtime,
preserves tool-call ids and inputs, and keeps the output valid for immediate
`maestro scenario validate <path>` and `maestro --replay <path>` use.

Longer term, Maestro should own local reconstruction, redaction, and
permissioned branch/checkpoint actions. Platform should own cross-run storage,
indexing, trace joins, benchmark-suite aggregation, and durable artifact lookup
once it can represent replay, approval, checkpoint, artifact, and child-run
semantics without losing these event IDs.

## Non-Goals

- Do not make raw session JSONL the cross-service contract.
- Do not use the user-facing timeline as the only eval schema.
- Do not make Platform authoritative for local runtime state in this phase.
- Do not copy raw prompts, raw tool args, full diffs, shell output, or secrets
  into trajectory events.
- Do not introduce LLM-only trajectory scoring without deterministic anchors.

## Verification

For this phase:

- `npm run test -- test/cli/run-command.test.ts`
- `npm run check:session-replay-fixtures`
- `npm run check:agent-trajectory-fixtures`
- `npm run check:agent-trajectory-replay-fixtures`
- `npm run check:agent-trajectory-score-fixtures`
- `npm run check:agent-trajectory-inspection-fixtures`
- `npm run check:agent-trajectory-scenario-fixtures`
- `npm run test -- test/server/agent-trajectory-validation.test.ts`
- `npx tsc -p tsconfig.build.json --noEmit`

For later phases, expand the corpus to at least one local, one hosted, one
governed, and one recovering run before treating trajectory scoring as a release
gate.
