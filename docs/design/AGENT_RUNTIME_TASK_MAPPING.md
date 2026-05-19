# AgentRuntime Task Mapping

This note is the next adoption-phase ADR for the Platform AgentRuntime bridge.
It follows the hosted progress projection in
[`PLATFORM_AGENT_RUNTIME_SESSION_BRIDGE.md`](PLATFORM_AGENT_RUNTIME_SESSION_BRIDGE.md)
and narrows the remaining design gap from evalops/maestro-internal#1720:
how Maestro local planning state maps to Platform durable run objects without
creating a second task graph inside Maestro.

## Decision

Maestro keeps `todo`, background tasks, and swarm/subagent coordination as
local runtime UX. Platform AgentRuntime becomes the durable product spine only
for transitions that need cross-session restore, hosted-runner support,
timeline/audit joins, or operator inspection.

That means Maestro should not port external `TaskCreateTool`, `TaskUpdateTool`,
or `TaskListTool` as a parallel durable task system. Those tools would duplicate
Maestro's existing local `todo` UX and compete with Platform's `AgentRun`,
`AgentRunStep`, `AgentRunWait`, checkpoints, artifacts, and runtime events.
The next write-through phase should project meaningful local transitions into
AgentRuntime instead of introducing another source of truth.

## Existing Boundaries

The current hosted bridge already writes:

- session start through `HandleTrigger`;
- turn start/end as `AgentRunStep` records;
- tool start/end as tool intent/result steps;
- server-request waits as `AgentRunWait` records with checkpoints;
- wait resolutions through `ResumeRun`;
- hosted-runner drain completion/failure as terminal run state.

The next task-state phase should reuse the same lease-gated, best-effort
recorder boundary in `src/server/hosted-agent-runtime-progress.ts`. It should
not let Platform mutate the live Maestro runtime, and it should no-op for local
or uncorrelated sessions.

The hosted recorder now exposes `recordTaskProgressEvent` and
`recordSwarmEvent`, and it derives initial todo/background task projections
from tool results during hosted runs. That gives Platform deterministic task
work item ids before any task state becomes Platform-authoritative.

## Mapping Table

| Maestro concept | Current local owner | Platform object | Write-through phase | Notes |
|---|---|---|---|---|
| `todo` goal | `src/tools/todo.ts` persisted checklist | `AgentRun` linkage or run attribute | Observation | The goal names the operator-visible intent for the current run. Do not create a separate Platform run for every local checklist. |
| `todo` item created | `todo` tool store | Timeline event, not a step by default | Observation | Creation is planning state. It becomes a step only after the agent starts acting on it. |
| `todo` item `pending` -> `in_progress` | `todo` update | `AgentRunStep` with `SYSTEM` kind and `RUNNING` state | Partial write-through | Use stable step id `maestro:<session>:todo:<todo_id>`. Include content, priority, blockers, and goal, redacted and length-bounded. |
| `todo` item `in_progress` -> `completed` | `todo` update | Same `AgentRunStep` with `SUCCEEDED` state | Partial write-through | Include completion metadata only; do not copy raw tool output or diffs. File edits/artifacts remain their own timeline/artifact events. |
| `todo` item moved back to `pending` | `todo` update | Same `AgentRunStep` with `PENDING` or timeline correction event | Partial write-through | Preserve local UX flexibility. Treat as a planning correction, not a failed run. |
| `todo` item removed | `todo` update | Timeline correction event | Observation | Removal is local planning cleanup unless the item had already started. |
| `todo.blockedBy` | `todo` item metadata | Step dependency attributes first; future Platform dependency edges later | Observation | Initial write-through should include blocker ids/names in step input. Add first-class Platform dependencies only after UI/read-model needs prove it. |
| Background task start | `src/tools/background-tasks.ts` | `AgentRunStep` with `SYSTEM` or `TOOL_CALL_INTENT` kind and `RUNNING` state | Partial write-through | Use when the task was started by a hosted run. Include command summary, cwd, shell mode, and task id, not environment values. |
| Background task restart | Background task runtime | Runtime event or step update | Observation | Restarts are operational signals. They should enrich the timeline without changing the parent task's semantic outcome. |
| Background task stopped/exited/failed | Background task runtime | Same step with `SUCCEEDED`, `CANCELLED`, or `FAILED` | Partial write-through | Map resource-limit failures to failed step output with safe reason and limit kind. |
| Background task logs | Background task log store | Artifact only when explicitly captured | Authoritative-later | Logs can be large and sensitive. Link a redacted artifact only when user-visible retrieval is intended. |
| Checkpoint created before/after mutation | `src/checkpoints/*` | `AgentRunCheckpoint` | Partial write-through | Checkpoint ids should reference the tool or task step that made the restore boundary meaningful. |
| Checkpoint restore | Checkpoint service | Runtime event plus checkpoint reference | Observation | Restore is a local control-plane action. Platform records it for audit/timeline, not as live ownership. |
| Swarm start | `src/agent/swarm/executor.ts` | Parent `AgentRunStep` or linked child run group | Observation | The default is one parent step under the current run until Platform needs independent leasing/retry per teammate. |
| Swarm task start | `SwarmEvent.task_start` | Child `AgentRunStep` under current run | Partial write-through | Preserve `swarmId`, `taskId`, `teammateId`, files, dependencies, and priority as safe metadata. |
| Swarm task complete/fail | `SwarmEvent.task_complete` / `task_fail` | Same child step with `SUCCEEDED` or `FAILED` | Partial write-through | Output should be summarized or linked as an artifact, not copied wholesale. |
| Swarm teammate process | `SwarmTeammate` subprocess | Step attributes now; linked `AgentRun` later | Authoritative-later | Separate linked runs make sense only when Platform can lease, retry, cancel, and inspect teammate work independently. |
| Swarm cancelled | `SwarmExecutor.cancel()` | Parent step `CANCELLED`; active child steps `CANCELLED` | Partial write-through | Cancellation should not fail the whole run unless the parent agent treats it as terminal. |
| User input / approval / MCP wait | Server request manager | `AgentRunWait` + checkpoint + `ResumeRun` | Shipped / #1710 follow-up | The local pending-request API remains the UX surface; #1710 owns canonical Platform resume wiring beyond Maestro-local resume. |

## Adoption Phases

### Phase 0: Shipped hosted progress

Maestro records session, turn, tool, wait, resume, and terminal hosted-runner
progress when an AgentRuntime run id and lease token are present. This is the
current bridge.

### Phase 1: Observation-only task events

Record planning/task lifecycle events for hosted runs without changing local
behavior:

- todo item create/remove/reorder/update events;
- background task restart and health events;
- checkpoint restore events;
- swarm start/complete/fail summary events.

These events should feed the timeline and audit joins but should not be used to
drive Maestro behavior.

Feature flag: `maestro.agent_runtime.task_events_enabled`.

### Phase 2: Partial write-through steps

Promote meaningful task execution transitions to AgentRuntime steps:

- todo item started/completed;
- background task started/stopped/failed;
- swarm task started/completed/failed;
- mutation checkpoints tied to the relevant step.

Maestro still owns local state and can continue if Platform writes fail. Step
ids must be deterministic from session id plus local object id so retries update
the same Platform object.

Feature flag: `maestro.agent_runtime.task_steps_enabled`.

### Phase 3: Platform-authoritative hosted task state

Use Platform as the authoritative hosted task ledger only after Platform can
represent dependencies, child runs, artifacts, cancellation, and resume
semantics needed by Maestro clients. Local `todo` remains available for
unmanaged/local sessions.

Feature flag: `maestro.agent_runtime.authoritative_tasks_enabled`.

This phase should require explicit managed deployment enablement and a migration
plan for existing local todo stores.

## Minimal Maestro Work For The Next Phase

0. Expose saved sessions as a local AgentRuntime ledger through
   `maestro run ledger|replay|promote`, giving harnesses an inspectable dry-run
   promotion contract before live Platform write-through is enabled.
1. Extend the existing hosted progress recorder with methods that accept
   normalized task events.
2. Emit normalized task events from the `todo`, background task, checkpoint, and
   swarm boundaries without importing Platform client code into those tools.
3. Use deterministic ids:
   - `maestro:<session_id>:todo:<todo_id>`
   - `maestro:<session_id>:background:<task_id>`
   - `maestro:<session_id>:swarm:<swarm_id>:task:<task_id>`
   - `maestro:<session_id>:checkpoint:<checkpoint_id>`
4. Add tests at the adapter boundary using fake AgentRuntime operations, similar
   to `test/server/hosted-agent-runtime-progress.test.ts`.
5. Extend the run-timeline fixture coverage so task steps render separately from
   raw tool calls and preserve product-safe redaction.
6. Keep #1710 separate: pending-request resume should wire Platform-correlated
   waits to canonical Platform resume/tool-resolution APIs before task state is
   made authoritative.

## Non-Goals

- Do not add external `TaskCreateTool`, `TaskUpdateTool`, or `TaskListTool`
  clones.
- Do not require Platform AgentRuntime for local Maestro sessions.
- Do not let Platform mutate the live todo store, background task manager, or
  swarm executor in Phase 1 or Phase 2.
- Do not copy raw task prompts, subprocess logs, environment variables, diffs,
  or teammate output into Platform payloads.

## Verification Plan

When implementing the next phase, verify:

- `npm run test -- test/server/hosted-agent-runtime-progress.test.ts`
- focused tests for each new task-progress adapter;
- `npm run test -- test/tools/todo.test.ts test/tools/background-tasks.test.ts test/agent/swarm-executor.test.ts`
- run-timeline tests for redacted task and swarm events;
- hosted-runner smoke in deploy before enabling managed write-through flags.
