import chalk from "chalk";
import type { AgentState } from "../agent/types.js";
import type { LspDiagnostic } from "../lsp/index.js";
import type { ApiKeyLookupResult } from "../providers/api-keys.js";
import type { SessionModelMetadata } from "../session-manager.js";
import type { TelemetryStatus } from "../telemetry.js";
import type { ExaUsageSummary } from "../tools/exa-usage.js";

export interface DiagnosticsInput {
	sessionId: string;
	sessionFile: string;
	state: AgentState;
	modelMetadata?: SessionModelMetadata;
	apiKeyLookup: ApiKeyLookupResult;
	telemetry: TelemetryStatus;
	exaUsage?: ExaUsageSummary | null;
	pendingTools: Array<{ id: string; name: string }>;
	explicitApiKey?: string;
	health?: {
		toolFailures: number;
		toolFailurePath?: string;
		gitStatus?: string;
		planGoals?: number;
		planPendingTasks?: number;
	};
	lspDiagnostics?: Record<string, LspDiagnostic[]>;
	context?: {
		systemPromptPreview?: string;
		systemPromptLength?: number;
		contextFiles?: Array<{ path: string; lines?: number }>;
	};
	runtime?: {
		safeMode: boolean;
		approvalMode?: string;
		pendingToolCount?: number;
	};
}

function formatProviderSection(
	state: AgentState,
	modelMetadata?: SessionModelMetadata,
): string {
	const provider = state.model.provider;
	const modelId = state.model.id;
	const parts: string[] = [];
	parts.push(`${chalk.bold("Provider")}: ${provider}`);
	parts.push(`${chalk.bold("Model")}: ${modelId}`);
	if (modelMetadata?.providerName) {
		parts.push(`${chalk.dim("Provider Name")}: ${modelMetadata.providerName}`);
	}
	if (modelMetadata?.name) {
		parts.push(`${chalk.dim("Model Name")}: ${modelMetadata.name}`);
	}
	if (modelMetadata?.source) {
		parts.push(`${chalk.dim("Source")}: ${modelMetadata.source}`);
	}
	if (modelMetadata?.baseUrl) {
		parts.push(`${chalk.dim("Base URL")}: ${modelMetadata.baseUrl}`);
	}
	if (modelMetadata?.contextWindow) {
		parts.push(
			`${chalk.dim("Context Window")}: ${modelMetadata.contextWindow.toLocaleString()}`,
		);
	}
	if (modelMetadata?.maxTokens) {
		parts.push(
			`${chalk.dim("Max Tokens")}: ${modelMetadata.maxTokens.toLocaleString()}`,
		);
	}
	if (modelMetadata?.reasoning !== undefined) {
		parts.push(
			`${chalk.dim("Reasoning")}: ${modelMetadata.reasoning ? "yes" : "no"}`,
		);
	}
	return parts.join("\n");
}

function formatApiKeySection(
	lookup: ApiKeyLookupResult,
	explicitApiKey?: string,
): string {
	const lines: string[] = [];
	const source = lookup.source;
	let status = "missing";
	if (lookup.key) {
		status = source === "explicit" ? "provided" : "found";
	} else if (source === "missing") {
		status = "missing";
	}
	lines.push(`${chalk.bold("API Key")}: ${status}`);
	if (source === "explicit" && explicitApiKey) {
		lines.push(chalk.dim("Source: --api-key"));
	}
	if (source === "env" && lookup.envVar) {
		lines.push(chalk.dim(`Source: ${lookup.envVar}`));
	}
	if (source === "custom_env" && lookup.envVar) {
		lines.push(chalk.dim(`Source: ${lookup.envVar} (custom provider)`));
	}
	if (source === "custom_literal") {
		lines.push(chalk.dim("Source: models.json literal"));
	}
	if (lookup.checkedEnvVars.length) {
		lines.push(
			chalk.dim(`Checked: ${lookup.checkedEnvVars.join(", ") || "(none)"}`),
		);
	}
	return lines.join("\n");
}

function formatTelemetrySection(status: TelemetryStatus): string {
	const lines: string[] = [];
	lines.push(
		`${chalk.bold("Telemetry")}: ${status.enabled ? "enabled" : "disabled"}`,
	);
	lines.push(chalk.dim(`Reason: ${status.reason}`));
	if (status.endpoint) {
		lines.push(chalk.dim(`Endpoint: ${status.endpoint}`));
	}
	if (status.filePath) {
		lines.push(chalk.dim(`File: ${status.filePath}`));
	}
	lines.push(chalk.dim(`Sample Rate: ${status.sampleRate}`));
	if (status.flagValue !== undefined) {
		lines.push(chalk.dim(`Flag: ${status.flagValue}`));
	}
	if (status.runtimeOverride) {
		const reason = status.overrideReason ? ` (${status.overrideReason})` : "";
		lines.push(
			chalk.dim(`Override: ${status.runtimeOverride.toUpperCase()}${reason}`),
		);
	}
	return lines.join("\n");
}

function formatExaUsageSection(
	summary?: ExaUsageSummary | null,
): string | null {
	if (!summary) return null;
	const lines: string[] = [];
	lines.push(chalk.bold("Exa Usage"));
	lines.push(
		`${chalk.dim("Calls")}: ${summary.totalCalls} (${summary.successes} ok, ${summary.failures} fail)`,
	);
	lines.push(
		`${chalk.dim("Duration")}: ${(summary.totalDurationMs / 1000).toFixed(2)}s total`,
	);
	lines.push(`${chalk.dim("Cost")}: $${summary.totalCostDollars.toFixed(4)}`);
	if (summary.lastEvents.length) {
		lines.push(chalk.dim("Recent"));
		for (const event of summary.lastEvents) {
			const ts = formatExaTimestamp(event.timestamp);
			lines.push(
				` - ${ts} ${event.operation ?? event.endpoint} (${event.success ? "ok" : "fail"}) ${event.costDollars ? `$${event.costDollars.toFixed(4)}` : ""}`.trim(),
			);
		}
	}
	return lines.join("\n");
}

function formatPendingToolsSection(
	pendingTools: Array<{ id: string; name: string }>,
): string {
	if (pendingTools.length === 0) {
		return chalk.dim("Pending tools: none");
	}
	const items = pendingTools
		.map((tool, index) => `${index + 1}. ${tool.name} (${tool.id})`)
		.join("\n");
	return `${chalk.bold("Pending Tools")}\n${items}`;
}

function formatHealthSection(
	health?: DiagnosticsInput["health"],
): string | null {
	if (!health) {
		return null;
	}
	const lines = [`${chalk.bold("Health")}`];
	lines.push(`${chalk.dim("Tool failures")}: ${health.toolFailures}`);
	if (health.toolFailurePath) {
		lines.push(chalk.dim(`Log: ${health.toolFailurePath}`));
	}
	if (health.gitStatus) {
		lines.push(`${chalk.dim("Git")}: ${health.gitStatus}`);
	}
	if (typeof health.planGoals === "number") {
		lines.push(
			`${chalk.dim("Plans")}: ${health.planGoals} goal${health.planGoals === 1 ? "" : "s"}`,
		);
	}
	if (typeof health.planPendingTasks === "number") {
		lines.push(
			`${chalk.dim("Pending tasks")}: ${health.planPendingTasks.toLocaleString()}`,
		);
	}
	return lines.join("\n");
}

function formatLspSection(
	diagnostics?: Record<string, LspDiagnostic[]>,
): string | null {
	if (!diagnostics) return null;
	const entries = Object.entries(diagnostics);
	if (entries.length === 0) {
		return chalk.dim("LSP: no diagnostics");
	}
	const maxFiles = 5;
	const lines: string[] = [chalk.bold("LSP Diagnostics")];
	for (const [file, items] of entries.slice(0, maxFiles)) {
		lines.push(chalk.underline(file));
		for (const diag of items.slice(0, 5)) {
			const severity = formatSeverity(diag.severity);
			lines.push(
				`${chalk.dim(`[${severity}]`)} ${diag.message} (${diag.range.start.line + 1}:${diag.range.start.character + 1})`,
			);
		}
	}
	if (entries.length > maxFiles) {
		lines.push(chalk.dim(`…and ${entries.length - maxFiles} more files`));
	}
	return lines.join("\n");
}

function formatSeverity(sev?: number) {
	switch (sev) {
		case 1:
			return "ERROR";
		case 2:
			return "WARN";
		case 3:
			return "INFO";
		case 4:
			return "HINT";
		default:
			return "UNKNOWN";
	}
}

function formatExaTimestamp(timestamp: number | string): string {
	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) {
		return "invalid";
	}
	const iso = date.toISOString();
	return `${iso.slice(11, 19)}Z`;
}

function formatPromptContextSection(
	context?: DiagnosticsInput["context"],
): string | null {
	if (!context) return null;
	const lines: string[] = [];
	const promptLength = context.systemPromptLength ?? 0;
	if (promptLength > 0) {
		lines.push(
			`${chalk.bold("System prompt")}: ${promptLength.toLocaleString()} chars`,
		);
		if (context.systemPromptPreview) {
			lines.push(
				`${chalk.dim("Preview")}: ${context.systemPromptPreview.replace(/\s+/g, " ").trim()}`,
			);
		}
	}
	const files = context.contextFiles ?? [];
	if (files.length) {
		lines.push(
			[
				chalk.bold("Context files"),
				...files.map((file) => {
					const suffix =
						typeof file.lines === "number"
							? chalk.dim(`(${file.lines} lines)`)
							: "";
					return `- ${file.path} ${suffix}`.trimEnd();
				}),
			].join("\n"),
		);
	}
	if (!lines.length) {
		return null;
	}
	return lines.join("\n");
}

function formatRuntimeSection(runtime?: DiagnosticsInput["runtime"]): string {
	if (!runtime) {
		return chalk.dim("Runtime: unavailable");
	}
	const flags: string[] = [];
	flags.push(
		`${chalk.bold("Runtime")}: safe-mode ${runtime.safeMode ? "on" : "off"}`,
	);
	flags.push(
		runtime.approvalMode
			? chalk.dim(`Approvals: ${runtime.approvalMode}`)
			: chalk.dim("Approvals: unknown"),
	);
	if (typeof runtime.pendingToolCount === "number") {
		flags.push(chalk.dim(`Pending tools: ${runtime.pendingToolCount}`));
	}
	return flags.join("\n");
}

export function formatDiagnosticsReport(input: DiagnosticsInput): string {
	const sections: string[] = [];
	sections.push(`${chalk.bold("Diagnostics")}`);
	sections.push("");
	sections.push(`${chalk.bold("Session")}`);
	sections.push(`${chalk.dim("ID")}: ${input.sessionId}`);
	sections.push(`${chalk.dim("File")}: ${input.sessionFile}`);
	sections.push("");
	sections.push(formatProviderSection(input.state, input.modelMetadata));
	sections.push("");
	sections.push(formatApiKeySection(input.apiKeyLookup, input.explicitApiKey));
	sections.push("");
	sections.push(formatTelemetrySection(input.telemetry));
	sections.push("");
	const exaUsageSection = formatExaUsageSection(input.exaUsage);
	if (exaUsageSection) {
		sections.push(exaUsageSection);
		sections.push("");
	}
	const healthSection = formatHealthSection(input.health);
	if (healthSection) {
		sections.push(healthSection);
		sections.push("");
	}
	const lspSection = formatLspSection(input.lspDiagnostics);
	if (lspSection) {
		sections.push(lspSection);
		sections.push("");
	}
	const promptSection = formatPromptContextSection(input.context);
	if (promptSection) {
		sections.push(promptSection);
		sections.push("");
	}
	sections.push(formatRuntimeSection(input.runtime));
	sections.push("");
	sections.push(formatPendingToolsSection(input.pendingTools));
	return sections.join("\n");
}
