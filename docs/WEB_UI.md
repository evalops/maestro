# Composer Web UI

A browser-based interface for Composer AI coding assistant with full feature parity to the TUI.

## Features

- **Real-time Streaming**: Live response streaming from LLM providers via Server-Sent Events
- **Full Tool Execution**: All Composer tools work (bash, read, write, edit, etc.)
- **Modern Design**: GitHub-inspired dark theme with smooth animations
- **Model Selection**: Switch between different AI models
- **Syntax Highlighting**: Code blocks with highlight.js
- **Markdown Rendering**: Rich text formatting with marked
- **Auto-approval**: Tools execute automatically in web mode for seamless experience

## Architecture

```
┌─────────────┐         HTTP/SSE          ┌──────────────┐
│  Web UI     │ ────────────────────────> │  Web Server  │
│  (Browser)  │ <──────────────────────── │  (Node.js)   │
└─────────────┘                           └──────────────┘
                                                  │
                                                  ├─> Agent Core
                                                  ├─> ProviderTransport
                                                  ├─> Tool Execution
                                                  └─> LLM Providers
```

### Components

1. **Web UI** (`packages/web/`) - Lit web components
   - `<composer-chat>` - Main chat interface
   - `<composer-message>` - Message display with markdown
   - `<composer-input>` - Multi-line input with shortcuts
   - `<model-selector>` - Model selection dialog

2. **Web Server** (`src/web-server.ts`) - HTTP API server
   - `/api/models` - List available models
   - `/api/chat` - Streaming chat endpoint (POST)
   - `/api/sessions` - Session management
   - `/` - Serves static web UI files

3. **Composer Core** - Shared with TUI
   - Agent, ProviderTransport, SessionManager
   - Tool execution (codingTools)
   - LLM provider integration
   - System prompt loading

## Quick Start

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
# Build everything
npx nx run composer:build:all --skip-nx-cache

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
export COMPOSER_SESSION_DIR="~/.composer/sessions"  # Session storage
export COMPOSER_AGENT_DIR="~/.composer/agent"       # Context files

# Proxy Configuration (when behind nginx, CloudFlare, etc.)
export COMPOSER_TRUST_PROXY="true"                  # Trust X-Forwarded-For headers
```

#### COMPOSER_TRUST_PROXY

When running behind a reverse proxy (nginx, CloudFlare, load balancer), set `COMPOSER_TRUST_PROXY=true` to extract the real client IP from the `X-Forwarded-For` header for rate limiting.

**Security Warning:** Only enable this if your server is behind a trusted proxy that properly sets the `X-Forwarded-For` header. Enabling this on a publicly accessible server allows IP spoofing for rate limit bypass.

**Important:** Ensure your server is NOT directly accessible from the internet when using this setting. The proxy should be the only entry point, and it should overwrite (not append to) the `X-Forwarded-For` header for incoming requests.

#### COMPOSER_TRUST_PROXY_HOPS

For multi-proxy setups (e.g., CDN -> nginx -> app), set `COMPOSER_TRUST_PROXY_HOPS` to the number of trusted proxy hops. Default is `1`.

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
export COMPOSER_TRUST_PROXY=true
export COMPOSER_TRUST_PROXY_HOPS=1  # Only nginx in front
```

### API Endpoints

#### GET /api/models

List available models:

```json
{
  "models": [
    {
      "id": "claude-sonnet-4-5",
      "provider": "anthropic",
      "name": "Claude Sonnet 4.5",
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
  "model": "anthropic:claude-sonnet-4-5",
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
- ... (all Composer tools)

## Security Considerations

### Auto-Approval Mode

The web server runs with `ActionApprovalService("auto")`, meaning:
- ⚠️ **All tool calls execute automatically**
- ⚠️ **No user confirmation prompts**
- ⚠️ **Full file system access**

**Recommended Setup:**
1. Run in Docker/container
2. Use read-only mounts where possible
3. Limit network access
4. Set up authentication (not included yet)
5. Run as non-root user

### Authentication

Currently **NO AUTHENTICATION** is implemented. To add:

```typescript
// Example: Add JWT middleware
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!verifyJWT(token)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }
  next();
}
```

### CORS

Currently allows all origins (`Access-Control-Allow-Origin: *`). Restrict in production:

```typescript
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://your-domain.com",
  // ...
};
```

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
COMPOSER_SESSION_DIR=/var/lib/composer/sessions
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
  -d '{"model":"anthropic:claude-sonnet-4-5","messages":[{"role":"user","content":"hi"}]}'
```

### Tools not executing

1. Check approval mode: `ActionApprovalService("auto")`
2. Verify tool is in `codingTools` array
3. Check server logs for tool execution events

## Future Enhancements

- [ ] Authentication (JWT/OAuth)
- [ ] Session persistence and resume
- [ ] File upload for attachments
- [ ] Multi-user support
- [ ] Rate limiting
- [ ] WebSocket alternative to SSE
- [ ] Dark/Light theme toggle
- [ ] Mobile responsive design
- [ ] Export conversations
- [ ] Keyboard shortcuts
- [ ] Voice input

## Contributing

See [CONTRIBUTING.md](../CONTRIBUTING.md) for development guidelines.

## License

MIT - see [LICENSE](../LICENSE) for details.
