/**
 * Prompt queue is generic runtime infrastructure, not TUI-specific.
 * Canonical implementation now lives at `src/runtime/prompt-queue.ts` so
 * non-TUI consumers (e.g. `src/runtime/agent-runtime.ts`) don't need to
 * depend on `src/cli-tui`. This re-export keeps internal TUI imports
 * (`./prompt-queue.js`) working unchanged.
 */
export * from "../runtime/prompt-queue.js";
