# Patterns Catalog

Audience: contributors implementing recurring behaviors.  
Nav: [Docs index](../README.md) · [Tools Reference](../TOOLS_REFERENCE.md) · [Safety](../SAFETY.md)

- `event-suppression.md` — Silent mode flag to suppress emissions during internal cleanup. Used by `src/cli-tui/prompt-queue.ts` and interrupt restore paths.
- `determinism-boundaries.md` — Inject clocks/RNG/env to keep agent behavior reproducible and tests stable. Used by `src/utils/clock.ts`, `src/utils/async.ts`, and `src/agent/context-manager.ts`.
- `tool-error-handling.md` — Guidance on when to throw vs. `respond.error()`; referenced by tool implementations in `src/tools/*`.
- `tui-controller-extraction.md` — Pattern for extracting controllers/handlers from TuiRenderer using dependency injection. Used by `src/cli-tui/tui-renderer/` controllers and `src/cli-tui/commands/` handlers.

Add new patterns here with a one-liner, consumer pointers, and link back to the owning code.
