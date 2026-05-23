# A2A Fleet And Delegation

Native A2A pairing makes peers discoverable. The fleet layer turns those peers
into a small, durable operator network: inspect who is available, delegate work,
poll task state, and keep a local transcript of what was asked and what came
back.

## Commands

```sh
maestro a2a fleet [--json] [--registry <path>] [--tasks <path>]
maestro a2a register --url <base-url> [--agent-id <id>] [--workspace-id <id>] [--json]
maestro a2a delegate <peer> <text> [--role <role>] [--cwd <path>] [--wait] [--work-graph]
maestro a2a delegate --platform --from-agent-id <agent-id> [--to-agent-id <agent-id>|--capability <capability>] --skill <skill-id> <text> [--json]
maestro a2a reply <peer> <task-id> <text> [--wait] [--work-graph]
maestro a2a tasks [peer] [--json] [--refresh] [--work-graph]
maestro a2a coordinate [peer] [--json] [--refresh] [--reply <text>] [--wait] [--work-graph]
maestro a2a wait <peer> <task-id> [--work-graph]
```

`fleet` reads the native peer registry, fetches each peer Agent Card when
reachable, and joins the result with the local task ledger. It never prints
bearer token values. Peers that cannot be reached are still shown with their
registry URL and a bounded error.

`register` publishes the current Maestro instance to Platform Agent Registry as
an A2A peer. The registration includes the Rust control-plane Agent Card URL,
HTTP+JSON 1.0 binding, EvalOps operating-plane extension, and the versioned
Codex subagent dispatch lanes (`code-writer`, `code-review`, `test-runner`,
`repo-explorer`, and `release-shepherd`). The command is idempotent when
`--agent-id` is supplied: an existing peer is updated, then heartbeated as
`AGENT_STATUS_IDLE` on the `a2a` surface, so Platform discovery and
capability-based delegation can route work to the peer without extra flags.
Operators can run `--heartbeat-only --agent-id <id>` without a public URL when
they only need to refresh presence for an already registered peer.

Hosted Rust control-plane instances also auto-register when
`MAESTRO_HOSTED_RUNNER_MODE=1` and Platform Agent Registry environment is
present. `MAESTRO_A2A_PLATFORM_REGISTER=0` disables the loop, while
`MAESTRO_A2A_PLATFORM_REGISTER=1` enables it outside hosted mode. The loop uses
the same A2A projection as `maestro a2a register`, updates an existing
`MAESTRO_A2A_AGENT_ID` on conflict, and heartbeats the Agent Card, governed
child-agent skills, current objective IDs, capacity hint, and endpoint URLs on a
bounded interval. Hosted default registration requires `MAESTRO_A2A_PUBLIC_URL`
or `MAESTRO_A2A_PUBLIC_HOST`/`MAESTRO_CONTROL_PUBLIC_HOST` so Platform does not
publish an unroutable local bind address; explicit opt-in can still use local
fallbacks for development. When no workspace ID is configured, the loop falls
back to the organization ID, matching the rest of the Platform client behavior.
Missing Platform configuration leaves local/offline Maestro unchanged.

`delegate` sends a normal A2A `message:send` request with Maestro delegation
metadata: origin, peer name, role, and working directory. The resulting task is
recorded in the local ledger before optional waiting begins. Treat the A2A task
as an operator projection over durable agent/objective/run state rather than as
the run itself: the task id is the protocol handle, `contextId` is the durable
conversation/work envelope, and Maestro stores the peer-local transcript needed
to resume, reply, audit, or wait later.

`delegate --platform` is the production-verifiable path for remote Maestro
work. It submits `agents.v1.AgentService/Delegate` with the coordinator agent,
target agent or capability, A2A skill id, workspace, prompt, role, cwd, and
workflow/objective correlation. Platform returns the delegation record and, when
dispatch is enabled, the remote A2A task id and resume-wait contract. Operators
then use the Platform delegation id with `maestro a2a control` and
`maestro a2a graph`, so the same durable handle joins registry discovery,
remote task control, subagent lineage, trace spans, artifacts, and later signed
evidence bundles.

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

## Remote Swarm Transport

Maestro swarm execution can now use A2A as the teammate transport instead of
spawning every teammate as a local subprocess. Set `transport: "a2a"` in the
swarm config or export `MAESTRO_SWARM_TRANSPORT=a2a`. The coordinator formats
the same delegation prompt used for local teammates, sends it through
`message:send` with `returnImmediately=true`, records the remote task in the
local A2A ledger, polls `GET /tasks/{id}` until the peer reaches a terminal A2A
state, then maps the final artifact text back into the swarm task result.
When `a2a.pushNotificationConfig` or `MAESTRO_SWARM_A2A_PUSH_URL` is configured,
the coordinator also sends a task push-notification config with the A2A request
so peers can deliver progress, artifact, and terminal task callbacks while the
polling loop remains the retry/resume fallback. Callback tokens are redacted
from exposed swarm state and event snapshots.

Static peer routing uses the local A2A peer registry:

```sh
MAESTRO_SWARM_TRANSPORT=a2a \
MAESTRO_SWARM_A2A_PEERS=mac-mini,dev-desktop \
MAESTRO_SWARM_A2A_TASKS=~/.maestro/a2a/tasks.json \
maestro swarm run plan.md
```

Platform discovery uses Agent Registry candidates instead of a local peer list:

```sh
MAESTRO_SWARM_TRANSPORT=a2a \
MAESTRO_SWARM_A2A_DISCOVER=1 \
MAESTRO_SWARM_A2A_WORKSPACE_ID="$EVALOPS_WORKSPACE_ID" \
MAESTRO_SWARM_A2A_SKILL_ID=maestro.subagent.code-review \
MAESTRO_SWARM_A2A_PREFER_INTERNAL=1 \
maestro swarm run plan.md
```

For a host-local proof of the full Maestro loop, run:

```sh
npm run smoke:a2a-local-swarm
```

The smoke starts a mock Agent Registry plus two real Rust control-plane
instances, waits for both peers to auto-register and heartbeat, runs the swarm
executor through Platform-style discovery, verifies both peers complete remote
A2A tasks, receives push status/artifact/task callbacks for both remote tasks,
checks the durable ledger captured normalized subagent work graphs, resumes one
task by `message.taskId`, and checks that a denied task class returns zero
eligible candidates before dispatch.

Platform-discovered peers are ranked by the A2A capability market
(`evalops.maestro.a2a-capability-market.v1`) before selection. The ranking
prefers exact skill matches, idle/online and freshly heartbeated agents,
internal endpoints when requested, push-notification support, declared approval
policies, and required artifact contracts. Peers whose advertised skills deny
the requested task class or cannot satisfy required context/artifact grants are
excluded before round-robin selection. `maestro a2a delegate --discover` uses
the same selector and prints the score reasons beside the imported peer.

Task-level overrides let the planner pin a specific peer or A2A skill with
`a2aPeer` and `a2aSkillId`. With Platform discovery, `a2aPeer` matches the
candidate agent id, agent name, A2A endpoint, or Agent Card URL before the
capability-market ranking. Otherwise Maestro round-robins across configured or
ranked discovered peers and maps Codex subagent lanes to advertised A2A skill
ids such as `maestro.subagent.code-writer`, `maestro.subagent.code-review`,
`maestro.subagent.test-runner`, `maestro.subagent.repo-explorer`, and
`maestro.subagent.release-shepherd`.

Every remote swarm task carries native A2A plus EvalOps operating-plane
metadata: `requestKind=maestro-swarm-task`, `transport=a2a`, `swarmId`,
`teammateId`, `taskId`, `relayPeer`, `a2aSkillId`, `evalops.swarm` lineage, and
`evalops.subagentRequest`. This gives Platform enough correlation to show a
root swarm, child delegations, remote task ids, and artifacts as one fleet-scale
work graph rather than disconnected peer transcripts. Terminal states other
than `TASK_STATE_COMPLETED`, including `INPUT_REQUIRED` or `AUTH_REQUIRED`, are
kept as failed swarm tasks so the coordinator/operator can follow up instead of
treating blocked remote work as successful.

When a swarm is cancelled after a remote task has been accepted, Maestro keeps
the non-secret peer/task/message correlation on the teammate state and sends the
spec-native `POST /tasks/{id}:cancel` request to the remote peer before clearing
local active-task bookkeeping.

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
POST /tasks/{id}/pushNotificationConfigs
GET  /tasks/{id}/pushNotificationConfigs
GET  /tasks/{id}/pushNotificationConfigs/{configId}
DELETE /tasks/{id}/pushNotificationConfigs/{configId}
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
advertises `capabilities.streaming=true`, `capabilities.pushNotifications=true`,
and authenticated extended-card support. The extended card declares Maestro's
EvalOps operating-plane extension for workspace/session/trace/retention
correlation metadata.

`A2A-Extensions` and `message.extensions` are accepted for the EvalOps
operating-plane extension URI:

```text
https://evalops.com/a2a/extensions/operating-plane/v1
```

Requests that ask Maestro to use unknown extensions fail before a task is
created. That keeps mixed fleets explicit: peers can detect when they are using
only core A2A versus EvalOps-specific workspace, trace, approval, and retention
correlation.

Push notification configs are stored with the task metadata in the same durable
ledger. Maestro POSTs A2A `StreamResponse` payloads to each configured callback
whenever a task state is published: a `statusUpdate` for every state publish,
plus terminal `artifactUpdate` and final `task` payloads when artifacts/final
state are available. Production callbacks should use HTTPS and public addresses;
local development can opt into insecure/private callback URLs with
`MAESTRO_A2A_PUSH_ALLOW_INSECURE=1` and
`MAESTRO_A2A_PUSH_ALLOW_PRIVATE=1`. `MAESTRO_A2A_PUSH_TIMEOUT_MS` bounds callback
delivery, and `MAESTRO_A2A_PUSH_DISABLE_DELIVERY=1` leaves configs stored without
dispatching callbacks.

## EvalOps Suite Integration

The current suite split is deliberate:

- Maestro owns the operator-native A2A peer surface: pairing, delegation, task
  transcript, streaming, push callback dispatch, extension negotiation, and
  publishing its Codex subagent lanes into Platform Agent Registry.
- Platform owns hosted AgentRuntime, AgentRun/Objective identity, task
  projection, workspace auth, and CloudEvents/trace joins.
- Deploy owns release-smoke and observability gates for the hosted A2A path:
  dashboards, alerts, smoke agents, and promotion checks.
- Cerebro should consume the same low-cardinality Platform events for analytics
  rather than reading Maestro's local ledger directly.
- Conductor remains a browser-control capability behind Maestro/Platform
  receipts; it should surface as task artifacts and tool evidence, not as a
  separate A2A peer protocol.

The next cross-repo integration should promote registry-published Maestro peers
into fully remote work envelopes: Platform work graph records should share the
same `contextId`, `taskId`, trace, workspace, and artifact metadata as the A2A
task, while Deploy smokes prove two production-like Maestro instances can
register, discover, delegate, resume/wait, and expose child-agent work after
target restart. Push callbacks then become the async wakeup path for clients
that cannot keep SSE subscriptions open.

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

maestro a2a register \
  --url "$BASE_URL" \
  --agent-id local-maestro-a2a-smoke \
  --workspace-id "$EVALOPS_WORKSPACE_ID" \
  --json \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s);if(!j.a2a?.skills?.some(s=>s.id==="maestro.subagent.code-review"))process.exit(1);})'

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
- TypeScript and Rust TUIs both recognize `/a2a fleet`, `/a2a register`,
  `/a2a tasks`, `/a2a tasks --work-graph`, `/a2a delegate`, `/a2a reply`, and
  `/a2a coordinate --work-graph`.
