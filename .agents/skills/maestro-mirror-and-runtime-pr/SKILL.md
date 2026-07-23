---
name: maestro-mirror-and-runtime-pr
description: Use when changing Maestro runtime, hosted runner, event contracts, migration packaging, or internal-to-public mirror behavior.
---

# Maestro Mirror and Runtime PR

Use this workflow for Maestro changes that may affect the public mirror, Platform integration, hosted runtime, or release packaging.

## Start

1. Check live PR state in both repos:
   - `gh pr list --repo evalops/maestro-internal --limit 20`
   - `gh pr list --repo evalops/maestro --limit 20`
2. Work from `evalops/maestro-internal` unless explicitly asked to edit the public mirror.
3. Read root `AGENTS.md`, root `README.md`, and the package README files before making broad changes.

## Implementation Rules

- Do not manually commit to `evalops/maestro` for normal mirrored code changes; let the mirror/release automation handle public sync.
- Keep Rust protocol implementations, fixtures, and native packaging in sync when a runtime contract changes.
- When touching Platform-facing behavior, identify the matching Platform issue, proto/event contract, or deploy flag in the PR body.
- Preserve public/private repo asymmetry; do not normalize away internal-only surfaces.

## Verification

Use narrow checks for the touched surface, then broaden if the change crosses package boundaries:

```bash
npm run check
cargo test --workspace --locked
```

Rust runtime changes:

```bash
cargo check -p maestro-tui
cargo check -p maestro-control-plane
```

Protocol or packaging changes:

```bash
cargo test --workspace --locked
npm run release:check
```

## PR Body Checklist

- Internal/public mirror impact.
- Runtime, event, or Platform contract impact.
- Commands run and result.
- Any public sync, release, or deploy follow-up.
