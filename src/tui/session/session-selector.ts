import { Container, Spacer, Text } from "@evalops/tui";
import chalk from "chalk";
import type { SessionManager } from "../../session/manager.js";
import { DynamicBorder } from "../utils/borders.js";
import { SessionDataProvider } from "./session-data-provider.js";
import { SessionList } from "./session-list.js";

/**
 * Component that renders a session selector
 */
export class SessionSelectorComponent extends Container {
	private sessionList: SessionList;

	constructor(
		sessionManager: SessionManager,
		onSelect: (sessionPath: string) => void,
		onCancel: () => void,
	) {
		super();

		const dataProvider = new SessionDataProvider(sessionManager);
		const sessions = dataProvider.loadSessions();

		// Add header
		this.addChild(new Spacer(1));
		this.addChild(new Text(chalk.bold("Resume Session"), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		// Create session list
		this.sessionList = new SessionList(sessions);
		this.sessionList.onSelect = onSelect;
		this.sessionList.onCancel = onCancel;

		this.addChild(this.sessionList);

		// Add bottom border
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		// Auto-cancel if no sessions
		if (sessions.length === 0) {
			setTimeout(() => onCancel(), 100);
		}
	}

	getSessionList(): SessionList {
		return this.sessionList;
	}
}
