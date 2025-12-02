# Patterns Catalog

Audience: contributors implementing recurring behaviors.  
Nav: [Docs index](../README.md) · [Tools Reference](../TOOLS_REFERENCE.md) · [Safety](../SAFETY.md)

- `event-suppression.md` — Silent mode flag to suppress emissions during internal cleanup. Used by `src/tui/prompt-queue.ts` and interrupt restore paths.
- `tool-error-handling.md` — Guidance on when to throw vs. `respond.error()`; referenced by tool implementations in `src/tools/*`.

Add new patterns here with a one-liner, consumer pointers, and link back to the owning code.
