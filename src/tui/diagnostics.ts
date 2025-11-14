import chalk from "chalk";
import type { AgentState } from "../agent/types.js";
import type { ApiKeyLookupResult } from "../providers/api-keys.js";
import type { SessionModelMetadata } from "../session-manager.js";
import type { TelemetryStatus } from "../telemetry.js";

export interface DiagnosticsInput {
	sessionId: string;
	sessionFile: string;
	state: AgentState;
	modelMetadata?: SessionModelMetadata;
	apiKeyLookup: ApiKeyLookupResult;
	telemetry: TelemetryStatus;
	pendingTools: Array<{ id: string; name: string }>;
	explicitApiKey?: string;
	health?: {
		toolFailures: number;
		toolFailurePath?: string;
		gitStatus?: string;
		planGoals?: number;
		planPendingTasks?: number;
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
	const healthSection = formatHealthSection(input.health);
	if (healthSection) {
		sections.push(healthSection);
		sections.push("");
	}
	sections.push(formatPendingToolsSection(input.pendingTools));
	return sections.join("\n");
}
