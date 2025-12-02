# Contributor Runbook

Audience: engineers touching code; use as the day-one checklist.  
Nav: [Docs index](README.md) · [Quickstart](QUICKSTART.md) · [Tools Reference](TOOLS_REFERENCE.md) · [Safety](SAFETY.md)

## 0. Clone & Install

- `bun install` (workspace-aware)  
- Keys: export provider keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.) or place in `~/.composer/keys.json`.

## 1. Build & Verify (fresh repo)

```bash
npx nx run composer:build --skip-nx-cache          # CLI fast path
npx nx run composer:build:all --skip-nx-cache      # CLI + TUI + Web
bun run bun:lint                                   # Biome + eval verifier
npx nx run composer:test --skip-nx-cache           # Builds TUI/Web, then Vitest
npx nx run composer:evals --skip-nx-cache          # Scenario runner
```

Expected: all commands succeed; dist artifacts appear under `dist/`.

## 2. Inner Loop

- `bun run dev` — TS watch (rebuilds `dist/`).
- TUI: `bun run cli -- --provider anthropic --model claude-opus-4-5-20251101 "hi"`.
- Web: `bun run web:dev` (server on `:8080`, Vite on `:3000`).
- Package builds: `bun run --filter @evalops/tui build`, `bun run --filter @evalops/composer-web build`.

## 3. Safety Checks

- Approvals/firewall: see `docs/SAFETY.md`; web server defaults to **auto-approval**—use Docker or auth if exposed.
- Guardian: `scripts/guardian.sh --staged` (or `/guardian` in TUI) before commits.

## 4. Docs & References

- TUI/CLI UX: `docs/FEATURES.md`
- Web parity: `docs/WEB_UI.md` (single parity source)
- Tool behaviors: `docs/TOOLS_REFERENCE.md`
- Model/registry: `docs/MODELS.md` + `packages/ai/README.md`
- Types/contracts: `packages/contracts/README.md`
- Patterns: `docs/patterns/INDEX.md`

## 5. Pre-PR Checklist

- `bun run bun:lint`
- `npx nx run composer:test --skip-nx-cache`
- Build touched packages (e.g., `npx nx run tui:build`, `npx nx run composer-web:build`)
- Ensure docs updated if flags/options changed (source-of-truth notes above)

## 6. Troubleshooting Quickies

- Missing keys → `composer --diag`
- Approval blocks → check firewall notes in `SAFETY.md`
- Web tooling stuck → `curl http://localhost:8080/api/models` to validate server
- Session issues → `docs/SESSIONS.md` for cleanup and flags
