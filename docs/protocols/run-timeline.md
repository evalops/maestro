# Run Timeline Contract

Maestro exposes a session-scoped run timeline at
`GET /api/sessions/:id/timeline`. The endpoint is a product read model for
answering what happened in a run without exposing raw tool arguments, raw diffs,
or secret-bearing payloads.

Local sessions use local session state. Hosted/Platform-backed sessions prefer
Platform `MaestroTimelineService/ListRunTimeline` when Maestro has an
`agent_run_id` or `remote_runner_session_id`, then fall back to the local
projection if Platform is not configured or unavailable. That keeps the visible
workflow understandable: start or attach a Maestro session, run governed tools,
and inspect the same run in Platform's timeline.

Required Platform configuration follows the shared EvalOps client conventions:

- `MAESTRO_PLATFORM_BASE_URL` or `MAESTRO_TIMELINE_SERVICE_URL`
- `MAESTRO_EVALOPS_ACCESS_TOKEN` or `MAESTRO_TIMELINE_SERVICE_TOKEN`
- `MAESTRO_EVALOPS_ORG_ID`
- `MAESTRO_REMOTE_RUNNER_WORKSPACE_ID` or `MAESTRO_TIMELINE_WORKSPACE_ID`

## Visibility Classes

| Visibility | Intended audience | Examples |
| --- | --- | --- |
| `user` | Normal run participants | user/assistant messages, tool requests/results, file changes, diagnostic deltas, denied policy decisions, pending waits |
| `admin` | Workspace operators and audit-capable UI | session metadata, model changes, compaction summaries, linked skill artifacts, non-denied policy decisions |
| `audit` | Compliance and forensic views | low-level custom events that do not yet have a product-safe summary |

Clients may render `user` events by default. Admin surfaces can include `admin`
events. `audit` events should stay hidden unless the caller is explicitly in an
audit workflow.

## Stable IDs

Timeline items should include whichever stable IDs are available:

- `sessionId` for every event
- `toolCallId` for tool request/result-derived events
- `approvalRequestId` and `toolExecutionId` for Platform waits or governed tool
  outcomes
- `artifactId` for linked skill or generated artifacts
- `remoteRunnerSessionId` when an event comes from a hosted runner session

## Redaction

Timeline summaries are compacted and redacted before response serialization.
Do not put raw tool arguments, raw diffs, command strings, file contents, or
full secret-bearing payloads in `summary` or `metadata`. Prefer counts, stable
IDs, display paths, result classifications, and booleans such as `hasDiff`.

Known event families:

- `session.*`, `message.*`, `tool.*`, and `wait.pending`
- `file.changed` for write/edit tool results
- `diagnostic.delta` for LSP diagnostic deltas from write/edit tool results
- `artifact.linked` for skill artifacts selected during a run
- `policy.decision` for governed tool outcomes
- `compaction.created`, `branch.created`, `model.changed`, `thinking.changed`,
  and `custom.event`
