# Platform ToolExecution Bridge

This document describes how Maestro maps local tool calls onto Platform `ToolExecution`
records so policy, approval, audit, and provenance can share one lifecycle.

## Overview

The bridge sits between Maestro's local safety pipeline and actual tool execution.
It decides whether a tool call should:

- stay local with no Platform traffic
- run locally and write an observe-only `ToolExecution` record
- create a governed `ToolExecution` first and wait for a Platform decision

The first implementation keeps local Maestro execution authoritative. Platform
currently governs classification, approval, and provenance, but the actual tool
handler still runs inside Maestro after approval.

## Rollout Flags

Feature flags are read from the JSON snapshot at `EVALOPS_FEATURE_FLAGS_PATH`.

| Flag | Effect |
|------|--------|
| `maestro.platform_runtime.agent_runtime_observe` | Enables observe-only Platform recording for supported tool calls |
| `maestro.platform_runtime.tool_execution_bridge` | Enables governed ToolExecution preflight and approval flow |
| `platform.kill_switches.maestro.platform_runtime_bridge` | Hard-disables the bridge even if rollout flags are on |

Rollout semantics:

- no rollout flags: Maestro stays fully local
- observe flag only: supported tool calls run locally and then write best-effort summaries to Platform
- bridge flag: observe mode is also enabled, and governed tool families can preflight through Platform
- kill switch: bridge logic is skipped entirely

## Supported Tool Families

The first cut supports Bash and MCP-backed tools.

| Tool family | Classification | Platform mode |
|-------------|----------------|---------------|
| `bash` read-only commands such as `git status`, `ls`, `cat`, `rg` | low risk | observe |
| `bash` mutating commands such as `git push`, `rm`, `kubectl apply`, `npm publish` | high or critical risk | governed when bridge flag is enabled |
| `mcp__...` tools | medium or high risk based on read-only hints | governed when bridge flag is enabled, otherwise observe-only when observe mode is enabled |

Governed Bash calls fail closed when Platform is unavailable. Observe-only calls
never block local execution.

## Environment and Destination Resolution

The bridge uses the shared Platform client and resolves configuration in this order.

### Base URL

1. `TOOL_EXECUTION_SERVICE_URL`
2. `MAESTRO_TOOL_EXECUTION_SERVICE_URL`
3. `MAESTRO_PLATFORM_BASE_URL`
4. `MAESTRO_EVALOPS_BASE_URL`
5. `EVALOPS_BASE_URL`

### Access token

1. `TOOL_EXECUTION_SERVICE_TOKEN`
2. `MAESTRO_TOOL_EXECUTION_SERVICE_TOKEN`
3. `MAESTRO_EVALOPS_ACCESS_TOKEN`
4. `EVALOPS_TOKEN`
5. stored EvalOps OAuth token, when present

### Organization ID

1. `TOOL_EXECUTION_SERVICE_ORGANIZATION_ID`
2. `MAESTRO_TOOL_EXECUTION_ORGANIZATION_ID`
3. `MAESTRO_EVALOPS_ORG_ID`
4. `EVALOPS_ORGANIZATION_ID`
5. `MAESTRO_ENTERPRISE_ORG_ID`
6. stored EvalOps OAuth organization metadata, when present

### Workspace ID

1. `TOOL_EXECUTION_SERVICE_WORKSPACE_ID`
2. `MAESTRO_TOOL_EXECUTION_WORKSPACE_ID`
3. `MAESTRO_REMOTE_RUNNER_WORKSPACE_ID`
4. `MAESTRO_EVALOPS_WORKSPACE_ID`
5. `EVALOPS_WORKSPACE_ID`
6. `MAESTRO_WORKSPACE_ID`

Timeout and retry tuning can be overridden with:

- `TOOL_EXECUTION_SERVICE_TIMEOUT_MS`
- `MAESTRO_TOOL_EXECUTION_SERVICE_TIMEOUT_MS`
- `TOOL_EXECUTION_SERVICE_MAX_ATTEMPTS`
- `MAESTRO_TOOL_EXECUTION_SERVICE_MAX_ATTEMPTS`

If the bridge cannot resolve a usable Platform destination, it returns `skip` and
Maestro keeps local behavior.

## Request Shape

Each governed or observed call builds a Platform `ExecuteTool` request with:

- stable linkage:
  - `organizationId`
  - `workspaceId`
  - `agentId`
  - `runId`
  - `stepId` from the Maestro `tool_call_id`
  - `actorId`
  - `surface`
  - `channelId`
  - `correlationId`
- a normalized tool reference for Bash or MCP
- sanitized arguments only
- risk level and retry policy
- metadata carrying Maestro correlation fields such as session ID, remote-runner
  session ID, display labels, and redaction state

Observe-only result recording adds:

- `maestro_local_outcome`
- `maestro_local_output_summary`
- `maestro_local_output_redactions`

Only a short scrubbed output summary leaves Maestro. Secret-like tokens are
redacted before the summary is sent.

## Flow

### Observe-only flow

1. Local safety and redaction run first.
2. The bridge classifies the call as observe-only.
3. Maestro executes the tool locally.
4. After completion, Maestro writes a best-effort `ExecuteTool` record with the
   sanitized arguments and scrubbed output summary.
5. Failure to write the observe record is logged and local execution still succeeds.

### Governed flow

1. Local safety and redaction run first.
2. The bridge calls Platform `ExecuteTool` before local execution.
3. Platform can:
   - allow execution
   - return `WAITING_APPROVAL`
   - deny execution
4. For approval waits, Maestro exposes the pending approval through its normal
   approval surface.
5. Approval resolution is synced back through `ResumeToolExecution`.
6. If Platform allows the action, Maestro runs the local tool handler.

## Failure Modes

| Condition | Behavior |
|-----------|----------|
| no rollout flags | skip bridge, local-only Maestro behavior |
| rollout enabled but no Platform config | skip bridge, local-only Maestro behavior |
| observe-only record fails | log warning and keep local result |
| governed preflight fails | deny the local tool call |
| approval sync fails after an allow decision | deny the local tool call and surface the sync failure |
| Platform returns denial | block the tool call with the Platform reason |

## Event Correlation

`tool_execution_start` and `tool_execution_end` events can carry:

- `toolExecutionId`
- `approvalRequestId`

This lets Maestro runtime telemetry, UI timelines, and downstream Platform
records join on the same execution.

## Testing

Focused coverage lives in:

- `test/platform/tool-execution-client.test.ts`
- `test/agent/tool-execution-bridge.test.ts`
- `test/agent/tool-safety-pipeline.test.ts`

The bridge tests cover:

- observe-only Bash recording
- governed MCP allow path
- governed approval wait and resume
- Platform denial
- governed Platform-unavailable fail-closed behavior
- no-config local fallback
- observe-only degradation when Platform recording fails
