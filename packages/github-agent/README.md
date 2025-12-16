# @evalops/github-agent

Autonomous GitHub agent for self-improvement. **Composer building Composer.**

## What It Does

This agent watches a GitHub repository for issues with specific labels, implements them, runs quality gates, and creates PRs - all autonomously.

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
# Install
bun install -g @evalops/github-agent

# Run as daemon (watches for new issues)
github-agent owner/repo

# Process a single issue
github-agent owner/repo --issue 42
```

### As a GitHub Action

Add this workflow to your repository:

```yaml
name: Composer Self-Improvement

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
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v1
      - run: bun install
      - run: npx nx run composer:build:all --skip-nx-cache
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
| `--issue` | Process specific issue and exit | |

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GITHUB_TOKEN` | Yes | GitHub personal access token |
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key for Composer |

## How It Works

### 1. Issue Triage

When a new issue is labeled with `composer-task`:

1. **Prioritization**: Issues are scored based on labels, complexity, and age
2. **Complexity estimation**: Analyzes title/body for keywords
3. **Task creation**: Eligible issues become tasks in the queue

### 2. Task Execution

For each task:

1. **Branch creation**: Creates a feature branch from main
2. **Composer execution**: Runs `composer exec --full-auto` with the task
3. **Quality gates**: Tests, lint, and type checking must pass
4. **Self-review**: Optional second pass to catch issues
5. **PR creation**: Opens a PR with proper formatting

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
