---
name: maestro-headless-protocol-testing
description: Use when verifying Maestro headless protocol behavior (Hello/HelloOk version negotiation, stdio `--headless`, hosted runner HTTP) against a real built binary, including from the Platform side.
---

# Maestro headless protocol testing against a real binary

Fixtures and unit tests do not prove the wire handshake. Drive the real binary.

## Build the binary

```bash
cd <maestro-internal>
cargo +1.95.0 build -p maestro     # target/debug/maestro
```

The default toolchain may be too old to parse `edition2024` dependencies; if `cargo build` fails with
an edition/parse error, pin a newer toolchain (`rustup toolchain install 1.95.0`) rather than editing
manifests. A debug build is enough for every smoke below — no release build required.

## Drive the stdio handshake directly

```bash
printf '%s\n%s\n' \
  '{"type":"hello","protocol_version":"<version>","client_info":{"name":"t","version":"1"},"role":"controller"}' \
  '{"type":"shutdown"}' | target/debug/maestro --headless
```

Expected shape: a `ready` line, then `hello_ok`, then `status: shutting down`. Key semantics to
assert (they are easy to get backwards). Client-version *rejection* arrives with
[#3279](https://github.com/evalops/maestro-internal/pull/3279); before that change every announced
version, including a placeholder, handshakes successfully:

- `ready.protocol_version` and `hello_ok.protocol_version` always report the agent's own
  `HEADLESS_PROTOCOL_VERSION` (see `packages/tui-rs/src/headless/generated_protocol.rs`).
- The client's announced version comes back separately as `hello_ok.client_protocol_version`.
- A `hello` with no `protocol_version` is accepted.
- An unsupported version yields `{"type":"error","fatal":true,"error_type":"protocol"}` and the stdio
  loop ends, so a following `init`/`prompt` on stdin is never served. Always append `init` + `prompt`
  to the rejection case and assert no `status`/`response_*` follows.

To prove a negotiation change is real, build the merge-base commit in a throwaway worktree with a
separate `CARGO_TARGET_DIR` and feed it the same input; remove the worktree afterwards
(`git worktree remove --force`).

## Hosted runner HTTP surface

```bash
mkdir -p /tmp/ws
MAESTRO_HOME=/tmp/hr-home MAESTRO_HOSTED_RUNNER_AUTH_TOKEN=testtoken \
  target/debug/maestro hosted-runner --host 127.0.0.1 --port 8793 --runner-session-id smoke-runner \
  --workspace-root /tmp/ws --agent-cli-path <path to the same maestro binary>
```

Gotchas, in the order they bite:

1. It refuses to start without `MAESTRO_HOSTED_RUNNER_AUTH_TOKEN` (or `MAESTRO_WEB_API_KEY`).
2. It refuses to start without `--agent-cli-path` ("Failed to spawn agent: No such file or directory").
3. `POST /api/headless/sessions/<id>/messages` returns 403 `access_denied`
   ("requires a private subscription") unless you pass a subscription. Create the connection *via*
   `POST /api/headless/sessions/<id>/subscribe` (not `/connections`) on a fresh runner — a connection
   made through `/connections` first becomes a "legacy connection" that `/subscribe` then rejects, and
   the controller lease is already taken. Restart the runner if you wedge it.
4. Send messages with headers `authorization: Bearer <token>`,
   `x-maestro-headless-connection-id`, `x-maestro-headless-subscription-id`.

The HTTP 501 `unsupported_capability` assertion for an unsupported client
protocol version requires [#3279](https://github.com/evalops/maestro-internal/pull/3279),
or an equivalent build that validates the hosted handshake. Before that change,
the hosted runner records the announced version and accepts the request, so do
not use the 501 assertion against a pre-#3279 binary.

## Release smoke

```bash
npm run smoke:release-native-only -- target/debug/maestro
```
Works against a debug binary. It used to announce a hardcoded `"1.2"`;
[#3279](https://github.com/evalops/maestro-internal/pull/3279) changes it to parse
`HEADLESS_PROTOCOL_VERSION` out of `packages/tui-rs/src/headless/generated_protocol.rs`, because a
placeholder version fails once the agent validates client versions. Any other client fixture that
hardcodes a version (e.g. `test/fixtures/rust-cutover/headless-requests.jsonl`) has the same
problem.

## Platform side

From the Platform checkout, the smoke skips silently unless `MAESTRO_BIN` is set:

```bash
MAESTRO_BIN=<abs path to maestro> python3 scripts/test-dex-maestro-headless-smoke.py
python3 scripts/dex-maestro-headless-smoke.py --maestro-bin <abs path to maestro>
```
Confirm the unittest prints `Ran 1 test ... OK` with a `.` (not `s`) — a skip looks like a pass at a
glance. The direct script prints JSON evidence; assert `"status":"passed"` and
`"sensitive_marker_exposed": false`. It runs a local fake OpenAI server, so no API key is needed.

## Devin Secrets Needed

None. All of the above runs offline with synthetic tokens.
