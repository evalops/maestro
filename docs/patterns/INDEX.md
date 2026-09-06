# Patterns Catalog

Audience: contributors implementing recurring behaviors.  
Nav: [Docs index](../README.md) · [Tools Reference](../TOOLS_REFERENCE.md) · [Safety](../SAFETY.md)

- `event-suppression.md` — Silent mode flag to suppress emissions during internal cleanup. Pattern remains valid; examples historically referenced the removed TS TUI prompt queue.
- `determinism-boundaries.md` — Inject clocks/RNG/env to keep agent behavior reproducible and tests stable. Used by `src/utils/clock.ts`, `src/utils/async.ts`, and `src/agent/context-manager.ts`.
- `platform-boundary-normalization.md` — Keep Platform wire-shape tolerance inside service clients so server handlers consume stable Maestro-owned types. Used by `src/platform/agent-runtime-client.ts` and A2A/hosted-runner correlation paths.
- `tool-error-handling.md` — Guidance on when to throw vs. `respond.error()`; referenced by tool implementations in `src/tools/*`.
- `tui-controller-extraction.md` — **Historical** extraction pattern for the removed TypeScript `TuiRenderer` (`src/cli-tui`). Interactive UI is now `packages/tui-rs`; see [TUI Architecture](../TUI_ARCHITECTURE.md).

Add new patterns here with a one-liner, consumer pointers, and link back to the owning code.
