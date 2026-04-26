import {
	MAESTRO_PLATFORM_RUNTIME_BRIDGE_KILL_SWITCH,
	isFeatureFlagEnabled,
	isPlatformRuntimeObserveEnabled,
	isPlatformToolExecutionBridgeEnabled,
} from "../../config/feature-flags.js";
import {
	type ExecutePlatformToolRequest,
	type ExecutePlatformToolResponse,
	type PlatformConnectorRef,
	type PlatformToolExecutionRecord,
	type PlatformToolRef,
	type RecordPlatformToolExecutionOutputRequest,
	type ResumePlatformToolExecutionRequest,
	type ToolExecutionLinkage,
	type ToolExecutionRiskLevel,
	type ToolExecutionServiceConfig,
	executeToolWithPlatform,
	recordToolExecutionOutputWithPlatform,
	resolveToolExecutionServiceConfig,
	resumeToolExecutionWithPlatform,
} from "../../platform/tool-execution-client.js";
import { isReadOnlyTool } from "../../tools/parallel-execution.js";
import { isAbortError } from "../../utils/abort.js";
import { createLogger } from "../../utils/logger.js";
import type {
	ActionApprovalDecision,
	ActionApprovalRequest,
} from "../action-approval.js";
import type {
	AgentRunConfig,
	AgentTool,
	ToolCall,
	ToolResultMessage,
} from "../types.js";

const logger = createLogger("transport:tool-execution-bridge");

const OBSERVE_OUTPUT_SUMMARY_MAX_LENGTH = 280;
const METADATA_VALUE_MAX_LENGTH = 512;
const READ_ONLY_BASH_PREFIXES = [
	"cat",
	"cd",
	"df",
	"du",
	"echo",
	"env",
	"find",
	"git diff",
	"git log",
	"git remote -v",
	"git rev-parse",
	"git show",
	"git status",
	"grep",
	"head",
	"ls",
	"pwd",
	"printenv",
	"ps",
	"rg",
	"sed -n",
	"tail",
	"which",
].map((value) => value.toLowerCase());

const BASH_MUTATION_MARKERS = [
	/\bchmod\b/u,
	/\bchown\b/u,
	/\bcp\b/u,
	/\bgit\s+(add|am|apply|branch|checkout|cherry-pick|clean|commit|merge|mv|pull|push|rebase|reset|restore|revert|rm|stash|switch|tag)\b/u,
	/\bmkdir\b/u,
	/\bmv\b/u,
	/\bnpm\s+(install|publish|uninstall|update|version)\b/u,
	/\bpnpm\s+(add|install|remove|update)\b/u,
	/\bpython\b.*-c/u,
	/\brm\b/u,
	/\bsed\s+-i\b/u,
	/\btee\b/u,
	/\btouch\b/u,
	/\byarn\s+(add|install|remove|upgrade)\b/u,
	/\bbun\s+(add|install|remove|update)\b/u,
	/\bkubectl\s+(apply|create|delete|patch|replace|scale)\b/u,
	/\bterraform\s+(apply|destroy|import)\b/u,
	/(^|[^<])>{1,2}/u,
] as const;

const READ_ONLY_GIT_BRANCH_ARGS = new Set([
	"--all",
	"--list",
	"--merged",
	"--no-contains",
	"--no-merged",
	"--points-at",
	"--remotes",
	"-a",
	"-l",
	"-r",
]);

export type PlatformBridgeMode = "observe" | "governed";

export interface ToolExecutionBridgeMetadata {
	toolExecutionId?: string;
	approvalRequestId?: string;
}

export interface ObserveToolExecutionPlan {
	kind: "observe";
	mode: "observe";
	classification: ToolExecutionClassification;
	config: ToolExecutionServiceConfig;
	request: ExecutePlatformToolRequest;
	metadata: ToolExecutionBridgeMetadata;
}

export interface GovernedToolExecutionPlan {
	kind: "governed";
	mode: "governed";
	classification: ToolExecutionClassification;
	config: ToolExecutionServiceConfig;
	request: ExecutePlatformToolRequest;
	metadata: ToolExecutionBridgeMetadata;
	resumeToken?: string;
}

export type ToolExecutionBridgePlan =
	| ObserveToolExecutionPlan
	| GovernedToolExecutionPlan;

export type ToolExecutionBridgePreparation =
	| {
			status: "skip";
	  }
	| {
			status: "observe";
			plan: ObserveToolExecutionPlan;
	  }
	| {
			status: "allow";
			plan: GovernedToolExecutionPlan;
	  }
	| {
			status: "wait_approval";
			plan: GovernedToolExecutionPlan;
			request: ActionApprovalRequest;
	  }
	| {
			status: "deny";
			plan?: GovernedToolExecutionPlan;
			reason: string;
	  };

export type ToolExecutionBridgeApprovalResolution =
	| {
			status: "allow";
			plan: GovernedToolExecutionPlan;
	  }
	| {
			status: "deny";
			plan: GovernedToolExecutionPlan;
			reason: string;
	  };

export interface ObserveToolExecutionResult {
	metadata: ToolExecutionBridgeMetadata;
}

export interface ToolExecutionBridgeInput {
	cfg: AgentRunConfig;
	toolCall: ToolCall;
	toolDef?: AgentTool;
	sanitizedArgs: Record<string, unknown>;
	displayName?: string;
	summaryLabel?: string;
	actionDescription?: string;
}

interface ToolExecutionClassification {
	family: "bash" | "mcp";
	mode: PlatformBridgeMode;
	riskLevel: ToolExecutionRiskLevel;
	tool: PlatformToolRef;
	connector?: PlatformConnectorRef;
}

function trimString(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function getEnvValue(names: readonly string[]): string | undefined {
	for (const name of names) {
		const value = trimString(process.env[name]);
		if (value) {
			return value;
		}
	}
	return undefined;
}

function metadataValue(value: string | undefined): string | undefined {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: metadata must neutralize C0 control characters and DEL.
	const normalized = value?.replace(/[\x00-\x1f\x7f]/gu, " ");
	const trimmed = trimString(normalized);
	if (!trimmed) {
		return undefined;
	}
	if (trimmed.length <= METADATA_VALUE_MAX_LENGTH) {
		return trimmed;
	}
	const suffix = "...";
	const maxPrefixLength = METADATA_VALUE_MAX_LENGTH - suffix.length;
	let prefix = "";
	for (const char of trimmed) {
		if (prefix.length + char.length > maxPrefixLength) {
			break;
		}
		prefix += char;
	}
	return `${prefix.trimEnd()}${suffix}`;
}

function getMetadataEnvValue(names: readonly string[]): string | undefined {
	return metadataValue(getEnvValue(names));
}

function getCurrentWorkingDirectory(): string | undefined {
	try {
		return metadataValue(process.cwd());
	} catch {
		return undefined;
	}
}

function buildShellCommandSummary(command: string): string {
	const normalized = command.replace(/\s+/gu, " ").trim();
	if (normalized.length <= 96) {
		return normalized;
	}
	return `${normalized.slice(0, 93).trimEnd()}...`;
}

function isReadOnlyBashCommand(command: string): boolean {
	const normalized = command.replace(/\s+/gu, " ").trim().toLowerCase();
	if (!normalized) {
		return false;
	}
	if (isReadOnlyGitBranchCommand(normalized)) {
		return true;
	}
	if (BASH_MUTATION_MARKERS.some((pattern) => pattern.test(normalized))) {
		return false;
	}
	return READ_ONLY_BASH_PREFIXES.some(
		(prefix) => normalized === prefix || normalized.startsWith(`${prefix} `),
	);
}

function isReadOnlyGitBranchCommand(normalized: string): boolean {
	const parts = normalized.split(" ");
	if (parts[0] !== "git" || parts[1] !== "branch") {
		return false;
	}
	const args = parts.slice(2);
	if (args.length === 0) {
		return true;
	}
	return args.every(
		(arg) =>
			READ_ONLY_GIT_BRANCH_ARGS.has(arg) ||
			arg.startsWith("--format=") ||
			arg.startsWith("--sort="),
	);
}

function inferBashRiskLevel(command: string): ToolExecutionRiskLevel {
	const normalized = command.toLowerCase();
	if (
		/\brm\s+-rf\b/u.test(normalized) ||
		/\bgit\s+push(\s+--force|\s+-f)\b/u.test(normalized) ||
		/\bnpm\s+publish\b/u.test(normalized) ||
		/\bkubectl\s+delete\b/u.test(normalized) ||
		/\bterraform\s+destroy\b/u.test(normalized)
	) {
		return "RISK_LEVEL_CRITICAL";
	}
	return isReadOnlyBashCommand(command) ? "RISK_LEVEL_LOW" : "RISK_LEVEL_HIGH";
}

function normalizeCapabilitySegment(value: string): string {
	return value.replace(/[^a-zA-Z0-9_.-]/gu, "_");
}

function parseBridgeMcpToolName(
	name: string,
): { server: string; tool?: string } | null {
	const parts = name.split("__");
	if (parts[0] !== "mcp" || parts.length < 2) {
		return null;
	}
	const server = parts[1];
	if (!server) {
		return null;
	}
	return {
		server,
		tool: parts.length > 2 ? parts.slice(2).join("__") : undefined,
	};
}

function classifyToolExecution(
	toolCall: ToolCall,
	toolDef: AgentTool | undefined,
	rollout: {
		observeEnabled: boolean;
		governedEnabled: boolean;
	},
): ToolExecutionClassification | null {
	if (!rollout.observeEnabled && !rollout.governedEnabled) {
		return null;
	}

	if (toolCall.name === "bash") {
		const command =
			typeof toolCall.arguments.command === "string"
				? toolCall.arguments.command
				: "";
		const isReadOnly = isReadOnlyBashCommand(command);
		const mode: PlatformBridgeMode =
			isReadOnly || !rollout.governedEnabled ? "observe" : "governed";
		if (mode === "observe" && !rollout.observeEnabled) {
			return null;
		}
		return {
			family: "bash",
			mode,
			riskLevel: inferBashRiskLevel(command),
			tool: {
				namespace: "maestro",
				name: "bash",
				version: process.env.npm_package_version,
				capability: "maestro.tool.bash",
				operation: command ? buildShellCommandSummary(command) : "shell",
				idempotent: isReadOnly,
				mutatesResource: !isReadOnly,
			},
		};
	}

	const mcpTool = parseBridgeMcpToolName(toolCall.name);
	if (!mcpTool) {
		return null;
	}
	const mode: PlatformBridgeMode = rollout.governedEnabled
		? "governed"
		: "observe";
	const toolName = mcpTool.tool ?? toolCall.name;
	const readOnly = isReadOnlyTool(toolCall.name, toolDef?.annotations);
	return {
		family: "mcp",
		mode,
		riskLevel: readOnly ? "RISK_LEVEL_MEDIUM" : "RISK_LEVEL_HIGH",
		tool: {
			namespace: "mcp",
			name: toolName,
			version: process.env.npm_package_version,
			capability: `mcp.${normalizeCapabilitySegment(mcpTool.server)}.${normalizeCapabilitySegment(toolName)}`,
			operation: toolName,
			idempotent: readOnly,
			mutatesResource: !readOnly,
		},
		connector: {
			providerId: mcpTool.server,
			resourceId: mcpTool.server,
			resourceKind: "mcp_server",
		},
	};
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableStringify(item)).join(",")}]`;
	}
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
	return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function scrubText(value: string): { text: string; redactions: string[] } {
	let next = value;
	const redactions = new Set<string>();
	for (const pattern of [
		/\b(gh[pousr]_[A-Za-z0-9_]{20,})\b/gu,
		/\b(Bearer\s+[A-Za-z0-9._-]{16,})\b/giu,
		/\b([A-Za-z0-9_-]{32,})\b/gu,
	]) {
		if (pattern.test(next)) {
			redactions.add("secret_like_token");
			next = next.replace(pattern, "[REDACTED]");
		}
	}
	return { text: next, redactions: [...redactions] };
}

function summarizeToolResult(result: ToolResultMessage): {
	summary: string;
	redactions: string[];
} {
	const text = result.content
		.filter(
			(part): part is { type: "text"; text: string } => part.type === "text",
		)
		.map((part) => part.text)
		.join("\n")
		.trim();
	if (!text) {
		return {
			summary: result.isError
				? "Tool failed without text output"
				: "Tool completed",
			redactions: [],
		};
	}
	const firstLine = text.split(/\r?\n/u)[0]?.trim() ?? text;
	const shortened =
		firstLine.length > OBSERVE_OUTPUT_SUMMARY_MAX_LENGTH
			? `${firstLine.slice(0, OBSERVE_OUTPUT_SUMMARY_MAX_LENGTH - 3).trimEnd()}...`
			: firstLine;
	const scrubbed = scrubText(shortened);
	return {
		summary: scrubbed.text,
		redactions: scrubbed.redactions,
	};
}

function buildOutputPayload(
	result: ToolResultMessage,
	durationMs: number | undefined,
): RecordPlatformToolExecutionOutputRequest["output"] {
	const summary = summarizeToolResult(result);
	const safeOutput = {
		status: result.isError ? "failed" : "succeeded",
		tool_name: result.toolName,
		tool_call_id: result.toolCallId,
		summary: summary.summary,
	};
	return {
		safeOutput,
		redactions: summary.redactions,
		contentType: "application/json",
		...(durationMs !== undefined
			? { durationMs: Math.max(0, Math.round(durationMs)) }
			: {}),
	};
}

function buildLinkage(
	cfg: AgentRunConfig,
	toolCall: ToolCall,
	organizationId: string | undefined,
	workspaceId: string,
): ToolExecutionLinkage {
	const sessionId =
		trimString(cfg.session?.id) ?? getEnvValue(["MAESTRO_SESSION_ID"]);
	const agentRunId = getEnvValue(["MAESTRO_AGENT_RUN_ID"]);
	return {
		workspaceId,
		...(organizationId ? { organizationId } : {}),
		agentId:
			getEnvValue(["MAESTRO_AGENT_ID"]) ??
			trimString(process.env.npm_package_name) ??
			"maestro",
		...(agentRunId ? { runId: agentRunId } : {}),
		objectiveId: getEnvValue(["MAESTRO_OBJECTIVE_ID"]),
		stepId: toolCall.id,
		actorId: trimString(cfg.user?.id) ?? getEnvValue(["MAESTRO_ACTOR_ID"]),
		surface: getEnvValue(["MAESTRO_SURFACE"]) ?? "maestro",
		channelId: getEnvValue(["MAESTRO_CHANNEL_ID"]),
		correlationId: `${sessionId ?? "session"}:${toolCall.id}`,
	};
}

function buildRuntimeContextMetadata(
	linkage: ToolExecutionLinkage,
): Record<string, string> {
	const cwd =
		getMetadataEnvValue(["MAESTRO_CWD"]) ?? getCurrentWorkingDirectory();
	const workspaceRoot = getMetadataEnvValue([
		"MAESTRO_WORKSPACE_ROOT",
		"WORKSPACE_ROOT",
	]);
	const repositoryRoot =
		getMetadataEnvValue([
			"MAESTRO_REPOSITORY_ROOT",
			"MAESTRO_REPO_ROOT",
			"GITHUB_WORKSPACE",
		]) ?? workspaceRoot;
	const repository = getMetadataEnvValue([
		"MAESTRO_GIT_REPOSITORY",
		"GITHUB_REPOSITORY",
		"CI_PROJECT_PATH",
	]);
	const gitBranch = getMetadataEnvValue([
		"MAESTRO_GIT_BRANCH",
		"GITHUB_HEAD_REF",
		"GITHUB_REF_NAME",
		"CI_COMMIT_REF_NAME",
		"VERCEL_GIT_COMMIT_REF",
	]);
	const gitCommit = getMetadataEnvValue([
		"MAESTRO_GIT_COMMIT",
		"GITHUB_SHA",
		"CI_COMMIT_SHA",
		"VERCEL_GIT_COMMIT_SHA",
	]);

	return {
		...(linkage.runId ? { maestro_agent_run_id: linkage.runId } : {}),
		maestro_agent_run_step_id: linkage.stepId,
		...(linkage.actorId ? { maestro_actor_id: linkage.actorId } : {}),
		...(linkage.correlationId
			? { maestro_correlation_id: linkage.correlationId }
			: {}),
		...(cwd ? { maestro_cwd: cwd } : {}),
		...(workspaceRoot ? { maestro_workspace_root: workspaceRoot } : {}),
		...(repositoryRoot ? { maestro_repository_root: repositoryRoot } : {}),
		...(repository ? { maestro_repository: repository } : {}),
		...(gitBranch ? { maestro_git_branch: gitBranch } : {}),
		...(gitCommit ? { maestro_git_commit: gitCommit } : {}),
	};
}

function buildMetadata(
	input: ToolExecutionBridgeInput,
	classification: ToolExecutionClassification,
	linkage: ToolExecutionLinkage,
): Record<string, string> {
	const originalArgs = input.toolCall.arguments as Record<string, unknown>;
	const redactedArguments =
		stableStringify(originalArgs) !== stableStringify(input.sanitizedArgs);
	const sessionId =
		trimString(input.cfg.session?.id) ?? getEnvValue(["MAESTRO_SESSION_ID"]);
	const remoteRunnerSessionId = getEnvValue([
		"MAESTRO_REMOTE_RUNNER_SESSION_ID",
		"MAESTRO_RUNNER_SESSION_ID",
	]);
	return {
		maestro_bridge_mode: classification.mode,
		maestro_tool_call_id: input.toolCall.id,
		...buildRuntimeContextMetadata(linkage),
		...(sessionId ? { maestro_session_id: sessionId } : {}),
		...(remoteRunnerSessionId
			? { maestro_remote_runner_session_id: remoteRunnerSessionId }
			: {}),
		...(input.displayName ? { maestro_display_name: input.displayName } : {}),
		...(input.summaryLabel
			? { maestro_summary_label: input.summaryLabel }
			: {}),
		...(input.actionDescription
			? { maestro_action_description: input.actionDescription }
			: {}),
		maestro_redacted_arguments: String(redactedArguments),
		maestro_tool_family: classification.family,
		maestro_local_execution_authoritative: String(
			classification.mode === "governed",
		),
	};
}

function buildExecuteRequest(
	input: ToolExecutionBridgeInput,
	config: ToolExecutionServiceConfig,
	classification: ToolExecutionClassification,
): ExecutePlatformToolRequest {
	const linkage = buildLinkage(
		input.cfg,
		input.toolCall,
		config.organizationId,
		config.workspaceId ?? process.cwd(),
	);
	return {
		linkage,
		tool: classification.tool,
		...(classification.connector
			? { connector: classification.connector }
			: {}),
		arguments: cloneRecord(input.sanitizedArgs),
		riskLevel: classification.riskLevel,
		retryPolicy: {
			maxAttempts: 1,
			initialDelayMs: 0,
			maxDelayMs: 0,
			allowNonIdempotentRetry: false,
		},
		idempotencyKey: `maestro:${input.toolCall.id}`,
		metadata: buildMetadata(input, classification, linkage),
	};
}

function planFromResponse(
	classification: ToolExecutionClassification,
	config: ToolExecutionServiceConfig,
	request: ExecutePlatformToolRequest,
	response: ExecutePlatformToolResponse,
): GovernedToolExecutionPlan {
	return {
		kind: "governed",
		mode: "governed",
		classification,
		config,
		request,
		metadata: {
			toolExecutionId: response.execution.id,
			approvalRequestId: response.execution.approvalWait?.approvalRequestId,
		},
		resumeToken: response.execution.approvalWait?.resumeToken,
	};
}

function waitApprovalRequest(
	input: ToolExecutionBridgeInput,
	plan: GovernedToolExecutionPlan,
	execution: PlatformToolExecutionRecord,
): ActionApprovalRequest {
	return {
		id:
			execution.approvalWait?.approvalRequestId ??
			plan.metadata.approvalRequestId ??
			input.toolCall.id,
		toolName: input.toolCall.name,
		displayName: input.displayName,
		summaryLabel: input.summaryLabel,
		actionDescription: input.actionDescription,
		args: input.sanitizedArgs,
		reason:
			execution.approvalWait?.reason ??
			execution.errorMessage ??
			"Approval required by Platform ToolExecution",
		platform: {
			source: "tool_execution",
			toolExecutionId: execution.id ?? plan.metadata.toolExecutionId,
			approvalRequestId:
				execution.approvalWait?.approvalRequestId ??
				plan.metadata.approvalRequestId,
		},
	};
}

function isBridgeGloballyDisabled(): boolean {
	return isFeatureFlagEnabled(MAESTRO_PLATFORM_RUNTIME_BRIDGE_KILL_SWITCH);
}

export interface PlatformToolExecutionBridge {
	prepare(
		input: ToolExecutionBridgeInput,
		signal?: AbortSignal,
	): Promise<ToolExecutionBridgePreparation>;
	resolveApproval(
		input: ToolExecutionBridgeInput,
		plan: GovernedToolExecutionPlan,
		decision: ActionApprovalDecision,
		signal?: AbortSignal,
	): Promise<ToolExecutionBridgeApprovalResolution>;
	recordObservation(
		plan: ObserveToolExecutionPlan,
		result: ToolResultMessage,
		signal?: AbortSignal,
	): Promise<ObserveToolExecutionResult>;
	recordGovernedOutput(
		plan: GovernedToolExecutionPlan,
		result: ToolResultMessage,
		durationMs?: number,
		signal?: AbortSignal,
	): Promise<ObserveToolExecutionResult>;
}

export class DefaultPlatformToolExecutionBridge
	implements PlatformToolExecutionBridge
{
	async prepare(
		input: ToolExecutionBridgeInput,
		signal?: AbortSignal,
	): Promise<ToolExecutionBridgePreparation> {
		if (isBridgeGloballyDisabled()) {
			return { status: "skip" };
		}

		const rollout = {
			observeEnabled:
				isPlatformRuntimeObserveEnabled() ||
				isPlatformToolExecutionBridgeEnabled(),
			governedEnabled: isPlatformToolExecutionBridgeEnabled(),
		};
		const classification = classifyToolExecution(
			input.toolCall,
			input.toolDef,
			rollout,
		);
		if (!classification) {
			return { status: "skip" };
		}

		const config = await resolveToolExecutionServiceConfig();
		if (!config) {
			return { status: "skip" };
		}

		const request = buildExecuteRequest(input, config, classification);
		if (classification.mode === "observe") {
			return {
				status: "observe",
				plan: {
					kind: "observe",
					mode: "observe",
					classification,
					config,
					request,
					metadata: {},
				},
			};
		}

		try {
			const response = await executeToolWithPlatform(config, request, signal);
			const plan = planFromResponse(classification, config, request, response);
			switch (response.execution.state) {
				case "TOOL_EXECUTION_STATE_DENIED":
					return {
						status: "deny",
						plan,
						reason:
							response.execution.errorMessage ??
							"Action denied by Platform ToolExecution",
					};
				case "TOOL_EXECUTION_STATE_WAITING_APPROVAL":
					return {
						status: "wait_approval",
						plan,
						request: waitApprovalRequest(input, plan, response.execution),
					};
				default:
					return { status: "allow", plan };
			}
		} catch (error) {
			if (isAbortError(error)) {
				throw error;
			}
			const message = error instanceof Error ? error.message : String(error);
			return {
				status: "deny",
				reason: `Platform ToolExecution unavailable: ${message}`,
			};
		}
	}

	async resolveApproval(
		input: ToolExecutionBridgeInput,
		plan: GovernedToolExecutionPlan,
		decision: ActionApprovalDecision,
		signal?: AbortSignal,
	): Promise<ToolExecutionBridgeApprovalResolution> {
		if (!plan.resumeToken || !plan.metadata.approvalRequestId) {
			return decision.approved
				? { status: "allow", plan }
				: {
						status: "deny",
						plan,
						reason: decision.reason ?? "Approval denied",
					};
		}
		const request: ResumePlatformToolExecutionRequest = {
			executionId: plan.metadata.toolExecutionId ?? "",
			approvalRequestId: plan.metadata.approvalRequestId,
			resumeToken: plan.resumeToken,
			approved: decision.approved,
			decidedBy:
				decision.resolvedBy === "user"
					? (trimString(input.cfg.user?.id) ?? "user")
					: "policy",
			reason: decision.reason,
		};
		try {
			const response = await resumeToolExecutionWithPlatform(
				plan.config,
				request,
				signal,
			);
			const nextPlan: GovernedToolExecutionPlan = {
				...plan,
				metadata: {
					toolExecutionId:
						response.execution.id ?? plan.metadata.toolExecutionId,
					approvalRequestId:
						response.execution.approvalWait?.approvalRequestId ??
						plan.metadata.approvalRequestId,
				},
			};
			switch (response.execution.state) {
				case "TOOL_EXECUTION_STATE_DENIED":
				case "TOOL_EXECUTION_STATE_FAILED":
				case "TOOL_EXECUTION_STATE_CANCELLED":
					return {
						status: "deny",
						plan: nextPlan,
						reason:
							response.execution.errorMessage ??
							decision.reason ??
							"Platform ToolExecution denied the action",
					};
				default:
					return { status: "allow", plan: nextPlan };
			}
		} catch (error) {
			if (isAbortError(error)) {
				throw error;
			}
			const message = error instanceof Error ? error.message : String(error);
			return decision.approved
				? {
						status: "deny",
						plan,
						reason: `Platform ToolExecution decision sync failed: ${message}`,
					}
				: {
						status: "deny",
						plan,
						reason: decision.reason ?? `Approval denied (${message})`,
					};
		}
	}

	async recordObservation(
		plan: ObserveToolExecutionPlan,
		result: ToolResultMessage,
		signal?: AbortSignal,
	): Promise<ObserveToolExecutionResult> {
		const summary = summarizeToolResult(result);
		const request: ExecutePlatformToolRequest = {
			...plan.request,
			metadata: {
				...plan.request.metadata,
				maestro_bridge_mode: "observe",
				maestro_local_outcome: result.isError ? "failed" : "succeeded",
				maestro_local_output_summary: summary.summary,
				maestro_local_output_redactions:
					summary.redactions.length > 0 ? summary.redactions.join(",") : "none",
			},
		};
		try {
			const response = await executeToolWithPlatform(
				plan.config,
				request,
				signal,
			);
			return {
				metadata: {
					toolExecutionId: response.execution.id,
					approvalRequestId: response.execution.approvalWait?.approvalRequestId,
				},
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.warn("Failed to record observe-only tool execution", {
				error: message,
				toolName: plan.request.tool.name,
				toolCallId: plan.request.metadata?.maestro_tool_call_id,
			});
			return { metadata: plan.metadata };
		}
	}

	async recordGovernedOutput(
		plan: GovernedToolExecutionPlan,
		result: ToolResultMessage,
		durationMs?: number,
		signal?: AbortSignal,
	): Promise<ObserveToolExecutionResult> {
		const executionId = plan.metadata.toolExecutionId;
		if (!executionId) {
			return { metadata: plan.metadata };
		}

		const request: RecordPlatformToolExecutionOutputRequest = {
			executionId,
			output: buildOutputPayload(result, durationMs),
			metadata: {
				...plan.request.metadata,
				maestro_bridge_mode: "governed",
				maestro_local_outcome: result.isError ? "failed" : "succeeded",
				maestro_tool_call_id: result.toolCallId,
			},
		};
		try {
			const response = await recordToolExecutionOutputWithPlatform(
				plan.config,
				request,
				signal,
			);
			return {
				metadata: {
					toolExecutionId: response.execution.id ?? executionId,
					approvalRequestId:
						response.execution.approvalWait?.approvalRequestId ??
						plan.metadata.approvalRequestId,
				},
			};
		} catch (error) {
			if (isAbortError(error)) {
				throw error;
			}
			const message = error instanceof Error ? error.message : String(error);
			logger.warn("Failed to record governed tool execution output", {
				error: message,
				toolName: plan.request.tool.name,
				toolCallId: result.toolCallId,
				toolExecutionId: executionId,
			});
			return { metadata: plan.metadata };
		}
	}
}

let defaultBridge: PlatformToolExecutionBridge | null = null;

export function getDefaultPlatformToolExecutionBridge(): PlatformToolExecutionBridge {
	if (!defaultBridge) {
		defaultBridge = new DefaultPlatformToolExecutionBridge();
	}
	return defaultBridge;
}

export function buildObservedResultMetadata(
	plan: ToolExecutionBridgePlan | undefined,
	observation: ObserveToolExecutionResult | undefined,
): ToolExecutionBridgeMetadata {
	if (!plan) {
		return observation?.metadata ?? {};
	}
	return {
		toolExecutionId:
			observation?.metadata.toolExecutionId ?? plan.metadata.toolExecutionId,
		approvalRequestId:
			observation?.metadata.approvalRequestId ??
			plan.metadata.approvalRequestId,
	};
}
