export type Mode = "text" | "json" | "rpc" | "headless";

export interface Args {
	provider?: string;
	model?: string;
	taskBudget?: number;
	error?: string;
	modelsFile?: string;
	apiKey?: string;
	systemPrompt?: string;
	appendSystemPrompt?: string;
	/** Port for `maestro web` (defaults to PORT env or 8080) */
	port?: number;
	continue?: boolean;
	resume?: boolean;
	help?: boolean;
	version?: boolean;
	mode?: Mode;
	/** Run in headless mode for native TUI communication */
	headless?: boolean;
	noSession?: boolean;
	session?: string;
	safeMode?: boolean;
	command?: string;
	subcommand?: string;
	/** Raw arguments owned by command-group handlers. */
	commandArgs?: string[];
	contextLiveMcp?: boolean;
	approvalMode?: "auto" | "prompt" | "fail";
	authMode?: "auto" | "api-key" | "claude";
	force?: boolean;
	execJson?: boolean;
	execFullAuto?: boolean;
	execReadOnly?: boolean;
	/** Sandbox backend or policy mode */
	sandbox?: string;
	execOutputSchema?: string;
	execOutputLast?: string;
	execResumeId?: string;
	execUseLast?: boolean;
	models?: string[];
	tools?: string[];
	messages: string[];
	/** TOML config profile to activate */
	profile?: string;
	/** CLI config overrides in key=value format */
	configOverrides?: string[];
	/** Start in read-only mode (activates explore composer) */
	readonly?: boolean;
	/** Composer profile to activate on startup */
	composer?: string;
	exportFormat?: string;
	redactSecrets?: boolean;
}

const COMMANDS = new Set([
	"config",
	"context",
	"models",
	"cost",
	"stats",
	"status",
	"run",
	"agents",
	"exec",
	"web",
	"hosted-runner",
	"init",
	"anthropic",
	"evalops",
	"openai",
	"codex",
	"hooks",
	"memory",
	"remote",
	"export",
	"import",
]);
const SUBCOMMAND_COMMANDS = new Set([
	"config",
	"context",
	"models",
	"cost",
	"stats",
	"run",
	"agents",
	"anthropic",
	"evalops",
	"openai",
	"codex",
	"hooks",
	"memory",
	"remote",
]);

const FLAGS_WITH_VALUES = new Set([
	"--mode",
	"--provider",
	"--model",
	"-m",
	"--task-budget",
	"--models",
	"--models-file",
	"--api-key",
	"--port",
	"--system-prompt",
	"--append-system-prompt",
	"--session",
	"--approval-mode",
	"--auth",
	"--sandbox",
	"--output-schema",
	"--output-last-message",
	"--tools",
	"--composer",
	"--format",
	"--profile",
	"--config",
]);

const DEPRECATED_FLAGS_WITH_VALUES = new Set(["--codex-api-key"]);
const DEPRECATED_FLAG_PREFIXES = ["--auth=chatgpt"];

function isConfigInitPresetFlag(result: Args, arg: string): boolean {
	return (
		result.command === "config" &&
		result.subcommand === "init" &&
		(arg === "--preset" || arg === "-p")
	);
}

function nextNonFlagToken(args: string[], start: number): string | undefined {
	for (let index = start; index < args.length; index++) {
		const token = args[index];
		if (!token) continue;
		if (!token.startsWith("-")) {
			return token;
		}
		if (FLAGS_WITH_VALUES.has(token) && index + 1 < args.length) {
			index++;
		}
	}
	return undefined;
}

export function parseArgs(args: string[]): Args {
	const result: Args = {
		messages: [],
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];

		if (arg === "--help" || arg === "-h") {
			result.help = true;
		} else if (arg === "--version" || arg === "-v") {
			result.version = true;
		} else if (arg?.startsWith("--mode=")) {
			const mode = arg.slice("--mode=".length);
			if (
				mode === "text" ||
				mode === "json" ||
				mode === "rpc" ||
				mode === "headless"
			) {
				result.mode = mode;
				if (mode === "headless") {
					result.headless = true;
				}
			}
		} else if (arg === "--mode" && i + 1 < args.length) {
			const mode = args[++i];
			if (
				mode === "text" ||
				mode === "json" ||
				mode === "rpc" ||
				mode === "headless"
			) {
				result.mode = mode;
				if (mode === "headless") {
					result.headless = true;
				}
			}
		} else if (arg === "--headless") {
			result.headless = true;
			result.mode = "headless";
		} else if (arg === "--continue" || arg === "-c") {
			result.continue = true;
		} else if (arg === "--resume" || arg === "-r") {
			if (result.command === "exec") {
				const nextArg = args[i + 1];
				if (i + 1 < args.length && nextArg && !nextArg.startsWith("-")) {
					result.execResumeId = nextArg;
					i++;
				} else {
					result.execUseLast = true;
				}
			} else {
				result.resume = true;
			}
		} else if (arg === "--provider" && i + 1 < args.length) {
			result.provider = args[++i];
		} else if ((arg === "--model" || arg === "-m") && i + 1 < args.length) {
			result.model = args[++i];
		} else if (arg === "--task-budget") {
			const rawValue = args[i + 1];
			if (
				rawValue === undefined ||
				(rawValue.startsWith("-") && Number.isNaN(Number(rawValue)))
			) {
				result.error = "--task-budget requires a value";
				continue;
			}

			i++;
			const value = Number(rawValue);
			if (Number.isInteger(value) && value > 0) {
				result.taskBudget = value;
			} else {
				result.error = "--task-budget must be a positive integer";
			}
		} else if (arg === "--models" && i + 1 < args.length) {
			const modelsArg = args[++i]!;
			const patterns = modelsArg
				.split(",")
				.map((value) => value.trim())
				.filter((value) => value.length > 0);
			if (patterns.length > 0) {
				result.models = patterns;
			}
		} else if (arg === "--models-file" && i + 1 < args.length) {
			result.modelsFile = args[++i];
		} else if (arg === "--api-key" && i + 1 < args.length) {
			result.apiKey = args[++i];
		} else if (arg === "--port" && i + 1 < args.length) {
			const value = Number.parseInt(args[++i] ?? "", 10);
			if (Number.isFinite(value) && value > 0 && value < 65536) {
				result.port = value;
			}
		} else if (arg === "--system-prompt" && i + 1 < args.length) {
			result.systemPrompt = args[++i];
		} else if (arg === "--append-system-prompt" && i + 1 < args.length) {
			result.appendSystemPrompt = args[++i];
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
		} else if (arg === "--auth" && i + 1 < args.length) {
			const value = args[++i];
			if (value === "auto" || value === "api-key" || value === "claude") {
				result.authMode = value;
			}
		} else if (arg === "--force") {
			result.force = true;
		} else if (arg === "--json") {
			result.execJson = true;
		} else if (arg === "--full-auto") {
			result.execFullAuto = true;
		} else if (arg === "--read-only") {
			result.execReadOnly = true;
		} else if (arg === "--sandbox" && i + 1 < args.length) {
			result.sandbox = args[++i];
		} else if (arg === "--output-schema" && i + 1 < args.length) {
			result.execOutputSchema = args[++i];
		} else if (arg === "--output-last-message" && i + 1 < args.length) {
			result.execOutputLast = args[++i];
		} else if (arg === "--last" && result.command === "exec") {
			result.execUseLast = true;
		} else if (arg === "--tools" && i + 1 < args.length) {
			const toolsArg = args[++i]!;
			const toolNames = toolsArg
				.split(",")
				.map((value) => value.trim())
				.filter((value) => value.length > 0);
			if (toolNames.length > 0) {
				result.tools = toolNames;
			}
		} else if (arg === "--readonly" || arg === "--read-only-mode") {
			result.readonly = true;
		} else if (arg === "--composer" && i + 1 < args.length) {
			result.composer = args[++i];
		} else if (arg === "--format" && i + 1 < args.length) {
			result.exportFormat = args[++i];
		} else if (arg === "--redact-secrets") {
			result.redactSecrets = true;
		} else if (arg === "--live-mcp") {
			result.contextLiveMcp = true;
		} else if (arg === "--profile" && i + 1 < args.length) {
			result.profile = args[++i];
		} else if (arg === "--config" && i + 1 < args.length) {
			// Config overrides in key=value format
			const override = args[++i]!;
			if (!result.configOverrides) {
				result.configOverrides = [];
			}
			result.configOverrides.push(override);
		} else if (arg && DEPRECATED_FLAGS_WITH_VALUES.has(arg)) {
			// Preserve the later migration error from validateCodexFlags().
			const nextArg = args[i + 1];
			if (nextArg && !nextArg.startsWith("-") && !COMMANDS.has(nextArg)) {
				i++;
			}
		} else if (
			arg &&
			(Array.from(DEPRECATED_FLAGS_WITH_VALUES).some((flag) =>
				arg.startsWith(`${flag}=`),
			) ||
				DEPRECATED_FLAG_PREFIXES.some((flag) => arg.startsWith(flag)))
		) {
			// Preserve the later migration error from validateCodexFlags().
		} else if (arg && isConfigInitPresetFlag(result, arg)) {
			const nextArg = args[i + 1];
			if (nextArg && !nextArg.startsWith("-")) {
				i++;
			}
		} else if (arg?.startsWith("-")) {
			result.error = `Unknown option: ${arg}`;
		} else if (arg) {
			const nextArg = args[i + 1];
			const isCommandToken =
				COMMANDS.has(arg) &&
				(arg !== "run" ||
					(result.messages.length === 0 &&
						nextNonFlagToken(args, i + 1) === "inspect"));
			if (!result.command && isCommandToken) {
				result.command = arg;
				const shouldConsumeSubcommand =
					SUBCOMMAND_COMMANDS.has(arg) &&
					(arg !== "context" || nextArg === "explain" || nextArg === "diff");
				if (
					shouldConsumeSubcommand &&
					i + 1 < args.length &&
					nextArg &&
					!nextArg.startsWith("-")
				) {
					result.subcommand = nextArg;
					i++;
				}
				if (
					arg === "remote" ||
					arg === "hosted-runner" ||
					arg === "init" ||
					arg === "evalops"
				) {
					result.commandArgs = args.slice(i + 1);
					break;
				}
			} else {
				result.messages.push(arg);
			}
		}
	}

	if (
		result.command === "run" &&
		!result.subcommand &&
		result.messages[0] === "inspect"
	) {
		result.subcommand = "inspect";
		result.messages = result.messages.slice(1);
	}

	return result;
}
