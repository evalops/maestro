# A2A Fleet And Delegation

Native A2A pairing makes peers discoverable. The fleet layer turns those peers
into a small, durable operator network: inspect who is available, delegate work,
poll task state, and keep a local transcript of what was asked and what came
back.

## Commands

```sh
maestro a2a fleet [--json] [--registry <path>] [--tasks <path>]
maestro a2a delegate <peer> <text> [--role <role>] [--cwd <path>] [--wait]
maestro a2a reply <peer> <task-id> <text> [--wait]
maestro a2a tasks [peer] [--json] [--refresh]
maestro a2a wait <peer> <task-id>
```

`fleet` reads the native peer registry, fetches each peer Agent Card when
reachable, and joins the result with the local task ledger. It never prints
bearer token values. Peers that cannot be reached are still shown with their
registry URL and a bounded error.

`delegate` sends a normal A2A `message:send` request with Maestro delegation
metadata: origin, peer name, role, and working directory. The resulting task is
recorded in the local ledger before optional waiting begins.

`reply` continues an existing remote A2A task by sending `message.taskId` and
the durable ledger `contextId` when available. It appends the operator's reply
to the same local transcript and can wait for the peer's follow-up result.

`tasks` reads the durable ledger and can refresh known task IDs from their
registered peers. This gives the operator a single place to see outstanding work
across the Mac mini, dev desktop, and local Maestro instances.

## Native Control-Plane Surface

The Rust control-plane A2A server uses the same task ledger path as the CLI. On
startup it restores known tasks from the ledger, and each task state transition
is written back to disk before being published to local subscribers.

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
`includeArtifacts`. List responses include `nextPageToken`, `pageSize`, and
`totalSize`.

`POST /message:stream` and `tasks/{id}:subscribe` use Server-Sent Events with A2A
`StreamResponse` payloads (`task`, `statusUpdate`, and `artifactUpdate`). The
public Agent Card advertises streaming plus authenticated extended-card support,
and the extended card declares Maestro's EvalOps operating-plane extension for
workspace/session/trace/retention correlation metadata.

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

## Acceptance Tests

Before this feature, the following tests fail:

```sh
npm run test:fast -- test/cli/commands/a2a-fleet-delegation.test.ts test/cli-tui/commands/a2a-handlers.test.ts
npm run test:fast -- test/cli/commands/a2a.test.ts test/platform/a2a-task-ledger.test.ts
cargo test -p maestro-tui commands::registry::tests::a2a_command_parses_peer_actions
```

After implementation, they must pass and prove:

- `maestro a2a delegate <peer> <text> --wait` sends real HTTP+JSON A2A traffic,
  records the task, updates the final state, and stores a transcript.
- `maestro a2a reply <peer> <task-id> <text> --wait` sends a follow-up message
  with the original task id and context id, appends to the same transcript, and
  does not mark `INPUT_REQUIRED` or `AUTH_REQUIRED` tasks as completed.
- `maestro a2a fleet --json` shows peer health, Agent Card capabilities, and the
  peer's most recent ledger task without leaking token values.
- `maestro a2a tasks --json` reads the ledger and can be used as a fleet task
  view.
- TypeScript and Rust TUIs both recognize `/a2a fleet`, `/a2a tasks`,
  `/a2a delegate`, and `/a2a reply`.
