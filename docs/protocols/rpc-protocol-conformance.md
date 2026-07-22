# RPC Protocol Conformance

The executable fixture lives at
[`test/fixtures/rpc/protocol-v1.json`](../../test/fixtures/rpc/protocol-v1.json).
It pins the JSON-over-stdio launch and dispatch contract used by embedded clients
and release E2E smokes after the native cutover:

- CLI `--mode rpc` (and headless) routes to `maestro-tui --headless`
- native server dispatch in `packages/tui-rs/src/headless_server.rs`
- typed client launch via `NativeHeadlessClient` (not the removed TS `RpcClient`)
- headless protocol message unions in `src/cli/headless-protocol.ts`
- launcher / runtime tests that keep rpc mode on the native headless path

The historical command catalog in the fixture (`prompt`, `abort`,
`get_messages`, …) remains as a structural gate for the conformance checker.
The live wire protocol is the versioned **headless** contract — see
[headless.md](./headless.md) and
[headless-conformance.md](./headless-conformance.md).

Run the gate with:

```bash
npm run check:rpc-protocol-conformance
```

This check is wired into `lint:evals` so RPC/headless launch drift blocks
release validation before published install and replay smokes depend on it.
