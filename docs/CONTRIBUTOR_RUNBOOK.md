# Contributor Runbook

Audience: engineers touching code; use as the day-one checklist.  
Nav: [Docs index](README.md) · [Quickstart](QUICKSTART.md) · [Tools Reference](TOOLS_REFERENCE.md) · [Safety](SAFETY.md)

## 0. Clone and install

- Install stable Rust and Node.js 22 or newer.
- Run `npm install` for the native packaging and repository-check scripts.
- Export provider keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.) or place them in `~/.maestro/keys.json`.

## 1. Build and verify

```bash
npm run check
npm run lint
npm test
npm run build
npm run smoke:release-native-only
```

The browser bundle under `packages/web/dist` is a versioned static input. Product code, protocols, adapters, CLI, TUI, and the control plane are Rust.

## 2. Inner loop

- Interactive TUI: `cargo run --manifest-path packages/maestro-rs/Cargo.toml`
- One-shot CLI: `cargo run --manifest-path packages/maestro-rs/Cargo.toml -- exec "summarize this repository"`
- Web control plane: `cargo run --manifest-path packages/maestro-rs/Cargo.toml -- web --port 3000`
- Focused crate test: `cargo test --manifest-path packages/tui-rs/Cargo.toml <test-name>`

## 3. Safety checks

- Approvals/firewall: see `docs/SAFETY.md`; exposed web auto-approval should be paired with Docker or authentication.
- Run `scripts/guardian.sh --staged` (or `/guardian` in the TUI) before commits.
- The Rust-only guards run through `npm run check:rust-only-runtime`.

## 4. Docs and references

- TUI/CLI UX: `docs/FEATURES.md`
- Web parity: `docs/WEB_UI.md`
- Tool behavior: `docs/TOOLS_REFERENCE.md`
- Native crates: `packages/maestro-rs`, `packages/tui-rs`, `packages/control-plane-rs`, and `packages/ambient-agent-rs`
- Historical design documents are reference material, not current build instructions.

## 5. Pre-PR checklist

- `npm run check`
- `npm run lint`
- `npm test`
- `npm run build`
- Update canonical docs when flags or behavior change.

## 6. Troubleshooting

- Missing keys: `maestro --diag`
- Approval blocks: check `docs/SAFETY.md`
- Control plane: `curl http://localhost:3000/api/health`
- Sessions: see `docs/SESSIONS.md`
