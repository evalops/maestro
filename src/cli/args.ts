export type Mode = "text" | "json" | "rpc";

export interface Args {
	provider?: string;
	model?: string;
	modelsFile?: string;
	apiKey?: string;
	systemPrompt?: string;
	continue?: boolean;
	resume?: boolean;
	help?: boolean;
	mode?: Mode;
	noSession?: boolean;
	session?: string;
	safeMode?: boolean;
	command?: string;
	subcommand?: string;
	approvalMode?: "auto" | "prompt" | "fail";
	messages: string[];
}

export function parseArgs(args: string[]): Args {
	const result: Args = {
		messages: [],
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];

		if (arg === "--help" || arg === "-h") {
			result.help = true;
		} else if (arg === "--mode" && i + 1 < args.length) {
			const mode = args[++i];
			if (mode === "text" || mode === "json" || mode === "rpc") {
				result.mode = mode;
			}
		} else if (arg === "--continue" || arg === "-c") {
			result.continue = true;
		} else if (arg === "--resume" || arg === "-r") {
			result.resume = true;
		} else if (arg === "--provider" && i + 1 < args.length) {
			result.provider = args[++i];
		} else if (arg === "--model" && i + 1 < args.length) {
			result.model = args[++i];
		} else if (arg === "--models-file" && i + 1 < args.length) {
			result.modelsFile = args[++i];
		} else if (arg === "--api-key" && i + 1 < args.length) {
			result.apiKey = args[++i];
		} else if (arg === "--system-prompt" && i + 1 < args.length) {
			result.systemPrompt = args[++i];
		} else if (arg === "--no-session") {
			result.noSession = true;
		} else if (arg === "--session" && i + 1 < args.length) {
			result.session = args[++i];
		} else if (arg === "--safe-mode") {
			result.safeMode = true;
		} else if (arg === "--approval-mode" && i + 1 < args.length) {
			const mode = args[++i];
			if (mode === "auto" || mode === "prompt" || mode === "fail") {
				result.approvalMode = mode;
			}
		} else if (!arg.startsWith("-")) {
			// Handle commands: "config", "models", "cost", etc.
			if (
				!result.command &&
				(arg === "config" || arg === "models" || arg === "cost")
			) {
				result.command = arg;
				// Check for subcommand
				if (i + 1 < args.length && !args[i + 1].startsWith("-")) {
					result.subcommand = args[++i];
				}
			} else {
				result.messages.push(arg);
			}
		}
	}

	return result;
}
