import type {
	ComposerPendingRequest,
	ComposerPendingRequestPlatformOperation,
	ComposerRunTimelineItem,
	ComposerRunTimelineResponse,
	ComposerRunTimelineStatus,
} from "@evalops/contracts";
import type {
	AppMessage,
	AssistantMessage,
	ToolResultMessage,
	UserMessage,
} from "../agent/types.js";
import { getDiagnosticDeltaFromToolResult } from "../lsp/diagnostic-repair.js";
import type { SessionEntry } from "../session/types.js";
import { getSkillArtifactMetadataFromDetails } from "../skills/artifact-metadata.js";

const SUMMARY_LIMIT = 180;

const SECRET_PATTERNS: Array<[RegExp, string]> = [
	[/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, "$1[redacted]"],
	[/\b(sk-[A-Za-z0-9_-]{16,})\b/g, "[redacted-secret]"],
	[/\b(gh[pousr]_[A-Za-z0-9_]{16,})\b/g, "[redacted-token]"],
	[/\b(xox[a-zA-Z]?-[A-Za-z0-9-]{16,})\b/g, "[redacted-token]"],
	[/\b(AKIA[0-9A-Z]{16})\b/g, "[redacted-access-key]"],
];

interface BuildComposerRunTimelineOptions {
	sessionId: string;
	entries?: SessionEntry[];
	messages?: AppMessage[];
	pendingRequests?: ComposerPendingRequest[];
	generatedAt?: string;
}

interface TimelineToolRequest {
	name: string;
	args: Record<string, unknown>;
}

interface TimelineBuildContext {
	toolRequests: Map<string, TimelineToolRequest>;
}

function normalizeTimestamp(value: unknown, fallback: string): string {
	if (typeof value === "string" || typeof value === "number") {
		const date = new Date(value);
		if (!Number.isNaN(date.getTime())) {
			return date.toISOString();
		}
	}
	return fallback;
}

function redactSecrets(value: string): string {
	let redacted = value;
	for (const [pattern, replacement] of SECRET_PATTERNS) {
		redacted = redacted.replace(pattern, replacement);
	}
	return redacted;
}

function compactSummary(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const singleLine = redactSecrets(value.replace(/\s+/g, " ").trim());
	if (!singleLine) return undefined;
	if (singleLine.length <= SUMMARY_LIMIT) return singleLine;
	return `${singleLine.slice(0, SUMMARY_LIMIT - 3)}...`;
}

function detailsRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	return value as Record<string, unknown>;
}

function redactedString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed ? redactSecrets(trimmed) : undefined;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function booleanValue(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function compactMetadata(
	values: Record<string, unknown>,
): Record<string, unknown> | undefined {
	const metadata = Object.fromEntries(
		Object.entries(values).filter(([, value]) => value !== undefined),
	);
	return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function textFromContent(content: unknown): string | undefined {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	const text = content
		.map((block) => {
			if (!block || typeof block !== "object") return "";
			const typed = block as { type?: unknown; text?: unknown };
			if (typed.type === "text" && typeof typed.text === "string") {
				return typed.text;
			}
			return "";
		})
		.filter(Boolean)
		.join(" ");
	return text || undefined;
}

function getToolPath(
	request: TimelineToolRequest | undefined,
): string | undefined {
	const args = request?.args;
	return redactedString(args?.path) ?? redactedString(args?.file_path);
}

function governedToolMetadata(details: unknown): {
	errorCode?: string;
	approvalRequestId?: string;
	governedOutcome?: string;
} {
	const record = detailsRecord(details);
	const outcome = detailsRecord(record?.governedOutcome);
	if (!outcome) return {};
	const classification = redactedString(outcome.classification);
	return {
		errorCode: redactedString(outcome.code) ?? classification,
		approvalRequestId: redactedString(outcome.approvalRequestId),
		governedOutcome: classification,
	};
}

function timelineStatusForGovernedOutcome(
	outcome: string | undefined,
): ComposerRunTimelineStatus {
	switch (outcome) {
		case "denied":
			return "denied";
		case "approval_required":
		case "approval_pending":
		case "authentication_required":
		case "rate_limited":
			return "pending";
		default:
			return "info";
	}
}

function addDerivedToolResultItems(
	items: ComposerRunTimelineItem[],
	sessionId: string,
	toolResult: ToolResultMessage,
	options: {
		baseId: string;
		timestamp: string;
		source: "local" | "platform";
		request?: TimelineToolRequest;
	},
): void {
	const details = detailsRecord(toolResult.details);
	const normalizedToolName = toolResult.toolName.toLowerCase();

	if (
		!toolResult.isError &&
		(normalizedToolName === "write" || normalizedToolName === "edit")
	) {
		const displayPath = getToolPath(options.request);
		const previousExists = booleanValue(details?.previousExists);
		const editsApplied = finiteNumber(details?.editsApplied);
		const bytesWritten = finiteNumber(details?.bytesWritten);
		const action =
			normalizedToolName === "write"
				? previousExists === false
					? "created"
					: "wrote"
				: "edited";
		const summary = compactSummary(
			[
				displayPath,
				bytesWritten !== undefined ? `${bytesWritten} bytes` : undefined,
				editsApplied !== undefined ? `${editsApplied} edits` : undefined,
			]
				.filter(Boolean)
				.join(" | "),
		);
		const hasDiff =
			typeof details?.diff === "string" && details.diff.length > 0;
		const metadata = compactMetadata({
			path: displayPath,
			action,
			previousExists,
			bytesWritten,
			editsApplied,
			hasDiff,
		});

		appendItem(items, {
			id: `file-change:${options.baseId}:${toolResult.toolCallId}`,
			sessionId,
			timestamp: options.timestamp,
			type: "file.changed",
			title: `File ${action}`,
			visibility: "user",
			source: options.source,
			status: "completed",
			toolCallId: toolResult.toolCallId,
			toolName: toolResult.toolName,
			...(summary ? { summary } : {}),
			...(metadata ? { metadata } : {}),
		});
	}

	const diagnosticDelta = getDiagnosticDeltaFromToolResult(toolResult);
	if (diagnosticDelta) {
		const summary = compactSummary(
			`Diagnostic delta: ${diagnosticDelta.introducedCount} introduced, ${diagnosticDelta.repairedCount} repaired, ${diagnosticDelta.remainingCount} remaining.`,
		);
		appendItem(items, {
			id: `diagnostic-delta:${options.baseId}:${toolResult.toolCallId}`,
			sessionId,
			timestamp: options.timestamp,
			type: "diagnostic.delta",
			title: `Diagnostics for ${diagnosticDelta.displayPath}`,
			visibility: "user",
			source: options.source,
			status: diagnosticDelta.introducedCount > 0 ? "failed" : "completed",
			toolCallId: toolResult.toolCallId,
			toolName: toolResult.toolName,
			...(summary ? { summary } : {}),
			metadata: {
				displayPath: diagnosticDelta.displayPath,
				usedDelta: diagnosticDelta.usedDelta,
				introducedCount: diagnosticDelta.introducedCount,
				repairedCount: diagnosticDelta.repairedCount,
				remainingCount: diagnosticDelta.remainingCount,
				fingerprint: diagnosticDelta.fingerprint,
				shouldFollowUp: diagnosticDelta.repair.shouldFollowUp,
				maxAttempts: diagnosticDelta.repair.maxAttempts,
			},
		});
	}

	const skillMetadata = getSkillArtifactMetadataFromDetails(toolResult.details);
	if (skillMetadata) {
		const summary = compactSummary(
			[
				skillMetadata.name,
				skillMetadata.version ? `v${skillMetadata.version}` : undefined,
				skillMetadata.source,
				skillMetadata.scope,
			]
				.filter(Boolean)
				.join(" | "),
		);
		const metadata = compactMetadata({
			name: skillMetadata.name,
			version: skillMetadata.version,
			source: skillMetadata.source,
			scope: skillMetadata.scope,
			workspaceId: skillMetadata.workspaceId,
			ownerId: skillMetadata.ownerId,
			hash: skillMetadata.hash,
		});
		appendItem(items, {
			id: `artifact-linked:${options.baseId}:${toolResult.toolCallId}`,
			sessionId,
			timestamp: options.timestamp,
			type: "artifact.linked",
			title: `Skill artifact loaded: ${skillMetadata.name}`,
			visibility: "admin",
			source: options.source,
			status: "completed",
			toolCallId: toolResult.toolCallId,
			toolName: toolResult.toolName,
			...(skillMetadata.artifactId
				? { artifactId: skillMetadata.artifactId }
				: {}),
			...(summary ? { summary } : {}),
			...(metadata ? { metadata } : {}),
		});
	}

	const governed = governedToolMetadata(toolResult.details);
	if (governed.governedOutcome || governed.errorCode) {
		const summary = compactSummary(
			[
				governed.governedOutcome
					? `Outcome: ${governed.governedOutcome}`
					: undefined,
				governed.errorCode ? `Code: ${governed.errorCode}` : undefined,
			]
				.filter(Boolean)
				.join(" | "),
		);
		const metadata = compactMetadata({
			governedOutcome: governed.governedOutcome,
			errorCode: governed.errorCode,
		});
		appendItem(items, {
			id: `policy-decision:${options.baseId}:${toolResult.toolCallId}`,
			sessionId,
			timestamp: options.timestamp,
			type: "policy.decision",
			title: `Policy decision for ${toolResult.toolName}`,
			visibility: governed.governedOutcome === "denied" ? "user" : "admin",
			source: options.source,
			status: timelineStatusForGovernedOutcome(governed.governedOutcome),
			toolCallId: toolResult.toolCallId,
			toolName: toolResult.toolName,
			...(governed.approvalRequestId
				? { approvalRequestId: governed.approvalRequestId }
				: {}),
			...(summary ? { summary } : {}),
			...(metadata ? { metadata } : {}),
		});
	}
}

function appendItem(
	items: ComposerRunTimelineItem[],
	item: ComposerRunTimelineItem,
): void {
	items.push(item);
}

function addMessageItems(
	items: ComposerRunTimelineItem[],
	sessionId: string,
	message: AppMessage,
	options: {
		baseId: string;
		timestamp: string;
		source: "local" | "platform";
		context?: TimelineBuildContext;
	},
): void {
	if (message.role === "user") {
		const userMessage = message as UserMessage;
		const summary = compactSummary(textFromContent(userMessage.content));
		appendItem(items, {
			id: `message:${options.baseId}`,
			sessionId,
			timestamp: options.timestamp,
			type: "message.user",
			title: "User message",
			visibility: "user",
			source: options.source,
			role: "user",
			status: "completed",
			...(summary ? { summary } : {}),
		});
		return;
	}

	if (message.role === "assistant") {
		const assistantMessage = message as AssistantMessage;
		const summary = compactSummary(textFromContent(assistantMessage.content));
		appendItem(items, {
			id: `message:${options.baseId}`,
			sessionId,
			timestamp: options.timestamp,
			type: "message.assistant",
			title: "Assistant response",
			visibility: "user",
			source: options.source,
			role: "assistant",
			status: assistantMessage.stopReason === "error" ? "failed" : "completed",
			...(summary ? { summary } : {}),
			...(assistantMessage.model
				? { metadata: { model: assistantMessage.model } }
				: {}),
		});

		for (const block of assistantMessage.content) {
			if (block.type !== "toolCall") continue;
			options.context?.toolRequests.set(block.id, {
				name: block.name,
				args: block.arguments,
			});
			appendItem(items, {
				id: `tool-requested:${options.baseId}:${block.id}`,
				sessionId,
				timestamp: options.timestamp,
				type: "tool.requested",
				title: `Requested ${block.name}`,
				visibility: "user",
				source: options.source,
				status: "running",
				toolCallId: block.id,
				toolName: block.name,
			});
		}
		return;
	}

	if (message.role === "toolResult") {
		const toolResult = message as ToolResultMessage;
		const details = detailsRecord(toolResult.details);
		const governed = governedToolMetadata(toolResult.details);
		const request = options.context?.toolRequests.get(toolResult.toolCallId);
		const approvalRequestId =
			governed.approvalRequestId ?? redactedString(details?.approvalRequestId);
		const toolExecutionId = redactedString(details?.toolExecutionId);
		const metadata = compactMetadata({
			governedOutcome: governed.governedOutcome,
			errorCode: governed.errorCode,
		});
		appendItem(items, {
			id: `tool-result:${options.baseId}:${toolResult.toolCallId}`,
			sessionId,
			timestamp: options.timestamp,
			type: toolResult.isError ? "tool.failed" : "tool.completed",
			title: `${toolResult.toolName} ${
				toolResult.isError ? "failed" : "completed"
			}`,
			visibility: "user",
			source: options.source,
			role: "tool",
			status: toolResult.isError ? "failed" : "completed",
			toolCallId: toolResult.toolCallId,
			toolName: toolResult.toolName,
			...(approvalRequestId ? { approvalRequestId } : {}),
			...(toolExecutionId ? { toolExecutionId } : {}),
			...(metadata ? { metadata } : {}),
		});
		addDerivedToolResultItems(items, sessionId, toolResult, {
			baseId: options.baseId,
			timestamp: options.timestamp,
			source: options.source,
			request,
		});
	}
}

function statusForPendingRequest(
	request: ComposerPendingRequest,
): ComposerRunTimelineStatus {
	return request.status === "pending" ? "pending" : "info";
}

function platformOperationForPending(
	request: ComposerPendingRequest,
): ComposerPendingRequestPlatformOperation | undefined {
	if (!request.platform) return undefined;
	if (request.kind === "approval") {
		return request.platform.source === "tool_execution"
			? "ResumeToolExecution"
			: "ResolveApproval";
	}
	if (
		request.kind === "client_tool" ||
		request.kind === "mcp_elicitation" ||
		request.kind === "user_input"
	) {
		return "ResumeRun";
	}
	return undefined;
}

function pendingRequestTitle(request: ComposerPendingRequest): string {
	const label =
		request.displayName ||
		request.summaryLabel ||
		request.toolName ||
		"request";
	switch (request.kind) {
		case "approval":
			return `Waiting for approval: ${label}`;
		case "tool_retry":
			return `Waiting for retry decision: ${label}`;
		case "client_tool":
			return `Waiting for client tool: ${label}`;
		case "mcp_elicitation":
			return "Waiting for MCP input";
		case "user_input":
			return "Waiting for user input";
	}
}

function addPendingRequestItems(
	items: ComposerRunTimelineItem[],
	sessionId: string,
	pendingRequests: ComposerPendingRequest[],
	generatedAt: string,
): void {
	for (const request of pendingRequests) {
		const summary = compactSummary(
			request.actionDescription || request.summaryLabel || request.reason,
		);
		const platformOperation = platformOperationForPending(request);
		appendItem(items, {
			id: `pending:${request.id}`,
			sessionId,
			timestamp: normalizeTimestamp(request.createdAt, generatedAt),
			type: "wait.pending",
			title: pendingRequestTitle(request),
			visibility: "user",
			source: request.source,
			status: statusForPendingRequest(request),
			toolCallId: request.toolCallId,
			toolName: request.toolName,
			pendingRequestId: request.id,
			pendingRequestKind: request.kind,
			...(summary ? { summary } : {}),
			...(request.platform?.approvalRequestId
				? { approvalRequestId: request.platform.approvalRequestId }
				: {}),
			...(request.platform?.toolExecutionId
				? { toolExecutionId: request.platform.toolExecutionId }
				: {}),
			...(request.platform ? { platform: request.platform } : {}),
			...(platformOperation ? { platformOperation } : {}),
		});
	}
}

function addEntryItems(
	items: ComposerRunTimelineItem[],
	sessionId: string,
	entries: SessionEntry[],
	generatedAt: string,
	context: TimelineBuildContext,
): number {
	let messageEntryCount = 0;

	for (const [index, entry] of entries.entries()) {
		const timestamp = normalizeTimestamp(
			(entry as { timestamp?: unknown }).timestamp,
			generatedAt,
		);

		switch (entry.type) {
			case "session": {
				appendItem(items, {
					id: `session-started:${entry.id}`,
					sessionId,
					timestamp,
					type: "session.started",
					title: "Session started",
					visibility: "user",
					source: "local",
					status: "info",
					...(entry.cwd ? { metadata: { cwd: entry.cwd } } : {}),
				});
				break;
			}
			case "session_meta": {
				const summary = compactSummary(
					entry.title || entry.resumeSummary || entry.summary,
				);
				appendItem(items, {
					id: `session-updated:${index}`,
					sessionId,
					timestamp,
					type: "session.updated",
					title: "Session metadata updated",
					visibility: "admin",
					source: "local",
					status: "info",
					...(summary ? { summary } : {}),
				});
				break;
			}
			case "message": {
				messageEntryCount += 1;
				addMessageItems(items, sessionId, entry.message, {
					baseId: entry.id,
					timestamp,
					source: "local",
					context,
				});
				break;
			}
			case "compaction": {
				const summary = compactSummary(entry.summary);
				appendItem(items, {
					id: `compaction:${entry.id}`,
					sessionId,
					timestamp,
					type: "compaction.created",
					title: "Context compacted",
					visibility: "admin",
					source: "local",
					status: "info",
					...(summary ? { summary } : {}),
					metadata: {
						tokensBefore: entry.tokensBefore,
						auto: entry.auto === true,
						fromHook: entry.fromHook === true,
					},
				});
				break;
			}
			case "branch_summary": {
				const summary = compactSummary(entry.summary);
				appendItem(items, {
					id: `branch:${entry.id}`,
					sessionId,
					timestamp,
					type: "branch.created",
					title: "Branch summary created",
					visibility: "admin",
					source: "local",
					status: "info",
					...(summary ? { summary } : {}),
					metadata: { fromId: entry.fromId },
				});
				break;
			}
			case "model_change": {
				const summary = compactSummary(entry.model);
				appendItem(items, {
					id: `model-change:${entry.id}`,
					sessionId,
					timestamp,
					type: "model.changed",
					title: "Model changed",
					visibility: "admin",
					source: "local",
					status: "info",
					...(summary ? { summary } : {}),
				});
				break;
			}
			case "thinking_level_change": {
				const summary = compactSummary(entry.thinkingLevel);
				appendItem(items, {
					id: `thinking-change:${entry.id}`,
					sessionId,
					timestamp,
					type: "thinking.changed",
					title: "Thinking level changed",
					visibility: "admin",
					source: "local",
					status: "info",
					...(summary ? { summary } : {}),
				});
				break;
			}
			case "custom_message": {
				if (!entry.display) break;
				const summary = compactSummary(textFromContent(entry.content));
				appendItem(items, {
					id: `custom-message:${entry.id}`,
					sessionId,
					timestamp,
					type: "custom.event",
					title: entry.customType,
					visibility: "admin",
					source: "local",
					status: "info",
					...(summary ? { summary } : {}),
				});
				break;
			}
			case "custom": {
				appendItem(items, {
					id: `custom:${entry.id}`,
					sessionId,
					timestamp,
					type: "custom.event",
					title: entry.customType,
					visibility: "audit",
					source: "local",
					status: "info",
				});
				break;
			}
		}
	}

	return messageEntryCount;
}

function sortItems(
	items: ComposerRunTimelineItem[],
): ComposerRunTimelineItem[] {
	return [...items].sort((a, b) => {
		const timestampDelta =
			new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
		if (timestampDelta !== 0) return timestampDelta;
		return a.id.localeCompare(b.id);
	});
}

export function buildComposerRunTimeline(
	options: BuildComposerRunTimelineOptions,
): ComposerRunTimelineResponse {
	const generatedAt = options.generatedAt ?? new Date().toISOString();
	const items: ComposerRunTimelineItem[] = [];
	const entries = options.entries ?? [];
	const messages = options.messages ?? [];
	const pendingRequests = options.pendingRequests ?? [];
	const context: TimelineBuildContext = {
		toolRequests: new Map<string, TimelineToolRequest>(),
	};

	const messageEntryCount = addEntryItems(
		items,
		options.sessionId,
		entries,
		generatedAt,
		context,
	);

	if (messageEntryCount === 0) {
		for (const [index, message] of messages.entries()) {
			addMessageItems(items, options.sessionId, message, {
				baseId: `fallback-${index}`,
				timestamp: normalizeTimestamp(
					(message as { timestamp?: unknown }).timestamp,
					generatedAt,
				),
				source: "local",
				context,
			});
		}
	}

	addPendingRequestItems(
		items,
		options.sessionId,
		pendingRequests,
		generatedAt,
	);

	return {
		sessionId: options.sessionId,
		source: "local",
		generatedAt,
		platformBacked: false,
		pendingRequestCount: pendingRequests.length,
		items: sortItems(items),
	};
}
