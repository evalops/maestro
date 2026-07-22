# MCP Servers

Maestro supports the Model Context Protocol so the agent can call external tools and data sources. Full detail: [MCP Guide](../../../../docs/MCP_GUIDE.md).

---

## Quick start

1. Install an MCP server (example: GitHub):

```bash
npm install -g @modelcontextprotocol/server-github
```

2. Create `~/.maestro/mcp.json`:

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "ghp_your_token_here"
      }
    }
  }
}
```

3. Launch Maestro and check status:

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
      "env": { "API_KEY": "…" },
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
| `http` / `sse` | Remote MCP server |

MCP servers do **not** inherit full `process.env` by default; pass required secrets explicitly in `env`.

---

## In-session commands

```text
/mcp
/mcp resources [server] [uri]
/mcp prompts …
/tools mcp
/diag mcp
```

Footer badges can show connected MCP counts (for example `mcp:2(14)`).

---

## Trust and safety

MCP tools still flow through approvals and the action firewall. Workspace trust, guarded files, and sandbox policy compose with MCP; see [Agent Safety Boundary](../../../../docs/design/AGENT_SAFETY_BOUNDARY.md) and [Sandbox and Safety](12-sandbox-and-safety.md).
