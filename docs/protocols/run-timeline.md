# Run Timeline Contract

Maestro exposes a session-scoped run timeline at
`GET /api/sessions/:id/timeline`. The endpoint is a product read model for
answering what happened in a run without exposing raw tool arguments, raw diffs,
or secret-bearing payloads.

The current source is local session state. Platform-backed population can replace
or augment this projection later as long as it preserves the same redaction and
visibility rules.

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

Known local event families:

- `session.*`, `message.*`, `tool.*`, and `wait.pending`
- `file.changed` for write/edit tool results
- `diagnostic.delta` for LSP diagnostic deltas from write/edit tool results
- `artifact.linked` for skill artifacts selected during a run
- `policy.decision` for governed tool outcomes
- `compaction.created`, `branch.created`, `model.changed`, `thinking.changed`,
  and `custom.event`
