# EvalOps Agent Core Parity Spec

## Goal

Ship a Hermes-class public agent distribution without copying Hermes as a monolith. Maestro is the local agent core, Platform is the governed durable control plane, and Ensemble is the Slack/channel product layer.

The distribution target is:

```text
maestro                    # local coding agent
maestro skill ...          # extension package authoring and validation
maestro run inspect ...    # durable run and evidence inspection
maestro init               # optional Platform attach
maestro remote ...         # hosted runtime attach
```

## Product Contract

EvalOps Agent Core must feel local-first on day one and cloud-governed when attached:

- A developer can install the public package and use Maestro without Platform credentials.
- A team can attach the same agent to Platform for identity, approvals, memory, audit, meter, traces, and hosted execution.
- Slack and other channels render Platform runtime events through Ensemble; they do not own durable execution state.
- Extension authors get one package format for instructions, references, scripts, toolbox executables, and MCP servers.

## Hermes Parity Map

| Hermes capability | EvalOps parity surface | First durable slice |
| --- | --- | --- |
| One installable OSS agent | public Maestro package | Keep Agent Core in Maestro, not a new repo |
| Progressive skills | `skills/`, `.maestro/skills`, `maestro skill` | Skill package linter/scaffolder |
| Bundled MCP/tool plugins | Skill `mcp.json` and `toolbox/` | Require `includeTools` for all bundled MCP servers |
| Local sessions and recall | Maestro sessions, run inspection, trajectories | Promote into a local AgentRuntime ledger |
| Durable goals/workboard | Platform Objectives and AgentRuns | Expose a local workboard that maps to Platform when attached |
| Gateway/channels | Ensemble adapters plus Maestro Slack/GitHub agents | Keep Slack deep before broad platform count |
| Governance and evidence | Platform approvals, audit, traces, VFS | Preserve evidence in runtime artifacts, not chat prose |

## Skill Package Format

A skill package is a directory:

```text
<skill-name>/
  SKILL.md
  reference/
  scripts/
  toolbox/
  mcp.json
```

`SKILL.md` is the progressive disclosure entry point. Startup loads only `name` and `description`; the full body is loaded only when the skill is relevant. Reference files remain Level 3 resources and should be read only on demand.

Frontmatter:

```yaml
---
name: reviewing-prs
description: "Review pull requests. Use when the user asks for PR review."
license: Apache-2.0
compatibility: "Requires gh CLI"
allowed-tools:
  - github.get_pull_request
builtin-tools:
  - read
  - search
argument-hint: "<owner/repo#number>"
model: gpt-5.5
mode: review
isolatedContext: true
metadata:
  owner: evalops
---
```

`mcp.json` is optional, but every server must be filtered:

```json
{
  "github": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-github"],
    "includeTools": ["get_pull_request", "list_pull_request_files"]
  }
}
```

Unfiltered MCP servers are rejected because they inflate prompt/tool surface and make governance unclear.

`toolbox/` is optional. Executables in that directory are expected to support `MAESTRO_TOOLBOX_ACTION=describe` so Maestro can register them as typed tools when the skill is active.

When the `Skill` tool loads a package, it returns a `skillRuntimeActivation`
manifest alongside artifact metadata. `maestro skill inspect <name> --json`
emits the same contract for local harnesses:

```json
{
  "runtimeActivation": {
    "name": "reviewing-prs",
    "source": "project",
    "profile": {
      "model": "gpt-5.5",
      "mode": "review",
      "isolatedContext": true
    },
    "tools": {
      "allowed": ["github.get_pull_request"],
      "builtin": ["read", "search"]
    },
    "resources": {
      "directories": {
        "reference": ".maestro/skills/reviewing-prs/reference",
        "toolbox": ".maestro/skills/reviewing-prs/toolbox"
      }
    },
    "toolPackage": {
      "mcp": {
        "configPath": ".maestro/skills/reviewing-prs/mcp.json",
        "servers": [
          {
            "name": "github",
            "command": "npx",
            "includeTools": ["get_pull_request", "list_pull_request_files"]
          }
        ]
      }
    }
  }
}
```

The activation manifest exposes scoped paths, toolbox entries, MCP server names,
and `includeTools` bounds. It does not copy MCP environment values into
agent-visible details or telemetry. MCP servers with missing or malformed
`includeTools` are omitted from the activatable server list and reported through
manifest warnings.

## CLI Contract

`maestro skill` is the public authoring surface:

```bash
maestro skill list
maestro skill inspect reviewing-prs --json
maestro skill new reviewing-prs --description "Review pull requests. Use when the user asks for PR review."
maestro skill lint .maestro/skills
maestro skill lint .maestro/skills --describe-toolbox
```

Lint rules:

- `SKILL.md` exists and has valid YAML frontmatter.
- `name` is lowercase, hyphenated, <= 64 chars, and matches the directory.
- `description` exists, is <= 1024 chars, and says when to use the skill.
- The body stays under 500 lines and about 5k tokens.
- `allowed-tools` and `builtin-tools` are strings or lists of strings.

## Local AgentRuntime Ledger

Saved sessions now have a local AgentRuntime projection layered on top of the
existing run reconstruction command. The ledger is deterministic and dry-run
only: it does not require Platform credentials, does not write remote
AgentRuntime state, and does not copy raw tool outputs into promotion payloads.

```bash
maestro run inspect <session-id> --json
maestro run ledger <session-id>
maestro run replay <session-id>
maestro run promote <session-id>
```

`maestro run ledger` emits `evalops.maestro.agent-runtime-ledger.v1`: run
metadata, ordered ledger entries, replay determinism, and a dry-run promotion
plan. `maestro run replay` emits
`evalops.maestro.agent-runtime-replay-summary.v1`, while
`maestro run promote` emits `evalops.maestro.agent-runtime-promotion-plan.v1`
operations shaped like Platform AgentRuntime trigger, step, work-item, wait,
and terminal writes. Promotion work items carry product-safe join keys such as
`toolExecutionId`, `waitId`, `evidenceRefs`, and compact linkage payloads, so a
future live promoter can join local session evidence to Platform ToolExecution,
approval, wait, and timeline records without copying raw tool output.

This is the local parity layer before live promotion: it gives harnesses and
operators a stable inspect/replay/promote contract without introducing a second
runtime source of truth or a new local database dependency.
- `isolatedContext` is boolean when present.
- `mcp.json` is valid JSON.
- Every MCP server has `command` and non-empty `includeTools`.
- Toolbox files are executable; optional strict mode runs their describe action.

## Next Slices

1. Local AgentRuntime ledger: one SQLite store for runs, tool calls, waits, summaries, checkpoints, and session search.
2. `maestro goal`: persistent objective loop backed by the local ledger, promotable to Platform Objectives.
3. `maestro workboard`: local multi-agent board mapped to Platform AgentRuns when attached.
4. Skill-bundled MCP lifecycle: activate servers from `skillRuntimeActivation` only when the skill triggers, stop them on cooldown/session end.
5. Skill-bundled toolbox registration: expose described toolbox commands from `skillRuntimeActivation` as governed tools while the skill is active.
6. Public cookbook and conformance fixtures for third-party skill authors.
