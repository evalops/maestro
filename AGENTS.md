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

## Commands

```bash
npm install
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

The root `Cargo.lock` is authoritative. Do not add nested Cargo lockfiles or crate-local target directories. New dependencies shared by multiple crates belong in `[workspace.dependencies]`.

## Change expectations

- Preserve native CLI and protocol contracts unless the change explicitly migrates them.
- Add regression tests for behavior changes.
- The workspace-root `clippy.toml` bans raw `std::fs::canonicalize`/`Path::canonicalize` (Windows verbatim `\\?\` paths); use `dunce::canonicalize`. `tokio::fs::canonicalize` remains allowed pending an async helper.
- Keep the npm package a thin native distribution wrapper; it must not execute Node, npm, npx, Bun, or TypeScript after installation.
- Keep `packages/web/dist` reproducible and checked in until a separate browser-source migration is approved.
- Run the relevant checks, tests, Clippy, formatting, build, native smoke, and packed-install smoke before release changes merge.
- Never make checks pass by weakening assertions, suppressing errors, or restoring a JavaScript fallback.

## CI invariants (learned the hard way)

- **Required status checks must always be reportable.** Never add a `paths:`/`paths-ignore:` filter to a workflow whose job is a required status check on `pull_request`; a required check that never reports wedges the PR at BLOCKED forever. This is enforced by `scripts/check-required-status-checks.mjs`.
- **Bound every network call in CI.** Use explicit short timeouts (e.g. apt via `Acquire::http::Timeout=10` / `Acquire::Retries=1`). Default tool timeouts let a dead mirror stall a job for its full `timeout-minutes` with no output.
- **Advisory automation fails open.** Jobs that label, annotate, or upload best-effort artifacts warn and exit 0 on permission errors; a red check is reserved for real failures.
- **Ignored-but-mirrored files need `git add -f`.** `packages/web/dist` is intentionally committed despite the `dist/` `.gitignore` rule; plain `git add` silently skips untracked ignored files in generated mirror commits. The dist is produced by an external browser-source build and committed wholesale — do not delete "extra" hashed bundles here; they can be live dynamic-import facades.
