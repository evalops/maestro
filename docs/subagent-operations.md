# Subagent operations

Maestro's native subagent runtime provides governed delegation with durable
records. A child is always assigned a role (`explore`, `plan`, `code`, or
`review`); read-only roles receive only read/search/diagnostic tools, while the
`code` role can use the normal editing tools. Child runs cannot recursively
spawn or control other subagents.

## Profiles and budgets

Specialist profiles live in `.maestro/agent-profiles/*.md` for a workspace or
`~/.maestro/agent-profiles/*.md` for a user. Trusted plugins may provide an
`agents/` directory (or a manifest `agents` path). Spawn with `profile`, and
the profile's prompt, model, and tool list are recorded with the child.

`spawn_subagent` accepts `timeout_ms` and `max_tokens`. Defaults are two hours
and 16,384 tokens; values are bounded at 24 hours and 131,072 tokens. Set
`MAESTRO_MAX_RUNNING_SUBAGENTS` to cap concurrent children (default four,
maximum 32). Queued, running, completed, failed, cancelled, timed-out, and
interrupted states are durable and queryable.

## Lifecycle and worktrees

The parent receives a lifecycle notification when a child reaches a terminal
state. Use `inspect_subagent` to view worktree status and diff statistics, and
`cleanup_subagent` (approval required) to remove a terminal child's registered
worktree safely. Shared children (`isolation=shared`) have no worktree; cleanup
is a no-op and does **not** set `worktree_cleaned`, so `resume_subagent` remains
valid. Isolated children that have been cleaned cannot be resumed—spawn a new
child instead. A restart marks orphaned queued/running records as
`interrupted`; `resume_subagent` can continue them after revalidation under the
execution lease.

## Skills, plugins, and hooks

Skills with matching triggers are automatically activated at prompt submission
unless their frontmatter sets `disable-model-invocation: true`; activation is
capped at three skills per prompt. Plugins can package skills, agents,
commands, hooks, and MCP configuration, with each capability independently
trust-gated. Trusted command and HTTP hooks receive serialized event input and
must return a bounded, compatible block/modify/context response.

The `Agents` capability defaults **off** for legacy `plugin-state.json` files
that predate it. Grant it explicitly (`maestro plugins` / capability toggles)
before a plugin's `agents/` directory is loaded.

### Codex-native governance

When a child uses an `openai-codex/*` model:

- Yolo still starts Codex with `approvalPolicy: on-request` so Maestro
  intercepts `commandExecution` and `fileChange` approvals.
- Approvals are checked against the active tool allowlist, policy hooks, and
  the action firewall. Multi-path and legacy `fileChanges` payloads are fully
  enumerated; unknown/itemId-only shapes fail closed unless paths were
  previously observed for that item id.
- A PreToolUse rewrite is treated as a denial (Codex cannot accept rewritten
  approval parameters).

### Observability

Useful signals when operating or debugging subagents:

| Signal | Meaning |
|--------|---------|
| Subagent lifecycle event status | Queued / running / completed / failed / cancelled / timed out / interrupted |
| Codex-native decline reason | Policy hook, action firewall, tool allowlist, or read-only sandbox |
| StopFailure hook log line | Provider stream failed without a recoverable completion |
| SessionEnd `turnCount` | Completed turns in the session (incremented only on successful turns) |
| Hook log `sessionId` | Bare session uuid (not `session:` routing scope) for parent correlation |

Dispatch coverage for wired hook events is enforced by
`npm run check:hook-dispatch` (see `scripts/check-hook-dispatch-coverage.mjs`).
