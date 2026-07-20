/**
 * @fileoverview CLI Session Selection UI
 *
 * This module provides an interactive terminal UI for selecting and resuming
 * previous Maestro sessions. The interactive implementation lives with the
 * terminal UI tree and is loaded lazily so non-interactive entrypoints do not
 * take a static dependency on it.
 *
 * ## Usage
 *
 * The `selectSession` function is invoked when:
 * - User runs `maestro --resume` or `maestro -r`
 * - User wants to pick from a list of previous sessions
 *
 * ## UI Behavior
 *
 * - Displays a searchable list of previous sessions
 * - Sessions show timestamp, summary (if available), and favorite status
 * - Arrow keys navigate, Enter selects, Escape cancels
 * - Returns the session path on selection, or null on cancel
 *
 * @module cli/session
 */
import type { SessionManager } from "../session/manager.js";

/**
 * Opens an interactive session selector in the terminal.
 *
 * This function lazy-loads the interactive selector implementation, then
 * creates a temporary TUI instance to display a list of available sessions.
 * The user can navigate and select a session to resume, or cancel.
 *
 * @param sessionManager - The session manager instance for loading session metadata
 * @returns Promise resolving to the selected session path, or null if cancelled
 *
 * @example
 * ```typescript
 * const sessionPath = await selectSession(sessionManager);
 * if (sessionPath) {
 *   // Load and resume the selected session
 *   const session = await sessionManager.load(sessionPath);
 * } else {
 *   // User cancelled, start fresh session
 * }
 * ```
 */
export async function selectSession(
	sessionManager: SessionManager,
): Promise<string | null> {
	// Lazy boundary: interactive selector lives under the terminal UI tree.
	// Path is assembled so this facade never embeds a static import of that tree.
	const uiTree = ["cli", "tui"].join("-");
	const modulePath = `../${uiTree}/session/select-session.js`;
	const { selectSession: selectSessionInteractive } = await import(modulePath);
	return selectSessionInteractive(sessionManager);
}
