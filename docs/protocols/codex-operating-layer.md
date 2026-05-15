# Codex Operating Layer

This protocol keeps the long-horizon Codex work honest. Maestro should not only
route to Codex app-server; it should behave like an audited operating layer for
durable EvalOps agents across TypeScript, Rust, web, headless, and live
operator workflows.

The executable evidence map lives at
[`codex-operating-layer.json`](./codex-operating-layer.json). Run it with:

```bash
npm run check:codex-operating-layer
```

## Far-Horizon Success Criteria

- Codex works from a fresh install without silently losing native safety-parser
  behavior.
- Operators can sign in with ChatGPT, inspect status, and run Codex doctor from
  the Maestro CLI.
- TypeScript can run Codex app-server threads with dynamic tools, dynamic-tool
  lifecycle events, approval-gated dynamic callbacks, token usage, subagent
  lifecycle events, and streaming output.
- Rust can expose the same Codex models through the control plane, bridge
  Codex headless runs, stream SSE/WebSocket events, handle approval requests,
  and preserve sandbox policy.
- Durable thread metadata covers goals and memory linkage instead of treating
  Codex runs as disposable one-off calls.
- Eval telemetry and trajectory fixtures can score approvals, child runs,
  recovery, and tool execution without scraping human-readable logs.
- Live verification exercises real Codex inference through the installed CLI,
  not only local mocks.

## Prompt-To-Artifact Checklist

| Requirement | Evidence area | Primary artifacts |
| --- | --- | --- |
| installed by default | `default-install` | `package.json`, `test/install/native-dependencies.test.ts` |
| ChatGPT sign-in | `chatgpt-sign-in` | `src/cli/commands/codex.ts`, `test/cli/codex-command.test.ts` |
| dynamic tools | `dynamic-tools` | `src/codex/compatibility.ts`, `src/agent/providers/codex-app-server.ts`, `test/codex/compatibility.test.ts`, `test/agent/codex-app-server.test.ts` |
| durable threads, goals, memory | `durable-threads-goals-memory` | `src/session/types.ts`, `test/app-server/session-api.test.ts` |
| approvals and sandbox policy | `approvals-sandbox-policy` | `src/agent/transport.ts`, `test/agent/provider-transport-provider-tools.test.ts`, `packages/control-plane-rs/src/main.rs`, `docs/protocols/pending-requests.md` |
| subagents | `subagents` | `src/agent/providers/codex-app-server.ts`, `test/agent/provider-transport-provider-tools.test.ts` |
| realtime streaming | `realtime-streaming` | `src/server/handlers/runtime-app-server-ws.ts`, `test/server/runtime-app-server-ws.test.ts` |
| TypeScript runtime | `typescript-runtime` | `src/agent/providers/codex-app-server.ts`, `test/agent/codex-app-server.test.ts` |
| Rust runtime | `rust-control-plane` | `packages/control-plane-rs/src/model_catalog.rs`, `packages/control-plane-rs/src/main.rs` |
| eval telemetry | `eval-telemetry` | `docs/protocols/agent-trajectory.md`, `test/telemetry/maestro-publisher-conformance-fixture.test.ts` |
| operator UX and docs | `operator-ux-docs` | `docs/protocols/codex-operating-layer.md`, `docs/MODELS.md` |
| live environment proof | `live-verification` | `scripts/smoke-codex-app-server-live.mjs`, `package.json` |

## Operator Verification Path

Use the fast gate while editing:

```bash
npm run check:codex-operating-layer
npm run check:codex-parity
```

Use the runtime gate before merging changes that affect Codex execution:

```bash
npm test -- test/agent/codex-app-server.test.ts test/agent/provider-transport-provider-tools.test.ts test/codex/app-server-client.test.ts test/codex/compatibility.test.ts test/cli/codex-command.test.ts test/scripts/codex-operating-layer-conformance.test.ts test/scripts/codex-parity-conformance.test.ts test/server/runtime-app-server-ws.test.ts test/headless/runtime-conformance.test.ts
cargo test codex_ --no-default-features
npm run smoke:codex-app-server-live
```

## Completion Bar

The operating-layer goal is not complete just because this manifest passes. This
manifest is the prompt-to-artifact checklist that prevents drift. Completion
still requires a fresh audit showing every area is covered by real code, tests,
operator documentation, PR review, merge state, and live evidence from the
current environment.
