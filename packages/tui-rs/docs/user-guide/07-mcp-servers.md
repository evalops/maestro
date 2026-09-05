# MCP Servers

Deixic Code supports the Model Context Protocol so the agent can call external tools and data sources. Full detail: [MCP Guide](../../../../docs/MCP_GUIDE.md).

---

## Quick start

1. Add a server from the built-in registry:

```bash
maestro mcp registry list
maestro mcp registry add context7
```

Or add a custom local/remote server:

```bash
maestro mcp add local-docs npx -y @upstash/context7-mcp --type stdio
maestro mcp add remote-tools https://host.example/mcp --type http
maestro mcp add private-tools https://host.example/mcp --type http \
  --header 'Authorization: Bearer ${MCP_API_KEY}'
```

2. Launch Deixic Code and open the manager:

```text
/mcp
```

---

## Config locations

| Scope | Path |
|-------|------|
| User (preferred) | `~/.maestro/mcp.json` |
| Project | `.maestro/mcp.json` |
| User MCP override | `MAESTRO_USER_MCP_PATH` |
| Enterprise override | `~/.maestro/enterprise/mcp.json` or `MAESTRO_ENTERPRISE_MCP_PATH` |

**Legacy** paths still consulted by the native client: `~/.composer/mcp.json`, `.composer/mcp.json`, `.composer/mcp.local.json`, `~/.composer/enterprise/mcp.json`.

Project entries override user entries by server name where applicable.

---

## Formats

### Claude Desktop style (recommended)

```json
{
  "mcpServers": {
    "server-name": {
      "command": "node",
      "args": ["path/to/server.js"],
      "env": { "API_KEY": "${API_KEY}" },
      "cwd": "/optional/working/dir"
    }
  }
}
```

### Array style

```json
{
  "servers": [
    {
      "name": "server-name",
      "transport": "stdio",
      "command": "node",
      "args": ["path/to/server.js"]
    }
  ]
}
```

### Transports

| Transport | Description |
|-----------|-------------|
| `stdio` (default) | Spawn process, communicate on stdin/stdout |
| `http` | Streamable HTTP MCP endpoint; uses the configured URL directly and keeps a stateful MCP session |
| `sse` | Legacy Server-Sent Events transport using `<url>/sse` and `<url>/message` |

For a Streamable HTTP server, set `url` to its MCP endpoint (for example, `https://host.example/mcp`) and place any required authorization in `headers`. Deixic Code sends those headers on every MCP request, replays the server-issued `Mcp-Session-Id`, sends the `notifications/initialized` notification, and terminates the session with `DELETE` when disconnecting. If the endpoint rejects the initial Streamable HTTP POST with `400`, `404`, or `405`, Deixic Code falls back to the legacy `<url>/message` request path.

```json
{
  "servers": [
    {
      "name": "hosted-mcp",
      "transport": "http",
      "url": "https://host.example/mcp",
      "headers": { "Authorization": "Bearer ${MCP_API_KEY}" }
    }
  ]
}
```

For a user-configured remote server, run `maestro mcp auth <name>`. Maestro follows the MCP protected-resource and OAuth authorization-server metadata, uses browser PKCE, and stores access/refresh credentials in the operating-system credential store. Servers without dynamic client registration can be used with `--client-id`. `maestro mcp clear-auth <name>` removes the stored credential.

Centrally managed MCP authentication remains owned by the managed connection authority. Local remembered approvals never bypass managed or enterprise policy.

MCP servers do **not** inherit full `process.env` by default; pass required secrets explicitly in `env`.

---

## In-session commands

```text
/mcp
/mcp-config
/mcp resources [server] [uri]
/mcp prompts …
/tools mcp
/diag mcp
```

The manager shows connecting, ready, needs-auth, failed, disabled, blocked-policy, workspace-trust, and config-error states. Use Space to enable/disable a server or selected tool, `r` to retry, `c` for the registry, `o` for OAuth, and `p` for remembered permissions. Connection checks run in the background so slow servers do not freeze input.

---

## Trust and safety

MCP tools still flow through approvals and the action firewall. On a local MCP approval, `s` remembers the exact server/tool/schema identity for this session and `w` persists it. Any endpoint, command, arguments, credential reference, or schema change requires approval again. Inspect or revoke grants with `maestro mcp permissions list|revoke|clear`.

Workspace trust, guarded files, and sandbox policy compose with MCP; see [Agent Safety Boundary](../../../../docs/design/AGENT_SAFETY_BOUNDARY.md) and [Sandbox and Safety](12-sandbox-and-safety.md).
