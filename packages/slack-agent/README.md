# @evalops/slack-agent

A Slack bot that runs an AI coding agent in a sandboxed environment. The agent can execute bash commands, read/write files, and interact with your development environment through natural language conversations.

## Table of Contents

- [Features](#features)
- [Quick Start](#quick-start)
- [Installation](#installation)
- [Slack App Setup](#slack-app-setup)
- [Configuration](#configuration)
- [Sandbox Modes](#sandbox-modes)
- [Workspace Layout](#workspace-layout)
- [Interacting with the Bot](#interacting-with-the-bot)
- [Scheduled Tasks](#scheduled-tasks)
- [Approval Workflows](#approval-workflows)
- [Cost Tracking](#cost-tracking)
- [Tools Reference](#tools-reference)
- [Programmatic Usage](#programmatic-usage)
- [Architecture](#architecture)
- [Security](#security)
- [Enterprise Features](#enterprise-features)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

---

## Features

### Core Capabilities

| Feature | Description |
|---------|-------------|
| **AI Coding Agent** | Claude-powered agent that can write code, run commands, and manage files |
| **Docker Sandbox** | Isolated execution environment with resource limits |
| **Thread Support** | Channel mentions reply in threads; thread replies stay in context |
| **File Handling** | Automatically reads uploaded code files and includes content in context |
| **Working Memory** | MEMORY.md files persist context across conversations |
| **Skills System** | Create reusable CLI tools for recurring tasks |

### Workflow Features

| Feature | Description |
|---------|-------------|
| **Scheduled Tasks** | Schedule one-time or recurring tasks with natural language |
| **Approval Workflows** | Requires confirmation for destructive operations |
| **Cost Tracking** | Per-channel usage and cost tracking with daily/all-time summaries |
| **Rate Limiting** | Configurable per-user and per-channel rate limits |
| **Extended Thinking** | Toggle Claude's extended thinking mode for complex tasks |

### Slack Integration

| Feature | Description |
|---------|-------------|
| **Socket Mode** | Real-time bidirectional communication (no webhooks needed) |
| **Emoji Reactions** | Control the bot with reactions (stop, retry, clear, etc.) |
| **Progress Indicators** | Live status updates during long-running tasks |
| **File Uploads** | Share files back to Slack from the agent |
| **Message Backfill** | Automatically syncs channel history on startup |

### Enterprise Features

| Feature | Description |
|---------|-------------|
| **Multi-Workspace OAuth** | OAuth 2.0 installation flow for multi-tenant deployments |
| **Role-Based Access Control** | Four roles: admin, power_user, user, viewer |
| **Audit Logging** | Tamper-evident logs with hash chaining and PII redaction |
| **Thread Memory** | Per-thread context management with token limits |
| **Idempotency** | Atomic event deduplication for reliability |
| **Pluggable Storage** | File, in-memory, or custom (Redis) storage backends |

---

## Quick Start

### Option 1: Auto-Create Container (Recommended)

```bash
# Set environment variables
export SLACK_APP_TOKEN=xapp-...
export SLACK_BOT_TOKEN=xoxb-...
export ANTHROPIC_API_KEY=sk-ant-...

# Run with auto-created container
slack-agent --sandbox=docker:auto ./data
```

### Option 2: Docker Compose

```bash
cd packages/slack-agent
docker compose up -d
slack-agent --sandbox=docker:slack-agent-sandbox ./data
```

### Option 3: Custom Container

```bash
docker run -d \
  --name slack-agent-sandbox \
  --cpus=2 --memory=2g \
  -v $(pwd)/data:/workspace \
  node:20-slim tail -f /dev/null

slack-agent --sandbox=docker:slack-agent-sandbox ./data
```

---

## Installation

```bash
# Global CLI install (recommended for `slack-agent` command)
bun install -g @evalops/slack-agent

# Or project-local install (library + CLI)
bun add @evalops/slack-agent

# Using npm
npm install @evalops/slack-agent

# Or run without installing (one-off)
bunx @evalops/slack-agent --help
# or
npx -y @evalops/slack-agent --help
```

### Requirements

- Node.js 20+
- Docker (for sandbox mode)
- Slack workspace with admin access

---

## Slack App Setup

### Step 1: Create the App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click "Create New App"
2. Choose "From scratch" and give it a name (e.g., "Coding Agent")
3. Select your workspace

### Step 2: Enable Socket Mode

1. Navigate to **Settings → Socket Mode**
2. Toggle "Enable Socket Mode" to ON
3. Click "Generate" to create an **App-Level Token** with `connections:write` scope
4. Save this token as `SLACK_APP_TOKEN` (starts with `xapp-`)

### Step 3: Configure Bot Permissions

Go to **OAuth & Permissions → Scopes → Bot Token Scopes** and add:

| Scope | Purpose |
|-------|---------|
| `app_mentions:read` | Receive @mentions |
| `channels:history` | Read channel messages |
| `channels:read` | List channels |
| `chat:write` | Send messages |
| `files:read` | Download shared files |
| `files:write` | Upload files to Slack |
| `groups:history` | Read private channel messages |
| `groups:read` | List private channels |
| `im:history` | Read DM history |
| `im:read` | List DMs |
| `im:write` | Send DMs |
| `users:read` | Look up user info |
| `reactions:read` | Receive reaction events |
| `reactions:write` | Add reactions |

### Step 4: Subscribe to Events

Go to **Event Subscriptions → Subscribe to bot events** and add:

| Event | Purpose |
|-------|---------|
| `app_mention` | Respond to @mentions in channels |
| `message.channels` | Receive channel messages |
| `message.groups` | Receive private channel messages |
| `message.im` | Receive direct messages |
| `reaction_added` | Handle emoji reactions |

### Step 5: Install and Get Token

1. Go to **OAuth & Permissions** and click "Install to Workspace"
2. Authorize the app
3. Copy the **Bot User OAuth Token** (starts with `xoxb-`)
4. Save this as `SLACK_BOT_TOKEN`

### Step 6: Add Bot to Channels

Invite the bot to channels where you want it to operate:
```
/invite @your-bot-name
```

---

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SLACK_APP_TOKEN` | Yes | - | App-level token (xapp-...) |
| `SLACK_BOT_TOKEN` | Yes | - | Bot token (xoxb-...) |
| `ANTHROPIC_API_KEY` | Yes* | - | Anthropic API key |
| `ANTHROPIC_OAUTH_TOKEN` | Yes* | - | Alternative: Anthropic OAuth token |
| `SLACK_AGENT_DEFAULT_TIMEZONE` | No | UTC | Default timezone for scheduled tasks (IANA name) |
| `SLACK_AGENT_DEFAULT_ROLE` | No | user | Default role for new users (admin, power_user, user, viewer) |
| `SLACK_AGENT_HISTORY_LIMIT` | No | 15 | Max messages per conversations.history request |
| `SLACK_AGENT_HISTORY_PAGES` | No | 3 | Max pages to backfill per channel |
| `SLACK_AGENT_BACKFILL_ON_STARTUP` | No | true | Toggle history backfill on startup |
| `SLACK_AGENT_BACKFILL_CHANNELS` | No | - | Comma-separated channel IDs or names to include in backfill |
| `SLACK_AGENT_BACKFILL_EXCLUDE_CHANNELS` | No | - | Comma-separated channel IDs or names to exclude from backfill |
| `SLACK_AGENT_BACKFILL_CONCURRENCY` | No | 1 | Number of concurrent channel backfills |
| `SLACK_RATE_LIMIT_USER` | No | 10 | Max requests per user per minute |
| `SLACK_RATE_LIMIT_CHANNEL` | No | 30 | Max requests per channel per minute |
| `SLACK_RATE_LIMIT_WINDOW_MS` | No | 60000 | Rate limit window in milliseconds |

*Either `ANTHROPIC_API_KEY` or `ANTHROPIC_OAUTH_TOKEN` is required.

Channel selectors accept IDs or names with or without a leading `#`.

### CLI Options

```bash
slack-agent [options] <working-directory>

Options:
  --sandbox=host                  Run tools directly on host (not recommended)
  --sandbox=docker:<container>    Run tools in existing Docker container
  --sandbox=docker:auto           Auto-create container with node:20-slim
  --sandbox=docker:auto:<image>   Auto-create with specific image
  -h, --help                      Show help

Examples:
  slack-agent --sandbox=docker:auto ./data
  slack-agent --sandbox=docker:slack-agent-sandbox ./data
  slack-agent --sandbox=docker:auto:python:3.12-slim ./data
```

---

## Sandbox Modes

### Host Mode (Not Recommended)

```bash
slack-agent --sandbox=host ./data
```

Commands execute directly on your machine with your user permissions. Only use this in trusted, isolated environments.

### Docker Mode (Recommended)

#### Auto-Create Mode

```bash
slack-agent --sandbox=docker:auto ./data
slack-agent --sandbox=docker:auto:python:3.12-slim ./data
```

The agent automatically:
1. Creates a container on first command (lazy initialization)
2. Mounts the working directory to `/workspace`
3. Applies resource limits (2 CPUs, 2GB memory)
4. Registers signal handlers for cleanup
5. Stops and removes the container on exit

#### Named Container Mode

```bash
slack-agent --sandbox=docker:my-sandbox ./data
```

Use a pre-existing container. Useful for custom configurations or persistent containers.

### Docker Compose Configuration

The included `docker-compose.yml` provides a reasonable starting sandbox configuration:

```yaml
services:
  sandbox:
    build: .
    container_name: slack-agent-sandbox
    volumes:
      - ./data:/workspace
    working_dir: /workspace
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 2G
    security_opt:
      - no-new-privileges:true
    read_only: true
    tmpfs:
      - /tmp:size=100M
    healthcheck:
      test: ["CMD", "node", "--version"]
      interval: 30s
      timeout: 10s
      retries: 3
```

### Custom Dockerfile

The included Dockerfile creates a development-ready image:

```dockerfile
FROM node:20-slim

# Common development tools
RUN apt-get update && apt-get install -y \
    git curl wget jq \
    ripgrep fd-find tree \
    python3 python3-pip \
    build-essential
```

Build and use:

```bash
docker build -t slack-agent-sandbox .
slack-agent --sandbox=docker:auto:slack-agent-sandbox ./data
```

---

## Workspace Layout

```
./data/                           # Working directory (mounted as /workspace in Docker)
├── MEMORY.md                     # Global memory (shared across all channels)
├── skills/                       # Global custom CLI tools
│   └── my-tool/
│       ├── SKILL.md              # Tool documentation
│       └── index.js              # Tool implementation
├── scheduled_tasks.json          # Persisted scheduled tasks
├── C123ABC/                      # Channel directory (by Slack channel ID)
│   ├── MEMORY.md                 # Channel-specific memory
│   ├── log.jsonl                 # Full conversation history
│   ├── usage.jsonl               # Token usage records
│   ├── last_prompt.txt           # Debug: last full prompt sent to Claude
│   ├── attachments/              # Files shared by users
│   │   └── 1234567890_file.py
│   ├── scratch/                  # Agent's working directory
│   └── skills/                   # Channel-specific tools
└── D456DEF/                      # Another channel (DM)
    └── ...
```

### Memory System

The agent uses MEMORY.md files to persist context:

**Global Memory** (`./data/MEMORY.md`):
- Skills and tools you've created
- User preferences and coding standards
- Project-wide information

**Channel Memory** (`./data/<channel>/MEMORY.md`):
- Channel-specific decisions
- Ongoing work and context
- Team preferences

Example MEMORY.md:
```markdown
## Skills
- `email-sender`: Send emails via SMTP (see skills/email-sender/)
- `jira-cli`: Create and update JIRA tickets

## Preferences
- Use TypeScript for new projects
- Follow Airbnb style guide
- Always run tests before committing

## Current Project
Working on API migration from v1 to v2
- Phase 1: Complete ✓
- Phase 2: In progress (endpoint /users)
```

### Skills System

Create reusable CLI tools that the agent can use:

```
./data/skills/email-sender/
├── SKILL.md          # Required: Usage documentation
├── index.js          # Entry point
├── package.json      # Dependencies
└── templates/
    └── welcome.html
```

**SKILL.md** (required):
```
# Email Sender

Send emails via SMTP.

## Usage

    ./skills/email-sender/index.js send \
      --to "user@example.com" \
      --subject "Hello" \
      --body "Message content"

## Environment

Requires SMTP_HOST, SMTP_USER, SMTP_PASS environment variables.
```

The agent will read SKILL.md before using any skill to understand its capabilities.

---

## Interacting with the Bot

### Basic Interaction

**Channel mention:**
```
@bot write a Python script that processes CSV files
```

**Direct message:**
```
Help me debug this error: TypeError: undefined is not a function
```

**Thread replies:**
```
@bot (in thread) Can you add error handling to that script?
```

### Emoji Reactions

Control the bot with reactions on any message:

| Emoji | Name | Action |
|-------|------|--------|
| 🛑 | `:octagonal_sign:` | Stop current task |
| 👀 | `:eyes:` | Check if bot is working |
| 💰 | `:moneybag:` | View usage/cost summary |
| 📈 | `:chart_with_upwards_trend:` | View usage/cost summary |
| 🔄 | `:arrows_counterclockwise:` | Retry last request |
| ☕ | `:coffee:` | Toggle extended thinking |
| 🧠 | `:brain:` | Toggle extended thinking |
| 🧹 | `:broom:` | Clear conversation history |
| 🗑️ | `:wastebasket:` | Clear conversation history |
| 📅 | `:calendar:` | List scheduled tasks |
| ⏰ | `:alarm_clock:` | List scheduled tasks |
| ✅ | `:white_check_mark:` | Approve pending operation |
| 👍 | `:thumbsup:` | Approve pending operation |
| ❌ | `:x:` | Reject pending operation |
| 👎 | `:thumbsdown:` | Reject pending operation |

### Slash Commands

Register these Slack slash commands to control the bot without reactions:

| Command | Action |
|---------|--------|
| `/tasks` | List, pause, resume, cancel, or run scheduled tasks |
| `/status` | Show current status and rate limit usage |
| `/cost` | View usage/cost summary |
| `/memory` | Show saved memory for the channel |
| `/backfill` | Backfill message history for this channel (use `/backfill all` for all channels) |
| `/clear` | Clear conversation history for the channel |

### Extended Thinking Mode

When enabled with ☕ or 🧠, the agent uses Claude's extended thinking for more careful reasoning:

```
User: (reacts with ☕)
Bot: Extended thinking enabled ☕ I'll think more carefully on complex tasks.

User: @bot Design a microservices architecture for an e-commerce platform
Bot: (uses extended reasoning before responding)
```

Check current status with 👀 - it will show "(thinking mode on)" if enabled.

### File Handling

**Upload files to include in context:**
1. Drag and drop a file into Slack
2. The bot automatically downloads and reads code/text files
3. File contents are included in the agent's context

Supported file types for automatic reading:
- Code: `.js`, `.ts`, `.py`, `.go`, `.rs`, `.java`, `.c`, `.cpp`, etc.
- Config: `.json`, `.yaml`, `.yml`, `.toml`, `.xml`, `.env`
- Text: `.md`, `.txt`, `.csv`

**Receive files from the agent:**
The agent can use the `attach` tool to share files back to Slack.

---

## Scheduled Tasks

Schedule tasks with natural language time expressions. Times are interpreted in the scheduler’s default timezone (`SLACK_AGENT_DEFAULT_TIMEZONE`, default `UTC`). If an invalid timezone is configured, the scheduler falls back to `UTC` and will show a warning when scheduling.

### One-Time Tasks

```
@bot remind me in 2 hours to check the deployment
@bot at 3pm run the test suite
@bot tomorrow at 9am generate the weekly report
@bot next friday at 3pm review open PRs
@bot this monday at 10am kick off the sprint
```

Supported expressions:
- `in X minutes/hours/days/weeks`
- `at HH:MM` or `at Ham/pm`
- `tomorrow` or `tomorrow at HH:MM`
- `next monday/tuesday/...` or `next monday at HH:MM`
- `this monday/tuesday/...` or `this monday at HH:MM`

### Recurring Tasks

```
@bot every day at 9am summarize yesterday's commits
@bot every monday at 10am generate the sprint report
@bot every hour check the error logs
@bot every weekday at 6pm run the backup script
@bot every 2 weeks on monday at 9am generate the sprint report
@bot first monday of month at 9am send the monthly summary
@bot last friday of month at 5pm remind us to close the books
@bot cron 0 9 * * 1 run the weekly report
```

Supported expressions:
- `every X minutes/hours`
- `every day at HH:MM`
- `every weekday at HH:MM`
- `every monday/tuesday/.../sunday at HH:MM`
- `every N weeks on <weekday> at HH:MM`
- `<first|second|third|fourth|last> <weekday> of month at HH:MM`
- `cron <min> <hour> <dom> <month> <dow>` (raw cron)

### Managing Tasks

View scheduled tasks:

- React with 📅 or ⏰, or
- Type `/tasks list`

If you register a Slack slash command named `/tasks` in your app, it will be handled identically to the text command above.

Other management commands:
```
/tasks pause <taskId>
/tasks resume <taskId>
/tasks cancel <taskId>
/tasks run <taskId>
```
```
(react with 📅 or ⏰)
```

Output:
```
*Scheduled Tasks:*
• Generate weekly report (recurring) - next: Dec 6, 2024, 9:00 AM (UTC)
• Check deployment - next: Dec 5, 2024, 3:00 PM (UTC)
```

Tasks are persisted to `scheduled_tasks.json` and survive restarts.

---

## Approval Workflows

The agent detects potentially destructive operations and requests approval:

### Destructive Patterns Detected

| Category | Patterns |
|----------|----------|
| File operations | `rm -rf`, `rm *`, `rmdir`, `unlink` |
| Git operations | `git push --force`, `git reset --hard`, `git clean -fd`, `git branch -D` |
| Database | `DROP TABLE`, `DROP DATABASE`, `TRUNCATE`, `DELETE FROM ... *` |
| System | `sudo`, `chmod 777`, `kill -9`, `pkill` |
| Package | `npm unpublish`, `yarn remove --all` |
| Docker | `docker rm`, `docker rmi`, `docker system prune` |

### Approval Flow

1. Agent detects destructive command
2. Posts approval request with description
3. User reacts with ✅ to approve or ❌ to reject
4. Approvals timeout after 5 minutes (auto-reject)

Example:
```
Bot: ⚠️ *Approval Required*
     Operation: Delete files/directories
     Command: rm -rf ./build

     React with ✅ to approve or ❌ to reject (expires in 5 minutes)

User: (reacts with ✅)

Bot: ✅ Approved. Executing...
```

---

## Cost Tracking

Usage is tracked per channel and saved to `usage.jsonl`:

### View Costs

React with 💰 or 📈 to see:

```
*Usage Summary*

_Today:_
  Requests: 15 | Cost: $0.0234
  Tokens: 12.5k in / 8.2k out

_All Time:_
  Requests: 847 | Cost: $1.2456
  Tokens: 654.3k in / 412.1k out
```

### Pricing Model

The default cost estimator uses a fixed price table **last verified on December 17, 2025** (update the code/docs if you change models or pricing):

| Token Type | Cost per Million |
|------------|------------------|
| Input | $3.00 |
| Output | $15.00 |
| Cache Write | $3.75 |
| Cache Read | $0.30 |

### Usage Log Format

Each API call is recorded in `<channel>/usage.jsonl`:

```json
{
  "timestamp": "2024-12-05T10:30:00.000Z",
  "model": "claude-sonnet-4-20250514",
  "inputTokens": 1250,
  "outputTokens": 456,
  "cacheWriteTokens": 0,
  "cacheReadTokens": 800,
  "estimatedCost": 0.00821
}
```

---

## Tools Reference

The agent has access to these tools:

### bash

Execute shell commands in the sandbox.

```typescript
{
  command: string;      // Required: command to run
  label: string;        // Required: human-readable description
  timeout?: number;     // Optional: timeout in ms (default: 120000)
  cwd?: string;         // Optional: working directory
}
```

### read

Read file contents (text and images).

```typescript
{
  path: string;         // Required: file path
  label: string;        // Required: description
  offset?: number;      // Optional: start line (1-indexed)
  limit?: number;       // Optional: max lines to read
}
```

### write

Create or overwrite files.

```typescript
{
  path: string;         // Required: file path
  content: string;      // Required: file content
  label: string;        // Required: description
}
```

### edit

Make surgical edits to existing files.

```typescript
{
  path: string;         // Required: file path
  oldText: string;      // Required: exact text to replace
  newText: string;      // Required: replacement text
  label: string;        // Required: description
}
```

### attach

Share files back to Slack.

```typescript
{
  path: string;         // Required: file path in container
  title?: string;       // Optional: display name in Slack
  label: string;        // Required: description
}
```

### status

Check system health and resource usage.

```typescript
{
  label: string;        // Required: description (e.g., "checking resources")
}
```

Returns container info, CPU/memory usage, and workspace disk stats:

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

---

## Programmatic Usage

### Basic Setup

```typescript
import {
  SlackBot,
  createExecutor,
  createSlackAgentTools
} from '@evalops/slack-agent';

// Create sandbox executor
const executor = createExecutor({
  type: 'docker',
  autoCreate: true,
  image: 'node:20-slim',
  cpus: '2',
  memory: '2g',
});

// Create tools
const tools = createSlackAgentTools(executor);

// Create bot
const bot = new SlackBot(
  {
    async onChannelMention(ctx) {
      // Handle @mentions in channels
      await ctx.respond(`Processing: ${ctx.message.text}`);
    },

    async onDirectMessage(ctx) {
      // Handle DMs
      await ctx.respond(`Got your message!`);
    },

    async onReaction(ctx) {
      // Handle emoji reactions
      if (ctx.reaction === 'eyes') {
        await ctx.postMessage(ctx.channel, 'Still here!');
      }
    },
  },
  {
    appToken: process.env.SLACK_APP_TOKEN!,
    botToken: process.env.SLACK_BOT_TOKEN!,
    workingDir: './data',
  }
);

await bot.start();

// Cleanup on shutdown
process.on('SIGTERM', async () => {
  await executor.dispose();
  await bot.stop();
  process.exit(0);
});
```

### API Reference

#### SlackBot

```typescript
class SlackBot {
  constructor(handler: SlackAgentHandler, config: SlackBotConfig);

  // Lifecycle
  start(): Promise<void>;
  stop(): Promise<void>;

  // Messaging
  postMessage(channelId: string, text: string): Promise<string | null>;
  createScheduledContext(channelId: string, prompt: string): Promise<SlackContext>;

  // Data access
  readonly store: ChannelStore;
}

interface SlackAgentHandler {
  onChannelMention(ctx: SlackContext): Promise<void>;
  onDirectMessage(ctx: SlackContext): Promise<void>;
  onReaction?(ctx: ReactionContext): Promise<void>;
}
```

#### SlackContext

```typescript
interface SlackContext {
  message: SlackMessage;
  channelName?: string;
  store: ChannelStore;
  channels: ChannelInfo[];
  users: UserInfo[];
  useThread: boolean;

  respond(text: string, log?: boolean): Promise<void>;
  replaceMessage(text: string): Promise<void>;
  respondInThread(text: string): Promise<void>;
  setTyping(isTyping: boolean): Promise<void>;
  uploadFile(filePath: string, title?: string): Promise<void>;
  setWorking(working: boolean): Promise<void>;
  updateStatus(status: string): Promise<void>;
}
```

#### Executor

```typescript
import { createExecutor, parseSandboxArg, validateSandbox } from '@evalops/slack-agent';

// Parse CLI argument
const sandbox = parseSandboxArg('docker:auto:python:3.12-slim');

// Validate sandbox exists/can be created
await validateSandbox(sandbox);

// Create executor
const executor = createExecutor(sandbox);

// Execute command
const result = await executor.exec('ls -la', { cwd: '/workspace' });
console.log(result.stdout);

// Get container name (for Docker mode)
console.log(executor.getContainerName()); // "slack-agent-abc12345"

// Translate paths
console.log(executor.getWorkspacePath('/host/data')); // "/workspace"

// Cleanup
await executor.dispose();
```

#### ChannelStore

```typescript
import { ChannelStore } from '@evalops/slack-agent';

const store = new ChannelStore({
  workingDir: './data',
  botToken: 'xoxb-...',
});

// Log a message
await store.logMessage('C123ABC', {
  date: new Date().toISOString(),
  ts: '1234567890.123456',
  user: 'U12345',
  userName: 'alice',
  text: 'Hello!',
  attachments: [],
  isBot: false,
});

// Clear history (creates backup)
await store.clearHistory('C123ABC');

// Wait for file downloads
await store.waitForDownloads();

// Read attachment content
const content = store.readAttachmentContent(attachment);
```

#### Scheduler

```typescript
import { Scheduler, parseTimeExpression, parseRecurringSchedule } from '@evalops/slack-agent';

const scheduler = new Scheduler({
  workingDir: './data',
  onTaskDue: async (task) => {
    console.log(`Running: ${task.description}`);
  },
});

scheduler.start();

// Schedule one-time task
await scheduler.schedule(
  'C123ABC',           // channelId
  'U12345',            // createdBy
  'Deploy to staging', // description
  'run deploy.sh',     // prompt
  'in 2 hours'         // when
);

// Schedule recurring task
await scheduler.schedule(
  'C123ABC',
  'U12345',
  'Daily standup summary',
  'summarize commits since yesterday',
  'every day at 9am'
);

// List tasks
const tasks = scheduler.listTasks('C123ABC');

// Cancel task
await scheduler.cancel('task_123456_abc');

scheduler.stop();
```

#### ApprovalManager

```typescript
import {
  ApprovalManager,
  isDestructiveCommand,
  describeDestructiveOperation
} from '@evalops/slack-agent';

// Check if command needs approval
const command = 'rm -rf ./build';
if (isDestructiveCommand(command)) {
  console.log(describeDestructiveOperation(command)); // "Delete files/directories"
}

const approvalManager = new ApprovalManager({
  defaultTimeout: 5 * 60 * 1000, // 5 minutes
});

approvalManager.start();

// Request approval
const id = approvalManager.requestApproval(
  'C123ABC',           // channelId
  '1234567890.123456', // messageTs
  'rm -rf ./build',    // operation
  'Delete build directory', // description
  async () => { /* on approve */ },
  async () => { /* on reject */ },
);

// Handle reaction
const handled = await approvalManager.handleReaction(
  'C123ABC',
  '1234567890.123456',
  'white_check_mark' // ✅
);

approvalManager.stop();
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Slack Workspace                          │
│                                                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                       │
│  │ Channel  │  │ Channel  │  │   DM     │                       │
│  │   #dev   │  │  #ops    │  │  @alice  │                       │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘                       │
└───────┼─────────────┼─────────────┼─────────────────────────────┘
        │             │             │
        └─────────────┼─────────────┘
                      │
                      ▼ Socket Mode
┌─────────────────────────────────────────────────────────────────┐
│                        SlackBot                                  │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐          │
│  │ Event       │  │ Rate         │  │ Reaction       │          │
│  │ Handler     │  │ Limiter      │  │ Handler        │          │
│  └──────┬──────┘  └──────────────┘  └────────────────┘          │
└─────────┼───────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────┐
│                      AgentRunner                                 │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐          │
│  │ Maestro    │  │ Tool         │  │ Cost           │          │
│  │ Agent       │  │ Executor     │  │ Tracker        │          │
│  └──────┬──────┘  └──────┬───────┘  └────────────────┘          │
└─────────┼────────────────┼──────────────────────────────────────┘
          │                │
          ▼                ▼
┌─────────────────┐  ┌─────────────────────────────────────────────┐
│   Claude API    │  │              Docker Sandbox                  │
│  (Anthropic)    │  │  ┌─────────────────────────────────────┐    │
│                 │  │  │  /workspace                          │    │
│  - Sonnet 4     │  │  │  ├── MEMORY.md                      │    │
│  - Extended     │  │  │  ├── C123ABC/                       │    │
│    Thinking     │  │  │  │   ├── log.jsonl                  │    │
│                 │  │  │  │   ├── scratch/                   │    │
└─────────────────┘  │  │  │   └── ...                        │    │
                     │  │  └──────────────────────────────────│    │
                     │  │  Resource Limits: 2 CPU, 2GB RAM     │    │
                     │  └─────────────────────────────────────────┘
                     └─────────────────────────────────────────────┘
```

### Data Flow

1. **Message received** → Socket Mode client receives event
2. **Rate check** → RateLimiter validates user/channel limits
3. **Context created** → SlackContext built with channel info, users, history
4. **Agent runs** → Maestro Agent processes with Claude API
5. **Tools execute** → Commands run in Docker sandbox
6. **Response sent** → Updates Slack message in real-time
7. **Usage tracked** → CostTracker records token usage

### Key Components

| Component | File | Purpose |
|-----------|------|---------|
| SlackBot | `src/slack/bot.ts` | Socket Mode client, event routing |
| AgentRunner | `src/agent-runner.ts` | Agent lifecycle, tool execution |
| Executor | `src/sandbox.ts` | Sandbox abstraction (Docker/host) |
| ChannelStore | `src/store.ts` | Message logging, file management |
| Scheduler | `src/scheduler.ts` | Task scheduling |
| ApprovalManager | `src/approval.ts` | Destructive operation approval |
| CostTracker | `src/cost-tracker.ts` | Usage tracking |
| RateLimiter | `src/rate-limiter.ts` | Request rate limiting |

---

## Security

### Docker Sandbox Benefits

| Protection | Description |
|------------|-------------|
| **Isolation** | Commands run in isolated container |
| **Resource limits** | CPU and memory caps prevent runaway processes |
| **No privilege escalation** | `--security-opt no-new-privileges` |
| **Read-only root** | (with docker-compose) Limits filesystem modifications |
| **Workspace containment** | Only `/workspace` is writable |

### Approval Workflow

Automatically detects and blocks potentially dangerous commands until user approves.

### Rate Limiting

Prevents abuse through per-user and per-channel request limits.

### Production Recommendations

1. **Always use Docker mode** - Never run in host mode in production
2. **Use custom images** - Build images with only required tools
3. **Network isolation** - Use `network_mode: none` if internet not needed
4. **Monitor resources** - Use the status tool to track usage
5. **Rotate workspace data** - Periodically clean up old logs/files
6. **Restrict channels** - Only add bot to channels that need it
7. **Audit logs** - Review `log.jsonl` files for activity

---

## Enterprise Features

The slack-agent includes enterprise-grade features for production deployments supporting multiple workspaces and teams.

### Multi-Workspace OAuth

Support OAuth 2.0 installation flow for multi-workspace deployments:

```typescript
import { startOAuthServer, WorkspaceManager } from '@evalops/slack-agent';

// Start OAuth installation server
const { server, stop } = startOAuthServer({
  clientId: process.env.SLACK_CLIENT_ID!,
  clientSecret: process.env.SLACK_CLIENT_SECRET!,
  workingDir: './data',
  port: 3000,
  onInstall: (workspace) => {
    console.log(`Installed to ${workspace.teamName}`);
  },
});

// Direct users to: http://localhost:3000/slack/install

// Load workspace tokens
const workspaces = new WorkspaceManager('./data');
const allActive = workspaces.getAll();
```

### Role-Based Access Control (RBAC)

Control user permissions with four built-in roles:

| Role | Description | Tool Access |
|------|-------------|-------------|
| `admin` | Full access to all features and settings | All tools + user management |
| `power_user` | Execute any tool, manage tasks and context | All tools |
| `user` | Execute common tools, manage own tasks | read, write, edit, bash, search |
| `viewer` | Read-only access, can search and view status | read, search, status |

```typescript
import { PermissionManager } from '@evalops/slack-agent';

const permissions = new PermissionManager('./data', {
  defaultRole: 'user',
});

// Check permissions
const result = permissions.check(userId, 'execute_tool', 'bash');
if (!result.allowed) {
  console.log(`Denied: ${result.reason}`);
}

// Admin operations
permissions.setRole(adminId, targetUserId, 'power_user');
permissions.blockUser(adminId, targetUserId, 'Policy violation');
```

### Audit Logging

Tamper-evident audit trail with hash chaining and automatic PII redaction:

```typescript
import { AuditLogger } from '@evalops/slack-agent';

const audit = new AuditLogger('./data', {
  enablePiiRedaction: true,
  maxPreviewLength: 200,
  retentionDays: 90,
  rotateAtMB: 100,
});

// Log events
audit.logMessage(userId, channelId, 'Hello world', threadTs);
audit.logToolCall(userId, channelId, 'bash', { command: 'ls' }, 'success', 'output', 150);
audit.logApproval(userId, channelId, 'approval_granted', 'rm -rf build/');

// Query logs
const userActions = audit.query({ userId, limit: 100 });

// Verify integrity (detect tampering)
const integrity = audit.verifyIntegrity();
if (!integrity.valid) {
  console.error('Audit log tampered!', integrity.errors);
}
```

**PII Patterns Automatically Redacted:**
- Email addresses → `[EMAIL]`
- Phone numbers → `[PHONE]`
- Credit card numbers → `[CARD]`
- Social Security Numbers → `[SSN]`
- API keys/tokens → `[REDACTED_KEY]`
- AWS keys → `[AWS_KEY]`

### Thread Memory Management

Per-thread conversation context with configurable limits:

```typescript
import { ThreadMemoryManager } from '@evalops/slack-agent';

const memory = new ThreadMemoryManager('./data', {
  maxMessages: 50,
  maxTokens: 8000,
  retentionDays: 30,
});

// Add messages
await memory.addMessage(channelId, threadTs, {
  role: 'user',
  content: 'Hello',
  userId: 'U123',
});

// Get context for agent
const messages = await memory.getMessagesForAgent(channelId, threadTs);

// Get summary
const summary = await memory.getThreadSummary(channelId, threadTs);
console.log(`${summary.messageCount} messages, ${summary.totalTokens} tokens`);

// Clear thread
await memory.clearThread(channelId, threadTs);
```

### Event Idempotency

Prevent duplicate processing with atomic locking:

```typescript
import { IdempotencyManager, withIdempotency } from '@evalops/slack-agent';

const idempotency = new IdempotencyManager('./data', {
  ttlMs: 3600000,  // 1 hour
  lockTimeout: 30000,
});

// Check and lock
const check = await idempotency.checkAndLock(eventId, 'message');
if (!check.shouldProcess) {
  if (check.isDuplicate) {
    console.log('Already processed');
  }
  return;
}

try {
  await processEvent(event);
  await idempotency.markComplete(eventId);
} catch (err) {
  await idempotency.markFailed(eventId, err.message);
}

// Or use the wrapper
const handler = withIdempotency(
  idempotency,
  async (event) => { /* process */ },
  (event) => event.id  // extract event ID
);

const result = await handler(event);
if (result.skipped) {
  console.log('Duplicate event');
}
```

### Signature Verification

Verify Slack request signatures for HTTP webhook mode:

```typescript
import { verifySlackSignature } from '@evalops/slack-agent';

// In your HTTP handler
const isValid = verifySlackSignature(
  process.env.SLACK_SIGNING_SECRET!,
  req.headers['x-slack-signature'],
  req.headers['x-slack-request-timestamp'],
  rawBody
);

if (!isValid) {
  return res.status(401).send('Invalid signature');
}
```

### Pluggable Storage Backends

All enterprise features support pluggable storage for distributed deployments:

```typescript
import { FileStorageBackend, InMemoryStorage } from '@evalops/slack-agent';

// File-based (default) - good for single instance
const fileStorage = new FileStorageBackend('./data/state');

// In-memory - good for tests
const memStorage = new InMemoryStorage();

// Custom Redis backend (implement StorageBackend interface)
interface StorageBackend {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlMs?: number): Promise<void>;
  setNX(key: string, value: unknown, ttlMs?: number): Promise<boolean>;
  delete(key: string): Promise<boolean>;
  exists(key: string): Promise<boolean>;
  keys(pattern: string): Promise<string[]>;
}

// Pass to enterprise features
const idempotency = new IdempotencyManager(null, { storage: redisStorage });
```

---

## Troubleshooting

### Connection Issues

**"Missing required environment variables"**
```bash
# Verify tokens are set
echo $SLACK_APP_TOKEN  # Should start with xapp-
echo $SLACK_BOT_TOKEN  # Should start with xoxb-
echo $ANTHROPIC_API_KEY
```

**Socket Mode disconnects**
- Check app-level token has `connections:write` scope
- Verify Socket Mode is enabled in Slack app settings

### Docker Issues

**"Container not found"**
```bash
# Check if container exists
docker ps -a | grep slack-agent

# For auto mode, it creates on first command
slack-agent --sandbox=docker:auto ./data
```

**"Permission denied"**
```bash
# Ensure data directory is accessible
chmod -R 755 ./data
```

### Bot Not Responding

1. **Check bot is invited** - `/invite @bot-name` in channel
2. **Check event subscriptions** - Verify `app_mention`, `message.*` events
3. **Check logs** - Look for errors in terminal output
4. **Check rate limits** - React with 👀 to see status

### Message History Issues

**"No message history yet"**
- Wait for backfill to complete on startup
- Check `log.jsonl` exists in channel directory

**Missing messages**
- Only last 3 pages of history are backfilled
- Bot messages from other bots are filtered out

### Debug Information

The agent writes debug info to `<channel>/last_prompt.txt`:
- Full system prompt
- Tool definitions
- User prompt with conversation history

---

## Development

### Build

```bash
# Build the package
bun run build

# Type check
bun run check

# Dev mode with watch
bun run dev
```

### Test

```bash
# Run package tests
cd packages/slack-agent
bun run test

# Run via Nx from repo root
npx nx run slack-agent:test --skip-nx-cache

# Run a specific test
bunx vitest --run -t "scheduler"
```

### Project Structure

```
packages/slack-agent/
├── src/
│   ├── main.ts              # CLI entry point
│   ├── index.ts             # Package exports
│   ├── agent-runner.ts      # Agent lifecycle
│   ├── approval.ts          # Approval workflows
│   ├── cost-tracker.ts      # Usage tracking
│   ├── logger.ts            # Console logging
│   ├── rate-limiter.ts      # Request rate limiting
│   ├── sandbox.ts           # Docker/host execution
│   ├── scheduler.ts         # Task scheduling
│   ├── store.ts             # Message/file storage
│   ├── slack/
│   │   └── bot.ts           # Slack integration
│   └── tools/
│       ├── index.ts         # Tool exports
│       ├── bash.ts          # Bash execution
│       ├── read.ts          # File reading
│       ├── write.ts         # File writing
│       ├── edit.ts          # File editing
│       ├── attach.ts        # Slack file upload
│       └── status.ts        # System status
├── Dockerfile               # Sandbox image
├── docker-compose.yml       # Container config
├── package.json
├── tsconfig.build.json
└── project.json             # Nx config
```

---

## License

MIT
