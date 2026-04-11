import { resolve } from "node:path";
import chalk from "chalk";
import { exportSessionToJsonl } from "../../export-html.js";
import { SessionManager } from "../../session/manager.js";

const JSONL_FORMAT = "jsonl";

function exitWithUsage(message: string, usage: string): never {
	console.error(chalk.red(message));
	console.error(chalk.dim(usage));
	process.exit(1);
}

export async function handleExportCommand(
	sessionId?: string,
	outputPath?: string,
	format?: string,
): Promise<void> {
	if (!sessionId) {
		exitWithUsage(
			"Session id required.",
			"Usage: maestro export <session-id> [output-path] --format jsonl",
		);
	}

	const normalizedFormat = (format ?? JSONL_FORMAT).toLowerCase();
	if (normalizedFormat !== JSONL_FORMAT) {
		exitWithUsage(
			`Unsupported export format: ${format}`,
			"Supported formats: jsonl",
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
	const exportedPath = await exportSessionToJsonl(exportManager, outputPath);

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
			"Usage: maestro import <file.jsonl>",
		);
	}

	const sessionManager = new SessionManager(false);
	const imported = sessionManager.importSessionJsonl(sourcePath);

	console.log(
		chalk.green(
			`Imported session ${imported.sessionId} from ${resolve(sourcePath)}.`,
		),
	);
	console.log(chalk.dim(`Stored at ${imported.sessionFile}`));
}
