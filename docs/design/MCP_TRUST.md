# MCP Workspace Trust

Maestro treats MCP tool invocation trust as a property of both the MCP server and
the current workspace. A server that is safe in one repository can still be risky
in another repository if the workspace contains hostile instructions, different
credentials, or project-local configuration that changes what the server can do.

## Trust Model

For each `(mcpServerId, workspaceUri)` tuple, trust resolves to one of:

- `trusted`: the agent may invoke the MCP server's tools.
- `ask`: the next invocation must ask the connected client before the tool call
  reaches the MCP server.
- `blocked`: the server is explicitly blocked for this workspace.
- `untrusted`: the server is unavailable unless policy/config changes.

When no workspace trust config exists, Maestro preserves the historical behavior
and treats configured MCP servers as trusted. Organizations can opt into
per-workspace prompting by setting:

```json
{
  "workspaceTrustDefault": "ask"
}
```

Specific server/workspace entries are configured with `trustedWorkspaces`:

```json
{
  "trustedWorkspaces": {
    "linear": [
      {
        "workspaceUri": "git:git@github.com:evalops/platform.git",
        "mode": "trusted",
        "grantedBy": "admin",
        "grantedAt": "2026-05-07T00:00:00.000Z",
        "reason": "Approved for Platform issue triage"
      }
    ]
  }
}
```

Configured entries take precedence over locally persisted user decisions so
central policy can revoke or block a workspace even after a user previously chose
`trust_always`. A `workspaceTrustDefault` of `untrusted` also overrides locally
stored trust.

## Workspace Identity

Maestro resolves the workspace URI from the active MCP config project root:

1. Prefer the Git `origin` remote URL when available, encoded as
   `git:<remote-url>`.
2. Fall back to the canonical local path, encoded as `file:<absolute-path>`.

The Git remote form is stable across machines for cloned repositories. The file
form keeps non-Git workspaces enforceable while acknowledging that trust is local
to that machine/path.

## Invocation Enforcement

`McpClientManager.callTool()` checks workspace trust before calling the MCP SDK.
For `ask`, it routes through the existing headless/client request path by calling
the connected client tool service with `toolName: "mcp_elicitation"`. That maps
to the runtime `SERVER_REQUEST_TYPE_MCP_ELICITATION` primitive instead of
invoking the MCP tool directly after connection.

The user can choose:

- `trust_once`: allow this invocation only.
- `trust_always`: persist a trusted entry for this server/workspace.
- `block`: persist a blocked entry for this server/workspace.
- `cancel`: deny this invocation.

If no MCP elicitation-capable client is connected, ask-mode invocations fail
closed and the MCP SDK tool call is not made.
