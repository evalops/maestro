# A2A Fleet And Delegation

Native A2A pairing makes peers discoverable. The fleet layer turns those peers
into a small, durable operator network: inspect who is available, delegate work,
poll task state, and keep a local transcript of what was asked and what came
back.

## Commands

```sh
maestro a2a fleet [--json] [--registry <path>] [--tasks <path>]
maestro a2a delegate <peer> <text> [--role <role>] [--cwd <path>] [--wait] [--work-graph]
maestro a2a reply <peer> <task-id> <text> [--wait] [--work-graph]
maestro a2a tasks [peer] [--json] [--refresh] [--work-graph]
maestro a2a coordinate [peer] [--json] [--refresh] [--reply <text>] [--wait] [--work-graph]
maestro a2a wait <peer> <task-id> [--work-graph]
```

`fleet` reads the native peer registry, fetches each peer Agent Card when
reachable, and joins the result with the local task ledger. It never prints
bearer token values. Peers that cannot be reached are still shown with their
registry URL and a bounded error.

`delegate` sends a normal A2A `message:send` request with Maestro delegation
metadata: origin, peer name, role, and working directory. The resulting task is
recorded in the local ledger before optional waiting begins. Treat the A2A task
as an operator projection over durable agent/objective/run state rather than as
the run itself: the task id is the protocol handle, `contextId` is the durable
conversation/work envelope, and Maestro stores the peer-local transcript needed
to resume, reply, audit, or wait later.

`reply` continues an existing remote A2A task by sending `message.taskId` and
the durable ledger `contextId` when available. It appends the operator's reply
to the same local transcript and can wait for the peer's follow-up result.

`tasks` reads the durable ledger and can refresh known task IDs from their
registered peers. This gives the operator a single place to see outstanding work
across the Mac mini, dev desktop, and local Maestro instances.

When a peer exposes Platform A2A `metadata.workGraph`, Maestro stores a
sanitized work graph with counts and IDs for active items, blocked items, child
runs, tool executions, waits, the correlation path, and `codexSubagents`
edges. Human task views show the compact summary by default; `--work-graph`
also shows Codex child-run/tool/thread IDs and the correlation breadcrumb. JSON
views include the normalized `workGraph` object for automation.

`coordinate` is the operator loop for actionable fleet work. It refreshes
non-final ledger tasks from their registered peers, filters the tasks that need
operator action such as `INPUT_REQUIRED` or `AUTH_REQUIRED`, and renders the
peer, task id, state, prompt, and next command. With `--reply <text>`, it replies
to the selected actionable task using the task id and durable `contextId`. Add
`--wait` when you want the command to refresh the ledger again and show whether
the task moved forward or still needs operator input. If more than one actionable
task matches the requested scope, use `maestro a2a reply <peer> <task-id> <text>`
to choose the task explicitly.

## Native Control-Plane Surface

The Rust control-plane A2A server uses the same task ledger path as the CLI. On
startup it restores known tasks from the ledger, and each task state transition
is written back to disk before being published to local subscribers.

The CLI ledger is a JSON object with a top-level `tasks` array. Each entry keeps
the local ledger id, peer name, remote `taskId`, optional `contextId` and
`messageId`, current A2A `state`, operator request text, optional role/cwd,
latest response text, transcript entries, metadata, and created/updated/completed
timestamps. The ledger deliberately stores peer/task correlation and transcript
shape, not bearer token material.

Supported A2A HTTP+JSON operations:

```text
GET  /.well-known/agent-card.json
GET  /extendedAgentCard
POST /message:send
POST /message:stream
GET  /tasks
GET  /tasks/{id}
GET  /tasks/{id}:subscribe
POST /tasks/{id}:subscribe
POST /tasks/{id}:cancel
```

`GET /tasks` accepts the spec-shaped fleet filters `contextId`, `status`,
`statusTimestampAfter`, `pageSize`, `pageToken`, `historyLength`, and
`includeArtifacts`. The implementation also accepts snake_case aliases
(`context_id`, `page_size`, `page_token`, `status_timestamp_after`,
`history_length`, and `include_artifacts`) plus `state`, `limit`, `offset`,
`lastUpdatedAfter`, and `last_updated_after` for local operator convenience.
List responses are sorted by newest status timestamp first and include `tasks`,
`nextPageToken`, `pageSize`, and `totalSize`. `includeArtifacts=false` is the
default; `historyLength=0` suppresses history in list responses.

`POST /message:stream`, `GET /tasks/{id}:subscribe`, and
`POST /tasks/{id}:subscribe` use Server-Sent Events with A2A `StreamResponse`
payloads (`task`, `statusUpdate`, and `artifactUpdate`). Subscribe is for
nonterminal work; terminal tasks should be read with `GET /tasks/{id}` and must
not be treated as a replayable subscription stream. The public Agent Card
advertises `capabilities.streaming=true` plus authenticated extended-card
support, and the extended card declares Maestro's EvalOps operating-plane
extension for workspace/session/trace/retention correlation metadata.

## Files

The peer registry remains:

```text
~/.maestro/a2a/peers.json
```

The task ledger defaults to:

```text
~/.maestro/a2a/tasks.json
```

`MAESTRO_A2A_TASKS_FILE` overrides the ledger path. `CODEX_A2A_TASKS_FILE` is
accepted as a migration alias.

## Operator Verification

Use bounded one-shot checks against a local control-plane peer:

```sh
BASE_URL=http://127.0.0.1:18787
TASK_ID=<task-id-from-delegate-or-send>
CONTEXT_ID=<context-id-from-task-detail>

curl -fsS "$BASE_URL/.well-known/agent-card.json" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s);if(j.capabilities?.streaming!==true)process.exit(1);})'

curl -fsS "$BASE_URL/tasks?status=TASK_STATE_COMPLETED&pageSize=1&pageToken=0&historyLength=1&includeArtifacts=false"
curl -fsS "$BASE_URL/tasks?contextId=$CONTEXT_ID&pageSize=1&includeArtifacts=false"
curl -fsS --max-time 10 \
  -H 'Content-Type: application/json' \
  -d '{"message":{"messageId":"operator-smoke","contextId":"operator-smoke-context","role":"ROLE_USER","parts":[{"text":"stream smoke","mediaType":"text/plain"}]}}' \
  "$BASE_URL/message:stream" \
  | rg '"statusUpdate"|"artifactUpdate"'
```

For the full local harness, run:

```sh
bash scripts/smoke-maestro-a2a-tmux.sh
```

## Acceptance Tests

Before this feature, the following tests fail:

```sh
npm run test:fast -- test/cli/commands/a2a-fleet-delegation.test.ts test/cli-tui/commands/a2a-handlers.test.ts
npm run test:fast -- test/cli/commands/a2a.test.ts test/platform/a2a-task-ledger.test.ts
cargo test -p maestro-tui commands::registry::tests::a2a_command_parses_peer_actions
npm run smoke:a2a-input-required
```

After implementation, they must pass and prove:

- `maestro a2a delegate <peer> <text> --wait` sends real HTTP+JSON A2A traffic,
  records the task, updates the final state, and stores a transcript.
- `maestro a2a reply <peer> <task-id> <text> --wait` sends a follow-up message
  with the original task id and context id, appends to the same transcript, and
  does not mark `INPUT_REQUIRED` or `AUTH_REQUIRED` tasks as completed.
- `npm run smoke:a2a-input-required` launches `scripts/codex-a2a-bridge.py` on a
  random localhost port with `CODEX_A2A_FIXTURE_MODE=input-required-once`,
  writes isolated `peers.json` and `tasks.json`, delegates with `--wait`, replies
  with `--wait`, and proves the same `taskId`/`contextId` moves
  `INPUT_REQUIRED` to `COMPLETED` with a four-turn transcript:
  user request, agent question, user reply, agent final.
- `maestro a2a fleet --json` shows peer health, Agent Card capabilities, and the
  peer's most recent ledger task plus any normalized Platform work graph without
  leaking token values.
- `maestro a2a tasks --json` reads the ledger and can be used as a fleet task
  view with the normalized `workGraph` object when a peer exposes it.
- TypeScript and Rust TUIs both recognize `/a2a fleet`, `/a2a tasks`,
  `/a2a tasks --work-graph`, `/a2a delegate`, `/a2a reply`, and
  `/a2a coordinate --work-graph`.
