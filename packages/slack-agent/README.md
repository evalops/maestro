# @evalops/slack-agent

A Slack bot that runs an AI coding agent in a sandboxed environment. The agent can execute bash commands, read/write files, and interact with your development environment.

## Features

- **Slack Integration**: Responds to @mentions in channels and DMs via Socket Mode
- **Thread Support**: Channel mentions reply in threads to reduce noise; thread replies stay in context
- **Progress Indicators**: Status updates during long-running tasks
- **Docker Sandbox**: Isolate command execution in a container (recommended)
- **Auto-Create Containers**: Automatically create and manage Docker containers
- **Persistent Workspace**: All conversation history, files, and tools stored in one directory
- **Working Memory**: MEMORY.md files for persistent context across sessions
- **Resource Limits**: CPU and memory limits for container isolation
- **Graceful Shutdown**: Proper cleanup of containers on exit

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

### Option 1: Auto-Create Container (Recommended)

The simplest way to get started - the agent automatically creates and manages a Docker container:

```bash
# Set environment variables
export SLACK_APP_TOKEN=xapp-...
export SLACK_BOT_TOKEN=xoxb-...
export ANTHROPIC_API_KEY=sk-ant-...

# Run with auto-created container
slack-agent --sandbox=docker:auto ./data
```

The container is created on first command and automatically cleaned up on exit.

### Option 2: Docker Compose

For more control over the container configuration:

```bash
# Build and start the sandbox container
cd packages/slack-agent
docker compose up -d

# Run the agent
slack-agent --sandbox=docker:slack-agent-sandbox ./data
```

### Option 3: Custom Container

```bash
# Create your own container
docker run -d \
  --name slack-agent-sandbox \
  --cpus=2 \
  --memory=2g \
  -v $(pwd)/data:/workspace \
  node:20-slim \
  tail -f /dev/null

# Run the agent
slack-agent --sandbox=docker:slack-agent-sandbox ./data
```

## CLI Options

```bash
slack-agent [options] <working-directory>

Options:
  --sandbox=host                  Run tools on host (not recommended)
  --sandbox=docker:<name>         Run tools in existing Docker container
  --sandbox=docker:auto           Auto-create container (recommended)
  --sandbox=docker:auto:<image>   Auto-create with specific image

Examples:
  slack-agent --sandbox=docker:auto ./data
  slack-agent --sandbox=docker:slack-agent-sandbox ./data
  slack-agent --sandbox=docker:auto:python:3.12-slim ./data
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `SLACK_APP_TOKEN` | Slack app-level token (xapp-...) |
| `SLACK_BOT_TOKEN` | Slack bot token (xoxb-...) |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `ANTHROPIC_OAUTH_TOKEN` | Alternative: Anthropic OAuth token |
| `SLACK_RATE_LIMIT_USER` | Max requests per user per minute (default: 10) |
| `SLACK_RATE_LIMIT_CHANNEL` | Max requests per channel per minute (default: 30) |
| `SLACK_RATE_LIMIT_WINDOW_MS` | Rate limit window in ms (default: 60000) |

## Emoji Reactions

Users can interact with the bot using emoji reactions:

| Emoji | Action |
|-------|--------|
| 🛑 `:octagonal_sign:` | Stop the current task |
| 👀 `:eyes:` | Check if the bot is working |
| 💰 `:moneybag:` | View usage/cost summary |
| 📈 `:chart_with_upwards_trend:` | View usage/cost summary |
| 🔄 `:arrows_counterclockwise:` | Retry the last request |
| ☕ `:coffee:` / 🧠 `:brain:` | Toggle extended thinking mode |
| 🧹 `:broom:` / 🗑️ `:wastebasket:` | Clear conversation history |

**Extended Thinking Mode:** When enabled with ☕, the agent will use Claude's extended thinking for more careful reasoning on complex tasks. Status shows in 👀 responses.

**Required Slack Permissions:**
- `reactions:read` - To receive reaction events
- `reactions:write` - To acknowledge reactions with ✅

**Required Bot Event Subscriptions:**
- `reaction_added` - To handle emoji reactions

## Docker Configuration

### Dockerfile

The included `Dockerfile` creates a container with common development tools:

- Node.js 20
- Git, curl, wget, jq
- ripgrep, fd-find, tree
- Python 3 with pip
- Build essentials (gcc, make)

Build the custom image:

```bash
docker build -t slack-agent-sandbox .
slack-agent --sandbox=docker:auto:slack-agent-sandbox ./data
```

### docker-compose.yml

The compose file includes:

- **Resource limits**: 2 CPUs, 2GB memory
- **Security options**: no-new-privileges
- **Read-only root filesystem** with tmpfs for /tmp
- **Health checks**

Customize by editing `docker-compose.yml`.

### Auto-Create Mode

When using `--sandbox=docker:auto`, the agent:

1. Creates a container on first command (lazy initialization)
2. Mounts the current directory to `/workspace`
3. Applies resource limits (2 CPUs, 2GB memory)
4. Uses `--rm` flag for automatic cleanup
5. Registers signal handlers for graceful shutdown
6. Stops and removes the container on exit

## Workspace Layout

```
./data/                         # Your host directory (mounted as /workspace)
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
- **status**: Check system health and resource usage

### Status Tool

The status tool provides visibility into the execution environment:

```
Environment: docker

Container:
  Name: slack-agent-abc12345
  ID: 7f01f7ce97c6
  Image: node:20-slim
  Status: running
  Uptime: 2h 15m

Resources:
  CPU: 12.5%
  Memory: 256MiB / 2GiB (12.8%)
  Processes: 8

Workspace:
  Path: /workspace
  Disk Usage: 45.2MB
  Files: 127
```

The agent uses this tool to:
- Report status when asked "how are you doing?"
- Check resources before memory-intensive tasks
- Debug performance issues

## Programmatic Usage

```typescript
import { SlackBot, createExecutor, createSlackAgentTools } from '@evalops/slack-agent';

// Option 1: Use existing container
const executor = createExecutor({ type: 'docker', container: 'my-sandbox' });

// Option 2: Auto-create container
const autoExecutor = createExecutor({
  type: 'docker',
  autoCreate: true,
  image: 'node:20-slim',  // optional
  cpus: '2',              // optional
  memory: '2g',           // optional
});

const tools = createSlackAgentTools(executor);

const bot = new SlackBot(
  {
    async onChannelMention(ctx) {
      await ctx.respond('Hello!');
    },
    async onDirectMessage(ctx) {
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

// Clean up on shutdown
process.on('SIGTERM', async () => {
  await executor.dispose();
  process.exit(0);
});
```

## Security Considerations

**Docker mode is strongly recommended.** In Docker mode:

- Commands execute inside an isolated container
- Resource limits prevent runaway processes (CPU, memory)
- `--security-opt no-new-privileges` prevents privilege escalation
- Read-only root filesystem (with docker-compose) limits modifications
- The agent can only access the mounted data directory

In host mode, the agent has full access to your machine with your user permissions.

### Production Recommendations

1. Use the provided `Dockerfile` or build a custom image with only required tools
2. Use `docker-compose.yml` for additional security controls
3. Consider network isolation (`network_mode: none`) if internet access not needed
4. Monitor container resource usage
5. Regularly rotate and clean up workspace data

## Development

```bash
# Build
bun run build

# Type check
bun run check

# Dev mode with watch
bun run dev

# Run tests
cd ../.. && bunx vitest run test/slack-agent/
```

## License

MIT
