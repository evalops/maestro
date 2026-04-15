# @evalops/github-agent

GitHub automation agent for issue-driven repository workflows.

## What It Does

This agent watches a GitHub repository for issues with specific labels, implements the requested changes, runs quality gates, and opens pull requests.

**Deep GitHub integration includes:**
- REST + GraphQL usage with rate-limit awareness, pagination, and conditional requests
- GitHub App auth (JWT + installation tokens) or PAT auth
- Issue comment progress reporting with step-by-step status
- Check runs on the PR head SHA summarizing tests/lint/typecheck results
- GraphQL review threads to capture file-level feedback for future prompts
- Webhook support for low-latency issue/comment/review handling

```
┌─────────────────────────────────────────────────────────────────┐
│                     GitHub (source of truth)                     │
│  Issues · PRs · Reviews · Comments · Merge/Reject signals       │
└──────────────────────────┬──────────────────────────────────────┘
                           │ polls
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                         Orchestrator                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │   Watcher   │  │   Triage    │  │   Memory    │              │
│  │ (GitHub)    │──│ (priority)  │──│ (learning)  │              │
│  └─────────────┘  └─────────────┘  └─────────────┘              │
└──────────────────────────┬──────────────────────────────────────┘
                           │ spawns
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Worker (composer exec)                        │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐        │
│  │  Impl    │─▶│  Tests   │─▶│  Review  │─▶│  Submit  │        │
│  │  (code)  │  │  (gate)  │  │  (self)  │  │  (PR)    │        │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘        │
└─────────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Feedback Loop                               │
│  PR merged? → positive signal → reinforce approach              │
│  PR rejected? → negative signal → store review, adjust          │
│  Review comments? → incorporate into future context             │
└─────────────────────────────────────────────────────────────────┘
```

## Usage

### As a CLI

```bash
# Install (global CLI)
bun install -g @evalops/github-agent

# Or run without installing (one-off)
bunx @evalops/github-agent owner/repo
# or
npx -y @evalops/github-agent owner/repo

# Run as daemon (watches for new issues)
github-agent owner/repo

# Process a single issue
github-agent owner/repo --issue 42
```

### As a GitHub Action

Add this workflow to your repository:

```yaml
name: Maestro GitHub Agent

on:
  issues:
    types: [labeled]
  issue_comment:
    types: [created]

jobs:
  process:
    if: |
      (github.event_name == 'issues' && github.event.label.name == 'composer-task') ||
      (github.event_name == 'issue_comment' && contains(github.event.comment.body, '@composer'))
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
      issues: write
      checks: write
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v1
      - run: bun install
      - run: npx nx run maestro:build:all --skip-nx-cache
      - run: |
          cd packages/github-agent && bun run build
          node dist/main.js ${{ github.repository }} \
            --issue ${{ github.event.issue.number }} \
            --working-dir ${{ github.workspace }}
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

## Configuration

### CLI Options

| Option | Description | Default |
|--------|-------------|---------|
| `--working-dir` | Repository working directory | `./workspace` |
| `--memory-dir` | Memory storage directory | `./memory` |
| `--labels` | Issue labels to watch (comma-separated) | `composer-task` |
| `--poll-interval` | Poll interval in ms | `60000` |
| `--max-attempts` | Max retry attempts per task | `3` |
| `--daily-budget` | Daily spending limit ($) | `50` |
| `--no-tests` | Skip test requirement | |
| `--no-lint` | Skip lint requirement | |
| `--no-self-review` | Skip self-review step | |
| `--draft-pr` | Create pull requests as drafts | |
| `--pr-labels` | Apply labels to the PR (comma-separated) | |
| `--reviewers` | Request reviewers by username (comma-separated) | |
| `--team-reviewers` | Request team reviewers by slug (comma-separated) | |
| `--auto-merge` | Enable auto-merge on created PRs | |
| `--auto-merge-method` | Auto-merge method (`merge`, `squash`, `rebase`) | `squash` |
| `--auto-merge-headline` | Custom auto-merge headline | |
| `--auto-merge-body` | Custom auto-merge body | |
| `--merge-queue` | Enqueue PR into merge queue if enabled | |
| `--merge-queue-jump` | Jump to the front of the merge queue | |
| `--issue` | Process specific issue and exit | |
| `--github-api-url` | Override GitHub API base URL (GHES) | |
| `--github-app-id` | GitHub App ID (App auth) | |
| `--github-app-private-key` | GitHub App private key (PEM or base64) | |
| `--github-app-private-key-file` | GitHub App private key path | |
| `--github-app-installation-id` | GitHub App installation id | |
| `--webhook-secret` | Webhook secret for verification | |
| `--webhook-port` | Webhook port | 8787 |
| `--webhook-path` | Webhook path | `/github/webhooks` |
| `--webhook-mode` | `poll` / `webhook` / `hybrid` | `poll` |
| `--webhook-backfill-interval` | Backfill poll interval in hybrid mode (ms) | `600000` |
| `--webhook-id` | Webhook ID (for redelivery) | |
| `--webhook-redelivery-interval` | Webhook redelivery poll interval (ms) | `600000` |

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GITHUB_TOKEN` | Optional | GitHub personal access token |
| `GITHUB_APP_ID` | Optional | GitHub App ID |
| `GITHUB_APP_PRIVATE_KEY` | Optional | GitHub App private key (PEM or base64) |
| `GITHUB_APP_PRIVATE_KEY_PATH` | Optional | GitHub App private key path |
| `GITHUB_APP_INSTALLATION_ID` | Optional | GitHub App installation id |
| `GITHUB_API_URL` | Optional | GitHub API base URL (GHES) |
| `GITHUB_WEBHOOK_SECRET` | Optional | Webhook secret |
| `GITHUB_WEBHOOK_PORT` | Optional | Webhook port |
| `GITHUB_WEBHOOK_PATH` | Optional | Webhook path |
| `GITHUB_WEBHOOK_MODE` | Optional | `poll` / `webhook` / `hybrid` |
| `GITHUB_WEBHOOK_ID` | Optional | Webhook ID (for redelivery) |
| `GITHUB_WEBHOOK_REDELIVERY_INTERVAL` | Optional | Webhook redelivery interval in ms |
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key for Maestro |

## How It Works

### 1. Issue Triage

When a new issue is labeled with `composer-task`:

1. **Prioritization**: Issues are scored based on labels, complexity, and age
2. **Complexity estimation**: Analyzes title/body for keywords
3. **Task creation**: Eligible issues become tasks in the queue

### 2. Task Execution

For each task:

1. **Branch creation**: Creates a feature branch from main
2. **Maestro execution**: Runs `maestro exec --full-auto` with the task
3. **Quality gates**: Tests, lint, and type checking must pass
4. **Self-review**: Optional second pass to catch issues
5. **PR creation**: Opens a PR with proper formatting
6. **Progress reporting**: Updates the issue with a live status checklist and publishes a check run (if permissions allow)

### 3. Feedback Loop

After PR creation:

- **Watches for merge/close**: Records outcome
- **Captures review comments**: Extracts patterns to avoid
- **Updates memory**: Learns from successes and failures

### 4. Memory System

The agent learns from experience:

```json
{
  "problematicFiles": { "src/foo.ts": 3 },
  "reviewPatterns": [
    { "pattern": "missing test", "suggestion": "Always add tests" }
  ],
  "stats": {
    "mergedPRs": 15,
    "rejectedPRs": 3,
    "averageAttemptsToMerge": 1.2
  }
}
```

This context is injected into future prompts to improve success rate.

## Safety

- **Budget limits**: Configurable daily spending cap
- **Attempt limits**: Tasks fail after max retries
- **Quality gates**: All PRs must pass tests/lint/types
- **Self-review**: Optional second pass catches mistakes
- **No force push**: Never rewrites history
- **Branch protection**: Works with protected branches

## GitHub API Integration

The agent uses a hybrid REST + GraphQL client for richer metadata (review decision), with:

- **ETag + Last-Modified conditional requests** to reduce rate limit usage
- **Link header pagination** to avoid redundant API calls
- **Retry/backoff** for secondary rate limits
- **GraphQL rate-limit tracking** to prevent exhaustion
- **Check runs** for per-task summaries
- **Review thread ingestion** to map feedback to specific files
- **Auto-merge / merge queue support** via GraphQL mutations

### Recommended GitHub App Permissions

For GitHub App auth, grant:

- **Issues**: Read & Write (status comments)
- **Pull requests**: Read & Write (create PRs)
- **Checks**: Read & Write (check runs)
- **Contents**: Read & Write (branch push)
- **Metadata**: Read-only

## Webhook Mode

For near-real-time responses without heavy polling, run in webhook or hybrid mode:

```bash
github-agent evalops/composer \\
  --webhook-secret $GITHUB_WEBHOOK_SECRET \\
  --webhook-mode hybrid \\
  --webhook-port 8787 \\
  --webhook-path /github/webhooks
```

Use `hybrid` to keep polling as a fallback when GitHub events are delayed.

## GitHub App Auth

For higher rate limits and org-wide installs, run with a GitHub App:

```bash
export GITHUB_APP_ID=12345
export GITHUB_APP_PRIVATE_KEY_PATH=/path/to/private-key.pem
github-agent evalops/composer --webhook-mode hybrid
```

## Development

```bash
# Build
cd packages/github-agent
bun run build

# Test
bun run test

# Development
bun run dev
```

## License

MIT
