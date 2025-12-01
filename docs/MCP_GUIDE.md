# MCP Server Integration Guide

This guide explains how to create, configure, and use custom MCP (Model Context Protocol) servers with Composer.

## What is MCP?

MCP (Model Context Protocol) is an open protocol that allows AI assistants to interact with external tools and data sources. Composer supports MCP servers, enabling you to extend its capabilities with custom tools.

## Quick Start

### 1. Install an existing MCP server

```bash
# Example: GitHub MCP server
npm install -g @modelcontextprotocol/server-github
```

### 2. Configure Composer to use it

Create `~/.composer/mcp.json`:

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

### 3. Verify connection

```bash
composer
/mcp
```

You should see:
```
Model Context Protocol

● github
    Tools: list_issues, create_issue, get_repository, ...
```

## Configuration

### File Locations

- **Global config**: `~/.composer/mcp.json` (applies to all projects)
- **Project config**: `.composer/mcp.json` (project-specific, overrides global)

### Configuration Formats

Composer supports two configuration formats:

#### Format 1: Claude Desktop Style (Recommended)

```json
{
  "mcpServers": {
    "server-name": {
      "command": "node",
      "args": ["path/to/server.js"],
      "env": {
        "API_KEY": "your-key"
      },
      "cwd": "/path/to/working/directory"
    }
  }
}
```

#### Format 2: Array Style

```json
{
  "servers": [
    {
      "name": "server-name",
      "transport": "stdio",
      "command": "node",
      "args": ["path/to/server.js"],
      "env": {
        "API_KEY": "your-key"
      }
    }
  ]
}
```

### Configuration Options

| Option | Type | Description | Required |
|--------|------|-------------|----------|
| `command` | string | Executable to run | Yes (for stdio) |
| `args` | string[] | Command arguments | No |
| `env` | object | Environment variables | No |
| `cwd` | string | Working directory | No |
| `url` | string | Server URL (for HTTP/SSE) | Yes (for HTTP/SSE) |
| `headers` | object | HTTP headers | No |
| `disabled` | boolean | Disable this server | No |
| `timeout` | number | Connection timeout (ms) | No (default: 30000) |

### Transport Types

Composer auto-detects the transport type:

- **stdio**: Default when `command` is provided
- **sse**: When URL contains `/sse` or `sse` subdomain
- **http**: For other URLs

## Creating a Custom MCP Server

### Minimal TypeScript Server

```typescript
// my-tools-server.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "my-tools", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// Define available tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "greet",
      description: "Generate a greeting message",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Name to greet",
          },
        },
        required: ["name"],
      },
    },
    {
      name: "calculate",
      description: "Perform basic math operations",
      inputSchema: {
        type: "object",
        properties: {
          operation: {
            type: "string",
            enum: ["add", "subtract", "multiply", "divide"],
          },
          a: { type: "number" },
          b: { type: "number" },
        },
        required: ["operation", "a", "b"],
      },
    },
  ],
}));

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "greet":
      return {
        content: [
          { type: "text", text: `Hello, ${args.name}! Welcome to Composer.` },
        ],
      };

    case "calculate": {
      const { operation, a, b } = args as {
        operation: string;
        a: number;
        b: number;
      };
      let result: number;
      switch (operation) {
        case "add":
          result = a + b;
          break;
        case "subtract":
          result = a - b;
          break;
        case "multiply":
          result = a * b;
          break;
        case "divide":
          result = b !== 0 ? a / b : NaN;
          break;
        default:
          throw new Error(`Unknown operation: ${operation}`);
      }
      return {
        content: [{ type: "text", text: `Result: ${result}` }],
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// Start the server
const transport = new StdioServerTransport();
await server.connect(transport);
```

### Build and Run

```bash
# Install dependencies
npm install @modelcontextprotocol/sdk

# Build
npx tsc my-tools-server.ts --module nodenext --moduleResolution nodenext

# Test locally
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node my-tools-server.js
```

### Register with Composer

```json
{
  "mcpServers": {
    "my-tools": {
      "command": "node",
      "args": ["/path/to/my-tools-server.js"]
    }
  }
}
```

## Tool Annotations

MCP tools can include behavior hints that Composer respects:

```typescript
{
  name: "delete_file",
  description: "Delete a file from the filesystem",
  inputSchema: { /* ... */ },
  annotations: {
    destructiveHint: true,   // May perform destructive actions
    readOnlyHint: false,     // Modifies environment
    idempotentHint: false,   // Multiple calls have different effects
    openWorldHint: true,     // Interacts with external systems
  }
}
```

| Annotation | Meaning |
|------------|---------|
| `readOnlyHint` | Tool doesn't modify its environment |
| `destructiveHint` | Tool may perform destructive updates |
| `idempotentHint` | Safe to call repeatedly with same args |
| `openWorldHint` | Tool interacts with external systems |

## Resources and Prompts

MCP servers can also provide resources (data) and prompts (templates):

### Listing Resources

```bash
/mcp resources
```

### Reading a Resource

```bash
/mcp resources my-server resource://path/to/resource
```

### Listing Prompts

```bash
/mcp prompts
```

### Getting a Prompt

```bash
/mcp prompts my-server prompt-name
```

## Example MCP Servers

### Database Query Server

```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "query") {
    const { sql } = request.params.arguments as { sql: string };

    // Safety: Only allow SELECT queries
    if (!sql.trim().toLowerCase().startsWith("select")) {
      return {
        content: [{ type: "text", text: "Error: Only SELECT queries allowed" }],
        isError: true,
      };
    }

    const result = await pool.query(sql);
    return {
      content: [
        { type: "text", text: JSON.stringify(result.rows, null, 2) },
      ],
    };
  }
});
```

### API Integration Server

```typescript
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "fetch_weather") {
    const { city } = request.params.arguments as { city: string };

    const response = await fetch(
      `https://api.weatherapi.com/v1/current.json?key=${process.env.WEATHER_API_KEY}&q=${city}`
    );
    const data = await response.json();

    return {
      content: [
        {
          type: "text",
          text: `Weather in ${city}: ${data.current.condition.text}, ${data.current.temp_c}°C`,
        },
      ],
    };
  }
});
```

### File Watcher Server

```typescript
import { watch } from "fs";

// Notify Composer when files change
watch("./src", { recursive: true }, (event, filename) => {
  server.notification({
    method: "notifications/resources/list_changed",
  });
});
```

## Troubleshooting

### Server not connecting

1. **Check server is executable**:
   ```bash
   node /path/to/server.js
   ```

2. **Verify config syntax**:
   ```bash
   cat ~/.composer/mcp.json | jq .
   ```

3. **Check Composer logs**:
   ```bash
   COMPOSER_LOG_LEVEL=debug composer
   ```

### Tools not appearing

1. **Verify server implements tools/list**:
   ```bash
   echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node server.js
   ```

2. **Check for connection errors** in `/mcp` output

### Environment variables not passed

- Only explicitly configured env vars are passed to stdio servers
- System env vars are NOT inherited (security measure)
- Add required vars to the `env` config block

### Server crashes on startup

- Check stderr output from the server
- Ensure all dependencies are installed
- Verify the working directory (`cwd`) is correct

## Security Considerations

1. **Environment Isolation**: MCP servers only receive explicitly configured env vars
2. **Input Validation**: Always validate tool inputs before execution
3. **Principle of Least Privilege**: Only expose necessary tools
4. **Secrets Management**: Use env vars for API keys, never hardcode

## API Reference

### MCP SDK

```bash
npm install @modelcontextprotocol/sdk
```

Key imports:
```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
```

### Composer MCP Commands

| Command | Description |
|---------|-------------|
| `/mcp` | Show server status and tools |
| `/mcp resources` | List all resources |
| `/mcp resources <server> <uri>` | Read a specific resource |
| `/mcp prompts` | List all prompts |
| `/mcp prompts <server> <name>` | Get a specific prompt |

## Further Resources

- [MCP Specification](https://spec.modelcontextprotocol.io/)
- [MCP SDK Documentation](https://github.com/modelcontextprotocol/sdk)
- [Example MCP Servers](https://github.com/modelcontextprotocol/servers)
