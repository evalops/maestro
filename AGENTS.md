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
- Keep the npm package a thin native distribution wrapper; it must not execute Node, npm, npx, Bun, or TypeScript after installation.
- Keep `packages/web/dist` reproducible and checked in until a separate browser-source migration is approved.
- Run the relevant checks, tests, Clippy, formatting, build, native smoke, and packed-install smoke before release changes merge.
- Never make checks pass by weakening assertions, suppressing errors, or restoring a JavaScript fallback.
