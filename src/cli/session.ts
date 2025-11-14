import type { SessionManager } from "../session-manager.js";
import { ProcessTerminal, TUI } from "../tui-lib/index.js";
import { SessionSelectorComponent } from "../tui/session-selector.js";

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
