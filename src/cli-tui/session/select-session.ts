/**
 * Interactive session selection for `maestro --resume` / `maestro -r`.
 *
 * Lives under the interactive terminal UI tree so the thin CLI facade at
 * `src/cli/session.ts` can lazy-load it without taking a static dependency
 * on the terminal UI package.
 */
import { ProcessTerminal, TUI } from "@evalops/tui";
import type { SessionManager } from "../../session/manager.js";
import { SessionSelectorComponent } from "./session-selector.js";

/**
 * Opens an interactive session selector in the terminal.
 *
 * @param sessionManager - Session manager for loading session metadata
 * @returns Selected session path, or null if cancelled
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
