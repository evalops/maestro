import { Box, Column, Text } from "@evalops/tui";
import chalk from "chalk";
import type { SessionManager } from "../../session/manager.js";
import { DynamicBorder } from "../utils/borders.js";
import { SessionDataProvider } from "./session-data-provider.js";
import { SessionList } from "./session-list.js";

/**
 * Component that renders a session selector
 */
export class SessionSelectorComponent extends Column {
	private sessionList: SessionList;

	constructor(
		sessionManager: SessionManager,
		onSelect: (sessionPath: string) => void,
		onCancel: () => void,
	) {
		super([], { gap: 1 });

		const dataProvider = new SessionDataProvider(sessionManager);
		const sessions = dataProvider.loadSessions();

		this.addChild(new Text(chalk.bold("Resume Session"), 1, 0));
		this.addChild(new DynamicBorder());

		// Create session list
		this.sessionList = new SessionList(sessions);
		this.sessionList.onSelect = onSelect;
		this.sessionList.onCancel = onCancel;

		const boxed = new Box([this.sessionList], {
			paddingX: 1,
			paddingY: 0,
			marginY: 0,
			border: "rounded",
		});
		this.addChild(boxed);

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
