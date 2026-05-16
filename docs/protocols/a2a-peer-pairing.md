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
