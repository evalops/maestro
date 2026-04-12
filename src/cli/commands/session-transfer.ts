import { resolve } from "node:path";
import chalk from "chalk";
import {
	exportSessionToJson,
	exportSessionToJsonl,
} from "../../export-html.js";
import { SessionManager } from "../../session/manager.js";

const JSONL_FORMAT = "jsonl";
const JSON_FORMAT = "json";
const SUPPORTED_EXPORT_FORMATS = new Set([JSON_FORMAT, JSONL_FORMAT]);

function exitWithUsage(message: string, usage: string): never {
	console.error(chalk.red(message));
	console.error(chalk.dim(usage));
	process.exit(1);
}

export async function handleExportCommand(
	sessionId?: string,
	outputPath?: string,
	format?: string,
	options: { redactSecrets?: boolean } = {},
): Promise<void> {
	if (!sessionId) {
		exitWithUsage(
			"Session id required.",
			"Usage: maestro export <session-id> [output-path] --format json|jsonl [--redact-secrets]",
		);
	}

	const normalizedFormat = (format ?? JSONL_FORMAT).toLowerCase();
	if (!SUPPORTED_EXPORT_FORMATS.has(normalizedFormat)) {
		exitWithUsage(
			`Unsupported export format: ${format}`,
			"Supported formats: json, jsonl",
		);
	}

	const lookupManager = new SessionManager(false);
	const sessionFile = lookupManager.getSessionFileById(sessionId);
	if (!sessionFile) {
		exitWithUsage(
			`Session not found: ${sessionId}`,
			"Run `maestro --continue` or `/sessions` to discover saved session ids.",
		);
	}

	const exportManager = new SessionManager(false, sessionFile);
	const exportedPath =
		normalizedFormat === JSON_FORMAT
			? await exportSessionToJson(exportManager, outputPath, options)
			: await exportSessionToJsonl(exportManager, outputPath, options);

	console.log(
		chalk.green(
			`Exported session ${sessionId} to ${resolve(exportedPath)} (${normalizedFormat}).`,
		),
	);
}

export async function handleImportCommand(sourcePath?: string): Promise<void> {
	if (!sourcePath) {
		exitWithUsage(
			"Import file required.",
			"Usage: maestro import <file.json|file.jsonl>",
		);
	}

	const sessionManager = new SessionManager(false);
	const imported = sessionManager.importPortableSession(sourcePath);

	console.log(
		chalk.green(
			imported.importedCount > 1
				? `Imported ${imported.importedCount} sessions from ${resolve(sourcePath)}. Active session: ${imported.sessionId}.`
				: `Imported session ${imported.sessionId} from ${resolve(sourcePath)}.`,
		),
	);
	console.log(chalk.dim(`Stored at ${imported.sessionFile}`));
}
