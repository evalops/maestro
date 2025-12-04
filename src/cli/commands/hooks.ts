import chalk from "chalk";
import {
	cleanupAsyncHooks,
	getAsyncHookCount,
	getHookConcurrencySnapshot,
} from "../../hooks/index.js";

export async function handleHooksCommand(subcommand?: string): Promise<void> {
	if (subcommand && subcommand !== "status") {
		console.error(chalk.red(`Unknown hooks subcommand: ${subcommand}`));
		console.error(chalk.dim("Try: composer hooks status"));
		process.exit(1);
	}

	// Ensure stale async entries are swept before reporting
	cleanupAsyncHooks();

	const concurrency = getHookConcurrencySnapshot();
	const asyncInFlight = getAsyncHookCount();

	const rows: Array<[string, string | number]> = [
		["Max concurrency", concurrency.max || "unlimited"],
		["Active slots", concurrency.active],
		["Queued requests", concurrency.queued],
		["Async in-flight", asyncInFlight],
	];

	console.log(chalk.bold("Hook Status"));
	for (const [label, value] of rows) {
		const padded = label.padEnd(18);
		console.log(`${chalk.cyan(padded)} ${value}`);
	}
}
