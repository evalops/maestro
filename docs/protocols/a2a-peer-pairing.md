# A2A Peer Pairing

Maestro peers pair by exchanging a short-lived `maestro-pair-v1` code. The code
is a bootstrap voucher, not a secret: it carries the peer display name, Agent
Card URL, selected A2A transport URL, protocol binding/version, expiry,
capability summary, and optional key fingerprint. It never embeds bearer tokens,
API keys, or arbitrary credentials.

## Flow

On the machine exposing an A2A endpoint:

```sh
maestro a2a offer --url http://mac-mini.tailnet.ts.net:18787 --name mac-mini --peer-id mac-mini
```

Share the printed `maestro-pair-v1...` code with the machine that should call
it. On the receiving machine:

```sh
maestro a2a accept 'maestro-pair-v1.<payload>.<checksum>' --name mac-mini --default
maestro a2a peers
maestro a2a send mac-mini "Review this branch and report the top risk" --wait
```

If the peer requires auth, attach an auth source while accepting the code:

```sh
maestro a2a accept 'maestro-pair-v1.<payload>.<checksum>' --name mac-mini --token-env MAC_MINI_A2A_TOKEN
```

Token values stay outside the pairing code and outside the registry. The
registry stores only `tokenEnv` or `tokenFile` references.

## Local tmux smoke

Use the tmux smoke when changing native A2A pairing or registry behavior:

```sh
bash scripts/smoke-maestro-a2a-tmux.sh
```

The smoke launches two local Maestro peers in tmux, exchanges native pairing
codes, accepts each peer into isolated registries, delegates work into a durable
task ledger, then verifies `fleet`, `tasks`, `send`, and explicit `wait`. See
[A2A tmux smoke](./a2a-tmux-smoke.md) for the harness contract and
troubleshooting knobs.

The smoke proves local A2A transport and registry behavior only. It is not
production evidence that two remote Maestro instances communicated through
Platform.

## Platform Agent Registry

Fleet-scale Maestro A2A uses Platform as the shared control plane. Each remote
Maestro publishes its Agent Card projection to `agents.v1.AgentService`, keeps
presence fresh with heartbeats, discovers eligible peers through Platform, and
can receive fenced task-control commands through the same registry surface.

Configure the Platform Agent Registry client with:

```sh
export MAESTRO_AGENT_REGISTRY_SERVICE_URL=https://platform.example.com
export MAESTRO_AGENT_REGISTRY_SERVICE_TOKEN=...
export MAESTRO_AGENT_REGISTRY_ORG_ID=org_...
export MAESTRO_AGENT_REGISTRY_WORKSPACE_ID=ws_...
```

Publish a Maestro instance from its reachable A2A endpoint:

```sh
maestro a2a register \
  --url https://worker-a.example.com \
  --agent-id maestro-worker-a \
  --capabilities code:write,code:review,a2a:task \
  --surface maestro,a2a
```

Discover eligible remote peers for a skill:

```sh
maestro a2a discover \
  --capability code:review \
  --skill maestro.subagent.code-review \
  --import
```

Delegate through the discovered Platform peer:

```sh
maestro a2a delegate \
  --discover \
  --skill maestro.subagent.code-review \
  "Review this branch and return the highest-risk finding"
```

Control a remote Platform A2A delegation task or one of its child/subagent
lanes:

```sh
maestro a2a control delegation_123 \
  --mode interrupt \
  --target-run-id run_remote_123 \
  --child-run-id run_child_456 \
  --subagent-lane-id lane_review \
  "Pause, re-plan, and continue with the narrower test target"
```

Production proof requires dereferenceable Platform evidence: registered agent
ids, heartbeat timestamps, discovery evidence, delegation id, remote A2A task
id, trace/span ids, returned artifacts, and any downstream GitHub or
deploy-verifier identifiers must resolve to live systems. Deterministic replay
fixtures can prove the schema and message contract, but they must not be
presented as proof of a production run.

## TUI Surface

The TypeScript TUI exposes:

```text
/a2a accept <pairing-code> [--name <peer>] [--default] [--token-env ENV]
/a2a peers
/a2a send <peer> <text>
```

The Rust TUI parses the same `/a2a` command family into native command actions
so the UI can grow a richer registry/send controller without changing the user
command shape.

## Registry

The default registry path is:

```text
~/.maestro/a2a/peers.json
```

`MAESTRO_A2A_PEERS_FILE` can override it. `CODEX_A2A_PEERS_FILE` is still
recognized so existing fleet hosts can migrate without rewriting all local
automation at once.

Entries are deliberately small:

```json
{
  "defaultPeer": "mac-mini",
  "peers": {
    "mac-mini": {
      "url": "http://mac-mini.tailnet.ts.net:18787",
      "agentCardUrl": "http://mac-mini.tailnet.ts.net:18787/.well-known/agent-card.json",
      "displayName": "mac-mini",
      "protocolBinding": "HTTP+JSON",
      "protocolVersion": "1.0",
      "tokenEnv": "MAC_MINI_A2A_TOKEN"
    }
  }
}
```

## Why This Replaces The Python Relay

The Python relay proved the A2A task lifecycle, but it made pairing feel like
external scaffolding: hand-edited peer JSON, a script entrypoint, and a separate
mental model for sends, cards, waits, and cancellation. Native pairing moves the
bootstrap into Maestro itself:

- Pairing uses Agent Cards and selected A2A interfaces directly.
- Sends reuse the TypeScript A2A client (`message:send` plus bounded task
  polling).
- The same registry feeds CLI and TUI surfaces.
- Auth is referenced out-of-band and never printed in normal peer listings.
