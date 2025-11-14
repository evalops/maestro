import type { SessionManager } from "../session-manager.js";

export interface SessionItem {
	path: string;
	id: string;
	created: Date;
	modified: Date;
	messageCount: number;
	firstMessage: string;
	allMessagesText: string;
}

export class SessionDataProvider {
	constructor(private readonly manager: SessionManager) {}

	loadSessions(): SessionItem[] {
		return this.manager.loadAllSessions();
	}
}
