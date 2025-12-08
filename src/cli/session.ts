/**
 * @fileoverview CLI Session Selection UI
 *
 * This module provides an interactive terminal UI for selecting and resuming
 * previous Composer sessions. It wraps the TUI session selector component
 * in a Promise-based API for use in CLI flows.
 *
 * ## Usage
 *
 * The `selectSession` function is invoked when:
 * - User runs `composer --resume` or `composer -r`
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
import { ProcessTerminal, TUI } from "@evalops/tui";
import type { SessionManager } from "../session/manager.js";
import { SessionSelectorComponent } from "../tui/session/session-selector.js";

/**
 * Opens an interactive session selector in the terminal.
 *
 * This function creates a temporary TUI instance to display a list of
 * available sessions. The user can navigate and select a session to resume,
 * or cancel to return to the CLI.
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
	return new Promise((resolve) => {
		const ui = new TUI(new ProcessTerminal());
		let resolved = false;

		const selector = new SessionSelectorComponent(
			sessionManager,
			(path: string) => {
				if (!resolved) {
					resolved = true;
					ui.stop();
					resolve(path);
				}
			},
			() => {
				if (!resolved) {
					resolved = true;
					ui.stop();
					resolve(null);
				}
			},
		);

		ui.addChild(selector);
		ui.setFocus(selector.getSessionList());
		ui.start();
	});
}
