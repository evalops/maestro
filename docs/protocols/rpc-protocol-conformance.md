# RPC Protocol Conformance

> **Status:** This document predates the Rust-only runtime migration (#3016, #3017, merged 2026-07-22), which deleted Maestro's TypeScript agent runtime and SDK. RPC/headless dispatch now lives in `packages/tui-rs`; the referenced TS file is gone. Some file paths below may be stale; they are kept for design context and updated only where a corresponding Rust module was confirmed.


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
