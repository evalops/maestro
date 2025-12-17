export type Mode = "text" | "json" | "rpc" | "headless";

export interface Args {
	provider?: string;
	model?: string;
	modelsFile?: string;
	apiKey?: string;
	systemPrompt?: string;
	/** Port for `composer web` (defaults to PORT env or 8080) */
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
	approvalMode?: "auto" | "prompt" | "fail";
	authMode?: "auto" | "api-key" | "claude";
	force?: boolean;
	execJson?: boolean;
	execFullAuto?: boolean;
	execReadOnly?: boolean;
	/** Sandbox mode: "docker", "local", "native", or "none" */
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
}

const COMMANDS = new Set([
	"config",
	"models",
	"cost",
	"agents",
	"exec",
	"web",
	"anthropic",
	"openai",
	"hooks",
]);
const SUBCOMMAND_COMMANDS = new Set([
	"config",
	"models",
	"cost",
	"agents",
	"anthropic",
	"openai",
	"hooks",
]);

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
		} else if (arg === "--mode" && i + 1 < args.length) {
			const mode = args[++i];
			if (
				mode === "text" ||
				mode === "json" ||
				mode === "rpc" ||
				mode === "headless"
			) {
				result.mode = mode;
			}
		} else if (arg === "--headless") {
			result.headless = true;
			result.mode = "headless";
		} else if (arg === "--continue" || arg === "-c") {
			result.continue = true;
		} else if (arg === "--resume" || arg === "-r") {
			if (result.command === "exec") {
				if (i + 1 < args.length && !args[i + 1].startsWith("-")) {
					result.execResumeId = args[++i];
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
		} else if (arg === "--models" && i + 1 < args.length) {
			const patterns = args[++i]
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
			const toolNames = args[++i]
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
		} else if (arg === "--profile" && i + 1 < args.length) {
			result.profile = args[++i];
		} else if (arg === "--config" && i + 1 < args.length) {
			// Config overrides in key=value format
			const override = args[++i];
			if (!result.configOverrides) {
				result.configOverrides = [];
			}
			result.configOverrides.push(override);
		} else if (!arg.startsWith("-")) {
			if (!result.command && COMMANDS.has(arg)) {
				result.command = arg;
				if (
					SUBCOMMAND_COMMANDS.has(arg) &&
					i + 1 < args.length &&
					!args[i + 1].startsWith("-")
				) {
					result.subcommand = args[++i];
				}
			} else {
				result.messages.push(arg);
			}
		}
	}

	return result;
}
