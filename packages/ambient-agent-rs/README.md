# Ambient Agent

A long-running GitHub agent that watches repositories, identifies work, and opens pull requests.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            AMBIENT DAEMON                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  WATCHERS ──▶ EVENT BUS ──▶ DECIDER ──▶ CASCADER ──▶ EXECUTOR ──▶ CRITIC   │
│                                │                           │         │       │
│                                │                           ▼         ▼       │
│                                │                      CHECKPOINT    PR       │
│                                │                                    │        │
│                                └──────────────────────────────┐     │        │
│                                                               ▼     ▼        │
│                                                            LEARNER           │
│                                                               │              │
│                                                               ▼              │
│                                                           RETRAINER          │
└─────────────────────────────────────────────────────────────────────────────┘

Flow: WATCH → FILTER → DECIDE → PLAN → ROUTE → EXECUTE → CRITIQUE → PR → LEARN
```

## Core Philosophy

1. **PRs are the permission layer** - Agent can do anything, but nothing lands without human review
2. **Confidence-gated execution** - High confidence → act; low confidence → ask
3. **Learn from outcomes** - Merged PRs reinforce patterns; rejected PRs update priors
4. **Swarm for complexity** - Simple tasks = single agent; complex = spawn teammates

## Components

| Component | Purpose |
|-----------|---------|
| **EventBus** | Receives and normalizes events from GitHub (issues, PRs, comments) |
| **Decider** | Determines whether to act on an event and plans the task |
| **Cascader** | Routes tasks to appropriate model tier based on complexity |
| **Executor** | Executes tasks by calling LLMs and applying file changes |
| **Critic** | LLM-as-Judge that reviews agent outputs before shipping |
| **CheckpointManager** | Provides atomic operations with rollback capability |
| **Learner** | Records outcomes and learns from success/failure patterns |
| **IPC** | Unix socket communication between CLI and daemon |

## Confidence Thresholds

| Confidence | Action |
|------------|--------|
| ≥ 0.8 | Auto-execute (high confidence) |
| 0.5 - 0.8 | Ask human for approval |
| < 0.5 | Skip (too uncertain) |

## Model Cascading

Tasks are routed to model tiers based on complexity to optimize cost:

| Tier | Model | Use Case |
|------|-------|----------|
| 1 | claude-3-5-haiku | Simple fixes, typos, doc updates |
| 2 | claude-3-5-sonnet | Standard features, refactoring |
| 3 | claude-3-opus | Complex architecture, security |

## Installation

```bash
cargo build --release
```

## Usage

### Initialize configuration

```bash
ambient init
```

This creates `ambient.yaml` with default settings.

### Add repositories to watch

```bash
ambient watch owner/repo
```

### Start the daemon

```bash
ambient start
# Or run in foreground:
ambient start --foreground
```

### Check status

```bash
ambient status
ambient stats
```

### Stop the daemon

```bash
ambient stop
```

### List watched repositories

```bash
ambient list
```

### Remove a repository

```bash
ambient unwatch owner/repo
```

## Configuration

Edit `ambient.yaml`:

```yaml
repos:
  - name: owner/repo
    watchers:
      - issues
      - pull_requests

thresholds:
  auto_execute: 0.8  # Confidence threshold for auto-execution
  ask_human: 0.5     # Below this, ask for human approval

github_token: ghp_xxxxx  # Your GitHub token
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | API key for Claude models |
| `GITHUB_TOKEN` | GitHub personal access token |

## Data Storage

By default, data is stored in:
- Linux: `~/.local/share/ambient-agent/`
- macOS: `~/Library/Application Support/ambient-agent/`
- Windows: `%APPDATA%\ambient-agent\`

Override with `--data-dir`:

```bash
ambient start --data-dir /path/to/data
```

## Development

### Run tests

```bash
cargo test
```

### Run with debug logging

```bash
ambient --log-level debug start --foreground
```

## License

MIT
