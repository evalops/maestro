import { type Stats, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { AppMessage } from "../agent/types.js";
import { SESSION_CONFIG } from "../config/constants.js";
import { createLogger } from "../utils/logger.js";
import { scheduleSessionMigration } from "./migration.js";
import {
	buildSessionFileInfo,
	safeReadSessionEntries,
} from "./session-context.js";
import type { SessionMetadata, SessionSummary } from "./types.js";

const logger = createLogger("session-catalog");

type SessionCatalogOptions = {
	sessionDir: string;
	beforeRead?: () => void;
	getCurrentSessionId?: () => string | undefined;
};

type SessionFileEntry = {
	filePath: string;
	modifiedAt: Date;
	stats: Stats;
};

export interface LoadedSessionData {
	id: string;
	subject?: string;
	title?: string;
	resumeSummary?: string;
	messages: AppMessage[];
	createdAt: string;
	updatedAt: string;
	messageCount: number;
	favorite: boolean;
	tags?: string[];
}

function getSortedSessionFiles(sessionDir: string): SessionFileEntry[] {
	return readdirSync(sessionDir)
		.filter((fileName) => fileName.endsWith(".jsonl"))
		.map((fileName) => {
			const filePath = join(sessionDir, fileName);
			const stats: Stats = statSync(filePath);
			return { filePath, modifiedAt: stats.mtime, stats };
		})
		.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
}

export class SessionCatalog {
	constructor(private readonly options: SessionCatalogOptions) {}

	loadAllSessions(): SessionMetadata[] {
		this.options.beforeRead?.();
		scheduleSessionMigration();
		const sessions: SessionMetadata[] = [];

		try {
			const files = getSortedSessionFiles(this.options.sessionDir);

			for (const fileEntry of files) {
				const { filePath, stats } = fileEntry;
				try {
					const entries = safeReadSessionEntries(filePath, (error) => {
						logger.error(
							`Failed to read session file ${filePath}`,
							error instanceof Error ? error : undefined,
						);
					});
					const info = buildSessionFileInfo(entries, stats);
					if (!info) {
						continue;
					}
					const derivedSummary =
						info.summary || info.firstMessage || "(no summary)";

					sessions.push({
						path: filePath,
						id: info.id,
						subject: info.subject,
						created: info.created,
						modified: stats.mtime,
						size: stats.size,
						messageCount: info.messageCount,
						firstMessage: info.firstMessage || "(no messages)",
						summary: derivedSummary,
						resumeSummary: info.resumeSummary,
						favorite: info.favorite,
						allMessagesText: info.allMessagesText,
					});
				} catch (error) {
					logger.error(
						`Failed to process session file ${filePath}`,
						error instanceof Error ? error : undefined,
					);
				}
			}
		} catch (error) {
			logger.error(
				"Failed to load sessions",
				error instanceof Error ? error : undefined,
			);
		}

		return sessions;
	}

	getSessionFileById(sessionId: string): string | null {
		const match = this.loadAllSessions().find(
			(session) => session.id === sessionId,
		);
		return match?.path ?? null;
	}

	listSessions(options?: {
		limit?: number;
		offset?: number;
	}): SessionSummary[] {
		this.options.beforeRead?.();
		const sessions: SessionSummary[] = [];
		const sortedFiles = getSortedSessionFiles(this.options.sessionDir);
		const offset = Math.max(0, options?.offset ?? 0);
		const limit = Math.max(1, options?.limit ?? sortedFiles.length);

		for (const [index, entry] of sortedFiles.entries()) {
			if (index < offset) continue;
			if (sessions.length >= limit) break;
			const { filePath, stats } = entry;

			try {
				const entries = safeReadSessionEntries(filePath);
				const info = buildSessionFileInfo(entries, stats);
				if (!info) continue;

				sessions.push({
					id: info.id,
					subject: info.subject,
					title: info.title ?? info.summary,
					resumeSummary: info.resumeSummary,
					createdAt: info.created.toISOString(),
					updatedAt: stats.mtime.toISOString(),
					messageCount: info.messageCount,
					favorite: info.favorite,
					tags: info.tags,
				});
			} catch {
				// Skip files that can't be read
			}
		}

		return sessions;
	}

	loadSession(sessionId: string): LoadedSessionData | null {
		this.options.beforeRead?.();
		const sessionFile = this.getSessionFileById(sessionId);
		if (!sessionFile) {
			return null;
		}

		const stats = statSync(sessionFile);
		const entries = safeReadSessionEntries(sessionFile);
		const info = buildSessionFileInfo(entries, stats);
		if (!info) {
			return null;
		}

		return {
			id: info.id,
			subject: info.subject,
			title: info.title ?? info.summary,
			resumeSummary: info.resumeSummary,
			messages: info.messages,
			createdAt: info.created.toISOString(),
			updatedAt: stats.mtime.toISOString(),
			messageCount: info.messageCount,
			favorite: info.favorite,
			tags: info.tags,
		};
	}

	deleteSession(sessionId: string): void {
		const sessionFile = this.getSessionFileById(sessionId);
		if (!sessionFile) {
			throw new Error(`Session ${sessionId} not found`);
		}

		unlinkSync(sessionFile);
	}

	pruneSessions(): { removed: number; errors: number } {
		const maxSessions = SESSION_CONFIG.MAX_SESSIONS;
		const maxAgeDays = SESSION_CONFIG.MAX_SESSION_AGE_DAYS;

		if (maxSessions <= 0 && maxAgeDays <= 0) {
			return { removed: 0, errors: 0 };
		}

		const sessions = this.loadAllSessions();
		const currentSessionId = this.options.getCurrentSessionId?.();
		const now = Date.now();
		const maxAgeMs = maxAgeDays > 0 ? maxAgeDays * 24 * 60 * 60 * 1000 : 0;
		const toRemove: SessionMetadata[] = [];

		if (maxAgeMs > 0) {
			for (const session of sessions) {
				if (session.favorite) continue;
				if (session.id === currentSessionId) continue;
				if (now - session.modified.getTime() > maxAgeMs) {
					toRemove.push(session);
				}
			}
		}

		if (maxSessions > 0) {
			const eligible = sessions.filter(
				(session) =>
					!session.favorite &&
					session.id !== currentSessionId &&
					!toRemove.some((removedSession) => removedSession.id === session.id),
			);
			if (eligible.length > maxSessions) {
				toRemove.push(...eligible.slice(maxSessions));
			}
		}

		let removed = 0;
		let errors = 0;
		for (const session of toRemove) {
			try {
				unlinkSync(session.path);
				removed++;
			} catch {
				errors++;
			}
		}

		return { removed, errors };
	}
}
