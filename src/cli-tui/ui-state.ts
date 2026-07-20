/**
 * UI preference state is shared config, not TUI-specific.
 * Canonical implementation lives at `src/config/ui-state.ts` so non-TUI
 * consumers (server handlers, web UI store) don't need to depend on this
 * package tree. This re-export keeps internal TUI imports (`./ui-state.js`)
 * working unchanged.
 */
export * from "../config/ui-state.js";
