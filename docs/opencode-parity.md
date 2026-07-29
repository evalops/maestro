# OpenCode Parity Roadmap

Updated: 2026-01-19

> **Note:** This snapshot predates the Rust-only runtime migration (#3016, #3017,
> merged 2026-07-22), which deleted Maestro's TypeScript agent runtime. The checked
> items below describe behavior as of the TypeScript implementation; the LSP entry has
> been updated to point at the current Rust module, but the other items have not been
> re-verified against the Rust CLI/TUI and may have moved or changed shape.

This note captures the quickest path to close the gaps called out during the OpenCode comparison (2025-11-23). Items are ordered by implementation cost vs impact.

## Status Snapshot
- ✅ Plan Mode (ask-before-write/bash): `/plan-mode on|off` + `MAESTRO_PLAN_MODE=1` gates `apply_patch`/`write`/`edit`/`bash` in the safety firewall and surfaces status in `/status`.
- ✅ User Command Catalog: JSON commands in `~/.maestro/commands/*.json` or `.maestro/commands/`, exposed via `/commands list|run` and the command palette.
- ✅ Session Share (read-only live view): `/api/sessions/:id/share` and `/share/:token` tokens in the web UI; TUI also supports `/share` HTML exports.
- ✅ LSP Auto-Attach: LSP support now lives in `packages/tui-rs/src/lsp.rs`; the exact
  `MAESTRO_LSP_AUTOSTART` env var and `/lsp status|restart` commands have not been
  re-verified in the Rust CLI/TUI.
- ✅ Multi-Session UX: Session switcher (Ctrl+O) plus `/sessions` and `/session` commands.
- ✅ Inline Editor (nice-to-have): Custom editor modal for quick patches in the TUI.
- ⏳ Curated Model Profile (Zen-like): still open (needs curated allowlist + cost caps).

## Remaining Work

### Curated Model Profile (Zen-like)
- **Goal:** Optional “safe” profile that uses a vetted model list with cost caps.
- **Implementation sketch:**
  - Add `MAESTRO_PROFILE=curated` to load a curated models allowlist + caps.
  - Warn/deny when user selects models outside curated profile.
