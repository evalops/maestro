# OpenCode Parity Roadmap

This note captures the quickest path to close the gaps called out during the OpenCode comparison (2025-11-23). Items are ordered by implementation cost vs impact.

## 1) Plan Mode (ask-before-write/bash)
- **User toggle:** `COMPOSER_PLAN_MODE=1` or `/plan-mode on|off` in TUI.
- **Behavior:**
  - All `write`, `edit`, and `bash` tools require explicit user confirmation unless already approved in the current session.
  - Surface status pill in TUI footer and `/status`.
- **Implementation sketch:**
  - Add `planModeEnabled` to `ContextState` (src/context/state.ts) and thread into safety guards.
  - In `tools/*`, gate mutations via existing approval flow; reuse safe-mode prompts but without the TODO requirement.
  - Add command handler in CLI/TUI to toggle and persist in session file.

## 2) User Command Catalog
- **Goal:** Reusable, user-authored commands stored in `~/.composer/commands/*.md` (or repo `.composer/commands/`).
- **Format:** Frontmatter with name, description, required args, and the slash/tool/script to execute.
- **Surfacing:** `/commands list`, `/commands run <name> --args`, palette entry.
- **Implementation sketch:**
  - Parser module `src/commands/catalog.ts` (YAML frontmatter + markdown body for prompt template).
  - Wire into TUI command palette and CLI `/commands` handler.
  - Optional: per-workspace overrides by searching up the tree (`.composer/commands`).

## 3) Session Share (read-only live view)
- **Goal:** Temporary share link to stream session output (read-only).
- **Scope:** Local HTTP endpoint (reuse web UI SSE) with one-time token; no auth persistence.
- **Implementation sketch:**
  - Add `composer share --ttl 30m` that starts a small express/fastify server under `/share/<token>`.
  - Pipe existing SSE events; disable file write endpoints.
  - Auto-stop when TTL expires or session ends.

## 4) LSP Auto-Attach (requested)
- **Goal:** Auto-detect and start language servers for the current workspace when `COMPOSER_LSP_ENABLED` and new flag `COMPOSER_LSP_AUTOSTART=1`.
- **Implementation sketch:**
  - Add detector `src/lsp/autodetect.ts`: look for common config/files (`tsconfig.json`, `package.json` scripts, `pyproject.toml`, `go.mod`, `Cargo.toml`) and map to server commands (tsserver, pyright, gopls, rust-analyzer).
  - On startup (src/main.ts), if autostart and not already configured, spawn detected servers via existing `lsp/bootstrap.ts`.
  - Expose `/lsp status|restart|disable` for control.

## 5) Multi-Session UX
- **Goal:** Switch between multiple sessions in TUI without quitting.
- **Implementation sketch:**
  - Add session switcher panel (reuse `/sessions` listing) bound to a hotkey.
  - Keep one active context; switching persists current and loads selected JSONL.

## 6) Curated Model Profile (Zen-like)
- **Goal:** Optional “safe” profile that uses a vetted model list with cost caps.
- **Implementation sketch:**
  - Add `COMPOSER_PROFILE=curated` to load `configs/curated-models.json` (hand-picked models + max cost/token caps).
  - Warn/deny when user selects models outside curated profile.

## 7) Inline Editor (nice-to-have)
- **Goal:** Minimal modal editor in TUI for quick patches.
- **Implementation sketch:**
  - Start with read-only preview + apply patch buffer (textarea) instead of full Vim clone.
  - Integrate with `write/edit` tool for final apply.

## Suggested Order
1) Plan Mode (small, high-safety win)
2) LSP Auto-Attach (requested explicitly)
3) User Command Catalog
4) Session Share
5) Curated Profile toggle
6) Multi-Session UX
7) Inline Editor

## Open Questions
- Should plan-mode confirmations be per-file or per-command? (Recommend per-command with file list shown.)
- For curated profile, who owns the vetted model list and cost ceilings? (Team decision.)
- Session share: acceptable to run local HTTP server by default, or behind explicit `--share` command only?
