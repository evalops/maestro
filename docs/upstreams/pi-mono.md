# pi-mono upstream notes

Maestro includes a few components that are **adapted from** or **inspired by** the open-source project **pi-mono**.

## Upstream

- Repo: https://github.com/badlogic/pi-mono
- License: MIT (Copyright (c) 2025 Mario Zechner)

## What we currently adapt/inherit

> **Note:** Maestro's side of both comparisons below was rewritten from TypeScript to
> Rust in the Rust-only runtime migration (#3016, #3017, merged 2026-07-22). The
> `Maestro:` paths point at the current Rust modules; the concepts still apply even
> though the original TS files are gone. The `Upstream reference:` paths are pi-mono's
> own (external) layout and are not expected to resolve in this repo.

### Theme system

- Maestro: `packages/tui-rs/src/themes/mod.rs` (color resolution folded in; there is
  no separate `color-utils` module in the Rust port)
- Upstream reference: `packages/coding-agent/src/modes/interactive/theme/theme.ts`

Notable differences in Maestro vs upstream:
- Maestro adds additional semantic tokens (e.g. `accentWarm`) and resolves colors inline in the themes module.
- Token sets and embedded defaults have diverged (upstream includes `thinkingXhigh` and `bashMode`; Maestro includes its own thinking levels and additional UI tokens).
- Theme discovery paths differ (Maestro searches built-in + CWD candidates; upstream uses config-based theme directories).

### Hooks loader (pi-style hooks)

- Maestro: `packages/tui-rs/src/hooks/` (`types.rs`, `config.rs`, plus native `lua.rs`
  and `wasm.rs` backends; hooks are no longer TypeScript-loaded)
- Upstream reference: `packages/coding-agent/src/core/hooks/{loader.ts,types.ts}`

Notable differences in Maestro vs upstream:
- Maestro supports a larger event surface (`HookEventType`) and additional integration layers (tool/session integration + UI context), plus Lua and WASM hook backends upstream does not have.
- Loader behavior and config locations differ (`~/.maestro` / `.maestro` vs upstream’s `~/.pi` / `.pi`).

## Low-risk upstream improvements we should track

- **Unicode whitespace normalization in hook paths**: upstream normalizes non-breaking / unicode spaces in paths before resolving. This prevents “file not found” issues when users paste paths containing invisible unicode whitespace.

