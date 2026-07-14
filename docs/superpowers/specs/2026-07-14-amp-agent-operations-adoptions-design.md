# Amp-Inspired Agent Operations Adoptions

## Objective

Bring four proven Amp interaction patterns into Maestro without replacing Maestro's existing profile, trajectory, package, safety, or verified-outcome systems:

1. An agent-operations UI for observing and controlling parent and child runs.
2. Session-pinned routing profiles with a visible receipt for every turn.
3. A governed custom-agent plugin API for primary modes and subagents.
4. Outcome-calibrated Oracle experiments and rollout gates.

Each capability must be independently reviewable, mergeable, and releasable. A newly discovered `main` build regression in the painter package boundary must be fixed first because it prevents the repository's required baseline suite from running.

## Product Decisions

### Agent operations

The web composer will expose an operations panel sourced from the existing durable trajectory and runtime-ledger data. It will group runs as a parent/child tree, show the latest status and activity summary, and let a user open the associated session or run. Controls will be limited to operations already authorized by Maestro's runtime, initially stop/cancel and navigation; the UI will not invent a second execution-control channel.

The lineage contract will include both `parentAgentRunId` and `childAgentRunId` on web-facing timeline items. Tree construction will be deterministic, tolerate missing ancestors, and surface sparse or legacy records as roots rather than hiding them.

### Session-pinned routing and receipts

An agent profile selection will be stored per session. A request without an explicit override uses the session pin; an explicit request may update the pin only when the caller asks to persist it. The process-global mode remains a compatibility fallback for sessions that have no pin.

Every completed or failed turn will expose a routing receipt containing:

- requested profile and source (`request`, `session`, or compatibility default);
- resolved profile identifier and version;
- primary provider, model, and reasoning effort;
- Oracle policy decision;
- fallback or degradation reason, when applicable;
- experiment assignment, when applicable.

The composer will render a compact receipt next to the assistant turn and provide an expanded detail view. Receipts are historical facts: changing the current pin does not rewrite earlier turns.

### Governed custom-agent plugin API

Maestro packages may register custom agents through a typed API modeled on `createAgent(config)` and `registerAgentMode(registration)`. Agents can be used as a main mode or spawned as subagents. Static package metadata declares discoverable agent modes before plugin execution and must match runtime registration.

The runtime API is capability-scoped. Agent configuration may select only policy-approved models and tools, must provide bounded budgets, and cannot expand the host process's filesystem, network, approval, or sandbox authority. Registration fails closed for duplicate names, metadata mismatches, unknown tools, disallowed models, invalid budgets, or attempted permission escalation. Package trust and existing installation scope remain the outer trust boundary; an installed package does not automatically bypass runtime policy.

The initial API deliberately excludes arbitrary UI extensions, raw process access, and dynamic tool implementation. Existing Maestro extensions and MCP remain the mechanisms for adding executable tools. This keeps the first agent API useful while preserving a reviewable security boundary.

### Outcome-calibrated Oracle rollout

Oracle policy evaluation will use deterministic control/treatment assignment keyed by experiment and session. Control uses the current policy; treatment uses the candidate policy. The assignment and policy version appear in routing receipts and trajectory telemetry.

A rollout evaluator will accept only verified outcomes. Completion without verifier evidence remains unverified. Promotion requires all of the following:

- at least 20 verified samples in each arm;
- treatment success rate is not worse than control beyond a five-percentage-point guardrail;
- treatment cost and latency stay within explicitly configured ceilings;
- no safety regression or policy violation;
- confidence and sample sufficiency are emitted with the decision.

The evaluator returns `hold`, `promote`, or `rollback` plus machine-readable reasons. It never mutates production policy by itself; deployment or configuration automation consumes the decision through an explicit approval boundary.

## Architecture and Data Flow

The four capabilities extend existing boundaries:

1. Runtime-ledger and trajectory events remain the source of lineage truth.
2. Session metadata owns the routing pin, and the chat handler resolves it before routing.
3. The routing decision produces an immutable receipt stored with turn/session history and streamed to clients.
4. Package loading discovers static agent declarations, then a constrained registry validates runtime registrations against policy.
5. Oracle experiment assignment is attached before policy evaluation; verified outcomes feed aggregate evaluation after the run.

Contracts in `@evalops/contracts` will be the shared wire source for receipts, lineage, custom-agent registrations, and rollout decisions. HTTP and WebSocket paths must project the same contracts.

## Error Handling

- Missing lineage is represented explicitly and does not prevent other runs from rendering.
- Invalid or unavailable pinned profiles return a structured routing error and leave the prior valid pin unchanged.
- Receipt generation is required for routed turns; degradation details are recorded rather than silently discarded.
- Invalid custom-agent registrations fail atomically and do not partially modify the registry.
- Experiment evaluation rejects mixed policy versions, insufficient verified evidence, and invalid thresholds with machine-readable reasons.
- Existing compatibility clients continue to receive legacy model and mode fields.

## Delivery Slices

1. Fix the painter TypeScript package-boundary regression on `main`.
2. Land agent operations contracts, tree derivation, panel, navigation, and safe controls.
3. Land per-session profile pins and immutable per-turn routing receipts across HTTP, WebSocket, persistence, and web UI.
4. Land the governed custom-agent registry/API, static discovery metadata, package integration, and documentation.
5. Land deterministic Oracle experiments, verified-outcome gates, telemetry, and operator-facing decisions.
6. Mirror the merged internal commits through the existing public-sync automation and deploy one final image containing all slices to the internal environment.

## Testing and Verification

Every behavior change follows red-green-refactor development. Focused tests will cover lineage tree construction, legacy sparse records, session-pin precedence, receipt immutability, HTTP/WebSocket parity, plugin validation and escalation rejection, deterministic experiment assignment, and every rollout gate outcome.

Before each PR, run the focused tests plus the affected package builds. Before final merge and deployment, run:

- `bun run bun:lint`
- `npx nx run maestro:test --skip-nx-cache`
- `npx nx run maestro:evals --skip-nx-cache`
- `npx nx run maestro:build --skip-nx-cache`

After deployment, verify the exact image digest, workload rollout, authenticated internal health, and the public mirror health workflow.

## Non-Goals

- Replacing Maestro's package, skill, extension, MCP, or sandbox systems.
- Giving plugins unrestricted host-process capabilities.
- Automatically promoting an Oracle policy without an explicit operator or deployment boundary.
- Building a new scheduler or distributed execution engine.
- Retrofitting every non-web client with the operations UI in this delivery.
