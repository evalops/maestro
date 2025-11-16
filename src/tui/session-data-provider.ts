import type { SessionManager } from "../session-manager.js";

export interface SessionItem {
	path: string;
	id: string;
	created: Date;
	modified: Date;
	size: number;
	messageCount: number;
	firstMessage: string;
	summary: string;
	favorite: boolean;
	allMessagesText: string;
}

export class SessionDataProvider {
	constructor(private readonly manager: SessionManager) {}

	private cache?: { timestamp: number; sessions: SessionItem[] };

	loadSessions(forceRefresh = false): SessionItem[] {
		if (!forceRefresh && this.cache) {
			return this.cache.sessions;
		}
		const sessions = this.manager.loadAllSessions();
		this.cache = { timestamp: Date.now(), sessions };
		return sessions;
	}

	refresh(): SessionItem[] {
		this.cache = undefined;
		return this.loadSessions(true);
	}

	toggleFavorite(sessionPath: string, favorite: boolean): void {
		this.manager.setSessionFavorite(sessionPath, favorite);
		this.cache = undefined;
	}
}
