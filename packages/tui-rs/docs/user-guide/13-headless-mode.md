# Headless Mode

Use Maestro without the full interactive TUI for scripting, CI, and embedding. Protocol reference: [Headless protocol](../../../../docs/protocols/headless.md).

---

## One-shot / print mode

Native print path (interactive binary, non-interactive output):

```bash
maestro "summarize package.json" --mode text
maestro "summarize package.json" --mode json
```

Non-TTY pipes and `maestro exec "…"` flows dispatch to the native print path. Structured output options such as `--output-schema` are owned by the Rust runtime.

```bash
# Direct native binary
maestro --print "list the top-level modules"
```

---

## JSON / RPC modes

```bash
maestro --mode json "…"
maestro --mode rpc "…"
maestro --mode headless "…"
```

Headless transport rules:

- **stdin**: one JSON object per line into Maestro
- **stdout**: one JSON object per line to the client
- **stderr**: diagnostics only (not protocol)

Protocol is versioned (see `ready` / `hello_ok` / `hello`). Treat unknown fields as additive; reject unknown message `type` values unless your client intentionally ignores them.

Current documented protocol version: `2026-08-01` (confirm against generated contracts when integrating).

---

## Multi-turn history seed

Send prior turns on `init` so the native agent has real conversation history
(not just an `append_system_prompt` blob):

```json
{"type":"init","history":[
  {"role":"user","content":"What is 2+2?"},
  {"role":"assistant","content":"4"}
]}
```

`role` is `user`, `assistant`, or `system`. History is applied via
`NativeAgent::replace_history` before the first `prompt`.

---

## Approvals in headless

Default approval behavior fails closed for high-risk tools in non-interactive contexts. Prefer:

```bash
maestro --approval-mode auto "…"   # trusted CI only
# or
export MAESTRO_APPROVAL_MODE=fail
```

Use sandboxes for untrusted repos: `--sandbox docker` / `MAESTRO_SANDBOX_MODE=docker`.

---

## Sessions in automation

```bash
maestro --no-session "ephemeral task"
maestro --session /path/to/session.jsonl "continue this work"
```

---

## Hosted runner / remote attach

Hosted continuity uses `maestro hosted-runner` and Platform attach fencing endpoints under `/.well-known/evalops/remote-runner/…`. See the headless protocol doc and [Hosted Runner Contract](../../../../docs/protocols/hosted-runner-contract.md).

---

## Related CLI helpers

Native early-exit subcommands (no full Node agent bootstrap):

```bash
maestro status
maestro cost
maestro sessions
maestro hooks
```
