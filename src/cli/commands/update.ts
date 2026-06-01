import chalk from "chalk";
import { getPackageVersion } from "../../package-metadata.js";
import { type UpdateCheckResult, checkForUpdate } from "../../update/check.js";
import {
	type StartupUpdateOutcome,
	attemptStartupUpdate,
} from "../../update/startup-refresh.js";

interface ParsedUpdateArgs {
	check: boolean;
	help: boolean;
	json: boolean;
}

interface UpdateCommandDeps {
	attemptStartupUpdateImpl?: typeof attemptStartupUpdate;
	checkForUpdateImpl?: typeof checkForUpdate;
	currentVersion?: string;
	env?: NodeJS.ProcessEnv;
	isTty?: boolean;
}

const STARTUP_UPDATE_SKIP_ENV = "MAESTRO_SKIP_STARTUP_UPDATE";
const STARTUP_UPDATE_MODE_ENV = "MAESTRO_STARTUP_UPDATE";
const STARTUP_UPDATE_RETRY_ENV = "MAESTRO_STARTUP_UPDATE_RETRY_MS";

function parseUpdateArgs(args: string[]): ParsedUpdateArgs | { error: string } {
	const parsed: ParsedUpdateArgs = {
		check: false,
		help: false,
		json: false,
	};

	for (const arg of args) {
		switch (arg) {
			case "--check":
				parsed.check = true;
				break;
			case "--json":
				parsed.json = true;
				break;
			case "--help":
			case "-h":
				parsed.help = true;
				break;
			default:
				return { error: `Unknown maestro update option: ${arg}` };
		}
	}

	return parsed;
}

function printUpdateHelp(): void {
	console.log(`Usage: maestro update [--check] [--json]

Options:
  --check   Check for the newest Maestro version without installing it
  --json    Print machine-readable update status
  --help    Show this help`);
}

function printJson(value: unknown): void {
	console.log(JSON.stringify(value, null, 2));
}

function formatCheckMessage(check: UpdateCheckResult): string {
	if (check.error) {
		return `Maestro update check failed: ${check.error}`;
	}
	if (check.isUpdateAvailable && check.latestVersion) {
		return `Maestro ${check.latestVersion} is available (current ${check.currentVersion}).`;
	}
	return `Maestro is up to date (${check.currentVersion}).`;
}

function installEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const nextEnv = { ...env };
	delete nextEnv[STARTUP_UPDATE_SKIP_ENV];
	delete nextEnv[STARTUP_UPDATE_MODE_ENV];
	delete nextEnv.CI;
	delete nextEnv.NODE_ENV;
	nextEnv[STARTUP_UPDATE_RETRY_ENV] = "0";
	return nextEnv;
}

function jsonForOutcome(outcome: StartupUpdateOutcome) {
	const check = "check" in outcome ? outcome.check : undefined;
	return {
		status: outcome.status,
		reason: "reason" in outcome ? outcome.reason : undefined,
		error: "error" in outcome ? outcome.error : undefined,
		exitCode: "exitCode" in outcome ? outcome.exitCode : undefined,
		currentVersion: check?.currentVersion,
		latestVersion: check?.latestVersion,
		sourceUrl: check?.sourceUrl,
	};
}

export async function handleUpdateCommand(
	commandArgs: string[] = [],
	deps: UpdateCommandDeps = {},
): Promise<void> {
	const parsed = parseUpdateArgs(commandArgs);
	if ("error" in parsed) {
		console.error(chalk.red(parsed.error));
		process.exitCode = 1;
		return;
	}
	if (parsed.help) {
		printUpdateHelp();
		return;
	}

	const currentVersion = deps.currentVersion ?? getPackageVersion();
	const env = deps.env ?? process.env;

	if (parsed.check) {
		const check = await (deps.checkForUpdateImpl ?? checkForUpdate)(
			currentVersion,
		);
		if (parsed.json) {
			printJson({
				status: check.error
					? "failed"
					: check.isUpdateAvailable
						? "available"
						: "current",
				currentVersion: check.currentVersion,
				latestVersion: check.latestVersion,
				sourceUrl: check.sourceUrl,
				error: check.error,
			});
		} else if (check.error) {
			console.error(chalk.red(formatCheckMessage(check)));
		} else {
			console.log(formatCheckMessage(check));
		}
		if (check.error) {
			process.exitCode = 1;
		}
		return;
	}

	const outcome = await (deps.attemptStartupUpdateImpl ?? attemptStartupUpdate)(
		{
			args: [],
			currentVersion,
			env: installEnv(env),
			isTty: deps.isTty ?? true,
			restart: false,
		},
	);

	if (parsed.json) {
		printJson(jsonForOutcome(outcome));
	} else {
		switch (outcome.status) {
			case "updated":
				console.log(
					chalk.green(
						`Updated Maestro to ${outcome.check.latestVersion ?? "the latest version"}.`,
					),
				);
				break;
			case "current":
				console.log(formatCheckMessage(outcome.check));
				break;
			case "available":
				console.log(
					`Maestro ${outcome.check.latestVersion ?? "update"} is available, but automatic install was not attempted.`,
				);
				break;
			case "skipped":
				console.error(
					chalk.yellow(`Maestro update skipped: ${outcome.reason}.`),
				);
				break;
			case "failed":
				console.error(chalk.red(`Maestro update failed: ${outcome.error}`));
				break;
			case "restarted":
				console.log(
					chalk.green(
						`Updated Maestro to ${outcome.check.latestVersion ?? "the latest version"}.`,
					),
				);
				break;
		}
	}

	if (outcome.status === "failed" || outcome.status === "skipped") {
		process.exitCode = 1;
	}
}
