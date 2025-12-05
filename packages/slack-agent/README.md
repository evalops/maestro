# @evalops/slack-agent

A Slack bot that runs an AI coding agent in a sandboxed environment. The agent can execute bash commands, read/write files, and interact with your development environment.

## Features

- **Slack Integration**: Responds to @mentions in channels and DMs via Socket Mode
- **Docker Sandbox**: Isolate command execution in a container (recommended)
- **Persistent Workspace**: All conversation history, files, and tools stored in one directory
- **Working Memory**: MEMORY.md files for persistent context across sessions
- **Custom Tools ("Skills")**: Create reusable CLI tools for recurring tasks

## Installation

```bash
bun add @evalops/slack-agent
```

### Slack App Setup

1. Create a new Slack app at https://api.slack.com/apps
2. Enable **Socket Mode** (Settings → Socket Mode → Enable)
3. Generate an **App-Level Token** with `connections:write` scope. This is `SLACK_APP_TOKEN`
4. Add **Bot Token Scopes** (OAuth & Permissions):
   - `app_mentions:read`
   - `channels:history`
   - `channels:read`
   - `chat:write`
   - `files:read`
   - `files:write`
   - `groups:history`
   - `groups:read`
   - `im:history`
   - `im:read`
   - `im:write`
   - `users:read`
5. **Subscribe to Bot Events** (Event Subscriptions):
   - `app_mention`
   - `message.channels`
   - `message.groups`
   - `message.im`
6. Install the app to your workspace. Get the **Bot User OAuth Token**. This is `SLACK_BOT_TOKEN`
7. Add the bot to any channels where you want it to operate

## Quick Start

```bash
# Set environment variables
export SLACK_APP_TOKEN=xapp-...
export SLACK_BOT_TOKEN=xoxb-...
export ANTHROPIC_API_KEY=sk-ant-...  # or ANTHROPIC_OAUTH_TOKEN

# Create Docker sandbox (recommended)
docker run -d \
  --name slack-agent-sandbox \
  -v $(pwd)/data:/workspace \
  alpine:latest \
  tail -f /dev/null

# Run the agent in Docker mode
slack-agent --sandbox=docker:slack-agent-sandbox ./data
```

## CLI Options

```bash
slack-agent [options] <working-directory>

Options:
  --sandbox=host              Run tools on host (not recommended)
  --sandbox=docker:<name>     Run tools in Docker container (recommended)
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `SLACK_APP_TOKEN` | Slack app-level token (xapp-...) |
| `SLACK_BOT_TOKEN` | Slack bot token (xoxb-...) |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `ANTHROPIC_OAUTH_TOKEN` | Alternative: Anthropic OAuth token |

## Workspace Layout

```
./data/                         # Your host directory
  ├── MEMORY.md                 # Global memory (shared across channels)
  ├── skills/                   # Global custom CLI tools
  ├── C123ABC/                  # Each Slack channel gets a directory
  │   ├── MEMORY.md             # Channel-specific memory
  │   ├── log.jsonl             # Full conversation history
  │   ├── attachments/          # Files users shared
  │   ├── scratch/              # Working directory
  │   └── skills/               # Channel-specific CLI tools
  └── C456DEF/                  # Another channel
      └── ...
```

## Tools

The agent has access to these tools:

- **bash**: Execute shell commands
- **read**: Read file contents (text and images)
- **write**: Create/overwrite files
- **edit**: Make surgical edits to existing files
- **attach**: Share files back to Slack

## Programmatic Usage

```typescript
import { SlackBot, createExecutor, createSlackAgentTools } from '@evalops/slack-agent';

const executor = createExecutor({ type: 'docker', container: 'my-sandbox' });
const tools = createSlackAgentTools(executor);

const bot = new SlackBot(
  {
    async onChannelMention(ctx) {
      // Handle @mentions
      await ctx.respond('Hello!');
    },
    async onDirectMessage(ctx) {
      // Handle DMs
      await ctx.respond('Got your message!');
    },
  },
  {
    appToken: process.env.SLACK_APP_TOKEN!,
    botToken: process.env.SLACK_BOT_TOKEN!,
    workingDir: './data',
  }
);

await bot.start();
```

## Security Considerations

**Docker mode is strongly recommended.** In Docker mode:
- Commands execute inside an isolated container
- The agent can only access the mounted data directory from your host
- Your host system is protected from destructive commands

In host mode, the agent has full access to your machine with your user permissions.

## Development

```bash
# Build
bun run build

# Type check
bun run check

# Dev mode with watch
bun run dev
```

## License

MIT
