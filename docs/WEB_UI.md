# Maestro Web UI

Audience: users running the browser UI; contributors touching web server/client.  
Nav: [Docs index](README.md) · [Quickstart](QUICKSTART.md) · [Safety](SAFETY.md) · [Features](FEATURES.md)

Contents: [Features](#features) · [Architecture](#architecture) · [Conductor (Chrome Extension)](#conductor-chrome-extension) · [Quick Start](#quick-start) · [Configuration](#configuration) · [API Endpoints](#api-endpoints) · [Parity Appendix](#parity-appendix)

A browser-based interface for the Maestro AI coding assistant with core parity to the TUI. Parity is documented once—in the appendix below—to keep a single source of truth.

Parity at a glance:
- Full: chat, sessions, models, config, usage, approvals, attachments, artifacts, share links (read-only), document extraction.
- Not included by design: destructive undo/clear, deep diagnostics (LSP/MCP control), guardian controls, OAuth login/logout, and other terminal-only UX.

## Features

- **Real-time Streaming**: Live response streaming via SSE with WebSocket fallback
- **Full Tool Execution**: All Maestro tools work (bash, read, write, edit, etc.)
- **Modern Design**: GitHub-inspired dark theme with smooth animations
- **Theme Toggle**: Light/dark themes with persisted preference
- **Model Selection**: Switch between different AI models
- **Syntax Highlighting**: Code blocks with highlight.js
- **Markdown Rendering**: Rich text formatting with marked
- **Attachments**: Upload images/documents; preview (PDF/DOCX/XLSX/PPTX text), download, and lazy-load bytes for session history
- **Artifacts**: View generated artifacts with sandboxed HTML rendering and downloads
- **Share Links**: Generate `/share/:token` read-only links for sessions
- **Export Sessions**: Download JSON/Markdown/Text exports
- **Voice Input**: Speech-to-text (when supported by the browser)
- **Responsive Layout**: Mobile + desktop layouts with sidebar overlay
- **Auto-approval**: Tools execute automatically in web mode for seamless experience

## Architecture

```
┌─────────────┐       HTTP/SSE/WS         ┌──────────────┐
│  Web UI     │ ────────────────────────> │  Web Server  │
│  (Browser)  │ <──────────────────────── │  (Node.js)   │
└─────────────┘                           └──────────────┘
                                                  │
                                                  ├─> Agent Core
                                                  ├─> ProviderTransport
                                                  ├─> Tool Execution
                                                  └─> LLM Providers
```

## Conductor (Chrome Extension)

Conductor connects to the Maestro web server and executes browser automation
tools inside the active tab. This turns the Web UI into a browser-aware surface
that can read pages, click elements, type into inputs, and capture diagnostics.

Setup and bridge details live in `docs/CONDUCTOR_BRIDGE.md`. In short:

- Run the web server (`maestro web`).
- Enable the Conductor Bridge in the extension and point it at your server URL.
- Send client tool headers so the server includes Conductor tools:
  - `X-Maestro-Client-Tools: 1`
  - `X-Maestro-Client: conductor`

Security notes:
- For local dev, you can use `MAESTRO_WEB_REQUIRE_KEY=0` and `MAESTRO_WEB_ORIGIN="*"`.
- For shared/hosted setups, lock CORS to your extension origin and require API keys.

### Components

1. **Web UI** (`packages/web/`) - Lit web components
   - `<composer-chat>` - Main chat interface
   - `<composer-message>` - Message display with markdown
   - `<composer-input>` - Multi-line input with shortcuts
   - `<model-selector>` - Model selection dialog
   - More details: `packages/web/README.md`

2. **Web Server** (`src/web-server.ts`) - HTTP API server
   - `/api/models` - List available models
   - `/api/chat` - Streaming chat endpoint (POST)
   - `/api/chat/ws` - WebSocket chat endpoint (upgrade)
   - `/api/sessions` - Session management
   - `/` - Serves static web UI files

3. **Maestro Core** - Shared with TUI
   - Agent, ProviderTransport, SessionManager
   - Tool execution (codingTools)
   - LLM provider integration
   - System prompt loading

## Quick Start

Prereqs and installation: follow `docs/QUICKSTART.md` (same setup as TUI/CLI).

### Development Mode

Run both server and UI with hot reload:

```bash
bun run web:dev
```

This starts:
- **Server**: http://localhost:8080/api (with auto-reload)
- **UI**: http://localhost:3000 (Vite dev server)

### Production Mode

Build and run:

```bash
# Full stack build (CLI + TUI + Web)
npx nx run maestro:build:all --skip-nx-cache

# Start web server
bun run web
# or
node dist/web-server.js

# Opens at http://localhost:8080
```

## Configuration

### Environment Variables

```bash
# API Keys (same as TUI)
export ANTHROPIC_API_KEY="..."
export OPENAI_API_KEY="..."
export GOOGLE_API_KEY="..."

# Server Configuration
export PORT=8080                                    # Server port
export MAESTRO_SESSION_DIR="~/.maestro/sessions"  # Session storage
export MAESTRO_AGENT_DIR="~/.maestro/agent"       # Context files
export MAESTRO_SESSION_SCOPE="auth"                # Scope sessions by auth subject
export MAESTRO_MULTI_USER="1"                      # Alias for MAESTRO_SESSION_SCOPE

# Proxy Configuration (when behind nginx, CloudFlare, etc.)
export MAESTRO_TRUST_PROXY="true"                  # Trust X-Forwarded-For headers
```

#### MAESTRO_TRUST_PROXY

When running behind a reverse proxy (nginx, CloudFlare, load balancer), set `MAESTRO_TRUST_PROXY=true` to extract the real client IP from the `X-Forwarded-For` header for rate limiting.

**Security Warning:** Only enable this if your server is behind a trusted proxy that properly sets the `X-Forwarded-For` header. Enabling this on a publicly accessible server allows IP spoofing for rate limit bypass.

**Important:** Ensure your server is NOT directly accessible from the internet when using this setting. The proxy should be the only entry point, and it should overwrite (not append to) the `X-Forwarded-For` header for incoming requests.

#### MAESTRO_TRUST_PROXY_HOPS

For multi-proxy setups (e.g., CDN -> nginx -> app), set `MAESTRO_TRUST_PROXY_HOPS` to the number of trusted proxy hops. Default is `1`.

The `X-Forwarded-For` header format is: `client-ip, proxy1-ip, proxy2-ip, ...`

Each proxy appends its upstream IP to the header. The formula skips `HOPS` entries from the right to find the client:

- With 1 hop (nginx only): `"client, nginx"` -> skips 1, uses `client`
- With 2 hops (CDN + nginx): `"client, cdn, nginx"` -> skips 2, uses `client`

**Example nginx configuration:**

```nginx
server {
  listen 80;
  server_name composer.yourdomain.com;

  location / {
    proxy_pass http://localhost:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    
    # SSE specific
    proxy_buffering off;
    proxy_read_timeout 24h;
  }
}
```

Then set:
```bash
export MAESTRO_TRUST_PROXY=true
export MAESTRO_TRUST_PROXY_HOPS=1  # Only nginx in front
```

#### MAESTRO_SESSION_SCOPE / MAESTRO_MULTI_USER

Enable per-user session isolation (recommended for hosted deployments):

- Set `MAESTRO_SESSION_SCOPE=auth` (or `true`/`1`) to scope sessions by the authenticated subject.
- `MAESTRO_MULTI_USER` is an alias for the same behavior.

When enabled, sessions are stored under per-subject subdirectories, and share links embed the scope automatically. Requests without a valid auth subject will fall back to the unscoped session directory.

### API Endpoints

#### GET /api/models

List available models:

```json
{
  "models": [
    {
      "id": "claude-opus-4-6",
      "provider": "anthropic",
      "name": "Claude Opus 4.6",
      "capabilities": {
        "streaming": true,
        "tools": true,
        "vision": false
      }
    }
  ]
}
```

#### POST /api/chat

Send message and receive streaming response:

**Request:**
```json
{
  "model": "anthropic:claude-opus-4-6",
  "messages": [
    { "role": "user", "content": "Create a hello world function" }
  ],
  "thinkingLevel": "off"
}
```

**Response:** (Server-Sent Events)
```
data: {"type":"content_block_delta","text":"Here"}
data: {"type":"content_block_delta","text":"'s"}
data: {"type":"content_block_delta","text":" a"}
...
data: [DONE]
```

#### WS /api/chat/ws

WebSocket alternative to SSE. Send the same JSON payload as `/api/chat` after the upgrade. Messages are JSON-encoded `AgentEvent` frames; the server terminates the stream with `{ "type": "done" }`.

Note: WebSocket requests must include authentication headers when `MAESTRO_WEB_API_KEY`/JWT/shared secret auth is enabled. Browsers cannot set custom headers during the WebSocket handshake; use an authenticated reverse proxy or configure `MAESTRO_WEB_REQUIRE_KEY=0` for local-only development.

## Tool Execution

Tools run with **auto-approval** in web mode:

```javascript
// User asks: "Create a new file hello.ts"

// Server automatically executes:
{
  "type": "tool_execution_start",
  "toolName": "write",
  "arguments": {
    "path": "/path/to/hello.ts",
    "content": "console.log('Hello!');"
  }
}

// No user approval needed - executes immediately
{
  "type": "tool_execution_end",
  "result": "File created successfully"
}
```

Available tools:
- `bash` - Execute shell commands
- `read` - Read files
- `write` - Create/overwrite files
- `edit` - Find and replace in files
- ... (all Maestro tools)

## Security Considerations

### Hardened profile (recommended for hosted use)

Set `MAESTRO_PROFILE=prod` (or `MAESTRO_WEB_PROFILE=prod`) when running the web server to enable secure defaults:
- Requires `MAESTRO_WEB_API_KEY` for all `/api` routes (401 otherwise).
- Approval mode defaults to `fail`.
- CSRF enforced on mutating routes when `MAESTRO_WEB_CSRF_TOKEN` is set (auto-required in prod profile; override with `MAESTRO_WEB_REQUIRE_CSRF=0` for dev).
- Strict CSP and security headers emitted for static assets; customize with `MAESTRO_WEB_CSP` if you need extra origins.
- Background shell tasks (`background_tasks` with `shell:true`) are blocked; untagged human-facing egress tools are blocked unless explicitly disabled.

Example hardened run:
```bash
MAESTRO_PROFILE=prod \
MAESTRO_WEB_API_KEY=<strong-token> \
MAESTRO_WEB_CSRF_TOKEN=<csrf-secret> \
MAESTRO_WEB_ORIGIN=https://your.host \
maestro web
```

### Development convenience
- For local hacking, keep `MAESTRO_PROFILE` unset or `dev`, and you can opt out of strict egress/background-shell blocks with:
  - `MAESTRO_FAIL_UNTAGGED_EGRESS=0`
  - `MAESTRO_BACKGROUND_SHELL_DISABLE=0`
- Set `MAESTRO_WEB_REQUIRE_KEY=0` to skip API key checks locally.

### CORS
`MAESTRO_WEB_ORIGIN` sets `Access-Control-Allow-Origin` and related headers. Use your real host in production.

## Deployment

### Docker

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package.json bun.lockb ./
RUN npm install
COPY . .
RUN npm run build:all
EXPOSE 8080
CMD ["node", "dist/web-server.js"]
```

### Nginx Reverse Proxy

```nginx
server {
  listen 80;
  server_name composer.yourdomain.com;

  location / {
    proxy_pass http://localhost:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host $host;
    proxy_cache_bypass $http_upgrade;
    
    # SSE specific
    proxy_buffering off;
    proxy_read_timeout 24h;
  }
}
```

### Environment Variables in Production

```bash
# .env.production
NODE_ENV=production
PORT=8080
ANTHROPIC_API_KEY=sk-ant-...
MAESTRO_SESSION_DIR=/var/lib/maestro/sessions
```

## Development

### Project Structure

```
packages/web/
├── src/
│   ├── components/
│   │   ├── composer-chat.ts           # Main chat UI
│   │   ├── composer-message.ts        # Message display
│   │   ├── composer-input.ts          # Text input
│   │   ├── *.test.ts                  # Component tests
│   ├── services/
│   │   └── api-client.ts              # API client with SSE
│   ├── styles/
│   │   └── theme.css                  # Design system
│   └── index.ts                       # Entry point
├── index.html                          # Main HTML page
└── package.json

src/
└── web-server.ts                       # HTTP server + API
```

### Adding New Features

1. **New API Endpoint:**
```typescript
// src/web-server.ts
function handleNewFeature(req, res) {
  // Implementation
}

// Add to handleRequest()
else if (pathname === "/api/new-feature") {
  handleNewFeature(req, res);
}
```

2. **New Web Component:**
```typescript
// packages/web/src/components/my-component.ts
import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';

@customElement('my-component')
export class MyComponent extends LitElement {
  static styles = css`...`;
  render() { return html`...`; }
}
```

3. **Update API Client:**
```typescript
// packages/web/src/services/api-client.ts
async getNewData(): Promise<Data> {
  const response = await fetch(`${this.baseUrl}/api/new-feature`);
  return await response.json();
}
```

### Testing

```bash
# Run web component tests
cd packages/web
bun test

# Run specific test file
bun test src/components/composer-chat.test.ts
```

## Troubleshooting

### Server won't start

```bash
# Check if port is in use
lsof -i :8080

# Try different port
PORT=3001 bun run web
```

### API not connecting

1. Check CORS headers in browser console
2. Verify server is running: `curl http://localhost:8080/api/models`
3. Check API keys are set: `echo $ANTHROPIC_API_KEY`

### Streaming not working

1. Verify SSE headers: `Content-Type: text/event-stream`
2. Check proxy settings (nginx must not buffer)
3. Test with curl:
```bash
curl -N -X POST http://localhost:8080/api/chat \
  -H "Content-Type: application/json" \
  -d '{"model":"anthropic:claude-opus-4-6","messages":[{"role":"user","content":"hi"}]}'
```
4. Try WebSocket transport from the UI (`/transport ws`) and confirm `/api/chat/ws` upgrades successfully.

### Tools not executing

1. Check approval mode: `ActionApprovalService("auto")`
2. Verify tool is in `codingTools` array
3. Check server logs for tool execution events

## Parity Appendix (summary)

Full parity (Web + TUI): chat streaming, session create/list/load/delete, model select/list, thinking level, config get/set, cost/usage, status/health, approval mode, policy validation, file list, commands list, queue mode/status, zen/clean/footer/compact toggles, branching, attachments, artifacts, share links (read-only), export, run scripts, git diff/review.

TUI-only (by design): destructive undo/clear, deep diagnostics (LSP/MCP control), guardian scans and plan-mode prompts, OAuth login/logout, tools failures/clear, Ollama/local model control.

Security note: Web API stays stateless and limits filesystem/git access; keep using TUI for those workflows.

- [x] Authentication (JWT/shared-secret). OAuth still pending
- [x] Session persistence and resume
- [x] File upload for attachments
- [x] Multi-user support
- [x] Rate limiting (session/IP)
- [x] WebSocket alternative to SSE
- [x] Dark/Light theme toggle
- [x] Mobile responsive design
- [x] Export conversations (web UI)
- [x] Keyboard shortcuts
- [x] Voice input

## Contributing

See [CONTRIBUTING.md](../CONTRIBUTING.md) for development guidelines.

## License

BUSL-1.1 - see [LICENSE](../LICENSE) for details.
