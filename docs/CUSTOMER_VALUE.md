# Customer Value Reports

Audience: teams, operators, and admins proving what Maestro did.
Nav: [Docs index](README.md) - [Sessions](SESSIONS.md) - [Safety](SAFETY.md) - [Features](FEATURES.md)

`maestro value` turns local Maestro artifacts into a customer-facing value report:

```bash
maestro value
maestro value week
maestro value all --format json
maestro value all --format md
maestro value week --write
maestro value week --write --output-dir .maestro/value-reports
```

The report is intentionally evidence-first. It uses local session JSONL files,
usage records, and telemetry logs to produce:

- Trust cards for recent sessions: task, summary, tool calls, failures, usage,
  memory provenance, and replayable session path.
- Value estimates: requests, tokens, spend, estimated hours saved, and estimated
  value multiple.
- Workflow opportunities: fix failing CI, review PR, cut release, triage
  Dependabot, and refactor with tests, each with a ready-to-save
  `.maestro/workflows/*.yaml` template.
- Multi-agent coordination: A2A delegated tasks, peer rollups, realized value
  from completed delegated work, workGraph pressure, audit readiness, and the
  next operator command for waiting/running/failed delegated work.
- Durable handoffs: delivered work, unfinished work, blockers, next actions, and
  persisted open todo items.
- Memory provenance: session memory extraction hashes and source sessions.
- Admin controls: policy/approval audit, evidence retention, spend/routing, and
  team-memory readiness.
- Collection gaps: missing telemetry, missing usage, missing summaries, or
  missing memory provenance.

## Evidence Sources

| Source | Default | Purpose |
| --- | --- | --- |
| Sessions | `~/.maestro/agent/sessions` | Trust cards, replay paths, summaries, tool calls, memory hashes |
| Usage | `~/.maestro/usage.json` | Requests, tokens, model spend, session spend |
| Telemetry | `~/.maestro/telemetry.log` | Tool/eval/canonical-turn event coverage |
| A2A task ledger | `~/.maestro/a2a/tasks.json` | Delegated task state, peer ownership, transcripts, workGraph and subagent evidence |
| Todos | `~/.maestro/todos.json` | Open work, blockers, priorities, and goals that should survive handoff |

Use the existing env overrides when testing or operating in managed setups:

```bash
MAESTRO_SESSION_DIR=/path/to/sessions \
MAESTRO_USAGE_FILE=/path/to/usage.json \
MAESTRO_TELEMETRY_FILE=/path/to/telemetry.log \
MAESTRO_A2A_TASKS_FILE=/path/to/a2a/tasks.json \
MAESTRO_TODO_FILE=/path/to/todos.json \
maestro value all --format md
```

## Interpretation

The report does not claim more than the local artifacts prove. For example,
estimated hours saved are conservative heuristics from assistant turns and tool
calls plus completed delegated A2A work. Waiting, running, failed, or incomplete
delegated tasks are shown as pending work or evidence gaps rather than realized
value. The report highlights collection gaps when a team needs stronger proof,
such as telemetry routing, persisted summaries, memory extraction provenance, or
multi-agent workGraph/correlation evidence.

The product principle is simple: every run should leave a durable, readable
artifact another human can audit without trusting the model's self-report.
The handoff section is the continuity layer: it separates delivered work from
unfinished or blocked work and ties both back to evidence paths and tracked
todos.

## Durable Artifacts

Use `--write` when the report needs to survive the terminal scrollback:

```bash
maestro value week --write
```

By default Maestro writes the artifact set under
`~/.maestro/value-reports`. Use `--output-dir` to write inside a repository or
handoff bundle. Each artifact set contains:

- A JSON report with the full trust-card, workflow, memory, admin, telemetry,
  handoff, open-work, and collection-gap payload.
- A Markdown report for human review.
- A manifest named `*.manifest.json` with the report paths, SHA-256 hashes,
  source paths, summary totals, admin control states, and evidence coverage.

The manifest is the durable audit handle. It lets an admin verify that the
Markdown and JSON files match what was generated, identify which local sessions
were used, and pass a compact evidence index to another system without copying
raw transcripts into the summary.

## Workflow Templates

`maestro value --format md` includes YAML templates for Maestro's existing
workflow runner. Save a template to its suggested path, then run it from the TUI
with `/workflow run <name>` after reviewing the commands for your repository.

These templates are intentionally evidence-oriented. They start with preflight
context, prefer local checks that already exist in the project, and finish by
emitting a fresh customer-value report so the workflow leaves a trust-card-ready
artifact.
