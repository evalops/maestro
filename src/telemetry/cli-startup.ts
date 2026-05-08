import { emitBeacon } from "./beacon.js";
import { getGlobalCliCommandAggregator } from "./cli-command-aggregator.js";

export interface CliStartupArgs {
	command?: string;
	subcommand?: string;
	version?: boolean;
	help?: boolean;
	error?: string;
	headless?: boolean;
	mode?: "text" | "json" | "rpc" | "headless";
	messages: string[];
}

export interface RecordCliStartupTelemetryOptions {
	args: CliStartupArgs;
	clientVersion: string;
	commandCountLockTimeoutMs?: number;
	rawArgs?: string[];
	now?: () => number;
	env?: NodeJS.ProcessEnv;
}

export function cliCommandName(args: CliStartupArgs): string {
	if (args.version) {
		return "version";
	}
	if (args.help) {
		return "help";
	}
	if (args.error) {
		return "parse_error";
	}
	if (args.command) {
		return args.subcommand
			? `${args.command}.${args.subcommand}`
			: args.command;
	}
	if (args.headless || args.mode === "headless") {
		return "headless";
	}
	if (args.mode === "rpc") {
		return "rpc";
	}
	if (args.messages.length > 0) {
		return args.mode === "json" ? "prompt.json" : "prompt.text";
	}
	return "interactive";
}

export async function recordCliStartupTelemetry(
	options: RecordCliStartupTelemetryOptions,
): Promise<void> {
	const env = options.env ?? process.env;
	const now = options.now ?? Date.now;
	const command = cliCommandName(options.args);
	const mode = cliStartupMode(options.args, command);
	await Promise.all([
		emitBeacon(
			{
				feature: "cli.startup",
				action: command,
				timestamp: now() * 1000,
				source: {
					client: "cli",
					clientVersion: options.clientVersion,
					surface:
						options.args.headless || options.args.mode === "headless"
							? "headless"
							: "cli",
				},
				parameters: {
					metadata: {
						command,
						mode,
						hasPrompt: options.args.messages.length > 0,
						argCount: options.rawArgs?.length ?? 0,
					},
				},
			},
			{ env },
		).catch(() => false),
		getGlobalCliCommandAggregator({
			clientVersion: options.clientVersion,
			env,
			lockTimeoutMs: options.commandCountLockTimeoutMs,
			now,
		})
			.submit(command)
			.catch(() => undefined),
	]);
}

function cliStartupMode(args: CliStartupArgs, command: string): string {
	if (args.mode) {
		return args.mode;
	}
	if (args.headless) {
		return "headless";
	}
	if (command === "prompt.text") {
		return "text";
	}
	if (command === "prompt.json") {
		return "json";
	}
	return "interactive";
}
