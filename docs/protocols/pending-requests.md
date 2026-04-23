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

This contract is the Maestro-side client/read-model slice for
`evalops/maestro-internal#1417`. Platform still owns the canonical `AgentRunWait`
and `ApprovalRequest` APIs; Maestro uses this session projection so clients can
rehydrate pending decisions after reload or hosted-runner attach while preserving
the older split queues.
