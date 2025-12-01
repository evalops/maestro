# Web UI Feature Parity Audit

This document compares features between the TUI (Terminal UI) and Web UI to identify gaps and guide future development.

## Summary

- **TUI Commands**: 65 slash commands
- **Web Endpoints**: 20 API routes
- **Feature Parity**: Core chat, sessions, models, config, usage, approvals
- **TUI-Only Features**: 38 features (intentionally terminal-specific)

## Feature Comparison

### Full Parity (Both TUI and Web)

| Feature | TUI | Web |
|---------|-----|-----|
| Chat streaming | `/` input | `POST /api/chat` |
| Session create | `/new` | `POST /api/sessions` |
| Session list | `/sessions` | `GET /api/sessions` |
| Session load | `/sessions load <id>` | `GET /api/sessions/:id` |
| Session delete | Menu | `DELETE /api/sessions/:id` |
| Model select | `/model` | `POST /api/model` |
| Model list | Selector UI | `GET /api/models` |
| Thinking level | `/thinking` | Request header |
| Config get/set | `/config` | `GET/POST /api/config` |
| Cost summary | `/cost` | `GET /api/usage` |
| Health status | `/status` | `GET /api/status` |
| Approval mode | `/approvals` | Header `x-composer-approval-mode` |
| Policy validate | `/policy/validate` | `POST /api/policy/validate` |
| File list | `@` mention | `GET /api/files` |
| Commands list | `/commands` | `GET /api/commands` |

### TUI-Only Features

These features are intentionally terminal-specific:

#### Session Management
- `/branch` - Fork session from earlier message
- `/sessions favorite/unfavorite` - Mark favorites
- `/compact` - Summarize old messages to reclaim context

#### Git Operations
- `/diff <path>` - Show file diff
- `/review` - Summarize git status
- `/undo <path>` - Discard changes via git checkout

#### Workspace Tools
- `/run <script>` - Execute npm scripts
- `/init` - Create AGENTS.md scaffolding
- `/ollama` - Local model management

#### Diagnostics
- `/diag` - Provider/model/API diagnostics
- `/lsp` - Language Server Protocol management
- `/mcp` - MCP server listing
- `/telemetry` - Telemetry toggles
- `/otel` - OpenTelemetry config
- `/quota` - Detailed token limits

#### Tools
- `/tools list` - Available tools
- `/tools failures` - Error details
- `/tools clear` - Clear logs

#### Safety
- `/guardian` - Run Semgrep + secrets scan
- `/plan-mode` - Ask before write/edit/bash

#### UI/Display
- `/theme` - Color theme selection
- `/zen` - Minimal UI mode
- `/clean` - Text deduplication
- `/footer` - Footer style
- `/compact-tools` - Fold tool outputs

#### Queue Management
- `/queue mode one|all`
- `/queue list`
- `/queue cancel <id>`

#### Export/Share
- `/export [path] html|text`
- `/share` - Generate shareable HTML

#### Authentication
- `/login` - OAuth for Claude Pro/Max
- `/logout` - Remove credentials

#### System
- `/help` - Command listing
- `/about` - Build/env info
- `/update` - Check for updates
- `/changelog` - Version history
- `/report` - Bug report collection

## Recommended Web API Additions

For better programmatic access, consider adding:

```
GET  /api/diagnostics    - Model/provider diagnostics
GET  /api/tools          - Available tools and status
POST /api/sessions/:id/branch - Branch from message
POST /api/export         - Export session to HTML/text
GET  /api/quota          - Detailed quota information
POST /api/git/diff       - Get file diff
POST /api/git/status     - Get git status
```

## Architecture Notes

1. **Web is Intentionally Focused**: The Web API provides core functionality for remote/programmatic access without terminal-specific features.

2. **Stateless HTTP**: Many TUI features (themes, zen mode, footer) don't apply to stateless HTTP APIs.

3. **Security Boundary**: Git operations and file system access are restricted in Web for security.

4. **Authentication**: OAuth flows require browser redirects, making them TUI-specific.

## Conclusion

The Web UI provides full parity for core workflows:
- Chat and messaging
- Session management
- Model selection
- Configuration
- Usage tracking

TUI-only features are either:
- Terminal-specific (UI, themes)
- Security-sensitive (git, file ops)
- Interactive (OAuth, queues)
- Diagnostic (LSP, MCP, telemetry)
