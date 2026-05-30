import chalk from "chalk";
import { SessionManager } from "../../session/manager.js";
import type { SessionMetadata, SessionSummary } from "../../session/types.js";
import {
	handleExportCommand,
	handleImportCommand,
} from "./session-transfer.js";

const DEFAULT_SESSION_LIMIT = 20;
const MAX_TEXT_SUMMARY_LENGTH = 92;

interface SessionsCommandOptions {
	json?: boolean;
	format?: string;
	redactSecrets?: boolean;
}

type SessionListItem = SessionSummary & {
	path?: string;
};

function trimForDisplay(value: string | undefined, maxLength: number): string {
	const normalized = (value ?? "").replace(/\s+/g, " ").trim();
	if (normalized.length <= maxLength) {
		return normalized;
	}
	return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function formatRelativeAge(isoTimestamp: string): string {
	const timestamp = new Date(isoTimestamp).getTime();
	if (!Number.isFinite(timestamp)) {
		return isoTimestamp;
	}

	const diffMs = Math.max(0, Date.now() - timestamp);
	const minutes = Math.floor(diffMs / 60_000);
	const hours = Math.floor(diffMs / 3_600_000);
	const days = Math.floor(diffMs / 86_400_000);

	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	if (hours < 24) return `${hours}h ago`;
	if (days < 7) return `${days}d ago`;
	return new Date(isoTimestamp).toISOString().slice(0, 10);
}

function toSessionListItem(session: SessionMetadata): SessionListItem {
	return {
		id: session.id,
		subject: session.subject,
		title: session.title ?? session.summary,
		summary: session.summary,
		resumeSummary: session.resumeSummary,
		memoryExtractionHash: session.memoryExtractionHash,
		createdAt: session.created.toISOString(),
		updatedAt: session.modified.toISOString(),
		messageCount: session.messageCount,
		favorite: session.favorite,
		tags: session.tags,
		archived: session.archived,
		archivedAt: session.archivedAt,
		path: session.path,
	};
}

function printSessionTable(sessions: SessionListItem[], heading: string): void {
	if (sessions.length === 0) {
		console.log(chalk.dim(`${heading}: no saved sessions found.`));
		return;
	}

	console.log(chalk.bold(heading));
	for (const session of sessions) {
		const marker = session.favorite ? "* " : "";
		const title = trimForDisplay(
			session.title ?? session.summary ?? session.id,
			MAX_TEXT_SUMMARY_LENGTH,
		);
		const tags =
			session.tags && session.tags.length > 0
				? chalk.dim(` [${session.tags.join(", ")}]`)
				: "";
		const archived = session.archived ? chalk.dim(" [archived]") : "";
		console.log(
			`${marker}${chalk.cyan(session.id)}  ${title}${tags}${archived}`,
		);
		console.log(
			chalk.dim(
				`  updated ${formatRelativeAge(session.updatedAt)} - ${session.messageCount} message${session.messageCount === 1 ? "" : "s"}`,
			),
		);
		if (session.path) {
			console.log(chalk.dim(`  path ${session.path}`));
		}
	}
	console.log(chalk.dim("\nResume with: maestro --session <path>"));
	console.log(
		chalk.dim(
			"Export with: maestro export <session-id> ./session.json --format json --redact-secrets",
		),
	);
}

function searchSessions(
	sessions: SessionMetadata[],
	queryTokens: string[],
): SessionListItem[] {
	return sessions
		.filter((session) => {
			const haystack = [
				session.id,
				session.title,
				session.summary,
				session.resumeSummary,
				session.firstMessage,
				session.allMessagesText,
				...(session.tags ?? []),
			]
				.filter(Boolean)
				.join(" ")
				.toLowerCase();
			return queryTokens.every((token) => haystack.includes(token));
		})
		.slice(0, DEFAULT_SESSION_LIMIT)
		.map(toSessionListItem);
}

function normalizeQuery(messages: string[]): string[] {
	return messages
		.join(" ")
		.toLowerCase()
		.split(/\s+/)
		.map((token) => token.trim())
		.filter(Boolean);
}

function printUsageAndExit(message: string): never {
	console.error(chalk.red(message));
	console.error(
		chalk.dim(
			"Usage: maestro sessions [list|search <query>|export <session-id> [output-path]|import <file>] [--json]",
		),
	);
	process.exit(1);
}

export async function handleSessionsCommand(
	subcommand: string | undefined,
	messages: string[],
	options: SessionsCommandOptions = {},
): Promise<void> {
	const command = subcommand ?? "list";
	switch (command) {
		case "export":
			await handleExportCommand(messages[0], messages[1], options.format, {
				redactSecrets: options.redactSecrets,
			});
			return;
		case "import":
			await handleImportCommand(messages[0]);
			return;
		case "list":
		case "search": {
			const manager = new SessionManager(false);
			try {
				if (command === "list") {
					const sessions = manager
						.loadAllSessions()
						.slice(0, DEFAULT_SESSION_LIMIT)
						.map(toSessionListItem);
					if (options.json) {
						console.log(JSON.stringify({ sessions }, null, 2));
						return;
					}
					printSessionTable(sessions, `Recent sessions (${sessions.length})`);
					return;
				}

				const queryTokens = normalizeQuery(messages);
				if (queryTokens.length === 0) {
					printUsageAndExit("Search query required.");
				}
				const sessions = searchSessions(manager.loadAllSessions(), queryTokens);
				if (options.json) {
					console.log(
						JSON.stringify({ query: messages.join(" "), sessions }, null, 2),
					);
					return;
				}
				printSessionTable(
					sessions,
					`Session search: ${messages.join(" ") || queryTokens.join(" ")}`,
				);
				return;
			} finally {
				manager.disable();
			}
		}
		default:
			printUsageAndExit(`Unknown sessions subcommand: ${command}`);
	}
}
