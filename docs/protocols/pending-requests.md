# Pending Request Contract

Maestro exposes pending human decisions through a compatibility surface and a
normalized product surface.

The compatibility fields on `GET /api/sessions/:id` remain:

- `pendingApprovalRequests`
- `pendingClientToolRequests`
- `pendingToolRetryRequests`

New clients should read `pendingRequests` when they need one queue across web,
hosted attach, admin, and Platform-backed flows. Each entry includes:

- `kind`: `approval`, `client_tool`, `mcp_elicitation`, `user_input`, or
  `tool_retry`
- `status`: currently `pending`
- `visibility`: currently `user`
- `toolCallId`, `toolName`, display labels, and redacted args
- `createdAt` and `expiresAt`
- `source`: `local` or `platform`
- `platform`: optional correlation for Platform approvals or ToolExecution

Platform ToolExecution waits set:

```json
{
  "source": "platform",
  "platform": {
    "source": "tool_execution",
    "toolExecutionId": "texec_123",
    "approvalRequestId": "approval_123"
  }
}
```

Approvals that are mirrored into the shared approvals service use
`platform.source=approvals_service`.

`POST /api/pending-requests/:requestId/resume` is the canonical Maestro UX
entry point. For hosted AgentRuntime waits with an active `agentRunId`, Maestro
calls Platform `ResumeRun` before resolving the local request. Governed
ToolExecution approval resume tokens stay server-side inside the ToolExecution
bridge plan; the web pending-request payload only exposes correlation ids, and
the bridge performs `ResumeToolExecution` after the local approval decision is
released.

MCP tools may still return governed-result payloads for compatibility with older
servers. Maestro normalizes those payloads into
`evalops.maestro.mcp-governed-tool-execution.v1` with
`authority=mcp_result_adapter` and states such as `waiting_approval`, `denied`,
`blocked_authentication`, and `blocked_retry_later`. That normalized state is
diagnostic metadata on the tool result, not the approval authority. New governed
MCP calls should flow through Platform ToolExecution so wait, resume, deny,
cancel, and output recording all use the same state machine as shell tools.

This contract is the Maestro-side client/read-model slice for
`evalops/maestro-internal#1417`. Platform still owns the canonical `AgentRunWait`
and `ApprovalRequest` APIs; Maestro uses this session projection so clients can
rehydrate pending decisions after reload or hosted-runner attach while preserving
the older split queues.

Web clients should merge `pendingRequests` with the legacy split queues during
the rollout. When the same request appears in both surfaces, prefer the
normalized `pendingRequests` entry so Platform correlation fields and refreshed
display metadata survive attach/reload recovery. Client UI surfaces should also
preserve `source`, `createdAt`, and `expiresAt` from the normalized entry so
users can tell whether a wait is Platform-backed and whether it is close to or
past timeout.
