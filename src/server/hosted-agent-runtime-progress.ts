import { createHash } from "node:crypto";
import type { SwarmEvent, SwarmTask } from "../agent/swarm/types.js";
import type { AgentEvent, AppMessage, Usage } from "../agent/types.js";
import {
	CODEX_SUBAGENT_TOOL_PREFIX,
	canonicalCodexSubagentTool,
	codexSubagentActiveStatus,
	codexSubagentNextAction as codexSubagentContractNextAction,
	codexSubagentOperationName,
	codexSubagentTerminalSuccessStatus,
} from "../codex/subagent-workgraph.js";
import {
	PlatformDelegationStatusValue,
	delegateAgentWithPlatform,
	resolveAgentDelegationWithPlatform,
} from "../platform/agent-registry-client.js";
import {
	type PlatformAgentRunStep,
	PlatformAgentRunStepKindValue,
	PlatformAgentRunStepStateValue,
	PlatformAgentRunWaitTypeValue,
	type PlatformAgentRuntimeRecordRunEventInput,
	type PlatformAgentWorkItem,
	PlatformAgentWorkItemKindValue,
	PlatformAgentWorkItemStateValue,
	PlatformRuntimeEventTypeValue,
	completeAgentRuntimeRun,
	failAgentRuntimeRun,
	recordAgentRuntimeRunCost,
	recordAgentRuntimeRunEvent,
	recordAgentRuntimeRunStep,
	recordAgentRuntimeRunWorkItem,
	resumeAgentRuntimeRun,
	updateAgentRuntimeRunWorkItem,
	waitAgentRuntimeRun,
} from "../platform/agent-runtime-client.js";
import { CREDENTIAL_PATTERN_DEFS } from "../safety/credential-patterns.js";
import { createLogger } from "../utils/logger.js";
import type { ServerRequestLifecycleEvent } from "./server-request-manager.js";

const logger = createLogger("server:hosted-agent-runtime-progress");
const CODEX_THREAD_CHILD_RUN_PREFIX = "codex-thread:";
const DEFAULT_CODEX_SUBAGENT_DELEGATION_CAPABILITY = "code:write";

type HostedAgentRuntimeTaskSource =
	| "todo"
	| "background"
	| "swarm"
	| "checkpoint";

type HostedAgentRuntimeTaskStatus =
	| "pending"
	| "running"
	| "waiting"
	| "blocked"
	| "succeeded"
	| "failed"
	| "cancelled";

export interface HostedAgentRuntimeTaskProgressEvent {
	source: HostedAgentRuntimeTaskSource;
	id: string;
	status: HostedAgentRuntimeTaskStatus;
	title: string;
	goal?: string;
	parentId?: string;
	ownerChildRunId?: string;
	workItemKind?: PlatformAgentWorkItemKindValue | string;
	stepKind?: PlatformAgentRunStepKindValue | string;
	nextAction?: string;
	blocker?: string;
	errorMessage?: string;
	toolCallId?: string;
	toolExecutionId?: string;
	approvalRequestId?: string;
	completionGate?: string;
	evidenceRefs?: string[];
	payload?: Record<string, unknown>;
	recordStep?: boolean;
}

export interface HostedAgentRuntimeProgressContext {
	enabled: true;
	agentRunId?: string;
	agentRuntimeLeaseToken?: string;
	agentRuntimeWorkerQueue?: string;
	agentRuntimeCorrelationPath?: string;
	workspaceId?: string;
	runnerSessionId?: string;
	ownerInstanceId?: string;
	agentId?: string;
}

type ProgressOperation = () => Promise<unknown>;

export interface HostedAgentRuntimeProgressRecorderOperations {
	recordStep?: typeof recordAgentRuntimeRunStep;
	recordEvent?: typeof recordAgentRuntimeRunEvent;
	recordCost?: typeof recordAgentRuntimeRunCost;
	recordWorkItem?: typeof recordAgentRuntimeRunWorkItem;
	updateWorkItem?: typeof updateAgentRuntimeRunWorkItem;
	waitRun?: typeof waitAgentRuntimeRun;
	resumeRun?: typeof resumeAgentRuntimeRun;
	completeRun?: typeof completeAgentRuntimeRun;
	failRun?: typeof failAgentRuntimeRun;
	delegateAgent?: typeof delegateAgentWithPlatform;
	resolveDelegation?: typeof resolveAgentDelegationWithPlatform;
}

export interface HostedAgentRuntimeProgressRecorderOptions {
	sessionId: string;
	hostedRunner?: HostedAgentRuntimeProgressContext;
	workspaceRoot?: string;
	operations?: HostedAgentRuntimeProgressRecorderOperations;
}

export interface HostedAgentRuntimeCompleteInput {
	reason?: string;
	requestedBy?: string;
	flushStatus?: string;
	manifestPath?: string;
}

export interface HostedAgentRuntimeFailInput {
	errorMessage: string;
	reason?: string;
	requestedBy?: string;
	retryable?: boolean;
	manifestPath?: string;
	flushStatus?: string;
}

export interface HostedAgentRuntimeDrainInput {
	status: "drained" | "interrupted" | string;
	reason?: string;
	requestedBy?: string;
	flushStatus?: string;
	manifestPath?: string;
	platformEvidence?: unknown;
	errorMessage?: string;
}

function safeIdPart(value: string): string {
	return value.replace(/[^A-Za-z0-9_.:-]+/g, "_").slice(0, 96) || "unknown";
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0
		? value
		: undefined;
}

function compactString(value: unknown, maxLength = 256): string | undefined {
	const text = nonEmptyString(value)?.trim();
	if (!text) {
		return undefined;
	}
	if (text.length <= maxLength) {
		return text;
	}
	if (maxLength <= 0) {
		return "";
	}
	if (maxLength <= 3) {
		return ".".repeat(maxLength);
	}
	return `${text.slice(0, maxLength - 3)}...`;
}

function isExistingWorkItemCreateError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /\b409\b|already exists|already_exists|duplicate|unique constraint/i.test(
		message,
	);
}

function stableShortHash(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function goalScopedTodoId(id: string, goal: string | undefined): string {
	return goal ? `goal-${stableShortHash(goal)}:${id}` : id;
}

function swarmCompletionStatus(
	event: Extract<SwarmEvent, { type: "swarm_complete" }>,
): HostedAgentRuntimeTaskStatus {
	switch (event.state.status) {
		case "completed":
			return "succeeded";
		case "failed":
			return "failed";
		case "cancelled":
			return "cancelled";
		case "completing":
			return "running";
		case "initializing":
			return "pending";
		case "running":
			return "running";
	}
}

function objectKeys(value: unknown): string[] | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	const keys = Object.keys(value).sort();
	return keys.length > 0 ? keys : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function recordArray(value: unknown): Record<string, unknown>[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter(isRecord);
}

function finiteNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringArray(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter(
		(item): item is string => typeof item === "string" && item.length > 0,
	);
}

function compactStringArray(
	value: string[],
	maxItems = 32,
): string[] | undefined {
	const compacted = value
		.map((item) => compactString(item, 160))
		.filter((item): item is string => Boolean(item))
		.slice(0, maxItems);
	return compacted.length > 0 ? compacted : undefined;
}

function sanitizeOutboundTextArray(
	value: string[],
	maxItems = 32,
	maxLength = MAX_TEXT_FIELD_LENGTH,
): string[] | undefined {
	const sanitized = value
		.map((item) => sanitizeOutboundText(item, maxLength))
		.filter((item): item is string => Boolean(item))
		.slice(0, maxItems);
	return sanitized.length > 0 ? sanitized : undefined;
}

function codexSubagentToolName(toolName: string): string | undefined {
	const tool = toolName.startsWith(CODEX_SUBAGENT_TOOL_PREFIX)
		? toolName.slice(CODEX_SUBAGENT_TOOL_PREFIX.length)
		: undefined;
	return tool ? (canonicalCodexSubagentTool(tool) ?? tool) : undefined;
}

function codexThreadChildRunId(threadId: string): string {
	return `${CODEX_THREAD_CHILD_RUN_PREFIX}${threadId}`;
}

function codexSubagentWorkGraph(
	args: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	const graph = args?.codexWorkGraph ?? args?.codex_work_graph;
	return isRecord(graph) ? graph : undefined;
}

function codexSubagentWorkGraphChildRuns(
	args: Record<string, unknown> | undefined,
): Record<string, unknown>[] {
	const graph = codexSubagentWorkGraph(args);
	const childRuns = graph?.childRuns ?? graph?.child_runs;
	if (!Array.isArray(childRuns)) {
		return [];
	}
	return childRuns.filter(isRecord);
}

function codexSubagentReceiverThreadIds(
	args: Record<string, unknown>,
): string[] {
	const explicit = stringArray(
		args.receiverThreadIds ?? args.receiver_thread_ids,
	);
	if (explicit.length > 0) {
		return explicit;
	}
	const graphThreadIds = codexSubagentWorkGraphChildRuns(args)
		.map((childRun) => childRun.threadId ?? childRun.thread_id)
		.filter(
			(threadId): threadId is string =>
				typeof threadId === "string" && threadId.length > 0,
		);
	return graphThreadIds;
}

function codexSubagentExplicitChildRunIds(
	args: Record<string, unknown>,
): string[] {
	const explicit = stringArray(args.childRunIds ?? args.child_run_ids);
	if (explicit.length > 0) {
		return explicit;
	}
	const graphChildRunIds = codexSubagentWorkGraphChildRuns(args)
		.map((childRun) => childRun.childRunId ?? childRun.child_run_id)
		.filter(
			(childRunId): childRunId is string =>
				typeof childRunId === "string" && childRunId.length > 0,
		);
	if (graphChildRunIds.length > 0) {
		return graphChildRunIds;
	}
	return [];
}

function codexSubagentChildRunIds(
	args: Record<string, unknown>,
	receiverThreadIds: string[],
): string[] {
	const explicit = codexSubagentExplicitChildRunIds(args);
	if (explicit.length > 0) {
		return explicit;
	}
	return receiverThreadIds.map(codexThreadChildRunId);
}

function codexSubagentNextAction(tool: string): string {
	return (
		codexSubagentContractNextAction(tool) ??
		"track Codex subagent collaboration"
	);
}

function codexSubagentDelegationTargetAgentId(
	args: Record<string, unknown>,
): string | undefined {
	return (
		nonEmptyString(args.toAgentId) ??
		nonEmptyString(args.to_agent_id) ??
		nonEmptyString(args.targetAgentId) ??
		nonEmptyString(args.target_agent_id)
	);
}

function codexSubagentDelegationRequiredCapability(
	args: Record<string, unknown>,
	targetAgentId?: string,
): string | undefined {
	const explicit =
		nonEmptyString(args.requiredCapability) ??
		nonEmptyString(args.required_capability) ??
		nonEmptyString(args.capability);
	return (
		explicit ??
		(targetAgentId ? undefined : DEFAULT_CODEX_SUBAGENT_DELEGATION_CAPABILITY)
	);
}

function codexSubagentDelegationA2ASkillID(
	args: Record<string, unknown>,
	requiredCapability?: string,
): string | undefined {
	const explicit =
		nonEmptyString(args.a2aSkillId) ??
		nonEmptyString(args.a2a_skill_id) ??
		nonEmptyString(args.agentSkillId) ??
		nonEmptyString(args.agent_skill_id) ??
		nonEmptyString(args.subagentSkillId) ??
		nonEmptyString(args.subagent_skill_id) ??
		nonEmptyString(args.skillId) ??
		nonEmptyString(args.skill_id);
	if (explicit) {
		return explicit.trim();
	}
	const subagentType =
		nonEmptyString(args.agentType) ??
		nonEmptyString(args.agent_type) ??
		nonEmptyString(args.subagentType) ??
		nonEmptyString(args.subagent_type);
	return (
		codexSubagentTypeA2ASkillID(subagentType) ??
		codexSubagentCapabilityA2ASkillID(requiredCapability)
	);
}

function codexSubagentTypeA2ASkillID(
	value: string | undefined,
): string | undefined {
	const token = codexSubagentSkillToken(value);
	if (!token) {
		return undefined;
	}
	switch (token) {
		case "pr-review":
		case "review":
		case "reviewer":
		case "code-review":
		case "code-reviewer":
			return "maestro.subagent.code-review";
		case "test":
		case "qa":
		case "ci":
		case "ci-monitor":
		case "test-runner":
			return "maestro.subagent.test-runner";
		case "explore":
		case "explorer":
		case "repo-explorer":
		case "research":
		case "competitive-intel":
		case "people-research":
			return "maestro.subagent.repo-explorer";
		case "release":
		case "release-shepherd":
			return "maestro.subagent.release-shepherd";
		case "worker":
		case "coder":
		case "code":
		case "code-writer":
		case "default":
			return "maestro.subagent.code-writer";
		default:
			return `maestro.subagent.${token}`;
	}
}

function codexSubagentCapabilityA2ASkillID(
	value: string | undefined,
): string | undefined {
	const token = codexSubagentSkillToken(value);
	if (!token) {
		return undefined;
	}
	switch (token) {
		case "code-review":
			return "maestro.subagent.code-review";
		case "code-test":
		case "test-run":
		case "test-runner":
			return "maestro.subagent.test-runner";
		case "repo-explore":
		case "repo-explorer":
		case "code-search":
			return "maestro.subagent.repo-explorer";
		case "release-shepherd":
		case "release-manage":
			return "maestro.subagent.release-shepherd";
		case "code-write":
		case "code-edit":
		case "code-implement":
			return "maestro.subagent.code-writer";
		default:
			return `maestro.subagent.${token}`;
	}
}

function codexSubagentSkillToken(
	value: string | undefined,
): string | undefined {
	const token = value
		?.trim()
		.toLowerCase()
		.replace(/[:_/. ]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-|-$/g, "");
	return token || undefined;
}

function codexSubagentDelegationReason(prompt: string | undefined): string {
	if (!prompt) {
		return "Codex subagent spawn requested by Maestro";
	}
	return `Codex subagent spawn requested by Maestro: ${prompt}`.slice(0, 512);
}

function codexSubagentOperation(tool: string): string | undefined {
	return codexSubagentOperationName(tool);
}

function activeCodexSubagentEdgeStatus(tool: string): string | undefined {
	return codexSubagentActiveStatus(tool);
}

function terminalCodexSubagentEdgeStatus(
	tool: string,
	isError: boolean,
): string | undefined {
	if (isError) {
		return "failed";
	}
	return codexSubagentTerminalSuccessStatus(tool);
}

function shouldResolveCodexSubagentDelegation(
	tool: string,
	isError: boolean,
): boolean {
	if (tool === "wait" || tool === "closeAgent") {
		return true;
	}
	if (tool === "spawnAgent" && isError) {
		return true;
	}
	if (tool === "resumeAgent" && isError) {
		return true;
	}
	return false;
}

function codexSubagentDelegationFailureMessage(tool: string): string {
	switch (tool) {
		case "spawnAgent":
			return "Codex subagent spawn failed";
		case "sendInput":
			return "Codex subagent input failed";
		case "resumeAgent":
			return "Codex subagent resume failed";
		case "wait":
			return "Codex subagent wait failed";
		case "closeAgent":
			return "Codex subagent close failed";
		default:
			return "Codex subagent delegation failed";
	}
}

function toolDisplayName(event: {
	displayName?: string;
	summaryLabel?: string;
	toolName: string;
}): string {
	return event.displayName ?? event.summaryLabel ?? event.toolName;
}

const MAX_TEXT_FIELD_LENGTH = 160;
const MAX_DELEGATION_PROMPT_LENGTH = 512;
const REDACTED = "[redacted]";
const COMMON_MAKE_TARGETS = new Set([
	"all",
	"build",
	"check",
	"clean",
	"dev",
	"dist",
	"docs",
	"format",
	"install",
	"lint",
	"release",
	"start",
	"test",
	"typecheck",
	"verify",
]);

function hostedCredentialPattern(source: string, flags: string): RegExp {
	return new RegExp(source, flags.replace(/g/g, ""));
}

const HOSTED_CREDENTIAL_PATTERNS = [
	...CREDENTIAL_PATTERN_DEFS.filter(
		(pattern) =>
			!["Authorization Header", "Bearer Token", "Password Assignment"].includes(
				pattern.name,
			) && pattern.name !== "Password in URL",
	).map((pattern) => hostedCredentialPattern(pattern.source, pattern.flags)),
	/\b(?:sk[-_][A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_-]{8,}|github_pat_[A-Za-z0-9_-]{8,}|xoxb[A-Za-z0-9_-]{8,}|xoxp[A-Za-z0-9_-]{8,}|AKIA[A-Za-z0-9_-]{8,}|ASIA[A-Za-z0-9_-]{8,})\b/,
	/\/\/[^:/\s@]+:[^@/\s]+@[^/\s]+/,
	/\b(?:api[_-]?key|apikey|api[_-]?token)[':"\s=]+['"]?[A-Za-z0-9_-]{20,}\b/i,
	/\b(?:password|passwd|pwd|secret)\s*[:=]\s*['"]?[^'"\s]{8,}/i,
	/\b(?:api[_-]?key|token|secret|password)[':"\s=]+['"]?[A-Za-z0-9+/=]{24,}/i,
	/\b(?:secret|key|token)[':"\s=]+['"]?[a-fA-F0-9]{32,}\b/i,
	/\b(?:api[_-]?key|token|secret|password)[':"\s=]+['"]?[A-Za-z0-9_.-]{16,}/i,
	/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
	/\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql):\/\/[^\s]+/i,
	/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
	/\b(?:aws[_-]?secret[_-]?(?:access[_-]?)?key|secret[_-]?key)[':"\s=]+['"]?[A-Za-z0-9/+=]{40}\b/i,
	/\bAIza[A-Za-z0-9_-]{35}\b/,
	/\bya29\.[A-Za-z0-9_-]{20,}\b/,
	/(^|[^A-Za-z0-9_-])1\/\/[A-Za-z0-9_-]{40,}/,
	/\bBearer\s+(?=[A-Za-z0-9_.-]{16,}\b)(?=[A-Za-z0-9_.-]*[0-9_.-])[A-Za-z0-9_.-]+/i,
	/\bBasic\s+[A-Za-z0-9+/=]{16,}/i,
	/\bAuthorization\s*[:=]\s*['"]?(?:Basic\s+[A-Za-z0-9+/=]{16,}|(?:Bearer|Token)\s+(?=[A-Za-z0-9_\-./+=]{16,}\b)(?=[A-Za-z0-9_\-./+=]*[0-9_\-./+=])[A-Za-z0-9_\-./+=]+)\b/i,
	/[?&](?:sv|sig|se|sp)=[A-Za-z0-9%_-]{10,}/i,
	/\b(?:AccountKey|SharedAccessKey)=[A-Za-z0-9+/=]{40,}/i,
	/\b(?:client[_-]?secret|azure[_-]?secret)[':"\s=]+['"]?[A-Za-z0-9~_.-]{32,}/i,
	/\bnpm_[A-Za-z0-9]{36}\b/,
	/\bpypi-[A-Za-z0-9]{60,}\b/,
];

function containsHostedCredential(value: string): boolean {
	return HOSTED_CREDENTIAL_PATTERNS.some((pattern) => pattern.test(value));
}

function shouldRedactOutboundText(text: string): boolean {
	return containsHostedCredential(text) || containsShellCommandSyntax(text);
}

function sanitizeOutboundText(
	value: string | undefined,
	maxLength = MAX_TEXT_FIELD_LENGTH,
): string | undefined {
	const text = nonEmptyString(value);
	if (!text) {
		return undefined;
	}
	if (shouldRedactOutboundText(text)) {
		return REDACTED;
	}
	return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function sanitizeToolBatchSummaryText(
	value: string | undefined,
	toolNames?: string[],
): string | undefined {
	const text = nonEmptyString(value);
	if (
		text?.split(/\s*,\s*/).some((part, index) => {
			const toolName = toolNames?.[index];
			return (
				containsGeneratedShellToolLabel(toolName, part) ||
				containsBatchGeneratedShellToolLabel(toolNames, part) ||
				containsShellCommandSyntax(part)
			);
		})
	) {
		return REDACTED;
	}
	return sanitizeOutboundText(value, 512);
}

function sanitizeToolBatchSummaryLabels(
	labels: string[] | undefined,
	toolNames: string[] | undefined,
): string[] | undefined {
	if (!labels) {
		return undefined;
	}
	return labels
		.map((label, index) =>
			containsBatchGeneratedShellToolLabel(toolNames, label)
				? REDACTED
				: sanitizeToolOutboundText(toolNames?.[index], label),
		)
		.filter((label): label is string => Boolean(label));
}

function sanitizeOutboundPayload(
	payload: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (!payload) {
		return undefined;
	}
	return Object.fromEntries(
		Object.entries(payload).map(([key, value]) => [
			key,
			typeof value === "string"
				? sanitizeOutboundText(value)
				: Array.isArray(value) &&
						value.every((item) => typeof item === "string")
					? sanitizeOutboundTextArray(value)
					: value,
		]),
	);
}

function sanitizeHostedDrainPlatformEvidence(value: unknown): unknown {
	if (!isRecord(value)) {
		return value;
	}
	const reason =
		typeof value.reason === "string"
			? sanitizeOutboundText(value.reason, 512)
			: undefined;
	return reason ? { ...value, reason } : value;
}

function containsShellCommandSyntax(value: string): boolean {
	const generatedShellLabel = /^\s*Ran\s+(.+)$/i.exec(value);
	if (
		generatedShellLabel?.[1] &&
		containsShellCommandAtStart(generatedShellLabel[1])
	) {
		return true;
	}
	const embeddedGeneratedShellLabel = /(?:^|[,;]\s*)Ran\s+(.+)$/i.exec(value);
	if (
		embeddedGeneratedShellLabel?.[1] &&
		containsShellCommandAtStart(embeddedGeneratedShellLabel[1])
	) {
		return true;
	}
	if (containsShellCommandAtStart(value)) {
		return true;
	}
	const prefixedCommand =
		/\b(?:detected (?:command|[^:\n]*\bcommand)|command failed|command):\s*(\S[\s\S]*)$/i.exec(
			value,
		);
	if (prefixedCommand?.[1]) {
		return containsCommandLikePrefixedText(prefixedCommand[1], {
			allowArbitraryMakeTargets: true,
		});
	}
	const embeddedCommand =
		/\b(?:please\s+)?(run|running|execute|start|launch|retry)\s+([\s\S]+)$/i.exec(
			value,
		);
	if (!embeddedCommand?.[1] || !embeddedCommand[2]) {
		return false;
	}
	if (
		embeddedCommand[1].toLowerCase() === "running" &&
		containsExplicitCommandLabelPlainOperandSyntax(embeddedCommand[2])
	) {
		return true;
	}
	return containsShellCommandAtStart(embeddedCommand[2], {
		allowArbitraryMakeTargets: true,
	});
}

function sanitizeStatusText(
	status: string,
	details: Record<string, unknown>,
): string | undefined {
	return containsGeneratedShellStatusContext(status, details)
		? REDACTED
		: sanitizeOutboundText(status, 512);
}

function containsGeneratedShellStatusContext(
	value: string,
	details: Record<string, unknown>,
): boolean {
	if (!isGeneratedShellToolStatus(details)) {
		return false;
	}
	const match = /^\s*Running\s+(.+?)\s*$/i.exec(value);
	const command = match?.[1]?.trim();
	return Boolean(command && command.toLowerCase() !== "command");
}

function isGeneratedShellToolStatus(details: Record<string, unknown>): boolean {
	if (details.kind !== "tool_execution_summary") {
		return false;
	}
	const toolName =
		typeof details.toolName === "string" ? details.toolName.toLowerCase() : "";
	return new Set(["bash", "shell", "exec_command"]).has(toolName);
}

function containsCommandLikePrefixedText(
	value: string,
	options: { allowArbitraryMakeTargets?: boolean } = {},
): boolean {
	if (containsShellCommandAtStart(value, options)) {
		return true;
	}
	const firstLine = value.split(/\r?\n/, 1)[0]?.trim();
	if (
		firstLine &&
		firstLine !== value.trim() &&
		containsShellCommandAtStart(firstLine, options)
	) {
		return true;
	}
	if (containsExplicitCommandLabelPlainOperandSyntax(value)) {
		return true;
	}
	const parts = value.trim().split(/\s+/);
	if (parts.length < 2) {
		return false;
	}
	return parts
		.slice(1)
		.some((part) =>
			/^(?:-|\.{1,2}$|\.{1,2}\/|~\/|\/|[A-Za-z0-9_.-]*\/|[A-Za-z_][A-Za-z0-9_]*=)|[/.*?]|\.[A-Za-z0-9_-]+$/.test(
				part,
			),
		);
}

function containsExplicitCommandLabelPlainOperandSyntax(
	value: string,
): boolean {
	return (
		containsPackageManagerPlainOperandCommandSyntax(value) ||
		containsGitPlainOperandCommandSyntax(value) ||
		containsYarnPlainOperandCommandSyntax(value) ||
		containsGoCargoPlainOperandCommandSyntax(value) ||
		containsPipPlainOperandCommandSyntax(value) ||
		containsDockerPlainOperandCommandSyntax(value) ||
		containsTerraformPlainOperandCommandSyntax(value) ||
		containsShellBuiltinPlainOperandCommandSyntax(value) ||
		containsSimpleShellCommandLabelSyntax(value)
	);
}

function containsShellBuiltinPlainOperandCommandSyntax(value: string): boolean {
	return /^\s*(?:echo|printf)(?:\s+\S+)+\s*$/.test(value);
}

function containsSimpleShellCommandLabelSyntax(value: string): boolean {
	const text = value.trim();
	return (
		/^(?:pwd|date)\s*$/.test(text) ||
		/^uname\s+-[A-Za-z]+\s*$/.test(text) ||
		/^which\s+\S+\s*$/.test(text)
	);
}

function containsPackageManagerPlainOperandCommandSyntax(
	value: string,
): boolean {
	const match =
		/^\s*(?:npm|pnpm|bun)\s+([A-Za-z][A-Za-z0-9_-]*)(?:\s+\S+)+\s*$/.exec(
			value,
		);
	const subcommand = match?.[1];
	return subcommand
		? new Set([
				"install",
				"add",
				"remove",
				"exec",
				"run",
				"test",
				"build",
				"start",
				"ci",
				"create",
			]).has(subcommand)
		: false;
}

function containsGitPlainOperandCommandSyntax(value: string): boolean {
	const match = /^\s*git\s+([A-Za-z][A-Za-z0-9_-]*)(?:\s+\S+)+\s*$/.exec(value);
	const subcommand = match?.[1];
	return subcommand
		? new Set([
				"add",
				"branch",
				"checkout",
				"clone",
				"commit",
				"fetch",
				"merge",
				"pull",
				"push",
				"rebase",
				"remote",
				"reset",
				"restore",
				"show",
				"stash",
				"status",
				"switch",
				"tag",
				"worktree",
			]).has(subcommand)
		: false;
}

function containsYarnPlainOperandCommandSyntax(value: string): boolean {
	const match = /^\s*yarn\s+([A-Za-z][A-Za-z0-9_-]*)(?:\s+\S+)+\s*$/.exec(
		value,
	);
	const subcommand = match?.[1];
	return subcommand
		? new Set([
				"add",
				"remove",
				"run",
				"test",
				"build",
				"install",
				"exec",
				"workspace",
				"workspaces",
				"dlx",
			]).has(subcommand)
		: false;
}

function containsGoCargoPlainOperandCommandSyntax(value: string): boolean {
	const match = /^\s*(go|cargo)\s+([A-Za-z][A-Za-z0-9_-]*)(?:\s+\S+)+\s*$/.exec(
		value,
	);
	const command = match?.[1];
	const subcommand = match?.[2];
	const allowed: Record<string, ReadonlySet<string>> = {
		go: new Set([
			"test",
			"run",
			"build",
			"mod",
			"fmt",
			"vet",
			"install",
			"generate",
			"env",
		]),
		cargo: new Set([
			"test",
			"run",
			"build",
			"check",
			"fmt",
			"clippy",
			"install",
		]),
	};
	return command && subcommand
		? (allowed[command]?.has(subcommand) ?? false)
		: false;
}

function containsPipPlainOperandCommandSyntax(value: string): boolean {
	const match = /^\s*pip(?:3)?\s+([A-Za-z][A-Za-z0-9_-]*)(?:\s+\S+)+\s*$/.exec(
		value,
	);
	const subcommand = match?.[1];
	return subcommand
		? new Set([
				"install",
				"uninstall",
				"download",
				"wheel",
				"show",
				"list",
				"freeze",
				"check",
			]).has(subcommand)
		: false;
}

function containsDockerPlainOperandCommandSyntax(value: string): boolean {
	const match = /^\s*docker\s+([A-Za-z][A-Za-z0-9_-]*)(?:\s+\S+)+\s*$/.exec(
		value,
	);
	const subcommand = match?.[1];
	return subcommand
		? new Set([
				"build",
				"run",
				"compose",
				"pull",
				"push",
				"exec",
				"inspect",
				"logs",
				"stop",
				"start",
				"restart",
				"rm",
				"rmi",
				"tag",
			]).has(subcommand)
		: false;
}

function containsTerraformPlainOperandCommandSyntax(value: string): boolean {
	const match = /^\s*terraform\s+([A-Za-z][A-Za-z0-9_-]*)(?:\s+\S+)+\s*$/.exec(
		value,
	);
	const subcommand = match?.[1];
	return subcommand
		? new Set([
				"apply",
				"destroy",
				"import",
				"output",
				"plan",
				"show",
				"state",
				"workspace",
			]).has(subcommand)
		: false;
}

function containsShellCommandAtStart(
	value: string,
	options: { allowArbitraryMakeTargets?: boolean } = {},
): boolean {
	const unwrapped = unwrapCommandText(value);
	if (unwrapped !== value && containsShellCommandAtStart(unwrapped, options)) {
		return true;
	}
	if (containsLeadingWrappedCommandSyntax(value, options)) {
		return true;
	}
	if (
		/^\s*(?:bash|sh|zsh)\s+(?:-[A-Za-z]+|\.{0,2}\/|~\/|[A-Za-z0-9_.\/-]+\.(?:bash|sh|zsh))/i.test(
			value,
		) ||
		/^\s*(?:powershell|cmd)\s+(?:-[A-Za-z]+|\/c\b)/i.test(value)
	) {
		return true;
	}
	if (containsKnownExecutableCommandSyntax(value)) {
		return true;
	}
	if (containsYarnGoCargoCommandSyntax(value)) {
		return true;
	}
	if (containsMakeCommandSyntax(value, options)) {
		return true;
	}
	if (containsEnvPrefixedCommandSyntax(value, options)) {
		return true;
	}
	if (containsEnvWrappedCommandSyntax(value, options)) {
		return true;
	}
	if (containsChainedShellBuiltinSyntax(value)) {
		return true;
	}
	return (
		containsPathCommandSyntax(value) ||
		containsSimpleShellUtilitySyntax(value) ||
		containsShellMetacharCommandSyntax(value) ||
		/^\s*(?:\.{0,2}\/|[A-Za-z0-9_.-]*\/)[^\s]+(?:\s+\S+)*(?:\s*(?:&&|\|\||[;|`])|\$\()/i.test(
			value,
		)
	);
}

function containsKnownExecutableCommandSyntax(value: string): boolean {
	const text = value.trimStart();
	return (
		/^(?:rm\s+-[A-Za-z]*[rf][A-Za-z]*\s+\S+|node\s+(?:-[A-Za-z]|--\S+|\.{1,2}\/\S+|~\/\S+|\/\S+|[A-Za-z0-9_.-]*\/\S+|\S+\.(?:cjs|mjs|js|ts|tsx))\S*(?:\s+\S+)*)/.test(
			text,
		) ||
		containsGitCommandSyntax(text) ||
		containsDockerCommandSyntax(text) ||
		containsGhCommandSyntax(text) ||
		containsSudoCommandSyntax(text) ||
		containsHttpFetchCommandSyntax(text) ||
		containsPackageManagerCommandSyntax(text) ||
		containsPythonCommandSyntax(text) ||
		containsInfraCommandSyntax(text) ||
		containsToolCommandSyntax(text)
	);
}

function containsGitCommandSyntax(value: string): boolean {
	const match = /^\s*git\s+(\S+)(?:\s+(.+?))?\s*$/.exec(value);
	const subcommand = match?.[1];
	if (!subcommand) {
		return false;
	}
	if (subcommand.startsWith("-")) {
		return true;
	}
	const allowed = new Set([
		"add",
		"am",
		"apply",
		"bisect",
		"branch",
		"checkout",
		"clone",
		"commit",
		"config",
		"diff",
		"fetch",
		"grep",
		"init",
		"log",
		"merge",
		"mv",
		"pull",
		"push",
		"rebase",
		"remote",
		"reset",
		"restore",
		"rm",
		"show",
		"stash",
		"status",
		"switch",
		"tag",
		"worktree",
	]);
	if (!allowed.has(subcommand)) {
		return false;
	}
	const args = match[2]?.trim();
	if (!args) {
		return true;
	}
	return args
		.split(/\s+/)
		.some((arg) => hasGitCommandCueArgument(subcommand, arg));
}

function hasGitCommandCueArgument(subcommand: string, arg: string): boolean {
	if (hasCommandCueArgument(arg) || /^https?:\/\//i.test(arg)) {
		return true;
	}
	if (["fetch", "pull", "push"].includes(subcommand)) {
		return /^[A-Za-z0-9_.-]+(?::[A-Za-z0-9_./-]+)?$/.test(arg);
	}
	return false;
}

function containsDockerCommandSyntax(value: string): boolean {
	const match = /^\s*docker\s+(\S+)(?:\s+(.+?))?\s*$/.exec(value);
	const subcommand = match?.[1];
	if (!subcommand) {
		return false;
	}
	const allowed = new Set([
		"build",
		"run",
		"compose",
		"ps",
		"pull",
		"push",
		"login",
		"logout",
		"exec",
		"image",
		"images",
		"container",
		"volume",
		"network",
		"system",
		"context",
		"inspect",
		"logs",
		"stop",
		"start",
		"restart",
		"rm",
		"rmi",
		"tag",
		"version",
		"info",
	]);
	if (!allowed.has(subcommand)) {
		return false;
	}
	const args = match[2]?.trim();
	if (!args) {
		return true;
	}
	return args.split(/\s+/).some((arg) => hasCommandCueArgument(arg));
}

function containsGhCommandSyntax(value: string): boolean {
	const match = /^\s*gh\s+(\S+)(?:\s+(.+?))?\s*$/.exec(value);
	const subcommand = match?.[1];
	if (!subcommand) {
		return false;
	}
	if (subcommand.startsWith("-")) {
		return true;
	}
	const allowed = new Set([
		"alias",
		"api",
		"auth",
		"browse",
		"codespace",
		"completion",
		"config",
		"extension",
		"gpg-key",
		"gist",
		"issue",
		"label",
		"pr",
		"release",
		"repo",
		"run",
		"search",
		"secret",
		"ssh-key",
		"status",
		"variable",
		"workflow",
	]);
	if (!allowed.has(subcommand)) {
		return false;
	}
	const args = match[2]?.trim();
	if (!args) {
		return !ghCommandGroupChildren[subcommand];
	}
	const [rawChild, ...rest] = args.split(/\s+/);
	if (!rawChild) {
		return false;
	}
	if (rawChild.startsWith("-")) {
		return true;
	}
	const child = rawChild.toLowerCase();
	const allowedChildren = ghCommandGroupChildren[subcommand];
	if (!allowedChildren) {
		return true;
	}
	if (allowedChildren?.has(child)) {
		return true;
	}
	return [rawChild, ...rest].some((arg) => hasCommandCueArgument(arg));
}

const ghCommandGroupChildren: Record<string, ReadonlySet<string>> = {
	auth: new Set([
		"login",
		"logout",
		"refresh",
		"setup-git",
		"status",
		"switch",
	]),
	codespace: new Set([
		"code",
		"cp",
		"create",
		"delete",
		"edit",
		"jupyter",
		"list",
		"logs",
		"ports",
		"rebuild",
		"ssh",
		"stop",
	]),
	extension: new Set([
		"browse",
		"create",
		"exec",
		"install",
		"list",
		"remove",
		"search",
		"upgrade",
	]),
	gist: new Set([
		"clone",
		"create",
		"delete",
		"edit",
		"list",
		"rename",
		"view",
	]),
	issue: new Set([
		"close",
		"comment",
		"create",
		"delete",
		"develop",
		"edit",
		"list",
		"lock",
		"pin",
		"reopen",
		"status",
		"transfer",
		"unlock",
		"unpin",
		"view",
	]),
	pr: new Set([
		"checkout",
		"checks",
		"close",
		"comment",
		"create",
		"diff",
		"edit",
		"list",
		"lock",
		"merge",
		"ready",
		"reopen",
		"review",
		"status",
		"unlock",
		"update-branch",
		"view",
	]),
	release: new Set([
		"create",
		"delete",
		"delete-asset",
		"download",
		"edit",
		"list",
		"upload",
		"view",
	]),
	repo: new Set([
		"archive",
		"clone",
		"create",
		"delete",
		"deploy-key",
		"edit",
		"fork",
		"list",
		"rename",
		"set-default",
		"sync",
		"unarchive",
		"view",
	]),
	run: new Set([
		"cancel",
		"delete",
		"download",
		"list",
		"rerun",
		"view",
		"watch",
	]),
	secret: new Set(["delete", "list", "set"]),
	variable: new Set(["delete", "get", "list", "set"]),
	workflow: new Set(["disable", "enable", "list", "run", "view"]),
};

function containsSudoCommandSyntax(value: string): boolean {
	const parts = value.trim().split(/\s+/);
	if (parts.shift() !== "sudo") {
		return false;
	}
	while (parts[0]?.startsWith("-")) {
		const option = parts.shift();
		if (option && ["-u", "-g", "-h", "-p", "-C", "-T"].includes(option)) {
			parts.shift();
		}
	}
	const command = parts.join(" ");
	return command ? containsShellCommandAtStart(command) : false;
}

function containsHttpFetchCommandSyntax(value: string): boolean {
	const match = /^\s*(?:curl|wget)\s+(.+?)\s*$/.exec(value);
	if (!match?.[1]) {
		return false;
	}
	const args = match[1].trim().split(/\s+/);
	return args.some(
		(arg) =>
			arg.startsWith("-") ||
			/^(?:https?|ftp):\/\//i.test(arg) ||
			/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?:[/:?#]\S*)?$/i.test(arg),
	);
}

function containsYarnGoCargoCommandSyntax(value: string): boolean {
	const match =
		/^\s*(yarn|go|cargo)\s+([A-Za-z][A-Za-z0-9_-]*)(?:\s+(.+?))?\s*$/.exec(
			value,
		);
	const command = match?.[1];
	const subcommand = match?.[2];
	if (!command || !subcommand) {
		return false;
	}
	const allowed: Record<string, ReadonlySet<string>> = {
		yarn: new Set([
			"test",
			"run",
			"build",
			"install",
			"add",
			"remove",
			"exec",
			"workspace",
			"workspaces",
			"dlx",
		]),
		go: new Set([
			"test",
			"run",
			"build",
			"mod",
			"fmt",
			"vet",
			"install",
			"generate",
			"env",
			"version",
		]),
		cargo: new Set([
			"test",
			"run",
			"build",
			"check",
			"fmt",
			"clippy",
			"install",
		]),
	};
	if (!allowed[command]?.has(subcommand)) {
		return false;
	}
	const args = match[3]?.trim();
	if (!args) {
		return true;
	}
	return args
		.split(/\s+/)
		.some((arg) =>
			/^(?:-|\.{1,2}$|\.{1,2}\/|~\/|\/|[A-Za-z0-9_.-]*\/|[A-Za-z_][A-Za-z0-9_]*=)|[/.*?]|\.[A-Za-z0-9_-]+$/.test(
				arg,
			),
		);
}

function containsPackageManagerCommandSyntax(value: string): boolean {
	return (
		containsNpmPnpmCommandSyntax(value) ||
		containsBunCommandSyntax(value) ||
		containsPackageRunnerCommandSyntax(value) ||
		containsUvCommandSyntax(value)
	);
}

function containsPackageRunnerCommandSyntax(value: string): boolean {
	const match = /^\s*(npx|bunx|uvx)\s+(\S+)(?:\s+(.+?))?\s*$/.exec(value);
	if (!match) {
		return false;
	}
	const command = match[2];
	if (!command) {
		return false;
	}
	if (
		/^(?:-[A-Za-z]|--\S+|\.{1,2}\/\S+|~\/\S+|\/\S+|[A-Za-z0-9_.-]*\/\S+)/.test(
			command,
		)
	) {
		return true;
	}
	if (!isPackageSpecCommandCue(command) && !isKnownPackageRunnerTool(command)) {
		return false;
	}
	const args = match[3]?.trim();
	if (!args) {
		return true;
	}
	return args
		.split(/\s+/)
		.some((arg) => hasPackageManagerCommandCueArgument(arg));
}

function containsUvCommandSyntax(value: string): boolean {
	const match = /^\s*uv\s+(\S+)(?:\s+(.+?))?\s*$/.exec(value);
	if (!match) {
		return false;
	}
	const subcommand = match[1];
	if (!subcommand) {
		return false;
	}
	if (
		/^(?:-[A-Za-z]|--\S+|\.{1,2}\/\S+|~\/\S+|\/\S+|[A-Za-z0-9_.-]*\/\S+)/.test(
			subcommand,
		)
	) {
		return true;
	}
	const allowed = new Set([
		"run",
		"tool",
		"pip",
		"venv",
		"sync",
		"add",
		"remove",
		"init",
		"lock",
		"export",
		"python",
		"build",
		"publish",
	]);
	if (!allowed.has(subcommand)) {
		return false;
	}
	const args = match[2]?.trim();
	if (!args) {
		return true;
	}
	return args
		.split(/\s+/)
		.some((arg) => hasPackageManagerCommandCueArgument(arg));
}

function hasPackageManagerCommandCueArgument(arg: string): boolean {
	return (
		hasCommandCueArgument(arg) ||
		isPackageSpecCommandCue(arg) ||
		isKnownPackageRunnerTool(arg) ||
		isPackageRunnerSubcommandCue(arg)
	);
}

function isKnownPackageRunnerTool(value: string): boolean {
	return /^(?:biome|eslint|jest|nx|playwright|prettier|pytest|ruff|tsc|vitest)$/i.test(
		value,
	);
}

function isPackageRunnerSubcommandCue(value: string): boolean {
	return /^(?:build|check|fix|format|lint|run|test)$/i.test(value);
}

function isPackageSpecCommandCue(value: string): boolean {
	return (
		value.includes("@") ||
		/^[A-Za-z0-9_.-]+(?:==|~=|!=|<=|>=|<|>)\S+$/.test(value) ||
		/^[A-Za-z0-9_.-]+\[[^\]\s]+\](?:==|~=|!=|<=|>=|<|>)?\S*$/.test(value)
	);
}

function containsNpmPnpmCommandSyntax(value: string): boolean {
	const match =
		/^\s*(npm|pnpm)\s+([A-Za-z][A-Za-z0-9_-]*)(?:\s+(.+?))?\s*$/.exec(value);
	const command = match?.[1];
	const subcommand = match?.[2];
	if (!command || !subcommand) {
		return false;
	}
	const allowed = new Set([
		"run",
		"test",
		"build",
		"install",
		"add",
		"remove",
		"exec",
		"ci",
		"start",
		"stop",
		"restart",
		"publish",
		"pack",
		"audit",
		"lint",
		"format",
		"view",
		"config",
		"cache",
		"workspace",
		"workspaces",
		"create",
		"init",
		"link",
		"unlink",
		"outdated",
		"update",
		"version",
	]);
	if (!allowed.has(subcommand)) {
		return false;
	}
	const args = match[3]?.trim();
	if (!args) {
		return true;
	}
	if (
		["run", "exec", "workspace", "workspaces", "create"].includes(subcommand)
	) {
		return true;
	}
	return args.split(/\s+/).some((arg) => hasCommandCueArgument(arg));
}

function containsBunCommandSyntax(value: string): boolean {
	if (
		/^\s*bun\s+(?:-[A-Za-z]|--\S+|\.{1,2}\/\S+|~\/\S+|\/\S+|[A-Za-z0-9_.-]*\/\S+|\S+\.(?:cjs|mjs|js|ts|tsx))(?:\s+\S+)*\s*$/.test(
			value,
		)
	) {
		return true;
	}
	const match = /^\s*bun\s+([A-Za-z][A-Za-z0-9_-]*)(?:\s+(.+?))?\s*$/.exec(
		value,
	);
	const subcommand = match?.[1];
	if (!subcommand) {
		return false;
	}
	const allowed = new Set([
		"run",
		"test",
		"install",
		"add",
		"remove",
		"x",
		"exec",
		"build",
		"create",
		"init",
	]);
	if (!allowed.has(subcommand)) {
		return false;
	}
	const args = match[2]?.trim();
	if (!args) {
		return true;
	}
	if (["run", "x", "exec", "create"].includes(subcommand)) {
		return true;
	}
	return args.split(/\s+/).some((arg) => hasCommandCueArgument(arg));
}

function hasCommandCueArgument(arg: string): boolean {
	return /^(?:-|\.{1,2}$|\.{1,2}\/|~\/|\/|[A-Za-z0-9_.-]*\/|[A-Za-z_][A-Za-z0-9_]*=)|[/.*?]|\.[A-Za-z0-9_-]+$/.test(
		arg,
	);
}

function containsPythonCommandSyntax(value: string): boolean {
	return (
		/^(?:python(?:3)?\s+(?:-[A-Za-z]|--\S+|\.{1,2}\/\S+|~\/\S+|\/\S+|[A-Za-z0-9_.-]*\/\S+|\S+\.(?:py|pyw))(?:\s+\S+)*|pytest(?:\s*$|\s+(?:-[A-Za-z]|--\S+|\.{1,2}\/\S+|~\/\S+|\/\S+|[A-Za-z0-9_.-]*\/\S+|tests?\b|\S+\.py\b)(?:\s+\S+)*))/.test(
			value,
		) || containsPipCommandSyntax(value)
	);
}

function containsPipCommandSyntax(value: string): boolean {
	const match =
		/^\s*pip(?:3)?\s+([A-Za-z][A-Za-z0-9_-]*)(?:\s+(.+?))?\s*$/.exec(value);
	if (!match) {
		return false;
	}
	const rawSubcommand = match[1];
	if (!rawSubcommand) {
		return false;
	}
	const subcommand = rawSubcommand.toLowerCase();
	const allowed = new Set([
		"install",
		"uninstall",
		"list",
		"freeze",
		"show",
		"download",
		"wheel",
		"check",
		"config",
		"cache",
	]);
	if (!allowed.has(subcommand)) {
		return false;
	}
	const args = match[2]?.trim();
	if (!args) {
		return true;
	}
	return args
		.split(/\s+/)
		.some((arg) => hasPythonPackageCommandCueArgument(arg));
}

function hasPythonPackageCommandCueArgument(arg: string): boolean {
	return (
		hasCommandCueArgument(arg) ||
		/^[A-Za-z0-9_.-]+(?:==|~=|!=|<=|>=|<|>)\S+$/.test(arg) ||
		/^[A-Za-z0-9_.-]+\[[^\]\s]+\](?:==|~=|!=|<=|>=|<|>)?\S*$/.test(arg)
	);
}

function containsInfraCommandSyntax(value: string): boolean {
	return (
		containsKubectlCommandSyntax(value) || containsTerraformCommandSyntax(value)
	);
}

function containsKubectlCommandSyntax(value: string): boolean {
	const match = /^\s*kubectl\s+([A-Za-z][A-Za-z0-9_-]*)(?:\s+(.+?))?\s*$/.exec(
		value,
	);
	const subcommand = match?.[1];
	if (!subcommand) {
		return false;
	}
	const allowed = new Set([
		"get",
		"apply",
		"delete",
		"describe",
		"logs",
		"exec",
		"port-forward",
		"cp",
		"create",
		"edit",
		"patch",
		"rollout",
		"scale",
		"annotate",
		"label",
		"config",
		"cluster-info",
		"api-resources",
		"version",
		"diff",
		"top",
	]);
	if (!allowed.has(subcommand)) {
		return false;
	}
	const args = match[2]?.trim();
	if (!args) {
		return true;
	}
	if (
		[
			"get",
			"apply",
			"delete",
			"describe",
			"logs",
			"exec",
			"port-forward",
			"cp",
			"create",
			"edit",
			"patch",
			"rollout",
			"scale",
			"annotate",
			"label",
			"config",
		].includes(subcommand)
	) {
		return true;
	}
	return args.split(/\s+/).some((arg) => hasCommandCueArgument(arg));
}

function containsTerraformCommandSyntax(value: string): boolean {
	const match =
		/^\s*terraform\s+([A-Za-z][A-Za-z0-9_-]*)(?:\s+(.+?))?\s*$/.exec(value);
	const subcommand = match?.[1];
	if (!subcommand) {
		return false;
	}
	const allowed = new Set([
		"init",
		"plan",
		"apply",
		"destroy",
		"fmt",
		"validate",
		"providers",
		"state",
		"import",
		"output",
		"workspace",
		"show",
		"taint",
		"untaint",
		"force-unlock",
		"graph",
		"version",
	]);
	if (!allowed.has(subcommand)) {
		return false;
	}
	const args = match[2]?.trim();
	if (!args) {
		return true;
	}
	if (["state", "import", "workspace"].includes(subcommand)) {
		return true;
	}
	return args.split(/\s+/).some((arg) => hasCommandCueArgument(arg));
}

function containsToolCommandSyntax(value: string): boolean {
	if (
		/^\s*tsc\s+(?:-[A-Za-z]|--\S+|\.{1,2}\/\S+|~\/\S+|\/\S+|[A-Za-z0-9_.-]*\/\S+|\S+\.(?:ts|tsx|js|json))(?:\s+\S+)*\s*$/.test(
			value,
		)
	) {
		return true;
	}
	const match = /^\s*(biome|buf|vite|vitest)\s+(\S+)(?:\s+(.+?))?\s*$/.exec(
		value,
	);
	if (!match) {
		return false;
	}
	const rawTool = match[1];
	const rawSubcommand = match[2];
	if (!rawTool || !rawSubcommand) {
		return false;
	}
	const tool = rawTool.toLowerCase();
	const subcommand = rawSubcommand.toLowerCase();
	const allowedByTool: Record<string, Set<string>> = {
		biome: new Set([
			"check",
			"ci",
			"format",
			"lint",
			"search",
			"migrate",
			"rage",
			"explain",
		]),
		buf: new Set([
			"lint",
			"generate",
			"format",
			"build",
			"breaking",
			"mod",
			"registry",
			"beta",
		]),
		vite: new Set(["build", "dev", "preview", "optimize"]),
		vitest: new Set(["run", "watch", "related"]),
	};
	if (subcommand.startsWith("--")) {
		return tool === "vite" || tool === "vitest";
	}
	if (!allowedByTool[tool]?.has(subcommand)) {
		return false;
	}
	const args = match[3]?.trim();
	if (!args) {
		return true;
	}
	return args.split(/\s+/).some((arg) => hasCommandCueArgument(arg));
}

function containsChainedShellBuiltinSyntax(value: string): boolean {
	return /^\s*cd\s+(?:-[A-Za-z]+\s+)*\S+(?:\s*(?:&&|\|\||;)\s*\S+)/.test(value);
}

function containsShellMetacharCommandSyntax(value: string): boolean {
	if (!/(?:\s*(?:&&|\|\||[;|])\s*\S+)/.test(value)) {
		return false;
	}
	return /^\s*(?:(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)+|(?:bash|sh|zsh|powershell|cmd|git|rm|sudo|curl|wget|npm|npx|pnpm|bunx?|uvx?|node|python3?|pip3?|docker|kubectl|terraform|yarn|make|go|cargo|echo|printf|grep|egrep|fgrep|awk|sed|cat|head|tail|find|xargs|sort|uniq|cut|tr|tee|wc|ls|touch|mkdir|export)\b|(?:\.{0,2}\/|~\/|\/|[A-Za-z0-9_.-]*\/)\S+)/.test(
		value,
	);
}

function containsSimpleShellUtilitySyntax(value: string): boolean {
	return (
		/^\s*ls\s+(?:-[A-Za-z0-9]+|\.{1,2}\/\S+|~\/\S+|\/\S+|\S*[/.*?]\S*|\S+\.[A-Za-z0-9_-]+)(?:\s+\S+)*\s*$/.test(
			value,
		) ||
		/^\s*cat\s+(?:\.{1,2}\/|~\/|\/|[A-Za-z0-9_.-]*\/)?[A-Za-z0-9_.-]+\.[A-Za-z0-9_.-]+(?:\s+\S+)*\s*$/.test(
			value,
		) ||
		containsGrepShellUtilitySyntax(value) ||
		/^\s*rg\s+(?:-\S+\s+)*(?:"[^"]+"|'[^']+'|\S+)\s+\S+(?:\s+\S+)*\s*$/.test(
			value,
		) ||
		/^\s*fd\s+(?:-\S+\s+)*(?:"[^"]+"|'[^']+'|\S+)(?:\s+\S+)*\s*$/.test(value) ||
		/^\s*sed\s+(?:-\S+\s+)*(?:"[^"]+"|'[^']+'|\S+)\s+\S+(?:\s+\S+)*\s*$/.test(
			value,
		) ||
		/^\s*(?:cp|mv)\s+(?:-\S+\s+)*\S+\s+\S+(?:\s+\S+)*\s*$/.test(value) ||
		/^\s*(?:mkdir|touch)\s+(?:-\S+\s+)*\S+(?:\s+\S+)*\s*$/.test(value) ||
		/^\s*chmod\s+(?:-\S+\s+)*(?:[0-7]{3,4}|[ugoa]*[+-=][rwxXstugo,]+)\s+\S+(?:\s+\S+)*\s*$/.test(
			value,
		) ||
		/^\s*tar\s+(?:-\S+\s+)+\S+(?:\s+\S+)*\s*$/.test(value) ||
		/^\s*find\s+(?:(?:\.{1,2}|\.{1,2}\/\S+|~\/\S+|\/\S+|[A-Za-z0-9_.-]*\/\S+)\s+)?(?:-\S+|\S+\s+-\S+)(?:\s+\S+)*\s*$/.test(
			value,
		) ||
		containsRemoteShellUtilitySyntax(value)
	);
}

function containsGrepShellUtilitySyntax(value: string): boolean {
	const match = /^\s*(?:grep|egrep|fgrep)\s+(.+?)\s*$/.exec(value);
	if (!match?.[1]) {
		return false;
	}
	const args = match[1].trim().split(/\s+/);
	if (args.length < 2) {
		return false;
	}
	if (args.some((arg) => arg.startsWith("-"))) {
		return true;
	}
	if (/^\s*(?:grep|egrep|fgrep)\s+(?:"[^"]+"|'[^']+')\s+\S+/.test(value)) {
		return true;
	}
	return args
		.slice(1)
		.some((arg) =>
			/(?:^\.{1,2}$|^\.{1,2}\/|^~\/|^\/|\/|\*|\?|\.[A-Za-z0-9_-]+$)/.test(arg),
		);
}

function containsRemoteShellUtilitySyntax(value: string): boolean {
	const parts = value.trim().split(/\s+/);
	const command = parts[0]?.toLowerCase();
	if (!command || !["ssh", "scp", "rsync"].includes(command)) {
		return false;
	}
	const args = parts.slice(1);
	if (args.length === 0) {
		return false;
	}
	if (args.some((arg) => arg.startsWith("-"))) {
		return true;
	}
	if (
		args.some((arg) =>
			/(?:@|:|^\.{1,2}$|^\.{1,2}\/|^~\/|^\/|\/|\.[A-Za-z0-9_-]+$)/.test(arg),
		)
	) {
		return true;
	}
	return command === "ssh" && args.length === 1;
}

function containsPathCommandSyntax(value: string): boolean {
	const pathMatch = /^\s*((?:\.{1,2}\/|~\/|\/)[^\s]+)(?:\s+(.+?))?\s*$/.exec(
		value,
	);
	if (!pathMatch?.[1]) {
		return false;
	}
	const path = pathMatch[1];
	const args = pathMatch[2]?.trim();
	return (
		Boolean(args) ||
		/\.(?:bash|sh|zsh|command|cmd|bat|ps1|exe|run|bin)$/i.test(path)
	);
}

function containsEnvPrefixedCommandSyntax(
	value: string,
	options: { allowArbitraryMakeTargets?: boolean } = {},
): boolean {
	const envPrefixedCommand =
		/^\s*(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)+(.+)$/.exec(
			value,
		);
	return envPrefixedCommand?.[1]
		? containsShellCommandAtStart(envPrefixedCommand[1], options)
		: false;
}

function containsEnvWrappedCommandSyntax(
	value: string,
	options: { allowArbitraryMakeTargets?: boolean } = {},
): boolean {
	const envMatch = /^\s*env\s+(.+?)\s*$/.exec(value);
	if (!envMatch?.[1]) {
		return false;
	}
	const args = envMatch[1].trim().split(/\s+/);
	let index = 0;
	while (index < args.length) {
		const arg = args[index];
		if (!arg) {
			break;
		}
		if (
			arg === "-" ||
			arg === "-i" ||
			arg === "--ignore-environment" ||
			arg === "-0" ||
			arg === "--null"
		) {
			index += 1;
			continue;
		}
		if (
			arg === "-C" ||
			arg === "--chdir" ||
			arg === "-u" ||
			arg === "--unset"
		) {
			index += 2;
			continue;
		}
		if (
			arg.startsWith("-C") ||
			arg.startsWith("--chdir=") ||
			arg.startsWith("--unset=")
		) {
			index += 1;
			continue;
		}
		if (/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)$/.test(arg)) {
			index += 1;
			continue;
		}
		break;
	}
	const command = args.slice(index).join(" ");
	return command ? containsShellCommandAtStart(command, options) : false;
}

function containsLeadingWrappedCommandSyntax(
	value: string,
	options: { allowArbitraryMakeTargets?: boolean } = {},
): boolean {
	const wrapped =
		/^\s*(?:`([^`]+)`|'([^']+)'|"([^"]+)")(?:\s+\S[\s\S]*)?$/.exec(value);
	const command = wrapped?.[1] ?? wrapped?.[2] ?? wrapped?.[3];
	return command ? containsShellCommandAtStart(command, options) : false;
}

function containsMakeCommandSyntax(
	value: string,
	options: { allowArbitraryMakeTargets?: boolean } = {},
): boolean {
	if (/^\s*make\s*$/.test(value)) {
		return true;
	}
	const makeMatch = /^\s*make\s+(.+?)\s*$/.exec(value);
	if (!makeMatch?.[1]) {
		return false;
	}
	const args = makeMatch[1].trim().split(/\s+/);
	if (args.length === 0) {
		return false;
	}
	if (args.length === 1) {
		const target = args[0];
		if (!target || !/^[A-Za-z0-9_.:/-]+$/.test(target)) {
			return false;
		}
		return (
			options.allowArbitraryMakeTargets ||
			COMMON_MAKE_TARGETS.has(target.toLowerCase()) ||
			/[./:_-]/.test(target)
		);
	}
	return (
		(options.allowArbitraryMakeTargets &&
			args.every((arg) => /^[A-Za-z0-9_.:/-]+$/.test(arg))) ||
		args.every((arg) => COMMON_MAKE_TARGETS.has(arg.toLowerCase())) ||
		args.some(
			(arg) =>
				arg.startsWith("-") ||
				/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg) ||
				/[./:_-]/.test(arg),
		)
	);
}

function unwrapCommandText(value: string): string {
	const trimmed = value.trim();
	const wrapped = /^(?:`([^`]+)`|'([^']+)'|"([^"]+)")$/.exec(trimmed);
	return wrapped?.[1] ?? wrapped?.[2] ?? wrapped?.[3] ?? value;
}

function sanitizeDelegationPrompt(
	value: string | undefined,
): string | undefined {
	const text = nonEmptyString(value);
	if (!text) {
		return undefined;
	}
	if (shouldRedactOutboundText(text)) {
		return REDACTED;
	}
	return text.length > MAX_DELEGATION_PROMPT_LENGTH
		? text.slice(0, MAX_DELEGATION_PROMPT_LENGTH)
		: text;
}

function isShellToolName(toolName: string | undefined): boolean {
	return /(?:^|[._-])(?:bash|shell|exec_command)$/i.test(toolName ?? "");
}

function containsGeneratedShellToolLabel(
	toolName: string | undefined,
	value: string | undefined,
): boolean {
	return isShellToolName(toolName) && /^\s*Ran\s+\S[\s\S]*$/i.test(value ?? "");
}

function containsBatchGeneratedShellToolLabel(
	toolNames: string[] | undefined,
	value: string | undefined,
): boolean {
	return (
		toolNames?.some(isShellToolName) === true &&
		/^\s*Ran\s+\S[\s\S]*$/i.test(value ?? "")
	);
}

function sanitizeToolOutboundText(
	toolName: string | undefined,
	value: string | undefined,
	maxLength = MAX_TEXT_FIELD_LENGTH,
): string | undefined {
	if (containsGeneratedShellToolLabel(toolName, value)) {
		return REDACTED;
	}
	return sanitizeOutboundText(value, maxLength);
}

function sanitizedToolDisplayName(event: {
	displayName?: string;
	summaryLabel?: string;
	toolName: string;
}): string {
	return (
		sanitizeToolOutboundText(event.toolName, toolDisplayName(event)) ??
		event.toolName
	);
}

function materializedToolExecutionId(event: {
	toolCallId: string;
	toolExecutionId?: string;
}): string | undefined {
	const toolExecutionId = nonEmptyString(event.toolExecutionId)?.trim();
	const toolCallId = nonEmptyString(event.toolCallId)?.trim();
	if (!toolExecutionId || toolExecutionId === toolCallId) {
		return undefined;
	}
	return toolExecutionId;
}

function toolResultMetrics(result: {
	content?: unknown;
	details?: unknown;
	isError?: unknown;
	toolExecutionId?: unknown;
	approvalRequestId?: unknown;
}): Record<string, unknown> {
	const content = Array.isArray(result.content) ? result.content : [];
	const textBlocks = content.filter(
		(block): block is { type: "text"; text: string } =>
			isRecord(block) &&
			block.type === "text" &&
			typeof block.text === "string",
	);
	const imageMimeTypes = content
		.map((block) =>
			isRecord(block) && block.type === "image"
				? compactString(block.mimeType, 128)
				: undefined,
		)
		.filter((mimeType): mimeType is string => Boolean(mimeType));
	return {
		content_block_count: content.length,
		text_block_count: textBlocks.length,
		text_total_chars: textBlocks.reduce(
			(total, block) => total + block.text.length,
			0,
		),
		image_block_count: imageMimeTypes.length,
		image_mime_types: imageMimeTypes.length > 0 ? imageMimeTypes : undefined,
		details_keys: objectKeys(result.details),
		result_error:
			typeof result.isError === "boolean" ? result.isError : undefined,
		result_tool_execution_id:
			typeof result.toolExecutionId === "string"
				? result.toolExecutionId
				: undefined,
		result_approval_request_id:
			typeof result.approvalRequestId === "string"
				? result.approvalRequestId
				: undefined,
	};
}

function waitTypeForRequest(
	kind: ServerRequestLifecycleEvent["request"]["kind"],
): PlatformAgentRunWaitTypeValue {
	switch (kind) {
		case "approval":
		case "tool_retry":
			return PlatformAgentRunWaitTypeValue.Approval;
		case "client_tool":
		case "mcp_elicitation":
		case "user_input":
			return PlatformAgentRunWaitTypeValue.Input;
	}
}

function taskWorkItemState(
	status: HostedAgentRuntimeTaskStatus,
): PlatformAgentWorkItemStateValue {
	switch (status) {
		case "pending":
			return PlatformAgentWorkItemStateValue.Pending;
		case "running":
			return PlatformAgentWorkItemStateValue.Running;
		case "waiting":
			return PlatformAgentWorkItemStateValue.Waiting;
		case "blocked":
			return PlatformAgentWorkItemStateValue.Blocked;
		case "succeeded":
			return PlatformAgentWorkItemStateValue.Succeeded;
		case "failed":
			return PlatformAgentWorkItemStateValue.Failed;
		case "cancelled":
			return PlatformAgentWorkItemStateValue.Cancelled;
	}
}

function taskStepState(
	status: HostedAgentRuntimeTaskStatus,
): PlatformAgentRunStepStateValue {
	switch (status) {
		case "pending":
			return PlatformAgentRunStepStateValue.Pending;
		case "running":
			return PlatformAgentRunStepStateValue.Running;
		case "waiting":
		case "blocked":
			return PlatformAgentRunStepStateValue.Waiting;
		case "succeeded":
			return PlatformAgentRunStepStateValue.Succeeded;
		case "failed":
			return PlatformAgentRunStepStateValue.Failed;
		case "cancelled":
			return PlatformAgentRunStepStateValue.Cancelled;
	}
}

function defaultTaskWorkItemKind(
	source: HostedAgentRuntimeTaskSource,
): PlatformAgentWorkItemKindValue {
	switch (source) {
		case "background":
			return PlatformAgentWorkItemKindValue.ToolCall;
		case "swarm":
			return PlatformAgentWorkItemKindValue.ChildRun;
		case "checkpoint":
			return PlatformAgentWorkItemKindValue.Recovery;
		case "todo":
			return PlatformAgentWorkItemKindValue.Followup;
	}
}

function defaultTaskStepKind(
	source: HostedAgentRuntimeTaskSource,
	status: HostedAgentRuntimeTaskStatus,
): PlatformAgentRunStepKindValue {
	if (status === "failed") {
		return PlatformAgentRunStepKindValue.Error;
	}
	if (source === "background") {
		return status === "succeeded" || status === "cancelled"
			? PlatformAgentRunStepKindValue.ToolResult
			: PlatformAgentRunStepKindValue.ToolCallIntent;
	}
	return PlatformAgentRunStepKindValue.System;
}

function shouldRecordTaskStep(
	event: HostedAgentRuntimeTaskProgressEvent,
): boolean {
	if (event.recordStep !== undefined) {
		return event.recordStep;
	}
	return event.status !== "pending";
}

function backgroundStatusToTaskStatus(
	status: string | undefined,
): HostedAgentRuntimeTaskStatus {
	switch (status) {
		case "running":
		case "restarting":
			return "running";
		case "stopped":
			return "cancelled";
		case "exited":
			return "succeeded";
		case "failed":
			return "failed";
		default:
			return "pending";
	}
}

function todoStatusToTaskStatus(status: unknown): HostedAgentRuntimeTaskStatus {
	switch (status) {
		case "in_progress":
			return "running";
		case "completed":
			return "succeeded";
		default:
			return "pending";
	}
}

function taskPromptSummary(task: SwarmTask): string {
	return compactString(task.prompt, 160) ?? task.id;
}

export class HostedAgentRuntimeProgressRecorder {
	private readonly sessionId: string;
	private readonly hostedRunner?: HostedAgentRuntimeProgressContext;
	private readonly workspaceRoot?: string;
	private readonly operations: Required<HostedAgentRuntimeProgressRecorderOperations>;
	private readonly pendingWaitIds = new Map<string, string>();
	private readonly resumedWaitIds = new Set<string>();
	private readonly codexSubagentReceiverThreadIds = new Map<string, string[]>();
	private readonly codexSubagentToolChildRunIds = new Map<string, string[]>();
	private readonly codexSubagentToolWorkGraphs = new Map<
		string,
		Record<string, unknown>
	>();
	private readonly codexSubagentThreadWorkItemIds = new Map<string, string>();
	private readonly codexSubagentDelegationIds = new Map<string, string>();
	private readonly codexSubagentDelegationIdsByThreadId = new Map<
		string,
		string
	>();
	private readonly codexSubagentDelegationIdsByChildRunId = new Map<
		string,
		string
	>();
	private readonly recordedModelUsageTurnIds = new Set<string>();
	private readonly toolArgsByCallId = new Map<
		string,
		Record<string, unknown>
	>();
	private readonly recordedTaskWorkItemIds = new Set<string>();
	private pending: Promise<void> = Promise.resolve();
	private turnIndex = 0;
	private autoRetrySequence = 0;
	private activeAutoRetrySequence: number | null = null;
	private lastAutoRetryAttempt = 0;
	private terminalRecorded = false;

	constructor(options: HostedAgentRuntimeProgressRecorderOptions) {
		this.sessionId = options.sessionId;
		this.hostedRunner = options.hostedRunner;
		this.workspaceRoot = options.workspaceRoot;
		this.operations = {
			recordStep: options.operations?.recordStep ?? recordAgentRuntimeRunStep,
			recordEvent:
				options.operations?.recordEvent ?? recordAgentRuntimeRunEvent,
			recordCost: options.operations?.recordCost ?? recordAgentRuntimeRunCost,
			recordWorkItem:
				options.operations?.recordWorkItem ?? recordAgentRuntimeRunWorkItem,
			updateWorkItem:
				options.operations?.updateWorkItem ?? updateAgentRuntimeRunWorkItem,
			waitRun: options.operations?.waitRun ?? waitAgentRuntimeRun,
			resumeRun: options.operations?.resumeRun ?? resumeAgentRuntimeRun,
			completeRun: options.operations?.completeRun ?? completeAgentRuntimeRun,
			failRun: options.operations?.failRun ?? failAgentRuntimeRun,
			delegateAgent:
				options.operations?.delegateAgent ?? delegateAgentWithPlatform,
			resolveDelegation:
				options.operations?.resolveDelegation ??
				resolveAgentDelegationWithPlatform,
		};
	}

	recordAgentEvent(event: AgentEvent): void {
		switch (event.type) {
			case "agent_start":
				this.recordStep({
					id: this.stepId("agent", `start-${this.turnIndex + 1}`),
					name: event.continuation ? "Agent continuation" : "Agent run",
					stepKind: PlatformAgentRunStepKindValue.System,
					state: PlatformAgentRunStepStateValue.Running,
					input: this.basePayload({
						event_type: event.type,
						continuation: event.continuation ?? false,
					}),
				});
				return;
			case "agent_end":
				{
					const stepId = this.stepId("agent", `end-${this.turnIndex}`);
					this.recordStep({
						id: stepId,
						name: "Agent run completed",
						stepKind:
							event.aborted || event.stopReason === "error"
								? PlatformAgentRunStepKindValue.Error
								: PlatformAgentRunStepKindValue.System,
						state:
							event.aborted || event.stopReason === "error"
								? PlatformAgentRunStepStateValue.Failed
								: PlatformAgentRunStepStateValue.Succeeded,
						output: this.basePayload({
							event_type: event.type,
							aborted: event.aborted ?? false,
							stop_reason: event.stopReason,
						}),
					});
					this.recordFinalStatusEvent(event, stepId);
				}
				return;
			case "status":
				this.recordStatusEvent(event);
				return;
			case "compaction":
				this.recordCompactionEvent(event);
				return;
			case "auto_retry_start":
				this.recordAutoRetryStart(event);
				return;
			case "auto_retry_end":
				this.recordAutoRetryEnd(event);
				return;
			case "diagnostic_delta":
				this.recordDiagnosticDelta(event);
				return;
			case "tool_batch_summary":
				this.recordToolBatchSummary(event);
				return;
			case "tool_phase_summary":
				this.recordToolPhaseSummary(event);
				return;
			case "tool_execution_update":
				this.recordToolExecutionUpdate(event);
				return;
			case "tool_retry_required":
				this.recordApprovalWait({
					id: event.request.id,
					callId: event.request.toolCallId,
					toolName: event.request.toolName,
					reason: event.request.summary ?? event.request.errorMessage,
					kind: "tool_retry",
				});
				this.recordToolRetryEvent(event);
				return;
			case "tool_retry_resolved":
				this.resumeWait({
					id: event.request.id,
					kind: "tool_retry",
					resolution: event.decision.action,
					resolvedBy: event.decision.resolvedBy,
					reason: event.decision.reason,
				});
				this.recordToolRetryEvent(event);
				return;
			case "turn_start":
				this.turnIndex += 1;
				this.recordStep({
					id: this.stepId("turn", String(this.turnIndex)),
					name: `Turn ${this.turnIndex}`,
					stepKind: PlatformAgentRunStepKindValue.ModelCall,
					state: PlatformAgentRunStepStateValue.Running,
					input: this.basePayload({ event_type: event.type }),
				});
				return;
			case "turn_end":
				this.recordStep({
					id: this.stepId("turn", String(this.turnIndex)),
					name: `Turn ${this.turnIndex}`,
					stepKind: PlatformAgentRunStepKindValue.ModelCall,
					state: PlatformAgentRunStepStateValue.Succeeded,
					output: this.basePayload({
						event_type: event.type,
						tool_result_count: event.toolResults.length,
					}),
				});
				this.recordModelUsageEvent(event.message);
				return;
			case "tool_execution_start":
				this.toolArgsByCallId.set(event.toolCallId, event.args);
				this.recordStep({
					id: this.toolStepId(event.toolCallId),
					name: sanitizedToolDisplayName(event),
					stepKind: PlatformAgentRunStepKindValue.ToolCallIntent,
					state: PlatformAgentRunStepStateValue.Running,
					input: this.basePayload({
						event_type: event.type,
						tool_call_id: event.toolCallId,
						tool_execution_id: materializedToolExecutionId(event),
						tool_name: event.toolName,
						display_name: sanitizeToolOutboundText(
							event.toolName,
							event.displayName,
						),
						summary_label: sanitizeToolOutboundText(
							event.toolName,
							event.summaryLabel,
						),
						arg_keys: objectKeys(event.args),
					}),
				});
				this.recordCodexSubagentWorkItem(event);
				return;
			case "tool_execution_end":
				this.recordStep({
					id: this.toolStepId(event.toolCallId),
					name: sanitizedToolDisplayName(event),
					stepKind: event.isError
						? PlatformAgentRunStepKindValue.Error
						: PlatformAgentRunStepKindValue.ToolResult,
					state: event.isError
						? PlatformAgentRunStepStateValue.Failed
						: PlatformAgentRunStepStateValue.Succeeded,
					errorMessage: event.isError
						? (event.errorCode ?? event.governedOutcome ?? "tool failed")
						: undefined,
					output: this.basePayload({
						event_type: event.type,
						tool_call_id: event.toolCallId,
						tool_execution_id: materializedToolExecutionId(event),
						approval_request_id: event.approvalRequestId,
						tool_name: event.toolName,
						display_name: sanitizeToolOutboundText(
							event.toolName,
							event.displayName,
						),
						summary_label: sanitizeToolOutboundText(
							event.toolName,
							event.summaryLabel,
						),
						error_code: event.errorCode,
						governed_outcome: event.governedOutcome,
					}),
				});
				this.updateCodexSubagentWorkItem(event);
				this.recordToolDerivedTaskProgress(event);
				this.recordToolArtifactEvent(event);
				return;
			case "action_approval_required":
				this.recordApprovalWait({
					id: event.request.id,
					callId: event.request.id,
					toolName: event.request.toolName,
					reason: event.request.reason,
					displayName: event.request.displayName,
					summaryLabel: event.request.summaryLabel,
					startedAtMs: event.request.startedAtMs,
				});
				return;
			case "action_approval_resolved":
				this.resumeWait({
					id: event.request.id,
					kind: "approval",
					resolution: event.decision.approved ? "approved" : "denied",
					resolvedBy: event.decision.resolvedBy ?? "user",
					reason: event.decision.reason,
					startedAtMs: event.request.startedAtMs,
					resolvedAtMs: event.decision.resolvedAtMs,
				});
				return;
			case "error":
				this.recordPromptFailure(event.message);
				return;
			default:
				return;
		}
	}

	private recordFinalStatusEvent(
		event: Extract<AgentEvent, { type: "agent_end" }>,
		stepId: string,
	): void {
		const finalStatus =
			event.aborted || event.stopReason === "error" ? "failed" : "succeeded";
		this.recordEvent({
			type: PlatformRuntimeEventTypeValue.AgentProgressRecorded,
			message: "Maestro agent final status recorded",
			stepId,
			attributes: this.basePayload({
				event_type: "agent_final_status",
				final_status: finalStatus,
				aborted: event.aborted ?? false,
				stop_reason: event.stopReason,
				message_count: event.messages.length,
				partial_accepted: Boolean(event.partialAccepted),
			}),
		});
	}

	private recordStatusEvent(
		event: Extract<AgentEvent, { type: "status" }>,
	): void {
		this.recordEvent({
			type: PlatformRuntimeEventTypeValue.AgentProgressRecorded,
			message: "Maestro status recorded",
			attributes: this.basePayload({
				event_type: event.type,
				status: sanitizeStatusText(event.status, event.details),
				detail_keys: objectKeys(event.details),
			}),
		});
	}

	private recordCompactionEvent(
		event: Extract<AgentEvent, { type: "compaction" }>,
	): void {
		this.recordEvent({
			type: PlatformRuntimeEventTypeValue.AgentProgressRecorded,
			message: "Maestro context compaction recorded",
			attributes: this.basePayload({
				event_type: event.type,
				first_kept_entry_index: event.firstKeptEntryIndex,
				tokens_before: event.tokensBefore,
				auto: event.auto ?? false,
				custom_instructions_present: Boolean(event.customInstructions),
				summary_chars: event.summary.length,
				timestamp: event.timestamp,
			}),
		});
	}

	private recordAutoRetryStart(
		event: Extract<AgentEvent, { type: "auto_retry_start" }>,
	): void {
		const sequence = this.resolveAutoRetryStartSequence(event.attempt);
		this.recordStep({
			id: this.autoRetryStepId(event.attempt, sequence),
			name: `Auto retry ${event.attempt}`,
			stepKind: PlatformAgentRunStepKindValue.System,
			state: PlatformAgentRunStepStateValue.Waiting,
			input: this.basePayload({
				event_type: event.type,
				attempt: event.attempt,
				max_attempts: event.maxAttempts,
				delay_ms: event.delayMs,
				error_message: sanitizeOutboundText(event.errorMessage, 512),
			}),
		});
	}

	private recordAutoRetryEnd(
		event: Extract<AgentEvent, { type: "auto_retry_end" }>,
	): void {
		const sequence = this.resolveAutoRetryEndSequence();
		this.recordStep({
			id: this.autoRetryStepId(event.attempt, sequence),
			name: `Auto retry ${event.attempt}`,
			stepKind: event.success
				? PlatformAgentRunStepKindValue.System
				: PlatformAgentRunStepKindValue.Error,
			state: event.success
				? PlatformAgentRunStepStateValue.Succeeded
				: PlatformAgentRunStepStateValue.Failed,
			errorMessage: event.success
				? undefined
				: sanitizeOutboundText(event.finalError, 512),
			output: this.basePayload({
				event_type: event.type,
				success: event.success,
				attempt: event.attempt,
				final_error: sanitizeOutboundText(event.finalError, 512),
			}),
		});
	}

	private recordDiagnosticDelta(
		event: Extract<AgentEvent, { type: "diagnostic_delta" }>,
	): void {
		this.recordEvent({
			type: PlatformRuntimeEventTypeValue.AgentProgressRecorded,
			message: "Maestro diagnostic delta recorded",
			stepId: this.toolStepId(event.toolCallId),
			attributes: this.basePayload({
				event_type: event.type,
				tool_call_id: event.toolCallId,
				tool_name: event.toolName,
				display_path: compactString(event.displayPath, 512),
				used_delta: event.usedDelta,
				introduced_count: event.introducedCount,
				repaired_count: event.repairedCount,
				remaining_count: event.remainingCount,
				fingerprint: event.fingerprint,
				repair_attempt: event.repairAttempt,
				max_repair_attempts: event.maxRepairAttempts,
				will_auto_follow_up: event.willAutoFollowUp,
				reason: compactString(event.reason),
			}),
		});
	}

	private recordToolBatchSummary(
		event: Extract<AgentEvent, { type: "tool_batch_summary" }>,
	): void {
		this.recordEvent({
			type: PlatformRuntimeEventTypeValue.AgentProgressRecorded,
			message: "Maestro tool batch summary recorded",
			attributes: this.basePayload({
				event_type: event.type,
				summary: sanitizeToolBatchSummaryText(event.summary, event.toolNames),
				summary_labels: sanitizeToolBatchSummaryLabels(
					event.summaryLabels,
					event.toolNames,
				),
				tool_call_ids: compactStringArray(event.toolCallIds),
				tool_names: compactStringArray(event.toolNames),
				calls_succeeded: event.callsSucceeded,
				calls_failed: event.callsFailed,
			}),
		});
	}

	private recordToolPhaseSummary(
		event: Extract<AgentEvent, { type: "tool_phase_summary" }>,
	): void {
		this.recordEvent({
			type: PlatformRuntimeEventTypeValue.AgentProgressRecorded,
			message: "Maestro tool phase summary recorded",
			attributes: this.basePayload({
				event_type: event.type,
				model_tool_call_count: event.modelToolCallCount,
				model_emitted_tool_call_count: event.modelEmittedToolCallCount,
				schedulable_wave_count: event.schedulableWaveCount,
				parallelized_call_count: event.parallelizedCallCount,
				actually_parallelized_call_count: event.actuallyParallelizedCallCount,
				serialized_call_count: event.serializedCallCount,
				delayed_call_count: event.delayedCallCount,
				blocked_by_mutation_count: event.blockedByMutationCount,
				mcp_opt_in_call_count: event.mcpOptInCallCount,
				mcp_opt_in_use_count: event.mcpOptInUseCount,
				cache_hit_count: event.cacheHitCount,
				total_tool_wait_ms: event.totalToolWaitMs,
				tool_wait_time_ms: event.toolWaitTimeMs,
				serialization_reasons: event.serializationReasons,
				batch_shaping_feedback: event.batchShapingFeedback,
			}),
		});
	}

	private recordToolExecutionUpdate(
		event: Extract<AgentEvent, { type: "tool_execution_update" }>,
	): void {
		const partialToolExecutionId =
			materializedToolExecutionId(event) ??
			materializedToolExecutionId({
				toolCallId: event.toolCallId,
				toolExecutionId: event.partialResult.toolExecutionId,
			});
		this.recordEvent({
			type: PlatformRuntimeEventTypeValue.AgentProgressRecorded,
			message: "Maestro tool execution update recorded",
			stepId: this.toolStepId(event.toolCallId),
			attributes: this.basePayload({
				event_type: event.type,
				tool_call_id: event.toolCallId,
				tool_execution_id: partialToolExecutionId,
				tool_name: event.toolName,
				display_name: sanitizeToolOutboundText(
					event.toolName,
					event.displayName,
				),
				summary_label: sanitizeToolOutboundText(
					event.toolName,
					event.summaryLabel,
				),
				arg_keys: objectKeys(event.args),
				...toolResultMetrics(event.partialResult),
			}),
		});
	}

	private recordToolArtifactEvent(
		event: Extract<AgentEvent, { type: "tool_execution_end" }>,
	): void {
		const metadata = event.skillMetadata;
		if (!metadata) {
			return;
		}
		this.recordEvent({
			type: PlatformRuntimeEventTypeValue.AgentProgressRecorded,
			message: "Maestro tool artifact evidence recorded",
			stepId: this.toolStepId(event.toolCallId),
			artifactId: metadata.artifactId,
			attributes: this.basePayload({
				event_type: "tool_artifact_recorded",
				tool_call_id: event.toolCallId,
				tool_execution_id: materializedToolExecutionId(event),
				tool_name: event.toolName,
				display_name: sanitizeToolOutboundText(
					event.toolName,
					event.displayName,
				),
				summary_label: sanitizeToolOutboundText(
					event.toolName,
					event.summaryLabel,
				),
				skill_name: metadata.name,
				skill_hash: metadata.hash,
				skill_source: metadata.source,
				skill_artifact_id: metadata.artifactId,
				skill_version: metadata.version,
				skill_scope: metadata.scope,
				skill_workspace_id: metadata.workspaceId,
				skill_owner_id: metadata.ownerId,
				source_path: compactString(metadata.sourcePath, 512),
			}),
		});
	}

	private recordToolRetryEvent(
		event: Extract<
			AgentEvent,
			{ type: "tool_retry_required" | "tool_retry_resolved" }
		>,
	): void {
		this.recordEvent({
			type: PlatformRuntimeEventTypeValue.AgentProgressRecorded,
			message:
				event.type === "tool_retry_required"
					? "Maestro tool retry required"
					: "Maestro tool retry resolved",
			stepId: this.toolStepId(event.request.toolCallId),
			waitId: this.waitId(event.request.id),
			attributes: this.basePayload({
				event_type: event.type,
				request_id: event.request.id,
				tool_call_id: event.request.toolCallId,
				tool_name: event.request.toolName,
				error_message: sanitizeOutboundText(event.request.errorMessage, 512),
				summary: sanitizeOutboundText(event.request.summary, 512),
				attempt: event.request.attempt,
				max_attempts: event.request.maxAttempts,
				arg_keys: objectKeys(event.request.args),
				...(event.type === "tool_retry_resolved"
					? {
							resolution: event.decision.action,
							resolved_by: event.decision.resolvedBy,
							reason: sanitizeOutboundText(event.decision.reason, 512),
						}
					: {}),
			}),
		});
	}

	recordServerRequestEvent(event: ServerRequestLifecycleEvent): void {
		if (event.type === "registered") {
			this.recordApprovalWait({
				id: event.request.id,
				callId: event.request.callId,
				toolName: event.request.toolName,
				reason: event.request.reason,
				displayName: event.request.displayName,
				summaryLabel: event.request.summaryLabel,
				kind: event.request.kind,
				startedAtMs: event.request.startedAtMs,
			});
			return;
		}
		this.resumeWait({
			id: event.request.id,
			kind: event.request.kind,
			resolution: event.resolution,
			resolvedBy: event.resolvedBy,
			reason: event.reason,
			startedAtMs: event.request.startedAtMs,
			resolvedAtMs: event.resolvedAtMs,
		});
	}

	recordPromptFailure(message: string): void {
		const stepId = this.stepId("error", `${Date.now()}`);
		this.recordStep({
			id: stepId,
			name: "Prompt failed",
			stepKind: PlatformAgentRunStepKindValue.Error,
			state: PlatformAgentRunStepStateValue.Failed,
			errorMessage: sanitizeOutboundText(message),
			output: this.basePayload({
				event_type: "prompt_failure",
			}),
		});
		this.recordEvent({
			type: PlatformRuntimeEventTypeValue.AgentProgressRecorded,
			message: "Maestro prompt failure recorded",
			stepId,
			attributes: this.basePayload({
				event_type: "prompt_failure",
				error_message: sanitizeOutboundText(message),
			}),
		});
	}

	recordTaskProgressEvent(event: HostedAgentRuntimeTaskProgressEvent): void {
		const runId = nonEmptyString(this.hostedRunner?.agentRunId);
		if (!this.hostedRunner?.enabled || !runId) {
			return;
		}
		const title = sanitizeOutboundText(event.title, 256) ?? event.title;
		const goal = sanitizeOutboundText(event.goal, 512);
		const nextAction = sanitizeOutboundText(event.nextAction);
		const blocker = sanitizeOutboundText(event.blocker);
		const errorMessage = sanitizeOutboundText(event.errorMessage, 512);
		const eventPayload = sanitizeOutboundPayload(event.payload);
		const taskId = this.taskProgressId(event.source, event.id);
		const parentWorkItemId = event.parentId
			? this.taskProgressId(event.source, event.parentId)
			: undefined;
		const evidenceRefs = [
			`maestro-task:${event.source}:${event.id}`,
			...(event.toolCallId ? [`tool-call:${event.toolCallId}`] : []),
			...(event.toolExecutionId
				? [`tool-execution:${event.toolExecutionId}`]
				: []),
			...(event.evidenceRefs ?? []),
		];
		const state = taskWorkItemState(event.status);
		const payload = this.basePayload({
			event_type: "maestro_task_progress",
			task_source: event.source,
			task_id: event.id,
			task_status: event.status,
			parent_task_id: event.parentId,
			owner_child_run_id: event.ownerChildRunId,
			tool_call_id: event.toolCallId,
			tool_execution_id: event.toolExecutionId,
			approval_request_id: event.approvalRequestId,
			title,
			goal,
			next_action: nextAction,
			blocker,
			...eventPayload,
		});
		this.enqueue(async () => {
			const updateWorkItem = () =>
				this.operations.updateWorkItem({
					runId,
					workItemId: taskId,
					state,
					...(nextAction ? { nextAction } : {}),
					...(blocker ? { blocker } : {}),
					...(event.toolExecutionId
						? { toolExecutionId: event.toolExecutionId }
						: {}),
					evidenceRefs,
					completionGate:
						event.completionGate ?? "maestro_task_progress_recorded",
					payload,
				});
			if (this.recordedTaskWorkItemIds.has(taskId)) {
				await updateWorkItem();
				return;
			}
			const workItem = {
				id: taskId,
				runId,
				...(parentWorkItemId ? { parentWorkItemId } : {}),
				...(event.ownerChildRunId
					? { ownerChildRunId: event.ownerChildRunId }
					: {}),
				kind: event.workItemKind ?? defaultTaskWorkItemKind(event.source),
				state,
				title,
				...(goal ? { goal } : {}),
				...(nextAction ? { nextAction } : {}),
				...(blocker ? { blocker } : {}),
				...(event.toolExecutionId
					? { toolExecutionId: event.toolExecutionId }
					: {}),
				evidenceRefs,
				completionGate:
					event.completionGate ?? "maestro_task_progress_recorded",
				payload,
			};
			try {
				await this.operations.recordWorkItem({
					runId,
					workItem,
				});
			} catch (error) {
				if (!isExistingWorkItemCreateError(error)) {
					throw error;
				}
				await updateWorkItem();
			}
			this.recordedTaskWorkItemIds.add(taskId);
		});
		this.recordEvent({
			type: PlatformRuntimeEventTypeValue.AgentProgressRecorded,
			message: `Maestro ${event.source} task ${event.status}`,
			stepId: shouldRecordTaskStep(event) ? taskId : undefined,
			attributes: payload,
		});
		if (!shouldRecordTaskStep(event)) {
			return;
		}
		const stepState = taskStepState(event.status);
		const stepKind =
			event.stepKind ?? defaultTaskStepKind(event.source, event.status);
		this.recordStep({
			id: taskId,
			name: title,
			stepKind,
			state: stepState,
			errorMessage: event.status === "failed" ? errorMessage : undefined,
			...(stepState === PlatformAgentRunStepStateValue.Running ||
			stepState === PlatformAgentRunStepStateValue.Waiting ||
			stepState === PlatformAgentRunStepStateValue.Pending
				? { input: payload }
				: { output: payload }),
		});
	}

	recordSwarmEvent(event: SwarmEvent): void {
		switch (event.type) {
			case "swarm_start":
				this.recordTaskProgressEvent({
					source: "swarm",
					id: event.swarmId,
					status: "running",
					title: `Swarm ${event.swarmId}`,
					goal: compactString(event.config.planFile, 512),
					workItemKind: PlatformAgentWorkItemKindValue.Root,
					nextAction: "coordinate swarm teammates",
					payload: {
						swarm_id: event.swarmId,
						teammate_count: event.config.teammateCount,
						task_count: event.config.tasks.length,
						mode: event.config.mode,
						model: event.config.model,
						model_provider: event.config.modelProvider,
						subagent_type: event.config.subagentType,
						reasoning_effort: event.config.reasoningEffort,
						continue_on_failure: event.config.continueOnFailure,
					},
				});
				return;
			case "task_start":
				this.recordTaskProgressEvent({
					source: "swarm",
					id: `${event.swarmId}:task:${event.task.id}`,
					parentId: event.swarmId,
					status: "running",
					title: `Swarm task ${event.task.id}`,
					goal: taskPromptSummary(event.task),
					workItemKind: PlatformAgentWorkItemKindValue.ChildRun,
					ownerChildRunId: `swarm:${event.swarmId}:teammate:${event.teammateId}`,
					nextAction: "wait for teammate task completion",
					payload: {
						swarm_id: event.swarmId,
						teammate_id: event.teammateId,
						task_id: event.task.id,
						file_count: event.task.files?.length ?? 0,
						depends_on: event.task.dependsOn,
						model: event.task.model,
						subagent_type: event.task.subagentType,
						priority: event.task.priority,
					},
				});
				return;
			case "task_complete":
				this.recordTaskProgressEvent({
					source: "swarm",
					id: `${event.swarmId}:task:${event.taskId}`,
					parentId: event.swarmId,
					status: "succeeded",
					title: `Swarm task ${event.taskId}`,
					workItemKind: PlatformAgentWorkItemKindValue.ChildRun,
					ownerChildRunId: `swarm:${event.swarmId}:teammate:${event.teammateId}`,
					payload: {
						swarm_id: event.swarmId,
						teammate_id: event.teammateId,
						task_id: event.taskId,
						output_bytes: Buffer.byteLength(event.output, "utf8"),
					},
				});
				return;
			case "task_fail":
				this.recordTaskProgressEvent({
					source: "swarm",
					id: `${event.swarmId}:task:${event.taskId}`,
					parentId: event.swarmId,
					status: "failed",
					title: `Swarm task ${event.taskId}`,
					workItemKind: PlatformAgentWorkItemKindValue.ChildRun,
					ownerChildRunId: `swarm:${event.swarmId}:teammate:${event.teammateId}`,
					errorMessage: event.error,
					payload: {
						swarm_id: event.swarmId,
						teammate_id: event.teammateId,
						task_id: event.taskId,
						error: compactString(event.error, 512),
					},
				});
				return;
			case "swarm_complete":
				this.recordTaskProgressEvent({
					source: "swarm",
					id: event.swarmId,
					status: swarmCompletionStatus(event),
					title: `Swarm ${event.swarmId}`,
					workItemKind: PlatformAgentWorkItemKindValue.Root,
					errorMessage: event.state.error,
					payload: {
						swarm_id: event.swarmId,
						swarm_status: event.state.status,
						completed_task_count: event.state.completedTasks.size,
						failed_task_count: event.state.failedTasks.size,
						teammate_count: event.state.teammates.length,
						error: compactString(event.state.error, 512),
					},
				});
				return;
			case "swarm_fail":
				this.recordTaskProgressEvent({
					source: "swarm",
					id: event.swarmId,
					status: "failed",
					title: `Swarm ${event.swarmId}`,
					workItemKind: PlatformAgentWorkItemKindValue.Root,
					errorMessage: event.error,
					payload: {
						swarm_id: event.swarmId,
						error: compactString(event.error, 512),
					},
				});
				return;
			case "teammate_spawn":
			case "teammate_complete":
				this.recordEvent({
					type: PlatformRuntimeEventTypeValue.AgentProgressRecorded,
					message: `Maestro swarm ${event.type}`,
					attributes: this.basePayload({
						event_type: "maestro_swarm_teammate_progress",
						swarm_id: event.swarmId,
						swarm_event_type: event.type,
						teammate_id: event.teammate.id,
						teammate_name: compactString(event.teammate.name),
						teammate_status: event.teammate.status,
						completed_task_count: event.teammate.completedTasks.length,
					}),
				});
				return;
		}
	}

	async flush(): Promise<void> {
		await this.pending;
	}

	async completeRun(
		input: HostedAgentRuntimeCompleteInput = {},
	): Promise<void> {
		if (this.terminalRecorded) {
			await this.flush();
			return;
		}
		this.terminalRecorded = true;
		this.enqueue(async () => {
			const handles = this.handles();
			if (!handles) {
				return;
			}
			await this.operations.completeRun({
				runId: handles.runId,
				leaseToken: handles.leaseToken,
				result: this.basePayload({
					event_type: "hosted_runner_drained",
					status: "drained",
					flush_status: input.flushStatus,
					reason: sanitizeOutboundText(input.reason, 512),
					requested_by: input.requestedBy,
					manifest_path: input.manifestPath,
				}),
			});
		});
		await this.flush();
	}

	async failRun(input: HostedAgentRuntimeFailInput): Promise<void> {
		if (this.terminalRecorded) {
			await this.flush();
			return;
		}
		this.terminalRecorded = true;
		const errorMessage =
			sanitizeOutboundText(input.errorMessage, 512) ?? input.errorMessage;
		const reason = sanitizeOutboundText(input.reason, 512);
		this.recordStep({
			id: this.stepId("terminal", "failed"),
			name: "Hosted runner drain failed",
			stepKind: PlatformAgentRunStepKindValue.Error,
			state: PlatformAgentRunStepStateValue.Failed,
			errorMessage,
			output: this.basePayload({
				event_type: "hosted_runner_drain_failed",
				reason,
				requested_by: input.requestedBy,
				flush_status: input.flushStatus,
				manifest_path: input.manifestPath,
			}),
		});
		this.enqueue(async () => {
			const handles = this.handles();
			if (!handles) {
				return;
			}
			await this.operations.failRun({
				runId: handles.runId,
				leaseToken: handles.leaseToken,
				errorMessage,
				retryable: input.retryable ?? false,
			});
		});
		await this.flush();
	}

	async recordHostedRunnerDrain(
		input: HostedAgentRuntimeDrainInput,
	): Promise<void> {
		this.recordDrainManifestEvent(input);
		if (input.status === "drained") {
			await this.completeRun({
				reason: input.reason,
				requestedBy: input.requestedBy,
				flushStatus: input.flushStatus,
				manifestPath: input.manifestPath,
			});
			return;
		}
		await this.failRun({
			errorMessage:
				input.errorMessage ?? "Hosted runner drain did not complete cleanly",
			reason: input.reason,
			requestedBy: input.requestedBy,
			retryable: false,
			flushStatus: input.flushStatus,
			manifestPath: input.manifestPath,
		});
	}

	private recordApprovalWait(input: {
		id: string;
		callId: string;
		toolName: string;
		reason: string;
		displayName?: string;
		summaryLabel?: string;
		kind?: ServerRequestLifecycleEvent["request"]["kind"];
		startedAtMs?: number;
	}): void {
		if (this.pendingWaitIds.has(input.id)) {
			return;
		}
		const waitId = this.waitId(input.id);
		this.pendingWaitIds.set(input.id, waitId);
		this.enqueue(async () => {
			const handles = this.handles();
			if (!handles) {
				return;
			}
			await this.operations.waitRun({
				runId: handles.runId,
				leaseToken: handles.leaseToken,
				wait: {
					id: waitId,
					stepId: this.toolStepId(input.callId),
					type: waitTypeForRequest(input.kind ?? "approval"),
					externalRef: input.id,
					reason: sanitizeOutboundText(input.reason),
					payload: this.basePayload({
						request_id: input.id,
						request_type: input.kind ?? "approval",
						call_id: input.callId,
						tool_name: input.toolName,
						display_name: sanitizeToolOutboundText(
							input.toolName,
							input.displayName,
						),
						summary_label: sanitizeToolOutboundText(
							input.toolName,
							input.summaryLabel,
						),
						started_at_ms: input.startedAtMs,
					}),
				},
				checkpoint: {
					id: this.checkpointId(input.id),
					stepId: this.toolStepId(input.callId),
					resumeToken: waitId,
					payload: this.basePayload({
						request_id: input.id,
						request_type: input.kind ?? "approval",
					}),
				},
			});
		});
	}

	private resumeWait(input: {
		id: string;
		kind: string;
		resolution: string;
		resolvedBy: string;
		reason?: string;
		startedAtMs?: number;
		resolvedAtMs?: number;
	}): void {
		if (this.resumedWaitIds.has(input.id)) {
			return;
		}
		this.resumedWaitIds.add(input.id);
		const waitId = this.pendingWaitIds.get(input.id) ?? this.waitId(input.id);
		this.pendingWaitIds.delete(input.id);
		this.enqueue(async () => {
			const handles = this.handles();
			if (!handles) {
				return;
			}
			await this.operations.resumeRun({
				runId: handles.runId,
				waitId,
				resumeEventId: this.resumeEventId(input.id),
				payload: this.basePayload({
					request_id: input.id,
					request_type: input.kind,
					resolution: input.resolution,
					resolved_by: input.resolvedBy,
					reason: sanitizeOutboundText(input.reason),
					started_at_ms: input.startedAtMs,
					resolved_at_ms: input.resolvedAtMs,
				}),
			});
		});
	}

	private recordStep(step: PlatformAgentRunStep): void {
		this.enqueue(async () => {
			const handles = this.handles();
			if (!handles) {
				return;
			}
			await this.operations.recordStep({
				runId: handles.runId,
				leaseToken: handles.leaseToken,
				step,
			});
		});
	}

	private recordModelUsageEvent(message: AppMessage): void {
		if (message.role !== "assistant") {
			return;
		}
		const usage = message.usage as Usage | undefined;
		if (!usage) {
			return;
		}
		const inputTokens = finiteNumber(usage.input);
		const outputTokens = finiteNumber(usage.output);
		const cacheReadTokens = finiteNumber(usage.cacheRead);
		const cacheWriteTokens = finiteNumber(usage.cacheWrite);
		const totalTokens =
			inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
		const estimatedCostMicros = Math.max(
			0,
			Math.round(finiteNumber(usage.cost?.total) * 1_000_000),
		);
		if (totalTokens <= 0 && estimatedCostMicros <= 0) {
			return;
		}
		const turnId = String(this.turnIndex);
		if (this.recordedModelUsageTurnIds.has(turnId)) {
			return;
		}
		this.recordedModelUsageTurnIds.add(turnId);
		const modelCallId = this.stepId("model", turnId);
		const costId = this.costId(turnId);
		const stepId = this.stepId("turn", turnId);
		const meterRef = this.meterRef(costId);
		this.recordEvent({
			type: PlatformRuntimeEventTypeValue.ModelResponseRecorded,
			message: "Maestro model response usage recorded",
			stepId,
			costId,
			attributes: this.basePayload({
				event_type: "model_response_recorded",
				session_kind: "codex",
				session_provider: "maestro",
				model_call_id: modelCallId,
				cost_id: costId,
				provider: message.provider,
				model: message.model,
				input_tokens: inputTokens,
				output_tokens: outputTokens,
				cache_read_tokens: cacheReadTokens,
				cache_write_tokens: cacheWriteTokens,
				total_tokens: totalTokens,
				estimated_cost_micros: estimatedCostMicros,
				currency: "USD",
			}),
		});
		this.recordCost({
			id: costId,
			stepId,
			meterRef,
			provider: message.provider,
			model: message.model,
			inputTokens,
			outputTokens,
			totalTokens,
			currency: estimatedCostMicros > 0 ? "USD" : undefined,
			estimatedCostMicros,
		});
	}

	private recordDrainManifestEvent(input: HostedAgentRuntimeDrainInput): void {
		this.recordEvent({
			type: PlatformRuntimeEventTypeValue.AgentProgressRecorded,
			message:
				input.status === "drained"
					? "hosted runner drain manifest recorded"
					: "hosted runner interrupted drain manifest recorded",
			attributes: this.basePayload({
				event_type: "hosted_runner_drain_manifest_recorded",
				status: input.status,
				flush_status: input.flushStatus,
				reason: sanitizeOutboundText(input.reason, 512),
				requested_by: input.requestedBy,
				manifest_path: input.manifestPath,
				error: sanitizeOutboundText(input.errorMessage, 512),
				platform_evidence: sanitizeHostedDrainPlatformEvidence(
					input.platformEvidence,
				),
			}),
		});
	}

	private recordEvent(
		event: Omit<PlatformAgentRuntimeRecordRunEventInput, "runId">,
	): void {
		this.enqueue(async () => {
			const runId = nonEmptyString(this.hostedRunner?.agentRunId);
			if (!this.hostedRunner?.enabled || !runId) {
				return;
			}
			await this.operations.recordEvent({
				runId,
				...event,
			});
		});
	}

	private recordCost(
		cost: Parameters<typeof recordAgentRuntimeRunCost>[0]["cost"],
	): void {
		this.enqueue(async () => {
			const runId = nonEmptyString(this.hostedRunner?.agentRunId);
			const leaseToken = nonEmptyString(
				this.hostedRunner?.agentRuntimeLeaseToken,
			);
			if (!this.hostedRunner?.enabled || !runId || !leaseToken) {
				return;
			}
			await this.operations.recordCost({
				runId,
				leaseToken,
				cost,
			});
		});
	}

	private recordCodexSubagentWorkItem(
		event: Extract<AgentEvent, { type: "tool_execution_start" }>,
	): void {
		const codexTool = codexSubagentToolName(event.toolName);
		if (!codexTool) {
			return;
		}
		const runId = nonEmptyString(this.hostedRunner?.agentRunId);
		if (!this.hostedRunner?.enabled || !runId) {
			return;
		}
		const workGraph = codexSubagentWorkGraph(event.args);
		const receiverThreadIds = codexSubagentReceiverThreadIds(event.args);
		const childRunIds = codexSubagentChildRunIds(event.args, receiverThreadIds);
		const ownerChildRunId = childRunIds[0];
		const linkedWorkItemIds =
			this.codexSubagentLinkedWorkItemIds(receiverThreadIds);
		const parentWorkItemId =
			linkedWorkItemIds.length === 1 ? linkedWorkItemIds[0] : undefined;
		const workItemId = this.workItemId(event.toolCallId);
		this.codexSubagentReceiverThreadIds.set(
			event.toolCallId,
			receiverThreadIds,
		);
		this.codexSubagentToolChildRunIds.set(event.toolCallId, childRunIds);
		if (workGraph) {
			this.codexSubagentToolWorkGraphs.set(event.toolCallId, workGraph);
		}
		if (codexTool === "spawnAgent") {
			for (const threadId of receiverThreadIds) {
				this.codexSubagentThreadWorkItemIds.set(threadId, workItemId);
			}
		}
		const toolExecutionId = materializedToolExecutionId(event);
		const prompt = nonEmptyString(event.args.prompt);
		const sanitizedPrompt = sanitizeOutboundText(prompt);
		const delegationPrompt = sanitizeDelegationPrompt(prompt);
		const model = nonEmptyString(event.args.model);
		const reasoningEffort = nonEmptyString(event.args.reasoningEffort);
		const codexSubagentOperationName = codexSubagentOperation(codexTool);
		const workItem: PlatformAgentWorkItem = {
			id: workItemId,
			runId,
			...(parentWorkItemId ? { parentWorkItemId } : {}),
			...(ownerChildRunId ? { ownerChildRunId } : {}),
			kind:
				codexTool === "wait"
					? PlatformAgentWorkItemKindValue.Wait
					: PlatformAgentWorkItemKindValue.ChildRun,
			state:
				codexTool === "wait"
					? PlatformAgentWorkItemStateValue.Waiting
					: PlatformAgentWorkItemStateValue.Running,
			title: sanitizedToolDisplayName(event),
			...(sanitizedPrompt ? { goal: sanitizedPrompt } : {}),
			nextAction: codexSubagentNextAction(codexTool),
			...(toolExecutionId ? { toolExecutionId } : {}),
			evidenceRefs: [
				`codex-tool-call:${event.toolCallId}`,
				...receiverThreadIds.map((id) => `codex-thread:${id}`),
				...childRunIds.map((id) => `codex-child-run:${id}`),
			],
			completionGate: "codex_collab_tool_completed",
			payload: this.basePayload({
				event_type: event.type,
				codex_tool: codexTool,
				tool_call_id: event.toolCallId,
				tool_name: event.toolName,
				display_name: sanitizeToolOutboundText(
					event.toolName,
					event.displayName,
				),
				summary_label: sanitizeToolOutboundText(
					event.toolName,
					event.summaryLabel,
				),
				codex_subagent_operation: codexSubagentOperationName,
				codex_subagent_edge_status: activeCodexSubagentEdgeStatus(codexTool),
				sender_thread_id: nonEmptyString(event.args.senderThreadId),
				receiver_thread_ids: receiverThreadIds,
				receiver_thread_count: receiverThreadIds.length,
				child_run_ids: childRunIds,
				codex_work_graph: workGraph,
				linked_work_item_ids: linkedWorkItemIds,
				model,
				reasoning_effort: reasoningEffort,
				arg_keys: objectKeys(event.args),
			}),
		};
		this.enqueue(async () => {
			await this.operations.recordWorkItem({ runId, workItem });
		});
		if (codexTool === "spawnAgent") {
			this.recordCodexSubagentDelegation({
				event,
				runId,
				workItemId,
				parentWorkItemId,
				ownerChildRunId,
				receiverThreadIds,
				childRunIds,
				linkedWorkItemIds,
				workGraph,
				prompt: delegationPrompt,
				model,
				reasoningEffort,
			});
		}
	}

	private recordCodexSubagentDelegation(input: {
		event: Extract<AgentEvent, { type: "tool_execution_start" }>;
		runId: string;
		workItemId: string;
		parentWorkItemId?: string;
		ownerChildRunId?: string;
		receiverThreadIds: string[];
		childRunIds: string[];
		linkedWorkItemIds: string[];
		workGraph?: Record<string, unknown>;
		prompt?: string;
		model?: string;
		reasoningEffort?: string;
	}): void {
		const fromAgentId = nonEmptyString(this.hostedRunner?.agentId) ?? "maestro";
		const toAgentId = codexSubagentDelegationTargetAgentId(input.event.args);
		const requiredCapability = codexSubagentDelegationRequiredCapability(
			input.event.args,
			toAgentId,
		);
		const a2aSkillId = codexSubagentDelegationA2ASkillID(
			input.event.args,
			requiredCapability,
		);
		this.enqueue(async () => {
			const result = await this.operations.delegateAgent({
				fromAgentId,
				...(toAgentId ? { toAgentId } : {}),
				...(requiredCapability ? { requiredCapability } : {}),
				...(a2aSkillId ? { a2aSkillId } : {}),
				contextPayload: this.basePayload({
					event_type: "codex_subagent_delegation_requested",
					codex_tool: "spawnAgent",
					agent_run_id: input.runId,
					work_item_id: input.workItemId,
					parent_work_item_id: input.parentWorkItemId,
					owner_child_run_id: input.ownerChildRunId,
					tool_call_id: input.event.toolCallId,
					tool_name: input.event.toolName,
					display_name: sanitizeOutboundText(input.event.displayName),
					summary_label: sanitizeOutboundText(input.event.summaryLabel),
					from_agent_id: fromAgentId,
					to_agent_id: toAgentId,
					required_capability: requiredCapability,
					a2a_skill_id: a2aSkillId,
					sender_thread_id: nonEmptyString(input.event.args.senderThreadId),
					receiver_thread_ids: input.receiverThreadIds,
					child_run_ids: input.childRunIds,
					codex_work_graph: input.workGraph,
					linked_work_item_ids: input.linkedWorkItemIds,
					prompt: input.prompt,
					model: input.model,
					reasoning_effort: input.reasoningEffort,
					arg_keys: objectKeys(input.event.args),
				}),
				reason: codexSubagentDelegationReason(input.prompt),
			});
			const delegationId = result?.delegation?.id;
			if (delegationId) {
				this.rememberCodexSubagentDelegation({
					delegationId,
					toolCallId: input.event.toolCallId,
					receiverThreadIds: input.receiverThreadIds,
					childRunIds: input.childRunIds,
				});
			}
		});
	}

	private updateCodexSubagentWorkItem(
		event: Extract<AgentEvent, { type: "tool_execution_end" }>,
	): void {
		const codexTool = codexSubagentToolName(event.toolName);
		if (!codexTool) {
			return;
		}
		const runId = nonEmptyString(this.hostedRunner?.agentRunId);
		if (!this.hostedRunner?.enabled || !runId) {
			return;
		}
		const details =
			event.result.details &&
			typeof event.result.details === "object" &&
			!Array.isArray(event.result.details)
				? (event.result.details as Record<string, unknown>)
				: undefined;
		const detailWorkGraph = codexSubagentWorkGraph(details);
		const workGraph =
			detailWorkGraph ?? this.codexSubagentToolWorkGraphs.get(event.toolCallId);
		const detailReceiverThreadIds = details
			? codexSubagentReceiverThreadIds(details)
			: [];
		const receiverThreadIds =
			detailReceiverThreadIds.length > 0
				? detailReceiverThreadIds
				: (this.codexSubagentReceiverThreadIds.get(event.toolCallId) ?? []);
		const detailChildRunIds = details
			? codexSubagentExplicitChildRunIds(details)
			: [];
		const childRunIds =
			detailChildRunIds.length > 0
				? detailChildRunIds
				: (this.codexSubagentToolChildRunIds.get(event.toolCallId) ??
					codexSubagentChildRunIds({}, receiverThreadIds));
		const linkedWorkItemIds =
			this.codexSubagentLinkedWorkItemIds(receiverThreadIds);
		this.codexSubagentReceiverThreadIds.delete(event.toolCallId);
		this.codexSubagentToolChildRunIds.delete(event.toolCallId);
		this.codexSubagentToolWorkGraphs.delete(event.toolCallId);
		if (codexTool === "closeAgent" && !event.isError) {
			for (const threadId of receiverThreadIds) {
				this.codexSubagentThreadWorkItemIds.delete(threadId);
			}
		}
		const codexSubagentOperationName = codexSubagentOperation(codexTool);
		const codexSubagentEdgeStatus = terminalCodexSubagentEdgeStatus(
			codexTool,
			event.isError,
		);
		this.enqueue(async () => {
			const delegationIds = this.codexSubagentDelegationIdsFor(
				event.toolCallId,
				receiverThreadIds,
				childRunIds,
			);
			const delegationId = delegationIds[0];
			const delegationEvidenceRefs = delegationIds.map(
				(id) => `agent-registry-delegation:${id}`,
			);
			const shouldResolveDelegation =
				delegationIds.length > 0 &&
				shouldResolveCodexSubagentDelegation(codexTool, event.isError);
			const toolExecutionId = materializedToolExecutionId(event);
			let updateError: unknown;
			try {
				await this.operations.updateWorkItem({
					runId,
					workItemId: this.workItemId(event.toolCallId),
					state: event.isError
						? PlatformAgentWorkItemStateValue.Failed
						: PlatformAgentWorkItemStateValue.Succeeded,
					...(toolExecutionId ? { toolExecutionId } : {}),
					evidenceRefs: [
						`codex-tool-call:${event.toolCallId}`,
						...receiverThreadIds.map((id) => `codex-thread:${id}`),
						...childRunIds.map((id) => `codex-child-run:${id}`),
						...delegationEvidenceRefs,
					],
					completionGate: event.isError
						? "codex_collab_tool_failed"
						: "codex_collab_tool_completed",
					payload: this.basePayload({
						event_type: event.type,
						codex_tool: codexTool,
						tool_call_id: event.toolCallId,
						tool_name: event.toolName,
						display_name: sanitizeToolOutboundText(
							event.toolName,
							event.displayName,
						),
						summary_label: sanitizeToolOutboundText(
							event.toolName,
							event.summaryLabel,
						),
						codex_subagent_operation: codexSubagentOperationName,
						codex_subagent_edge_status: codexSubagentEdgeStatus,
						error_code: event.errorCode,
						governed_outcome: event.governedOutcome,
						result_error: event.isError,
						receiver_thread_ids: receiverThreadIds,
						child_run_ids: childRunIds,
						codex_work_graph: workGraph,
						linked_work_item_ids: linkedWorkItemIds,
						delegation_id: delegationId,
						delegation_ids:
							delegationIds.length > 0 ? delegationIds : undefined,
						delegation_resolution:
							codexTool === "spawnAgent" &&
							delegationIds.length > 0 &&
							!event.isError
								? "deferred_until_child_terminal_edge"
								: shouldResolveDelegation
									? "resolved_from_child_terminal_edge"
									: undefined,
						result_detail_keys: objectKeys(details),
					}),
				});
			} catch (error) {
				updateError = error;
			}
			if (shouldResolveDelegation) {
				for (const delegationIdToResolve of delegationIds) {
					try {
						await this.operations.resolveDelegation({
							delegationId: delegationIdToResolve,
							status: event.isError
								? PlatformDelegationStatusValue.Failed
								: PlatformDelegationStatusValue.Completed,
							resultPayload: this.basePayload({
								event_type: "codex_subagent_delegation_resolved",
								codex_tool: codexTool,
								codex_subagent_operation: codexSubagentOperationName,
								codex_subagent_edge_status: codexSubagentEdgeStatus,
								agent_run_id: runId,
								work_item_id: this.workItemId(event.toolCallId),
								resolution_tool_call_id: event.toolCallId,
								tool_call_id: event.toolCallId,
								tool_name: event.toolName,
								result_error: event.isError,
								receiver_thread_ids: receiverThreadIds,
								child_run_ids: childRunIds,
								codex_work_graph: workGraph,
								linked_work_item_ids: linkedWorkItemIds,
								delegation_ids: delegationIds,
								result_detail_keys: objectKeys(details),
							}),
							errorMessage: event.isError
								? (event.errorCode ??
									event.governedOutcome ??
									codexSubagentDelegationFailureMessage(codexTool))
								: undefined,
						});
					} catch (error) {
						logger.warn("Failed to resolve Codex subagent delegation", {
							error: error instanceof Error ? error.message : String(error),
							session_id: this.sessionId,
							agent_run_id: runId,
							tool_call_id: event.toolCallId,
							delegation_id: delegationIdToResolve,
						});
					} finally {
						this.clearCodexSubagentDelegationLinks(delegationIdToResolve);
					}
				}
			}
			if (updateError !== undefined) {
				throw updateError;
			}
		});
	}

	private rememberCodexSubagentDelegation(input: {
		delegationId: string;
		toolCallId: string;
		receiverThreadIds: string[];
		childRunIds: string[];
	}): void {
		this.codexSubagentDelegationIds.set(input.toolCallId, input.delegationId);
		for (const threadId of input.receiverThreadIds) {
			this.codexSubagentDelegationIdsByThreadId.set(
				threadId,
				input.delegationId,
			);
		}
		for (const childRunId of input.childRunIds) {
			this.codexSubagentDelegationIdsByChildRunId.set(
				childRunId,
				input.delegationId,
			);
		}
	}

	private codexSubagentDelegationIdsFor(
		toolCallId: string,
		receiverThreadIds: string[],
		childRunIds: string[],
	): string[] {
		const ids = new Set<string>();
		const add = (delegationId: string | undefined) => {
			if (delegationId) {
				ids.add(delegationId);
			}
		};
		add(this.codexSubagentDelegationIds.get(toolCallId));
		for (const childRunId of childRunIds) {
			add(this.codexSubagentDelegationIdsByChildRunId.get(childRunId));
		}
		for (const threadId of receiverThreadIds) {
			add(this.codexSubagentDelegationIdsByThreadId.get(threadId));
		}
		return [...ids];
	}

	private clearCodexSubagentDelegationLinks(delegationId: string): void {
		for (const [toolCallId, linkedDelegationId] of this
			.codexSubagentDelegationIds) {
			if (linkedDelegationId === delegationId) {
				this.codexSubagentDelegationIds.delete(toolCallId);
			}
		}
		for (const [threadId, linkedDelegationId] of this
			.codexSubagentDelegationIdsByThreadId) {
			if (linkedDelegationId === delegationId) {
				this.codexSubagentDelegationIdsByThreadId.delete(threadId);
			}
		}
		for (const [childRunId, linkedDelegationId] of this
			.codexSubagentDelegationIdsByChildRunId) {
			if (linkedDelegationId === delegationId) {
				this.codexSubagentDelegationIdsByChildRunId.delete(childRunId);
			}
		}
	}

	private codexSubagentLinkedWorkItemIds(
		receiverThreadIds: string[],
	): string[] {
		const linked = receiverThreadIds
			.map((threadId) => this.codexSubagentThreadWorkItemIds.get(threadId))
			.filter((id): id is string => Boolean(id));
		return Array.from(new Set(linked));
	}

	private recordToolDerivedTaskProgress(
		event: Extract<AgentEvent, { type: "tool_execution_end" }>,
	): void {
		const args = this.toolArgsByCallId.get(event.toolCallId);
		this.toolArgsByCallId.delete(event.toolCallId);
		if (event.isError) {
			return;
		}
		if (event.toolName === "todo") {
			this.recordTodoTaskProgress(event, args);
			return;
		}
		if (event.toolName === "background_tasks" || event.toolName === "bash") {
			this.recordBackgroundTaskProgress(event, args);
		}
	}

	private recordTodoTaskProgress(
		event: Extract<AgentEvent, { type: "tool_execution_end" }>,
		args: Record<string, unknown> | undefined,
	): void {
		const details = isRecord(event.result.details)
			? event.result.details
			: undefined;
		if (!details) {
			return;
		}
		const rawGoal = nonEmptyString(args?.goal)?.trim();
		const goal = compactString(rawGoal, 512);
		const goalHash = rawGoal ? stableShortHash(rawGoal) : undefined;
		for (const item of recordArray(details.items)) {
			const id = compactString(item.id, 128);
			const content = compactString(item.content, 512);
			if (!id || !content) {
				continue;
			}
			const scopedId = goalScopedTodoId(id, rawGoal);
			const blockedBy = stringArray(item.blockedBy);
			const status = todoStatusToTaskStatus(item.status);
			this.recordTaskProgressEvent({
				source: "todo",
				id: scopedId,
				status,
				title: content,
				goal,
				toolCallId: event.toolCallId,
				toolExecutionId: materializedToolExecutionId(event),
				completionGate: "todo_status_projected",
				nextAction:
					status === "pending"
						? "wait for task to start"
						: status === "running"
							? "complete the active task"
							: "task completed",
				blocker: blockedBy.length > 0 ? blockedBy.join(", ") : undefined,
				payload: {
					task_id: id,
					todo_id: id,
					todo_scope: rawGoal ? "goal" : "session",
					todo_goal_hash: goalHash,
					todo_status: compactString(item.status),
					priority: compactString(item.priority),
					blocked_by: blockedBy,
					due: compactString(item.due),
				},
			});
		}
	}

	private recordBackgroundTaskProgress(
		event: Extract<AgentEvent, { type: "tool_execution_end" }>,
		args: Record<string, unknown> | undefined,
	): void {
		const details = event.result.details;
		const candidates = Array.isArray(details)
			? recordArray(details)
			: isRecord(details)
				? [details]
				: [];
		for (const detail of candidates) {
			const id = compactString(detail.id ?? detail.taskId, 128);
			if (!id) {
				continue;
			}
			const statusLabel = compactString(detail.status, 64);
			if (!statusLabel) {
				continue;
			}
			const command = compactString(detail.command ?? args?.command, 512);
			const commandSummary = command ? REDACTED : undefined;
			const status = backgroundStatusToTaskStatus(statusLabel);
			this.recordTaskProgressEvent({
				source: "background",
				id,
				status,
				title: commandSummary
					? `Background task: ${commandSummary}`
					: `Background task ${id}`,
				toolCallId: event.toolCallId,
				toolExecutionId: materializedToolExecutionId(event),
				completionGate: "background_task_status_projected",
				nextAction:
					status === "running"
						? "monitor or stop the background task"
						: "inspect task result if needed",
				errorMessage: compactString(detail.failureReason, 512),
				payload: {
					background_task_id: id,
					background_task_status: statusLabel,
					command_summary: commandSummary,
					cwd: compactString(detail.cwd, 512),
					pid: typeof detail.pid === "number" ? detail.pid : undefined,
					shell_mode: compactString(detail.shellMode, 64),
					restart_attempts: finiteNumber(detail.restartAttempts),
					restart_max_attempts: finiteNumber(detail.restartMaxAttempts),
					log_truncated:
						typeof detail.logTruncated === "boolean"
							? detail.logTruncated
							: undefined,
					monitoring_mode: compactString(detail.monitoringMode, 64),
				},
			});
		}
	}

	private enqueue(operation: ProgressOperation): void {
		this.pending = this.pending.then(operation, operation).then(
			() => {},
			(error) => {
				logger.warn("Failed to record hosted AgentRuntime progress", {
					error: error instanceof Error ? error.message : String(error),
					session_id: this.sessionId,
					agent_run_id: this.hostedRunner?.agentRunId,
				});
			},
		);
	}

	private handles(): { runId: string; leaseToken: string } | null {
		const runId = nonEmptyString(this.hostedRunner?.agentRunId);
		const leaseToken = nonEmptyString(
			this.hostedRunner?.agentRuntimeLeaseToken,
		);
		if (!this.hostedRunner?.enabled || !runId || !leaseToken) {
			return null;
		}
		return { runId, leaseToken };
	}

	private basePayload(
		values: Record<string, unknown>,
	): Record<string, unknown> {
		return {
			maestro_session_id: this.sessionId,
			...(this.workspaceRoot ? { workspace_root: this.workspaceRoot } : {}),
			...(this.hostedRunner?.workspaceId
				? { workspace_id: this.hostedRunner.workspaceId }
				: {}),
			...(this.hostedRunner?.runnerSessionId
				? { runner_session_id: this.hostedRunner.runnerSessionId }
				: {}),
			...(this.hostedRunner?.ownerInstanceId
				? { owner_instance_id: this.hostedRunner.ownerInstanceId }
				: {}),
			...(this.hostedRunner?.agentId
				? { agent_id: this.hostedRunner.agentId }
				: {}),
			...(this.hostedRunner?.agentRuntimeWorkerQueue
				? { worker_queue: this.hostedRunner.agentRuntimeWorkerQueue }
				: {}),
			...(this.hostedRunner?.agentRuntimeCorrelationPath
				? { correlation_path: this.hostedRunner.agentRuntimeCorrelationPath }
				: {}),
			...Object.fromEntries(
				Object.entries(values).filter(([, value]) => value !== undefined),
			),
		};
	}

	private stepId(kind: string, id: string): string {
		return `maestro:${safeIdPart(this.sessionId)}:${kind}:${safeIdPart(id)}`;
	}

	private taskProgressId(
		source: HostedAgentRuntimeTaskSource,
		id: string,
	): string {
		return this.stepId(source, id);
	}

	private toolStepId(toolCallId: string): string {
		return this.stepId("tool", toolCallId);
	}

	private workItemId(toolCallId: string): string {
		return this.stepId("work", toolCallId);
	}

	private resolveAutoRetryStartSequence(attempt: number): number {
		if (
			this.activeAutoRetrySequence === null ||
			attempt <= this.lastAutoRetryAttempt
		) {
			this.autoRetrySequence += 1;
			this.activeAutoRetrySequence = this.autoRetrySequence;
		}
		this.lastAutoRetryAttempt = attempt;
		return this.activeAutoRetrySequence;
	}

	private resolveAutoRetryEndSequence(): number {
		if (this.activeAutoRetrySequence === null) {
			this.autoRetrySequence += 1;
			this.activeAutoRetrySequence = this.autoRetrySequence;
		}
		const sequence = this.activeAutoRetrySequence;
		this.activeAutoRetrySequence = null;
		this.lastAutoRetryAttempt = 0;
		return sequence;
	}

	private autoRetryStepId(attempt: number, sequence: number): string {
		return this.stepId("retry", `auto-${sequence}-attempt-${attempt}`);
	}

	private waitId(requestId: string): string {
		return this.stepId("wait", requestId);
	}

	private checkpointId(requestId: string): string {
		return this.stepId("checkpoint", requestId);
	}

	private resumeEventId(requestId: string): string {
		return this.stepId("resume", requestId);
	}

	private costId(turnId: string): string {
		return this.stepId("cost", turnId);
	}

	private meterRef(costId: string): string {
		return `meter://maestro/model-usage/${safeIdPart(costId)}`;
	}
}

export function createHostedAgentRuntimeProgressRecorder(
	options: HostedAgentRuntimeProgressRecorderOptions,
): HostedAgentRuntimeProgressRecorder | undefined {
	if (!options.hostedRunner?.enabled) {
		return undefined;
	}
	return new HostedAgentRuntimeProgressRecorder(options);
}
