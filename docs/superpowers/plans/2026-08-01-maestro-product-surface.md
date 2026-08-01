# Maestro Product Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Make `maestro` the coherent public product surface, improve first-run activation and TUI branding, advance the Rust crate split, harden release installation, and bring security documentation in line with the Rust runtime.

**Architecture:** Preserve `maestro-tui` as an internal Cargo compatibility target while making all user-facing CLI/help/docs identify the canonical `maestro` command. Add setup as a read-only diagnostic/onboarding layer over the existing typed doctor report. Extract the dependency-free execution-policy module into a leaf crate behind the existing `maestro_tui::execpolicy` facade. Install verified release contents into versioned directories and update one stable launcher atomically.

**Tech Stack:** Rust workspace, Cargo, ratatui/crossterm, Bash installer, Cosign keyless release bundles, Markdown documentation, Node-based repository checks.

## Global Constraints

- The supported public executable remains `maestro`; `maestro-tui` remains available only as an internal/development Cargo target and compatibility alias.
- Preserve `maestro_tui::execpolicy` source compatibility through a public facade while moving implementation ownership to the new crate.
- Setup must never print or persist credential material and must not perform live network calls unless `--live` is explicitly supplied.
- Release installs verify the signed `SHA256SUMS` manifest and selected binary/web artifacts when signed metadata is published; `MAESTRO_REQUIRE_SIGNED_INSTALL=1` makes that requirement strict.
- Installer tests may use an explicit unsigned-fixture override; the production default remains fail-closed.
- Do not change headless protocol identifiers or internal A2A/MCP IDs merely to rename user-facing CLI text.
- No unrelated feature additions, history rewrites, force-pushes, or disabled checks.

---

### Task 1: Establish the canonical `maestro` command surface

**Files:**
- Modify: `packages/maestro-rs/src/main.rs`
- Modify: `packages/maestro-rs/src/cli.rs`
- Modify: `packages/maestro-rs/tests/dispatch.rs`
- Modify: `packages/tui-rs/src/entrypoint.rs`
- Modify: `packages/tui-rs/src/cli_commands.rs`
- Modify: `packages/tui-rs/src/hosted_runner_cli.rs`
- Modify: `packages/tui-rs/src/app.rs`
- Modify: `packages/tui-rs/tests/direct_cli.rs`
- Modify: `packages/tui-rs/tests/entrypoint.rs`
- Modify: `README.md`, `docs/QUICKSTART.md`, `docs/TUI_ARCHITECTURE.md`, and the native TUI user-guide command examples

**Interfaces:**
- `packages/maestro-rs` continues to classify only `web`, help, and version locally; all other arguments still reach the canonical Rust runtime.
- `packages/tui-rs` exposes the same command behavior under both executable names, but user-visible usage and error text uses `maestro`.
- Protocol-facing client names such as `maestro-tui-rs` remain unchanged.

- [x] **Step 1: Add regression assertions for public naming.** Extend dispatch/direct CLI tests so `maestro --help`, `maestro-tui --help`, `exec` usage errors, `status`/`sessions` help, hosted-runner help, and trust errors contain `maestro` and do not contain the obsolete executable name in user-facing text.
- [x] **Step 2: Run the focused tests and observe the expected failures.** Run `cargo test --locked -p maestro --test dispatch` and `cargo test --locked -p maestro-tui --test direct_cli --test entrypoint`; the new assertions should fail against the current internal-name strings.
- [x] **Step 3: Replace the duplicated user-facing executable literals.** Set the Clap command name/long help to `maestro`, update utility and fast-path usage strings, and expand the canonical top-level help in `packages/maestro-rs/src/main.rs` with common and advanced stable commands including `setup`, `config`, `models`, `sessions`, `scenario`, `run`, `codex`, `mcp`, and `plugins`.
- [x] **Step 4: Update user documentation and preserve internal identifiers.** Change installation/use examples and user-guide commands to `maestro`; retain Cargo package names, test binary environment variables, protocol client IDs, and internal performance labels where they are not user-facing.
- [x] **Step 5: Run focused verification.** Run the two focused Cargo test commands and `target/release/maestro --help`/`target/release/maestro-tui --help` smoke checks, confirming the canonical text is identical enough for users.
- [x] **Step 6: Commit the canonical-surface slice.** Commit as `feat: make maestro the canonical user-facing command`.

### Task 2: Add an actionable, credential-safe first-run setup command

**Files:**
- Create: `packages/tui-rs/src/setup_cli.rs`
- Modify: `packages/tui-rs/src/lib.rs`
- Modify: `packages/tui-rs/src/entrypoint.rs`
- Modify: `packages/tui-rs/src/cli_commands.rs`
- Modify: `packages/tui-rs/src/doctor.rs`
- Modify: `packages/tui-rs/src/doctor.rs` tests
- Modify: `README.md`, `docs/QUICKSTART.md`, `docs/MODELS.md`, and `packages/tui-rs/docs/user-guide/01-getting-started.md`

**Interfaces:**
- `maestro setup [--model <provider/model>] [--live] [--json]` calls the existing typed doctor report builder.
- Human output includes selected model/provider, pass/warning/fail summary, and concrete next commands; JSON output contains schema version, report, and redacted next steps.
- `--live` is the only setup mode allowed to contact provider metadata endpoints.

- [x] **Step 1: Define setup output and tests.** Add a serializable `SetupReport`/next-step representation and tests for configured credentials, missing credentials, invalid provider resolution, and secret redaction; tests must assert that API-key values never appear.
- [x] **Step 2: Run setup tests to verify the new API is absent.** Run `cargo test --locked -p maestro-tui setup_cli`; confirm the test target fails to compile until the module is wired.
- [x] **Step 3: Implement setup as a doctor projection.** Build the existing `DoctorReport` with `build_report`, derive deterministic next steps from check IDs/statuses, render human output, and serialize JSON without duplicating provider/auth logic.
- [x] **Step 4: Wire `setup` into native dispatch.** Add it to `NATIVE_UTILITY_COMMANDS`, utility dispatch, top-level help, and the public command naming tests.
- [x] **Step 5: Document the activation path.** Make Quickstart read as install → `maestro setup` → configure a provider → run a safe first prompt, with explicit examples for environment credentials and Codex login.
- [x] **Step 6: Run setup verification.** Run `cargo test --locked -p maestro-tui setup_cli`, `cargo test --locked -p maestro --test dispatch`, and isolated `maestro setup --json` with a temporary `HOME`/`MAESTRO_HOME` proving redacted output.
- [x] **Step 7: Commit the onboarding slice.** Commit as `feat: add credential-safe maestro setup diagnostics`.

### Task 3: Make the TUI brand visible and regression-tested across terminal sizes

**Files:**
- Modify: `packages/tui-rs/src/components/deixic_logo.rs`
- Modify: `packages/tui-rs/src/components/message.rs` only if the compact rendering path needs a dedicated branch
- Modify: `packages/tui-rs/src/components/deixic_logo.rs` tests
- Modify: `scripts/smoke-tui-interactive.sh`
- Modify: `docs/TUI_ARCHITECTURE.md` and `packages/tui-rs/docs/user-guide/01-getting-started.md`

**Interfaces:**
- The welcome renderer keeps full/compact/tiny tiers and adds a one-line micro mark for short but usable terminal areas.
- The interactive smoke defaults to the canonical `maestro` binary when available and still accepts `MAESTRO_TUI_BIN` for Cargo-level testing.

- [x] **Step 1: Add height-boundary tests.** Test welcome content at heights 3, 4, 7, 8, 14, and 20, asserting the micro mark/title/hint behavior and no unexpected blank-only output.
- [x] **Step 2: Run the logo tests to capture the current short-terminal failure.** Run `cargo test --locked -p maestro-tui deixic_logo`; the new height-4/7 expectations should fail before implementation.
- [x] **Step 3: Add a compact micro mark and preserve accessibility.** Render a one-line mark plus `Maestro` and the `/help` hint in short terminals, retain the existing full art at larger heights, and make reduced-motion/animation-disabled rendering deterministic.
- [x] **Step 4: Update the PTY smoke.** Prefer `target/release/maestro`, assert the canonical welcome text, and keep clean Ctrl-C exit coverage.
- [x] **Step 5: Run visual/runtime verification.** Run `cargo test --locked -p maestro-tui deixic_logo`, build the canonical release binary, and run the interactive smoke when `tmux` is available.
- [x] **Step 6: Commit the TUI slice.** Commit as `feat: keep maestro branding visible in compact terminals`.

### Task 4: Extract the dependency-free execution-policy leaf crate

**Files:**
- Create: `packages/execpolicy-rs/Cargo.toml`
- Move: former TUI execution-policy module to `packages/execpolicy-rs/src/lib.rs`
- Modify: root `Cargo.toml`
- Modify: `packages/tui-rs/Cargo.toml`
- Modify: `packages/tui-rs/src/lib.rs`
- Modify: `packages/tui-rs/src/import_claude_cli.rs`
- Modify: `packages/tui-rs/tests/trace_replay.rs`
- Modify: `packages/tui-rs/src/bin/maestro_perf_bench.rs`
- Modify: `docs/design/crate-seams.md` and `docs/ARCHITECTURE.md`

**Interfaces:**
- New package `maestro-execpolicy` owns `Decision`, `Policy`, parsing, rendering, and tests.
- `maestro-tui` re-exports `maestro_execpolicy` as `maestro_tui::execpolicy` so existing source consumers remain compatible.
- The policy remains non-live and is not wired into approval decisions by this change.

- [x] **Step 1: Add the new workspace manifest and facade test.** Declare the leaf crate with only `regex`, `serde`, and `serde_json` dependencies, add it to the workspace, and add a temporary facade compile test that imports `maestro_tui::execpolicy::Decision`.
- [x] **Step 2: Run the package check to verify the moved symbols are not yet available.** Run `cargo check --locked -p maestro-execpolicy -p maestro-tui`; confirm the new crate has no unresolved `crate::` dependencies before moving production references.
- [x] **Step 3: Move the module and re-export it.** Move the implementation with history preserved, replace `pub mod execpolicy` with `pub use maestro_execpolicy as execpolicy`, and update direct internal imports only where Cargo requires the new dependency path.
- [x] **Step 4: Run leaf and dependent tests.** Run `cargo test --locked -p maestro-execpolicy`, `cargo test --locked -p maestro-tui --test trace_replay`, and `cargo check --locked -p maestro-control-plane -p maestro`.
- [x] **Step 5: Update seam documentation with measured scope.** Record that the leaf extraction shipped while safety/approval wiring remains intentionally separate and dangerous project-controlled policy files are still not live.
- [x] **Step 6: Commit the crate-boundary slice.** Commit as `refactor: extract execution policy into a leaf crate`.

### Task 5: Verify release artifacts and install atomically with rollback retained

**Files:**
- Modify: `scripts/install.sh`
- Create: `scripts/test-install.sh`
- Modify: `README.md` and `docs/release-ops.md`
- Modify: `.github/workflows/release.yml` only if the installer needs an explicit stable asset name or metadata field

**Interfaces:**
- Installer downloads `SHA256SUMS` and `SHA256SUMS.cosign.bundle` when available, verifies the manifest using the pinned Cosign release binary for the four supported platform pairs, then verifies the selected binary and web archive hashes. Legacy releases without signed metadata remain compatible unless `MAESTRO_REQUIRE_SIGNED_INSTALL=1` is set.
- Verified contents are staged under `${MAESTRO_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/maestro}/releases/<version>/<platform>`.
- The stable `${MAESTRO_INSTALL_DIR:-$HOME/.local/bin}/maestro` launcher is replaced only after staging succeeds and points to the verified release; previous release directories remain available for rollback.
- `MAESTRO_RELEASE_BASE_URL`, `MAESTRO_DATA_DIR`, and an explicitly named unsigned-fixture override are available only for deterministic tests/development.

- [x] **Step 1: Add an offline installer fixture test.** Create a local HTTP fixture server that serves a fake binary, web archive, checksum manifest, and unsigned-test marker; assert failed hash/signature verification leaves the existing launcher and web assets untouched.
- [x] **Step 2: Run the fixture test to prove the current installer lacks the contract.** Run `bash scripts/test-install.sh`; it should fail before the release metadata/staging implementation exists.
- [x] **Step 3: Add platform-aware Cosign bootstrap and signed-manifest verification.** Pin Cosign 2.6.1 asset names and SHA-256 digests, verify the bootstrap binary, download the release manifest/bundle, verify the expected GitHub Actions identity/issuer, and verify selected artifact hashes.
- [x] **Step 4: Add versioned staging and an atomic launcher.** Stage binary/web contents in a versioned release directory, validate `index.html`, write a temporary launcher with the release path and `MAESTRO_WEB_STATIC_ROOT`, and atomically rename it into place only after all checks pass.
- [x] **Step 5: Add success/rollback assertions.** Extend the fixture test to install two versions, confirm the second launcher replaces the first only after verification, and confirm a failed second install leaves version one runnable.
- [x] **Step 6: Document verification and rollback.** Document signed installation when release metadata is available, `MAESTRO_VERSION`, the versioned release location, strict mode, and the explicit test-only unsigned override.
- [x] **Step 7: Run shell and release checks.** Run `bash -n scripts/install.sh scripts/test-install.sh`, `shellcheck` when available, and the fixture test.
- [x] **Step 8: Commit the installer slice.** Commit as `feat: verify and atomically install Maestro releases`.

### Task 6: Replace stale security claims with a current Rust threat model

**Files:**
- Rewrite: `docs/THREAT_MODEL.md`
- Modify: `docs/SAFETY.md` if referenced paths or defaults are stale
- Modify: `docs/ENTERPRISE.md` only for claims explicitly marked unverified by the current Rust tree
- Modify: `docs/README.md` navigation if section names change

**Interfaces:**
- Every shipped mitigation in the threat model points to an existing Rust path and names its test or verification boundary where one exists.
- Enterprise RBAC/SSO/audit claims without a verified Rust implementation are listed under an explicit “not verified in the native runtime” section rather than presented as shipped controls.
- The document preserves operator-safe guidance for approval mode, sandboxing, MCP trust, and guarded files.

- [x] **Step 1: Inventory current Rust safety/auth modules and tests.** Build the path table from `packages/tui-rs/src/safety`, `sandbox.rs`, `tools`, `mcp`, `packages/control-plane-rs/src/auth.rs`, and their tests; do not copy old TypeScript paths.
- [x] **Step 2: Rewrite the threat model around verified controls.** Replace stale TypeScript tables with current Rust paths, distinguish local process permissions from web control-plane auth, and enumerate residual risks without claiming unverified enterprise features.
- [x] **Step 3: Add documentation checks.** Extend the Rust-only documentation check or add a focused test that rejects removed TypeScript paths in `docs/THREAT_MODEL.md` and requires the Rust migration status header.
- [x] **Step 4: Run documentation verification.** Run `node scripts/check-rust-only-docs.mjs`, the focused documentation test, and link/path checks.
- [x] **Step 5: Commit the security documentation slice.** Commit as `docs: align threat model with native runtime`.

### Task 7: Full verification, publish, review, and merge

**Files:**
- No additional product files; only PR metadata and any fixes required by checks.

- [x] **Step 1: Run formatting, lint, focused tests, installer tests, and release/build smoke checks.** Use `cargo fmt --all --check`, targeted package tests, `cargo clippy --workspace --all-targets --locked -- -D warnings`, `cargo test --workspace --locked`, `npm run check`, `npm run build`, `bash scripts/test-install.sh`, and the native release smoke where the environment supports it.
- [x] **Step 2: Inspect the final diff and repository status.** Confirm only the six requested slices and the plan are present, no secrets are staged, and the working tree is clean after commit.
- [x] **Step 3: Push the branch and open a ready PR against `main`.** Use `agent/maestro-product-surface`, a PR title covering the public-surface/onboarding/release hardening work, and a body listing the six slices, compatibility behavior, tests, and known platform limitations.
- [x] **Step 4: Monitor required checks and address failures.** Use GitHub Actions logs for failures; fix root causes, rerun the relevant checks, and update the PR description if scope changes.
- [x] **Step 5: Mark the PR ready and merge it.** Once required checks are green and no review blocker remains, mark ready, use the repository’s allowed merge method, verify the resulting `main` commit, and confirm the local branch state.
