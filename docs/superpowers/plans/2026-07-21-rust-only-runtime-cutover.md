# Rust-Only Maestro Runtime Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Rust the only shipped Maestro agent, CLI, and web-backend runtime; delete the internal TypeScript agent SDK and every TypeScript execution fallback while preserving product contracts.

**Architecture:** `packages/tui-rs` remains the reusable agent core. `packages/control-plane-rs` becomes a library-backed HTTP control plane. A new `packages/maestro-rs` package produces the canonical `maestro` binary and dispatches directly into those libraries. TypeScript remains only for browser UI, generated/data-only contracts, and thin service adapters that call Rust.

**Tech Stack:** Rust 2021, Tokio, Serde, existing Maestro native crates, TypeScript contract fixtures, Vitest, Cargo tests, GitHub Actions.

## Global Constraints

- Rust is the only implementation of agent execution, providers, tools, sessions, safety, CLI behavior, and the web backend.
- The browser frontend and thin IDE/chat transport adapters may remain TypeScript but may not construct or execute agents.
- Preserve current HTTP, SSE, WebSocket, headless, session, provider, approval, telemetry, and exit-code contracts.
- Delete TypeScript execution code before implementing replacement behavior; never restore a TS fallback.
- Missing native functionality fails with a typed error.
- No force-push, hook bypass, weakened assertions, deleted coverage without a Rust replacement, or ignored failures.

---

## File Map

- `packages/tui-rs/src/agent/`, `ai/`, `tools/`, `headless/`, `session/`, `safety/`, `telemetry/`: authoritative agent runtime.
- `packages/control-plane-rs/src/lib.rs`: reusable server entrypoint and state construction.
- `packages/control-plane-rs/src/main.rs`: thin `maestro-control-plane` binary wrapper.
- `packages/maestro-rs/src/main.rs`: canonical native `maestro` CLI.
- `packages/contracts/`: generated and data-only TypeScript contracts.
- `packages/slack-agent/src/native-runtime-client.ts`: thin Rust control-plane client; no model/provider/tool execution.
- `test/fixtures/rust-cutover/`: language-neutral compatibility fixtures.
- `scripts/check-rust-only-runtime.mjs`: static no-TS-runtime guard.
- `.github/workflows/`, `scripts/install*`, release scripts, and `package.json`: native-only packaging and CI.

---

### Task 1: Freeze the runtime contracts and add the deletion guard

**Files:**
- Create: `test/fixtures/rust-cutover/cli-routing.json`
- Create: `test/fixtures/rust-cutover/headless-requests.jsonl`
- Create: `test/fixtures/rust-cutover/web-routes.json`
- Create: `test/fixtures/rust-cutover/provider-matrix.json`
- Create: `test/fixtures/rust-cutover/slack-events.json`
- Create: `scripts/check-rust-only-runtime.mjs`
- Create: `test/scripts/rust-only-runtime.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: stable fixture schemas consumed by Rust tests and a repository guard invoked as `npm run check:rust-only-runtime`.

- [ ] **Step 1: Add a failing static-guard test**

```ts
it("rejects executable TypeScript agent runtime code", async () => {
  const result = spawnSync(process.execPath, ["scripts/check-rust-only-runtime.mjs"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
});
```

- [ ] **Step 2: Run the guard test and verify RED**

Run: `npx vitest --run test/scripts/rust-only-runtime.test.ts`

Expected: FAIL listing current `new Agent`, `ProviderTransport`, SDK exports, Node launcher, and TS fallback sites.

- [ ] **Step 3: Add the guard implementation**

```js
const forbidden = [
  /\bnew\s+Agent\s*\(/,
  /\bnew\s+ProviderTransport\s*\(/,
  /\bcreateAgent\s*\(/,
  /MAESTRO_(?:ALLOW_)?TS_AGENT/,
];

const allowedPrefixes = [
  "packages/contracts/",
  "packages/web/",
  "test/fixtures/rust-cutover/",
];
```

The script scans shipped `src/`, `packages/`, `scripts/`, installers, and workflows; reports every file/pattern pair; and exits non-zero while offenders exist.

- [ ] **Step 4: Materialize contract fixtures from current tests**

Record exact CLI route/exit behavior, every `ToAgentMessage` JSON shape, web endpoint method/path/status/header/body shape, provider aliases/auth variables, and Slack stream events. Fixture records use `{ "schemaVersion": 1, "cases": [...] }` and contain no executable TS imports.

- [ ] **Step 5: Run fixture validation and commit**

Run: `npx vitest --run test/scripts/rust-only-runtime.test.ts test/cli/headless.test.ts test/web/chat-handler-routing.test.ts`

Expected: existing contract fixtures pass; static guard remains intentionally red until deletion tasks.

Commit: `test: freeze Rust cutover contracts`

---

### Task 2: Extract the Rust control plane as a library

**Files:**
- Create: `packages/control-plane-rs/src/lib.rs`
- Modify: `packages/control-plane-rs/src/main.rs`
- Modify: `packages/control-plane-rs/src/tests.rs`
- Modify: `packages/control-plane-rs/Cargo.toml`

**Interfaces:**
- Produces: `pub struct ControlPlaneConfig`, `pub async fn serve(config: ControlPlaneConfig) -> anyhow::Result<()>`, and `pub async fn serve_listener(listener: TcpListener, config: ControlPlaneConfig) -> anyhow::Result<()>`.

- [ ] **Step 1: Add failing library-entrypoint tests**

```rust
#[tokio::test]
async fn library_server_serves_health_and_static_assets() {
    let fixture = TestControlPlane::start(ControlPlaneConfig::test_default()).await;
    assert_eq!(fixture.get("/api/health").await.status, 200);
    assert_eq!(fixture.get("/").await.status, 200);
}
```

- [ ] **Step 2: Run and verify RED**

Run: `cargo test --manifest-path packages/control-plane-rs/Cargo.toml library_server_serves_health_and_static_assets`

Expected: FAIL because the package has no library entrypoint.

- [ ] **Step 3: Move server construction behind public library functions**

```rust
pub async fn serve(config: ControlPlaneConfig) -> anyhow::Result<()> {
    config.validate_startup().map_err(anyhow::Error::msg)?;
    let listener = TcpListener::bind(config.listen_addr()).await?;
    serve_listener(listener, config).await
}

pub async fn serve_listener(
    listener: TcpListener,
    config: ControlPlaneConfig,
) -> anyhow::Result<()> {
    let state = AppState::load(Arc::new(config)).await;
    accept_loop(listener, state).await
}
```

`main.rs` becomes argument parsing plus `maestro_control_plane::serve(config).await`.

- [ ] **Step 4: Run control-plane tests and commit**

Run: `cargo test --locked --manifest-path packages/control-plane-rs/Cargo.toml`

Expected: PASS.

Commit: `refactor(control-plane): expose native server library`

---

### Task 3: Add the canonical native `maestro` binary

**Files:**
- Create: `packages/maestro-rs/Cargo.toml`
- Create: `packages/maestro-rs/src/main.rs`
- Create: `packages/maestro-rs/src/cli.rs`
- Create: `packages/maestro-rs/tests/dispatch.rs`
- Modify: `packages/tui-rs/src/lib.rs`
- Modify: `packages/control-plane-rs/src/lib.rs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `maestro_tui::run_cli(Vec<OsString>)` and `maestro_control_plane::serve(ControlPlaneConfig)`.
- Produces: native `maestro` binary supporting help/version, TUI, print/exec/headless, utilities, hosted runner, and web.

- [ ] **Step 1: Add failing dispatch tests from `cli-routing.json`**

```rust
#[test]
fn web_dispatches_to_in_process_control_plane() {
    assert_eq!(classify(["web"]), Command::Web { port: None });
}

#[test]
fn exec_dispatches_to_native_print() {
    assert_eq!(classify(["exec", "hello"]), Command::Agent(AgentMode::Exec));
}
```

- [ ] **Step 2: Run and verify RED**

Run: `cargo test --manifest-path packages/maestro-rs/Cargo.toml`

Expected: FAIL because the package and classifier do not exist.

- [ ] **Step 3: Implement typed dispatch without Node/Bun**

```rust
pub enum Command {
    Web { port: Option<u16> },
    Agent(AgentMode),
    HostedRunner(Vec<OsString>),
    Utility(Vec<OsString>),
    Help,
    Version,
}
```

The `Web` arm calls the control-plane library; all other runtime arms call `maestro-tui` library entrypoints in-process.

- [ ] **Step 4: Run dispatch and smoke tests and commit**

Run: `cargo test --locked --manifest-path packages/maestro-rs/Cargo.toml`

Run: `cargo run --quiet --manifest-path packages/maestro-rs/Cargo.toml -- --version`

Expected: native version output and all dispatch cases pass.

Commit: `feat(cli): add canonical native maestro binary`

---

### Task 4: Complete headless request handling and capability negotiation

**Files:**
- Modify: `packages/tui-rs/src/headless_server.rs`
- Modify: `packages/tui-rs/src/headless/messages.rs`
- Modify: `packages/tui-rs/src/headless/generated_protocol.rs`
- Modify: `packages/tui-rs/src/headless/supervisor.rs`
- Create: `packages/tui-rs/tests/headless_request_parity.rs`

**Interfaces:**
- Produces: an exhaustive `handle_request` result for every `ToAgentMessage`; `HelloOk.capabilities` reflects implemented handlers.

- [ ] **Step 1: Add exhaustive fixture-driven tests**

```rust
#[tokio::test]
async fn every_contract_request_is_handled_or_typed_unsupported() {
    for case in load_jsonl("../../test/fixtures/rust-cutover/headless-requests.jsonl") {
        let events = harness.send(case.request).await;
        assert!(!events.iter().any(|event| event.message.contains("ignored message")));
        assert!(events.iter().any(|event| event.correlates(&case)));
    }
}
```

- [ ] **Step 2: Run and verify RED**

Run: `cargo test --manifest-path packages/tui-rs/Cargo.toml --test headless_request_parity`

Expected: FAIL on client-tool, server-response, utility command/file/watch, and remaining fallback variants.

- [ ] **Step 3: Implement handlers**

Route client-tool and server responses to pending request registries; utility commands to the existing process registry; file search/read to workspace utilities; watch start/stop to a watcher registry. Unknown protocol-version operations return `Error { error_type: Protocol, fatal: false }`.

- [ ] **Step 4: Make matching exhaustive**

Remove the `other =>` ignored-message arm. Match every enum variant explicitly so adding a new request fails Rust compilation until a handler exists.

- [ ] **Step 5: Run protocol suites and commit**

Run: `cargo test --locked --manifest-path packages/tui-rs/Cargo.toml headless`

Run: `npm run check:rpc-protocol-conformance`

Expected: PASS.

Commit: `feat(headless): complete native request parity`

---

### Task 5: Close provider and native command parity

**Files:**
- Modify: `packages/tui-rs/src/ai/client.rs`
- Modify: `packages/tui-rs/src/ai/openai.rs`
- Modify: `packages/tui-rs/src/main.rs`
- Modify: `packages/tui-rs/src/context_cli.rs`
- Modify: `packages/tui-rs/src/run_cli.rs`
- Modify: `packages/tui-rs/src/lsp.rs`
- Create: `packages/tui-rs/tests/provider_matrix.rs`
- Create: `packages/tui-rs/tests/command_parity.rs`

**Interfaces:**
- Consumes: `provider-matrix.json` and existing session/context fixtures.
- Produces: explicit native provider registry and complete `context`, `run`, and LSP behavior.

- [ ] **Step 1: Add failing provider matrix tests**

```rust
#[test]
fn provider_matrix_resolves_auth_and_base_url() {
    for case in provider_cases() {
        let resolved = ProviderRegistry::resolve(&case.model, &case.env).unwrap();
        assert_eq!(resolved.provider, case.provider);
        assert_eq!(resolved.auth_source, case.auth_source);
        assert_eq!(resolved.base_url, case.base_url);
    }
}
```

- [ ] **Step 2: Verify RED for missing providers/compatibility**

Run: `cargo test --manifest-path packages/tui-rs/Cargo.toml --test provider_matrix`

Expected: FAIL for matrix cases not represented by `AiProvider` or native auth/base-URL policy.

- [ ] **Step 3: Implement explicit provider descriptors**

```rust
pub struct ProviderDescriptor {
    pub id: &'static str,
    pub aliases: &'static [&'static str],
    pub auth_env: &'static [&'static str],
    pub default_base_url: Option<&'static str>,
    pub protocol: ProviderProtocol,
}
```

Use descriptors for Anthropic, OpenAI/Codex, Google/Vertex, Azure, OpenRouter, Copilot, Bedrock, Groq, Cerebras, xAI, DeepSeek, Moonshot, Qwen, MiniMax, Z.ai, Mistral, and configured compatible endpoints.

- [ ] **Step 4: Add failing command-parity cases**

Cover context MCP metadata, legacy run entries/derived events/promotion operations, and LSP request/result/error behavior.

- [ ] **Step 5: Implement command parity and remove residual-gap comments**

Reuse native MCP config/auth/trust types, session entry parsers, trajectory event constructors, and LSP client methods; typed errors replace omissions.

- [ ] **Step 6: Run and commit**

Run: `cargo test --locked --manifest-path packages/tui-rs/Cargo.toml --test provider_matrix --test command_parity`

Expected: PASS.

Commit: `feat(runtime): close provider and command parity`

---

### Task 6: Make the Rust control plane the complete web backend

**Files:**
- Modify: `packages/control-plane-rs/src/lib.rs`
- Modify: `packages/control-plane-rs/src/chat.rs`
- Modify: `packages/control-plane-rs/src/sessions.rs`
- Create: `packages/control-plane-rs/src/automations.rs`
- Create: `packages/control-plane-rs/src/background.rs`
- Create: `packages/control-plane-rs/src/migrations.rs`
- Modify: `packages/control-plane-rs/src/tests.rs`
- Create: `packages/control-plane-rs/tests/web_contract.rs`
- Create: `packages/control-plane-rs/tests/legacy_migration.rs`

**Interfaces:**
- Consumes: `web-routes.json`, legacy state fixtures, and `maestro_tui` library APIs.
- Produces: complete backend route parity and atomic legacy migration.

- [ ] **Step 1: Add fixture-driven web route tests**

```rust
#[tokio::test]
async fn rust_control_plane_matches_web_contract() {
    for case in web_cases() {
        let response = fixture.request(case.request).await;
        case.assert_matches(response);
    }
}
```

- [ ] **Step 2: Run and verify RED**

Run: `cargo test --manifest-path packages/control-plane-rs/Cargo.toml --test web_contract`

Expected: FAIL with an exact list of missing routes or response mismatches.

- [ ] **Step 3: Port missing backend services**

Implement routes by calling native agent/session/tool/policy APIs. Add Rust automation scheduling, background-task state, pending requests, approvals, telemetry/usage, and session replay endpoints. Do not shell out to Node.

- [ ] **Step 4: Add and pass legacy migration tests**

Use copied session/config/database fixtures. Write upgrades to a sibling temporary file, fsync, and atomically rename only after validation. Keep the original on failure.

- [ ] **Step 5: Run security and web tests and commit**

Run: `cargo test --locked --manifest-path packages/control-plane-rs/Cargo.toml`

Expected: PASS including auth, CORS/CSRF, SSRF, symlink, persistence, and migration cases.

Commit: `feat(control-plane): complete native web backend`

---

### Task 7: Cut Slack and remaining adapters over to Rust

**Files:**
- Create: `packages/slack-agent/src/native-runtime-client.ts`
- Create: `packages/slack-agent/test/native-runtime-client.test.ts`
- Modify: `packages/slack-agent/src/agent-runner.ts`
- Modify: `packages/slack-agent/src/ui/api-server.ts`
- Modify: `packages/slack-agent/package.json`
- Modify: `packages/github-agent/src/worker/evalops.ts`
- Modify: relevant IDE adapter entrypoints identified by the static guard

**Interfaces:**
- Produces: `NativeRuntimeClient.runTurn(request): AsyncIterable<AgentEvent>` over authenticated Rust control-plane HTTP/SSE or WebSocket.

- [ ] **Step 1: Add failing Slack event-contract tests**

```ts
it("streams the frozen Slack event contract from Rust", async () => {
  const events = await collect(client.runTurn(fixture.request));
  expect(events).toEqual(fixture.events);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npx vitest --run packages/slack-agent/test/native-runtime-client.test.ts`

Expected: FAIL because the native client does not exist.

- [ ] **Step 3: Implement the thin protocol client**

```ts
export interface NativeRuntimeClient {
  runTurn(request: NativeTurnRequest, signal?: AbortSignal): AsyncIterable<AgentEvent>;
}
```

The implementation serializes contract messages, authenticates to the Rust control plane, parses SSE/WebSocket events, and forwards cancellation. It contains no provider, model, tool, approval, or session execution.

- [ ] **Step 4: Replace all direct TS agent construction**

Main Slack turns, conversation summaries, and dashboard generation use native requests. Apply the same conversion to every adapter reported by `check:rust-only-runtime`.

- [ ] **Step 5: Run adapter tests and commit**

Run: `npx vitest --run packages/slack-agent/test test/slack-agent packages/github-agent/src`

Expected: PASS with no `Agent` or `ProviderTransport` construction.

Commit: `feat(adapters): route product turns through Rust`

---

### Task 8: Convert evals, scripts, and shared contracts

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Move data-only types from `packages/ai` and `packages/core` into focused files under `packages/contracts/src/`
- Modify: `scripts/evals/**/*.ts`, `scripts/measure-tool-call-*.ts`, and `scripts/mock-agent-*.js`
- Modify: affected tests importing TS runtime classes

**Interfaces:**
- Produces: data-only contract exports and native-headless eval/dev drivers.

- [ ] **Step 1: Add failing contract-boundary tests**

Assert that contracts export required event/message/model/tool schema types and import no root `src/agent`, providers, or tools.

- [ ] **Step 2: Verify RED**

Run: `npx vitest --run test/packages/ai-tsconfig-boundary.test.ts test/packages/core/consumer-integration.test.ts`

Expected: FAIL until consumers and expectations move to contracts/native drivers.

- [ ] **Step 3: Move data contracts and convert drivers**

Evals start `maestro --headless`, send fixture protocol messages, collect native events, and judge results. Mock-agent scripts use native scripted replay rather than TypeScript `Agent` construction.

- [ ] **Step 4: Run eval contract suites and commit**

Run: `npm run check:agent-trajectory-fixtures`

Run: `npm run check:scenario-replay-gate`

Expected: PASS.

Commit: `refactor(evals): use native runtime contracts`

---

### Task 9: Delete the TypeScript runtime and backend

**Files:**
- Delete: `packages/ai/`
- Delete: `packages/core/`
- Delete: executable runtime portions of `src/agent/`, `src/tools/`, `src/providers/`, `src/mcp/`, `src/hooks/`, `src/sandbox/`, `src/safety/`, `src/session/`, `src/memory/`, and `src/telemetry/` after consumers move
- Delete: `src/main.ts`, `src/cli.ts`, `src/cli-runtime.ts`, `src/cli-command-runtime.ts`, `src/web-server.ts`, and `src/server/`
- Delete or rewrite: TS-runtime tests superseded by Rust fixture coverage
- Modify: TypeScript configs, Nx projects, package metadata, and workspace references

**Interfaces:**
- Consumes: completed Rust implementations and data-only contracts.
- Produces: repository with no executable TS agent/backend path.

- [ ] **Step 1: Delete runtime packages and directories**

Use explicit paths from the static guard and compiler inventory. Preserve only data-only modules already moved to contracts and thin adapters allowed by the design.

- [ ] **Step 2: Run TypeScript build and fix only legitimate adapter/frontend imports**

Run: `npx tsc -b tsconfig.build.json --force`

Expected: PASS; no import is redirected to a compatibility TS implementation.

- [ ] **Step 3: Run the Rust-only static guard**

Run: `npm run check:rust-only-runtime`

Expected: PASS with zero shipped/runtime offenders.

- [ ] **Step 4: Run Rust and remaining TypeScript tests and commit**

Run: `cargo test --locked --manifest-path packages/tui-rs/Cargo.toml`

Run: `cargo test --locked --manifest-path packages/control-plane-rs/Cargo.toml`

Run: `cargo test --locked --manifest-path packages/maestro-rs/Cargo.toml`

Run: `npx nx run maestro:test --skip-nx-cache`

Expected: PASS.

Commit: `refactor: delete TypeScript runtime and backend`

---

### Task 10: Switch packaging, installers, releases, and CI to native-only

**Files:**
- Modify: `package.json`
- Modify: `scripts/install.sh`, `scripts/install.ps1`
- Modify: `scripts/build-release-binary.mjs`
- Modify: `scripts/materialize-tui-vendor.mjs`
- Modify: `scripts/smoke-release-binary.mjs`
- Modify: `.github/workflows/release.yml`, `.github/workflows/ci.yml`, `.github/workflows/rust.yml`
- Modify: `Dockerfile`, `.devcontainer/devcontainer.json`, Nix/Bazel build files

**Interfaces:**
- Produces: one canonical native `maestro-<platform>-<arch>` artifact plus any explicitly separate hosted runner artifact; npm installs select native platform binaries without Node runtime execution.

- [ ] **Step 1: Add failing no-Node release smoke**

The smoke constructs a PATH containing the installed native binaries and system utilities but no `node`, `npm`, `bun`, or `npx`, then exercises version/help, exec scripted replay, headless handshake, web health/static serving, and session resume.

- [ ] **Step 2: Run and verify RED**

Run: `npm run smoke:release-native-only`

Expected: FAIL while installers/package bins still select `dist/cli.js` or require Node.

- [ ] **Step 3: Build and package native artifacts**

Release matrices compile `packages/maestro-rs`, `packages/tui-rs`, and hosted runner targets with locked dependencies. Package `bin.maestro` resolves to the native platform binary.

- [ ] **Step 4: Run release and container smokes and commit**

Run: `npm run smoke:release-native-only`

Run: `npm run release:check`

Run: `npm run check:docker-runtime-workspaces`

Expected: PASS without Node/Bun in runtime PATH.

Commit: `build: ship Rust-only Maestro runtime`

---

### Task 11: Clean documentation and migration tracking

**Files:**
- Modify: `README.md`, `docs/ARCHITECTURE.md`, `docs/TUI_ARCHITECTURE.md`, `docs/NATIVE_TUI_PARITY.md`, `docs/WEB_UI.md`, `docs/FEATURES.md`, contributor/release docs, package READMEs
- Delete: obsolete TS migration documentation and baselines
- Modify: issue references in changelog/release notes

**Interfaces:**
- Produces: one Rust-only architecture description and an issue closure list.

- [ ] **Step 1: Add a documentation guard**

Reject claims that print/headless/web/server product execution uses TS, that the TS agent SDK remains supported, or that `maestro` requires Node/Bun.

- [ ] **Step 2: Update docs and remove obsolete migration status**

Document `maestro-rs`, `control-plane-rs`, `tui-rs`, adapter boundaries, native install artifacts, and troubleshooting.

- [ ] **Step 3: Run documentation/static checks and commit**

Run: `npm run check:rust-only-runtime`

Run: `npm run check:developer-surface`

Expected: PASS.

Commit: `docs: describe Rust-only Maestro architecture`

---

### Task 12: Full verification, review, PR, CI, and merge

**Files:**
- No planned product changes; fixes discovered by verification remain scoped to the failing causal surface.

**Interfaces:**
- Produces: merged Rust-only cutover and verified `main`.

- [ ] **Step 1: Run fresh local verification on `dev-desktop`**

Run all Rust format, Clippy `-D warnings`, unit/integration/security/migration suites, remaining TypeScript adapter/frontend checks, Nx tests, lint, scenario replay, evals, release packaging, no-Node smokes, and the static guard.

Expected: every command exits zero. Pre-existing failures must be independently reproduced on refreshed `main` and fixed if they block required checks.

- [ ] **Step 2: Review the full diff and consumer inventory**

Run: `git diff --check origin/main...HEAD`

Run: `rg -n 'new Agent|ProviderTransport|createAgent|MAESTRO_(ALLOW_)?TS_AGENT|dist/cli\.js' src packages scripts .github package.json`

Expected: no executable runtime matches outside frozen historical fixtures or explicit negative static-guard patterns.

- [ ] **Step 3: Push and open a ready PR**

Push the named branch with tracking. The PR body records architecture, deletions, migrations, security behavior, tests, and native-only runtime evidence.

- [ ] **Step 4: Address review and CI with new commits**

Do not amend pushed commits or bypass checks. Rerun the causal local command for every fix.

- [ ] **Step 5: Merge and verify `main`**

Merge only after every required check is green. Refresh `origin/main`, verify the merge commit and post-merge required workflows, then close or supersede obsolete migration issues with the merged PR link.
