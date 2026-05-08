# Agent Safety Boundary

Maestro's agent safety boundary is the set of checks that run before a model
can read, write, execute, or delegate through a tool. The boundary is deliberately
layered: no single approval mode, MCP trust setting, or sandbox policy is treated
as enough context to make a risky action safe.

This note ties together the two user-controlled safety surfaces that are most
likely to be confused:

- [Guarded Files](GUARDED_FILES.md): path-level protection for user, editor,
  agent, and credential configuration.
- [MCP Workspace Trust](MCP_TRUST.md): server plus workspace trust for MCP tool
  invocation.

## Boundary Layers

| Layer | Scope | Default | Override shape | Audit shape |
| --- | --- | --- | --- | --- |
| Tool availability | Tool name and runtime surface | Tool-specific | Runtime config and feature flags | Tool unavailable or approval events |
| MCP trust | `(mcpServerId, workspaceUri)` | Historical trusted mode unless policy sets `ask` or `untrusted` | `trustedWorkspaces` and `workspaceTrustDefault` | MCP elicitation and trust decision events |
| Guarded files | Path or glob category | Built-in guarded categories require prompt approval | User/org `guardedFiles` allowlists, rules, and mandatory keys | `ApprovalHit` with `policy_id: guardedFiles_block` |
| Action firewall | Command/tool risk | Prompt or block by policy | Approval mode, hooks, governance policy | Approval and denial events |
| Sandbox | Process/file isolation | Runtime-selected mode | Sandbox policy | Sandbox violation events |

The layers are cumulative. For example, a trusted MCP server still cannot silently
read `~/.ssh/config`, and a guarded-file allowlist does not make an untrusted MCP
workspace callable.

## MCP Trust Flow

MCP calls enter the boundary in `McpClientManager.callTool()` before the MCP SDK
invocation happens.

1. Resolve the current workspace identity.
2. Resolve server/workspace trust from configured policy and local persisted
   decisions.
3. If the result is `ask`, issue a server request through the existing
   `mcp_elicitation` path, which maps to
   `SERVER_REQUEST_TYPE_MCP_ELICITATION`.
4. Invoke the MCP tool only after a trust decision allows the call.
5. Block or cancel without contacting the MCP server when trust is denied.

This keeps trust grants separate from normal tool invocation approval. The trust
decision answers "may this server act in this workspace"; the later tool policy
still answers "may this concrete call run now."

## Guarded File Flow

Guarded file checks run inside the tool safety pipeline before permission hooks
or permissive approval modes can auto-allow the operation.

1. Extract candidate paths from direct file tools, search/list/diff/status
   tools, shell commands, and background tasks.
2. Match candidates against the default guarded file categories plus org and
   user custom rules.
3. Apply allowlists only for non-mandatory, non-`block` matches.
4. Require prompt approval for matching `ask` categories.
5. Block matching `block` categories or prompt-required access when no prompt
   surface is available.
6. Emit a structured `ApprovalHit` with guarded file metadata.

The default list ships in `@evalops/contracts` so clients and admin surfaces can
render the same policy shape the runtime enforces.

## Product Rule

When a safety boundary decision can affect user data, credentials, external
systems, or auditability, the product should expose the decision as a durable
request or event rather than relying on local stderr or an ephemeral prompt.

Today that means:

- MCP trust prompts use the server-request path.
- Guarded file prompts use normal action approval events.
- Guarded file blocks emit `guardedFiles_block` approval telemetry.
- Platform ToolExecution can see guarded-file denials as governed tool
  unavailability or denial decisions.

## Current Completion State

The shipped boundary covers:

- Default guarded file categories for editor, agent, shell, SSH, and GPG paths.
- Read, write, search/list/diff/status, shell, and background-task path checks.
- User and organization guarded-file rules, key/path allowlists, mandatory keys,
  and hard block behavior.
- Prompt-time guarded-file awareness in the system prompt.
- Per-workspace MCP trust with `ask`, `trusted`, `blocked`, and `untrusted`
  resolution.
- MCP `ask` routing through the headless server-request primitive instead of a
  direct post-connect invocation.
- Documentation for the guarded-file and MCP trust policies.

Remaining work should be filed as narrower follow-ups only when it changes a
specific surface, such as a richer admin UI, a new audit sink, or a stricter
org-managed default.
