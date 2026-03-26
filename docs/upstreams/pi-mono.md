# pi-mono upstream notes

Maestro includes a few components that are **adapted from** or **inspired by** the open-source project **pi-mono**.

## Upstream

- Repo: https://github.com/badlogic/pi-mono
- License: MIT (Copyright (c) 2025 Mario Zechner)

## What we currently adapt/inherit

### Theme system

- Maestro: `src/theme/theme.ts`
- Upstream reference: `packages/coding-agent/src/modes/interactive/theme/theme.ts`

Notable differences in Maestro vs upstream:
- Maestro adds additional semantic tokens (e.g. `accentWarm`) and uses `src/theme/color-utils.ts` for color resolution.
- Token sets and embedded defaults have diverged (upstream includes `thinkingXhigh` and `bashMode`; Maestro includes its own thinking levels and additional UI tokens).
- Theme discovery paths differ (Maestro searches built-in + CWD candidates; upstream uses config-based theme directories).

### TypeScript hooks loader (pi-style hooks)

- Maestro: `src/hooks/typescript-loader.ts`, `src/hooks/types.ts`
- Upstream reference: `packages/coding-agent/src/core/hooks/{loader.ts,types.ts}`

Notable differences in Maestro vs upstream:
- Maestro supports a larger event surface (`HookEventType`) and additional integration layers (tool/session integration + UI context).
- Loader behavior and config locations differ (`~/.maestro` / `.maestro` vs upstream’s `~/.pi` / `.pi`).

## Low-risk upstream improvements we should track

- **Unicode whitespace normalization in hook paths**: upstream normalizes non-breaking / unicode spaces in paths before resolving. This prevents “file not found” issues when users paste paths containing invisible unicode whitespace.

