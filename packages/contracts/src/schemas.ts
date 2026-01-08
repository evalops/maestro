import { Type } from "@sinclair/typebox";

export const ComposerRoleSchema = Type.Union([
	Type.Literal("user"),
	Type.Literal("assistant"),
	Type.Literal("system"),
	Type.Literal("tool"),
]);

export const ComposerTextContentSchema = Type.Object({
	type: Type.Literal("text"),
	text: Type.String(),
	textSignature: Type.Optional(Type.String()),
});

export const ComposerImageContentSchema = Type.Object({
	type: Type.Literal("image"),
	data: Type.String(),
	mimeType: Type.String(),
});

export const ComposerThinkingContentSchema = Type.Object({
	type: Type.Literal("thinking"),
	thinking: Type.String(),
	thinkingSignature: Type.Optional(Type.String()),
});

export const ComposerToolCallContentSchema = Type.Object({
	type: Type.Literal("toolCall"),
	id: Type.String(),
	name: Type.String(),
	arguments: Type.Record(Type.String(), Type.Unknown()),
	thoughtSignature: Type.Optional(Type.String()),
});

export const ComposerContentBlockSchema = Type.Union([
	ComposerTextContentSchema,
	ComposerImageContentSchema,
	ComposerThinkingContentSchema,
	ComposerToolCallContentSchema,
]);

export const ComposerThinkingLevelSchema = Type.Union([
	Type.Literal("off"),
	Type.Literal("minimal"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
]);

export const ComposerToolCallSchema = Type.Object({
	name: Type.String(),
	status: Type.Union([
		Type.Literal("pending"),
		Type.Literal("running"),
		Type.Literal("completed"),
		Type.Literal("error"),
	]),
	args: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	result: Type.Optional(Type.Unknown()),
	toolCallId: Type.Optional(Type.String()),
});

export const ComposerAttachmentSchema = Type.Object({
	id: Type.String(),
	type: Type.Union([Type.Literal("image"), Type.Literal("document")]),
	fileName: Type.String(),
	mimeType: Type.String(),
	size: Type.Number(),
	content: Type.Optional(Type.String()),
	contentOmitted: Type.Optional(Type.Boolean()),
	extractedText: Type.Optional(Type.String()),
	preview: Type.Optional(Type.String()),
});

export const ComposerUsageCostSchema = Type.Object({
	input: Type.Number(),
	output: Type.Number(),
	cacheRead: Type.Optional(Type.Number()),
	cacheWrite: Type.Optional(Type.Number()),
	total: Type.Optional(Type.Number()),
});

export const ComposerUsageSchema = Type.Object({
	input: Type.Number(),
	output: Type.Number(),
	cacheRead: Type.Optional(Type.Number()),
	cacheWrite: Type.Optional(Type.Number()),
	cost: Type.Optional(ComposerUsageCostSchema),
});

export const ComposerMessageSchema = Type.Object({
	role: ComposerRoleSchema,
	content: Type.Union([Type.String(), Type.Array(ComposerContentBlockSchema)]),
	attachments: Type.Optional(Type.Array(ComposerAttachmentSchema)),
	timestamp: Type.Optional(Type.String()),
	thinking: Type.Optional(Type.String()),
	tools: Type.Optional(Type.Array(ComposerToolCallSchema)),
	toolName: Type.Optional(Type.String()),
	isError: Type.Optional(Type.Boolean()),
	usage: Type.Optional(ComposerUsageSchema),
});

export const ComposerChatRequestSchema = Type.Object({
	model: Type.Optional(Type.String()),
	messages: Type.Array(ComposerMessageSchema),
	thinkingLevel: Type.Optional(ComposerThinkingLevelSchema),
	sessionId: Type.Optional(Type.String()),
	stream: Type.Optional(Type.Boolean()),
});

export const ComposerModelSetSchema = Type.Object({
	model: Type.String({ minLength: 1 }),
});

export const ComposerModelCapabilitiesSchema = Type.Object({
	streaming: Type.Optional(Type.Boolean()),
	tools: Type.Optional(Type.Boolean()),
	vision: Type.Optional(Type.Boolean()),
	reasoning: Type.Optional(Type.Boolean()),
});

export const ComposerModelSchema = Type.Object({
	id: Type.String(),
	provider: Type.String(),
	name: Type.String(),
	api: Type.Optional(Type.String()),
	contextWindow: Type.Optional(Type.Number()),
	maxOutputTokens: Type.Optional(Type.Number()),
	maxTokens: Type.Optional(Type.Number()),
	reasoning: Type.Optional(Type.Boolean()),
	cost: Type.Optional(ComposerUsageCostSchema),
	capabilities: Type.Optional(ComposerModelCapabilitiesSchema),
});

export const ComposerModelListResponseSchema = Type.Object({
	models: Type.Array(ComposerModelSchema),
});

export const ComposerSessionSummarySchema = Type.Object({
	id: Type.String(),
	title: Type.Optional(Type.String()),
	createdAt: Type.String(),
	updatedAt: Type.String(),
	messageCount: Type.Number(),
	favorite: Type.Optional(Type.Boolean()),
	tags: Type.Optional(Type.Array(Type.String())),
});

export const ComposerSessionSchema = Type.Object({
	id: Type.String(),
	title: Type.Optional(Type.String()),
	createdAt: Type.String(),
	updatedAt: Type.String(),
	messageCount: Type.Number(),
	favorite: Type.Optional(Type.Boolean()),
	tags: Type.Optional(Type.Array(Type.String())),
	messages: Type.Array(ComposerMessageSchema),
});

export const ComposerAssistantMessageEventSchema = Type.Union([
	Type.Object({
		type: Type.Literal("start"),
		partial: ComposerMessageSchema,
	}),
	Type.Object({
		type: Type.Literal("text_start"),
		contentIndex: Type.Number(),
		partial: ComposerMessageSchema,
	}),
	Type.Object({
		type: Type.Literal("text_delta"),
		contentIndex: Type.Number(),
		delta: Type.String(),
		partial: ComposerMessageSchema,
	}),
	Type.Object({
		type: Type.Literal("text_end"),
		contentIndex: Type.Number(),
		content: Type.String(),
		partial: ComposerMessageSchema,
	}),
	Type.Object({
		type: Type.Literal("thinking_start"),
		contentIndex: Type.Number(),
		partial: ComposerMessageSchema,
	}),
	Type.Object({
		type: Type.Literal("thinking_delta"),
		contentIndex: Type.Number(),
		delta: Type.String(),
		partial: ComposerMessageSchema,
	}),
	Type.Object({
		type: Type.Literal("thinking_end"),
		contentIndex: Type.Number(),
		content: Type.String(),
		partial: ComposerMessageSchema,
	}),
	Type.Object({
		type: Type.Literal("toolcall_start"),
		contentIndex: Type.Number(),
		partial: ComposerMessageSchema,
	}),
	Type.Object({
		type: Type.Literal("toolcall_delta"),
		contentIndex: Type.Number(),
		delta: Type.String(),
		partial: ComposerMessageSchema,
	}),
	Type.Object({
		type: Type.Literal("toolcall_end"),
		contentIndex: Type.Number(),
		toolCall: ComposerToolCallContentSchema,
		partial: ComposerMessageSchema,
	}),
	Type.Object({
		type: Type.Literal("done"),
		reason: Type.Union([
			Type.Literal("stop"),
			Type.Literal("length"),
			Type.Literal("toolUse"),
		]),
		message: ComposerMessageSchema,
	}),
	Type.Object({
		type: Type.Literal("error"),
		reason: Type.Union([Type.Literal("aborted"), Type.Literal("error")]),
		error: ComposerMessageSchema,
	}),
]);

export const ComposerActionApprovalRequestSchema = Type.Object({
	id: Type.String(),
	toolName: Type.String(),
	args: Type.Unknown(),
	reason: Type.String(),
});

export const ComposerActionApprovalDecisionSchema = Type.Object({
	approved: Type.Boolean(),
	reason: Type.Optional(Type.String()),
	resolvedBy: Type.Union([Type.Literal("policy"), Type.Literal("user")]),
});

export const ComposerAgentEventSchema = Type.Union([
	Type.Object({ type: Type.Literal("agent_start") }),
	Type.Object({
		type: Type.Literal("agent_end"),
		messages: Type.Array(ComposerMessageSchema),
		aborted: Type.Optional(Type.Boolean()),
		partialAccepted: Type.Optional(ComposerMessageSchema),
		stopReason: Type.Optional(
			Type.Union([
				Type.Literal("stop"),
				Type.Literal("length"),
				Type.Literal("toolUse"),
				Type.Literal("error"),
				Type.Literal("aborted"),
			]),
		),
	}),
	Type.Object({
		type: Type.Literal("status"),
		status: Type.String(),
		details: Type.Record(Type.String(), Type.Unknown()),
	}),
	Type.Object({ type: Type.Literal("error"), message: Type.String() }),
	Type.Object({ type: Type.Literal("turn_start") }),
	Type.Object({
		type: Type.Literal("turn_end"),
		message: ComposerMessageSchema,
		toolResults: Type.Array(ComposerMessageSchema),
	}),
	Type.Object({
		type: Type.Literal("message_start"),
		message: ComposerMessageSchema,
	}),
	Type.Object({
		type: Type.Literal("message_update"),
		message: ComposerMessageSchema,
		assistantMessageEvent: ComposerAssistantMessageEventSchema,
	}),
	Type.Object({
		type: Type.Literal("message_end"),
		message: ComposerMessageSchema,
	}),
	Type.Object({
		type: Type.Literal("tool_execution_start"),
		toolCallId: Type.String(),
		toolName: Type.String(),
		args: Type.Record(Type.String(), Type.Unknown()),
	}),
	Type.Object({
		type: Type.Literal("tool_execution_update"),
		toolCallId: Type.String(),
		toolName: Type.String(),
		args: Type.Record(Type.String(), Type.Unknown()),
		partialResult: Type.Unknown(),
	}),
	Type.Object({
		type: Type.Literal("tool_execution_end"),
		toolCallId: Type.String(),
		toolName: Type.String(),
		result: Type.Unknown(),
		isError: Type.Boolean(),
	}),
	Type.Object({
		type: Type.Literal("action_approval_required"),
		request: ComposerActionApprovalRequestSchema,
	}),
	Type.Object({
		type: Type.Literal("action_approval_resolved"),
		request: ComposerActionApprovalRequestSchema,
		decision: ComposerActionApprovalDecisionSchema,
	}),
	Type.Object({
		type: Type.Literal("client_tool_request"),
		toolCallId: Type.String(),
		toolName: Type.String(),
		args: Type.Unknown(),
	}),
	Type.Object({
		type: Type.Literal("compaction"),
		summary: Type.String(),
		firstKeptEntryIndex: Type.Number(),
		tokensBefore: Type.Number(),
		auto: Type.Optional(Type.Boolean()),
		customInstructions: Type.Optional(Type.String()),
		timestamp: Type.String(),
	}),
	Type.Object({
		type: Type.Literal("auto_retry_start"),
		attempt: Type.Number(),
		maxAttempts: Type.Number(),
		delayMs: Type.Number(),
		errorMessage: Type.String(),
	}),
	Type.Object({
		type: Type.Literal("auto_retry_end"),
		success: Type.Boolean(),
		attempt: Type.Number(),
		finalError: Type.Optional(Type.String()),
	}),
	Type.Object({
		type: Type.Literal("session_update"),
		sessionId: Type.String(),
	}),
	Type.Object({ type: Type.Literal("heartbeat") }),
	Type.Object({ type: Type.Literal("aborted") }),
]);

export const ComposerSessionListResponseSchema = Type.Object({
	sessions: Type.Array(ComposerSessionSummarySchema),
});

export const ComposerSessionUpdateEventSchema = Type.Object({
	type: Type.Literal("session_update"),
	sessionId: Type.String(),
});

export const ComposerBackgroundTaskLimitBreachSchema = Type.Object({
	kind: Type.Union([Type.Literal("memory"), Type.Literal("cpu")]),
	limit: Type.Number(),
	actual: Type.Number(),
});

export const ComposerBackgroundTaskHistoryEntrySchema = Type.Object({
	event: Type.Union([
		Type.Literal("started"),
		Type.Literal("restarted"),
		Type.Literal("exited"),
		Type.Literal("failed"),
		Type.Literal("stopped"),
	]),
	taskId: Type.String(),
	status: Type.String(),
	command: Type.String(),
	timestamp: Type.String(),
	restartAttempts: Type.Number(),
	failureReason: Type.Optional(Type.String()),
	limitBreach: Type.Optional(ComposerBackgroundTaskLimitBreachSchema),
});

export const ComposerBackgroundTaskHealthEntrySchema = Type.Object({
	id: Type.String(),
	status: Type.String(),
	summary: Type.String(),
	command: Type.String(),
	restarts: Type.Optional(Type.String()),
	issues: Type.Array(Type.String()),
	lastLogLine: Type.Optional(Type.String()),
	logTruncated: Type.Optional(Type.Boolean()),
	durationSeconds: Type.Number(),
});

export const ComposerBackgroundTaskHealthSchema = Type.Object({
	total: Type.Number(),
	running: Type.Number(),
	restarting: Type.Number(),
	failed: Type.Number(),
	entries: Type.Array(ComposerBackgroundTaskHealthEntrySchema),
	truncated: Type.Boolean(),
	notificationsEnabled: Type.Boolean(),
	detailsRedacted: Type.Boolean(),
	history: Type.Array(ComposerBackgroundTaskHistoryEntrySchema),
	historyTruncated: Type.Boolean(),
});

export const ComposerStatusResponseSchema = Type.Object({
	cwd: Type.String(),
	git: Type.Union([
		Type.Object({
			branch: Type.String(),
			status: Type.Object({
				modified: Type.Number(),
				added: Type.Number(),
				deleted: Type.Number(),
				untracked: Type.Number(),
				total: Type.Number(),
			}),
		}),
		Type.Null(),
	]),
	context: Type.Object({
		agentMd: Type.Boolean(),
		claudeMd: Type.Boolean(),
	}),
	server: Type.Object({
		uptime: Type.Number(),
		version: Type.String(),
		staticCacheMaxAgeSeconds: Type.Optional(Type.Number()),
	}),
	database: Type.Object({
		configured: Type.Boolean(),
		connected: Type.Boolean(),
	}),
	backgroundTasks: Type.Union([
		ComposerBackgroundTaskHealthSchema,
		Type.Null(),
	]),
	hooks: Type.Object({
		asyncInFlight: Type.Number(),
		concurrency: Type.Object({
			max: Type.Number(),
			active: Type.Number(),
			queued: Type.Number(),
		}),
	}),
	lastUpdated: Type.Number(),
	lastLatencyMs: Type.Number(),
});

export const ComposerUsageTokenTotalsSchema = Type.Object({
	input: Type.Number(),
	output: Type.Number(),
	cacheRead: Type.Number(),
	cacheWrite: Type.Number(),
	total: Type.Number(),
});

export const ComposerUsageBreakdownSchema = Type.Object({
	cost: Type.Number(),
	requests: Type.Number(),
	tokens: Type.Number(),
	tokensDetailed: ComposerUsageTokenTotalsSchema,
	calls: Type.Number(),
	cachedTokens: Type.Number(),
});

export const ComposerUsageSummarySchema = Type.Object({
	totalCost: Type.Number(),
	totalRequests: Type.Number(),
	totalTokens: Type.Number(),
	tokensDetailed: ComposerUsageTokenTotalsSchema,
	totalTokensDetailed: ComposerUsageTokenTotalsSchema,
	totalTokensBreakdown: ComposerUsageTokenTotalsSchema,
	totalCachedTokens: Type.Number(),
	byProvider: Type.Record(Type.String(), ComposerUsageBreakdownSchema),
	byModel: Type.Record(Type.String(), ComposerUsageBreakdownSchema),
});

export const ComposerUsageResponseSchema = Type.Object({
	summary: ComposerUsageSummarySchema,
	hasData: Type.Boolean(),
});

export const ComposerErrorSeveritySchema = Type.Union([
	Type.Literal("error"),
	Type.Literal("warning"),
	Type.Literal("info"),
]);

export const ComposerErrorCategorySchema = Type.Union([
	Type.Literal("validation"),
	Type.Literal("permission"),
	Type.Literal("network"),
	Type.Literal("timeout"),
	Type.Literal("filesystem"),
	Type.Literal("tool"),
	Type.Literal("session"),
	Type.Literal("config"),
	Type.Literal("api"),
	Type.Literal("internal"),
]);

export const ComposerErrorPayloadSchema = Type.Object({
	code: Type.String(),
	category: ComposerErrorCategorySchema,
	severity: Type.Optional(ComposerErrorSeveritySchema),
	retriable: Type.Optional(Type.Boolean()),
	context: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

export const ComposerErrorResponseSchema = Type.Object({
	error: Type.String(),
	code: Type.Optional(Type.String()),
	details: Type.Optional(
		Type.Array(Type.Record(Type.String(), Type.Unknown())),
	),
	composer: Type.Optional(ComposerErrorPayloadSchema),
});
