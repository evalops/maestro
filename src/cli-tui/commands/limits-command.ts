import {
	API_CONFIG,
	LIMITS,
	SESSION_CONFIG,
	TOOL_CONFIG,
} from "../../config/constants.js";
import { getToolOutputLimits } from "../utils/tool-text-utils.js";
import { isHelpRequest } from "./subcommands/utils.js";
import type { CommandExecutionContext } from "./types.js";

type LimitSection = {
	key: string;
	title: string;
	lines: string[];
};

const LIMITS_USAGE = [
	"Usage: /limits [all|tool|tui|api|session|runtime|help]",
	"",
	"Categories:",
	"  tool      Tool execution defaults",
	"  tui       TUI tool output limits",
	"  api       API/network timeouts",
	"  session   Session persistence limits",
	"  runtime   File/search/output limits",
].join("\n");

function formatLimitLine(
	label: string,
	value: string | number,
	envVar?: string,
): string {
	if (!envVar) {
		return `  ${label}: ${value}`;
	}
	const envValue = process.env[envVar];
	const envDisplay = envValue ? `${envVar}=${envValue}` : envVar;
	return `  ${label}: ${value} (env: ${envDisplay})`;
}

export function handleLimitsCommand(context: CommandExecutionContext): void {
	const args = context.argumentText.trim().split(/\s+/).filter(Boolean);
	const subcommand = (args[0] || "all").toLowerCase();

	if (isHelpRequest(subcommand)) {
		context.showInfo(LIMITS_USAGE);
		return;
	}

	const toolOutputLimits = getToolOutputLimits();
	const sections: LimitSection[] = [
		{
			key: "tool",
			title: "Tool execution defaults",
			lines: [
				formatLimitLine(
					"BASH_DEFAULT_TIMEOUT_MS",
					TOOL_CONFIG.BASH_DEFAULT_TIMEOUT_MS,
					"MAESTRO_BASH_TIMEOUT_MS",
				),
				formatLimitLine("READ_DEFAULT_LIMIT", TOOL_CONFIG.READ_DEFAULT_LIMIT),
				formatLimitLine(
					"SEARCH_MAX_CONTEXT_LINES",
					`${TOOL_CONFIG.SEARCH_MAX_CONTEXT_LINES} lines`,
				),
			],
		},
		{
			key: "tui",
			title: "TUI tool output limits",
			lines: [
				formatLimitLine(
					"TUI_TOOL_MAX_CHARS",
					toolOutputLimits.maxChars,
					"MAESTRO_TUI_TOOL_MAX_CHARS",
				),
				formatLimitLine(
					"TUI_TOOL_MAX_LINES",
					toolOutputLimits.maxLines,
					"MAESTRO_TUI_TOOL_MAX_LINES",
				),
			],
		},
		{
			key: "runtime",
			title: "Runtime limits",
			lines: [
				formatLimitLine(
					"MAX_FILE_SIZE_BYTES",
					LIMITS.MAX_FILE_SIZE_BYTES,
					"MAESTRO_MAX_FILE_SIZE",
				),
				formatLimitLine(
					"MAX_SEARCH_RESULTS",
					LIMITS.MAX_SEARCH_RESULTS,
					"MAESTRO_MAX_SEARCH_RESULTS",
				),
				formatLimitLine("MAX_COMMAND_OUTPUT", LIMITS.MAX_COMMAND_OUTPUT),
				formatLimitLine("TEST_TIMEOUT_MS", LIMITS.TEST_TIMEOUT_MS),
			],
		},
		{
			key: "api",
			title: "API & telemetry",
			lines: [
				formatLimitLine(
					"REQUEST_TIMEOUT_MS",
					API_CONFIG.REQUEST_TIMEOUT_MS,
					"MAESTRO_API_TIMEOUT_MS",
				),
				formatLimitLine(
					"TELEMETRY_SAMPLE_RATE",
					API_CONFIG.TELEMETRY_SAMPLE_RATE,
					"MAESTRO_TELEMETRY_SAMPLE",
				),
			],
		},
		{
			key: "session",
			title: "Session persistence",
			lines: [
				formatLimitLine(
					"WRITE_BATCH_SIZE",
					SESSION_CONFIG.WRITE_BATCH_SIZE,
					"MAESTRO_SESSION_BATCH_SIZE",
				),
			],
		},
	];

	const selectedSections =
		subcommand === "all" || subcommand === ""
			? sections
			: sections.filter((section) => section.key === subcommand);

	if (selectedSections.length === 0) {
		context.showError(`Unknown limits category: ${subcommand}`);
		context.showInfo(LIMITS_USAGE);
		return;
	}

	const lines: string[] = ["Limits (restart after changing env vars):"];
	for (const section of selectedSections) {
		lines.push("", `${section.title}:`, ...section.lines);
	}

	context.showInfo(lines.join("\n"));
}
