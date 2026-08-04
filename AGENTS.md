# Maestro contributor guide

Maestro is a native Rust product. The CLI, TUI, control plane, protocols, adapters, and agents live in the root Cargo workspace. `packages/web/dist` is a checked-in static browser asset; do not add a JavaScript or TypeScript runtime path.

## Repository map

- `packages/maestro-rs`: installed `maestro` binary and command dispatch
- `packages/tui-rs`: interactive TUI, agent runtime, tools, sessions, and hooks
- `packages/control-plane-rs`: native web/API control plane
- `packages/ambient-agent-rs`: ambient automation agent
- `packages/web/dist`: versioned browser bundle served by Rust
- `proto`: protocol definitions shared by native crates
- `scripts`: packaging, release, and repository checks

Crate names differ from directory names; cargo commands need the crate name:

| Crate | Directory |
| --- | --- |
| `maestro` | `packages/maestro-rs` |
| `maestro-tui` | `packages/tui-rs` |
| `maestro-control-plane` | `packages/control-plane-rs` |
| `ambient-agent` | `packages/ambient-agent-rs` |

## Commands

`package.json` has zero runtime dependencies and one locked, test-only development dependency. Run `npm ci` before repository and workflow contract tests; the scripts below otherwise run directly against the Rust workspace and `scripts/*`.

```bash
npm run check
npm test
npm run lint
npm run build
npm run smoke:release-native-only
```

Focused Rust work should use workspace package selection:

```bash
cargo check -p maestro-tui
cargo test -p maestro-control-plane
cargo test -p maestro-tui test_name
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo fmt --all --check
```

`scripts/check-pr.sh [crate]` runs the local PR gates (fmt, clippy `-D warnings`, tests) in one command; pass a crate name to scope the tests, or no argument for workspace-wide. Clippy always runs workspace-wide regardless of scoping — CI's `rust-validation` gates on `cargo clippy --workspace`, and crate-scoped clippy misses cross-crate breaks. A PR verification section that claims clippy passed means the workspace command.

The root `Cargo.lock` is authoritative. Do not add nested Cargo lockfiles or crate-local target directories. New dependencies shared by multiple crates belong in `[workspace.dependencies]`.

## Change expectations

- Preserve native CLI and protocol contracts unless the change explicitly migrates them.
- Add regression tests for behavior changes.
- A PR that intentionally shifts a benchmarked hot path must refresh the perf baselines and include the bench output in the PR body (`packages/tui-rs/benches/baselines/README.md`); the `perf-baselines` workflow is advisory and must not become a required status check.
- The workspace-root `clippy.toml` bans raw `std::fs::canonicalize`/`Path::canonicalize` (Windows verbatim `\\?\` paths); use `dunce::canonicalize`. `tokio::fs::canonicalize` remains allowed pending an async helper.
- Keep the npm package a thin native distribution wrapper; it must not execute Node, npm, npx, Bun, or TypeScript after installation.
- Keep `packages/web/dist` reproducible and checked in until a separate browser-source migration is approved.
- Run the relevant checks, tests, Clippy, formatting, build, native smoke, and packed-install smoke before release changes merge.
- Never make checks pass by weakening assertions, suppressing errors, or restoring a JavaScript fallback.
- Test module names mirror source file names, so `cargo test -p <crate> <file-stem>` finds the tests covering `src/<file-stem>.rs`.

## CI lanes

Required status checks on pull requests:

- `native` (`ci.yml`): aggregate gate over `rust-validation` (rust-only runtime check, `cargo fmt --all --check`, workspace clippy `-D warnings`, workspace tests) and `native-release` (`npm run build` + native-only release smoke).
- `test` (`rust.yml`): `cargo fmt --all --check`, workspace clippy `--locked -D warnings`, and `cargo test --workspace --locked` on stable.
- `Rust-only Source Guard` (`hooks.yml`): fails if a JavaScript hooks/runtime path reappears (`scripts/check-rust-only-runtime.mjs`).
- `Rust Hook Tests` (`hooks.yml`): fmt plus `cargo test --locked -p maestro-tui --test hooks_integration`.
- `pull-request-path-check` (`integration.yml`): detects whether a PR touches integration-relevant paths and gates `integration-suite`.
- `integration-suite` (`integration.yml`): `cargo test --locked -p maestro-control-plane` against Redis and Postgres service containers; runs only when integration paths changed.
- `integration-tests` (`integration.yml`): required result aggregator that always reports and succeeds only when path detection succeeds and the conditional integration suite has the expected successful or skipped result.
- `scenario-replay` (`scenario-replay.yml`): builds the native `maestro` scenario runner and runs the replay gate scenario suite.
- `actionlint` (`actionlint.yml`): lints workflow and action YAML.
- `shellcheck` (`shellcheck.yml`): ShellCheck on shell scripts changed by the PR.
- `unresolved-review-threads` (`review-thread-guard.yml`): reusable-workflow guard that fails while high-severity review threads are unresolved on non-draft PRs.
- `build-and-publish` (`ghcr-publish.yml`): builds and pushes the GHCR runtime image on main pushes; the job is skipped on PRs but the context is still required, so it reports as skipped.

General CI — unit tests, Clippy, integration tests, scenario replay, lint lanes — routes via `vars.PR_VALIDATION_RUNNER || 'evalops-private-ci'`, the Hetzner execution lane. None of it needs cluster adjacency, and `evalops/deploy` `policy/dual-cloud-runner-lanes.yaml` lists `static_validation` as a forbidden workflow family on the GCP trusted lanes (`evalops-internal`, `evalops-internal-arc`). Jobs with `services:` (`integration-suite`, `capability-gated-tests`) additionally carry a `hetzner` label so they land on the static VMs, which have a Docker daemon; the `evalops-private-ci-arc` pods do not. Release, mirror, and publish workflows stay on `vars.INTERNAL_CONFIRMATION_RUNNER`.

## CI invariants (learned the hard way)

- **Required status checks must always be reportable.** Never add a `paths:`/`paths-ignore:` filter to a workflow whose job is a required status check on `pull_request`; a required check that never reports wedges the PR at BLOCKED forever. This is enforced by `scripts/check-required-status-checks.mjs`.
- **Bound every network call in CI.** Use explicit short timeouts (e.g. apt via `Acquire::http::Timeout=10` / `Acquire::Retries=1`). Default tool timeouts let a dead mirror stall a job for its full `timeout-minutes` with no output.
- **Advisory automation fails open.** Jobs that label, annotate, or upload best-effort artifacts warn and exit 0 on permission errors; a red check is reserved for real failures.
- **Monitors fail closed.** The rule above stops where the job's output *is* the signal. `scheduled-failure-watchdog` must exit non-zero when it cannot read the workflows it monitors. It ran green for weeks while `sync-public-release-mirror` failed 29 consecutive times, because a 403 on `/actions/workflows` was downgraded to a warning and the workflow was skipped. Do not soften those errors back into warnings.
- **Ignored-but-mirrored files need `git add -f`.** `packages/web/dist` is intentionally committed despite the `dist/` `.gitignore` rule; plain `git add` silently skips untracked ignored files in generated mirror commits. The dist is produced by an external browser-source build and committed wholesale — do not delete "extra" hashed bundles here; they can be live dynamic-import facades.
