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
	provider: Type.Optional(Type.String()),
	api: Type.Optional(Type.String()),
	model: Type.Optional(Type.String()),
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

export const ComposerCommandArgSchema = Type.Object({
	name: Type.String(),
	required: Type.Optional(Type.Boolean()),
});

export const ComposerCommandSchema = Type.Object({
	name: Type.String(),
	description: Type.Optional(Type.String()),
	prompt: Type.String(),
	args: Type.Optional(Type.Array(ComposerCommandArgSchema)),
});

export const ComposerCommandListResponseSchema = Type.Object({
	commands: Type.Array(ComposerCommandSchema),
});

export const ComposerCommandPrefsSchema = Type.Object({
	favorites: Type.Array(Type.String()),
	recents: Type.Array(Type.String()),
});

export const ComposerCommandPrefsUpdateSchema = Type.Object({
	favorites: Type.Optional(Type.Array(Type.String())),
	recents: Type.Optional(Type.Array(Type.String())),
});

export const ComposerCommandPrefsWriteResponseSchema = Type.Object({
	ok: Type.Boolean(),
});

export const ComposerConfigWriteRequestSchema = Type.Object({
	config: Type.Record(Type.String(), Type.Unknown()),
});

export const ComposerConfigResponseSchema = Type.Object({
	config: Type.Record(Type.String(), Type.Unknown()),
	configPath: Type.String(),
});

export const ComposerConfigWriteResponseSchema = Type.Object({
	success: Type.Boolean(),
});

export const ComposerFilesResponseSchema = Type.Object({
	files: Type.Array(Type.String()),
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
		partial: Type.Optional(ComposerMessageSchema),
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
		partial: Type.Optional(ComposerMessageSchema),
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
		partial: Type.Optional(ComposerMessageSchema),
		toolCallId: Type.Optional(Type.String()),
		toolCallName: Type.Optional(Type.String()),
		toolCallArgs: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		toolCallArgsTruncated: Type.Optional(Type.Boolean()),
	}),
	Type.Object({
		type: Type.Literal("toolcall_delta"),
		contentIndex: Type.Number(),
		delta: Type.String(),
		partial: Type.Optional(ComposerMessageSchema),
		toolCallId: Type.Optional(Type.String()),
		toolCallName: Type.Optional(Type.String()),
		toolCallArgs: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		toolCallArgsTruncated: Type.Optional(Type.Boolean()),
	}),
	Type.Object({
		type: Type.Literal("toolcall_end"),
		contentIndex: Type.Number(),
		toolCall: ComposerToolCallContentSchema,
		partial: Type.Optional(ComposerMessageSchema),
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
	displayName: Type.Optional(Type.String()),
	summaryLabel: Type.Optional(Type.String()),
	actionDescription: Type.Optional(Type.String()),
	args: Type.Unknown(),
	reason: Type.String(),
});

export const ComposerActionApprovalDecisionSchema = Type.Object({
	approved: Type.Boolean(),
	reason: Type.Optional(Type.String()),
	resolvedBy: Type.Union([Type.Literal("policy"), Type.Literal("user")]),
});

export const ComposerPendingClientToolRequestSchema = Type.Object({
	toolCallId: Type.String(),
	toolName: Type.String(),
	args: Type.Unknown(),
	kind: Type.Optional(
		Type.Union([Type.Literal("client_tool"), Type.Literal("user_input")]),
	),
	reason: Type.Optional(Type.String()),
});

export const ComposerToolRetryRequestSchema = Type.Object({
	id: Type.String(),
	toolCallId: Type.String(),
	toolName: Type.String(),
	args: Type.Unknown(),
	errorMessage: Type.String(),
	attempt: Type.Number(),
	maxAttempts: Type.Optional(Type.Number()),
	summary: Type.Optional(Type.String()),
});

export const ComposerToolRetryDecisionSchema = Type.Object({
	action: Type.Union([
		Type.Literal("retry"),
		Type.Literal("skip"),
		Type.Literal("abort"),
	]),
	reason: Type.Optional(Type.String()),
	resolvedBy: Type.Union([
		Type.Literal("policy"),
		Type.Literal("user"),
		Type.Literal("runtime"),
	]),
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
	pendingApprovalRequests: Type.Optional(
		Type.Array(ComposerActionApprovalRequestSchema),
	),
	pendingClientToolRequests: Type.Optional(
		Type.Array(ComposerPendingClientToolRequestSchema),
	),
	pendingToolRetryRequests: Type.Optional(
		Type.Array(ComposerToolRetryRequestSchema),
	),
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
		message: Type.Optional(ComposerMessageSchema),
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
		displayName: Type.Optional(Type.String()),
		summaryLabel: Type.Optional(Type.String()),
		args: Type.Record(Type.String(), Type.Unknown()),
	}),
	Type.Object({
		type: Type.Literal("tool_execution_update"),
		toolCallId: Type.String(),
		toolName: Type.String(),
		displayName: Type.Optional(Type.String()),
		summaryLabel: Type.Optional(Type.String()),
		args: Type.Record(Type.String(), Type.Unknown()),
		partialResult: Type.Unknown(),
	}),
	Type.Object({
		type: Type.Literal("tool_execution_end"),
		toolCallId: Type.String(),
		toolName: Type.String(),
		displayName: Type.Optional(Type.String()),
		summaryLabel: Type.Optional(Type.String()),
		result: Type.Unknown(),
		isError: Type.Boolean(),
	}),
	Type.Object({
		type: Type.Literal("tool_batch_summary"),
		summary: Type.String(),
		summaryLabels: Type.Array(Type.String()),
		toolCallIds: Type.Array(Type.String()),
		toolNames: Type.Array(Type.String()),
		callsSucceeded: Type.Number(),
		callsFailed: Type.Number(),
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
		type: Type.Literal("tool_retry_required"),
		request: ComposerToolRetryRequestSchema,
	}),
	Type.Object({
		type: Type.Literal("tool_retry_resolved"),
		request: ComposerToolRetryRequestSchema,
		decision: ComposerToolRetryDecisionSchema,
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
	Type.Object({ type: Type.Literal("done") }),
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

export const ComposerGuardianTargetSchema = Type.Union([
	Type.Literal("staged"),
	Type.Literal("all"),
]);

export const ComposerGuardianStatusSchema = Type.Union([
	Type.Literal("passed"),
	Type.Literal("failed"),
	Type.Literal("skipped"),
	Type.Literal("error"),
]);

export const ComposerGuardianToolResultSchema = Type.Object({
	tool: Type.String(),
	exitCode: Type.Number(),
	stdout: Type.String(),
	stderr: Type.String(),
	durationMs: Type.Number(),
	skipped: Type.Optional(Type.Boolean()),
	reason: Type.Optional(Type.String()),
});

export const ComposerGuardianRunResultSchema = Type.Object({
	status: ComposerGuardianStatusSchema,
	exitCode: Type.Number(),
	startedAt: Type.Number(),
	durationMs: Type.Number(),
	target: ComposerGuardianTargetSchema,
	trigger: Type.Optional(Type.String()),
	filesScanned: Type.Number(),
	files: Type.Optional(Type.Array(Type.String())),
	summary: Type.String(),
	skipReason: Type.Optional(Type.String()),
	toolResults: Type.Array(ComposerGuardianToolResultSchema),
});

export const ComposerGuardianStateSchema = Type.Object({
	enabled: Type.Boolean(),
	lastRun: Type.Optional(ComposerGuardianRunResultSchema),
});

export const ComposerGuardianStatusResponseSchema = Type.Object({
	enabled: Type.Boolean(),
	state: ComposerGuardianStateSchema,
});

export const ComposerGuardianRunResponseSchema =
	ComposerGuardianRunResultSchema;

export const ComposerGuardianConfigRequestSchema = Type.Object({
	enabled: Type.Boolean(),
});

export const ComposerGuardianConfigResponseSchema = Type.Object({
	success: Type.Boolean(),
	enabled: Type.Boolean(),
});

export const ComposerPlanModeStateSchema = Type.Object({
	active: Type.Boolean(),
	filePath: Type.String(),
	sessionId: Type.Optional(Type.String()),
	gitBranch: Type.Optional(Type.String()),
	gitCommitSha: Type.Optional(Type.String()),
	createdAt: Type.String(),
	updatedAt: Type.String(),
	name: Type.Optional(Type.String()),
});

export const ComposerPlanStatusResponseSchema = Type.Object({
	state: Type.Union([ComposerPlanModeStateSchema, Type.Null()]),
	content: Type.Union([Type.String(), Type.Null()]),
});

export const ComposerPlanEnterRequestSchema = Type.Object({
	action: Type.Literal("enter"),
	name: Type.Optional(Type.String()),
	sessionId: Type.Optional(Type.String()),
});

export const ComposerPlanExitRequestSchema = Type.Object({
	action: Type.Literal("exit"),
});

export const ComposerPlanUpdateRequestSchema = Type.Object({
	action: Type.Literal("update"),
	content: Type.String(),
});

export const ComposerPlanRequestSchema = Type.Union([
	ComposerPlanEnterRequestSchema,
	ComposerPlanExitRequestSchema,
	ComposerPlanUpdateRequestSchema,
]);

export const ComposerPlanActionResponseSchema = Type.Union([
	Type.Object({
		success: Type.Boolean(),
		state: ComposerPlanModeStateSchema,
	}),
	Type.Object({
		success: Type.Boolean(),
	}),
]);

export const ComposerBackgroundSettingsSchema = Type.Object({
	notificationsEnabled: Type.Boolean(),
	statusDetailsEnabled: Type.Boolean(),
});

export const ComposerBackgroundStatusSnapshotSchema = Type.Object({
	running: Type.Number(),
	total: Type.Number(),
	failed: Type.Number(),
	detailsRedacted: Type.Boolean(),
});

export const ComposerBackgroundStatusResponseSchema = Type.Object({
	settings: ComposerBackgroundSettingsSchema,
	snapshot: Type.Union([ComposerBackgroundStatusSnapshotSchema, Type.Null()]),
});

export const ComposerBackgroundHistoryEntrySchema = Type.Object({
	timestamp: Type.String(),
	event: Type.Union([
		Type.Literal("started"),
		Type.Literal("restarted"),
		Type.Literal("exited"),
		Type.Literal("failed"),
		Type.Literal("stopped"),
	]),
	taskId: Type.String(),
	command: Type.String(),
	failureReason: Type.Optional(Type.String()),
	limitBreach: Type.Optional(ComposerBackgroundTaskLimitBreachSchema),
});

export const ComposerBackgroundHistoryResponseSchema = Type.Object({
	history: Type.Array(ComposerBackgroundHistoryEntrySchema),
	truncated: Type.Boolean(),
});

export const ComposerBackgroundPathResponseSchema = Type.Object({
	path: Type.String(),
	exists: Type.Boolean(),
	overridden: Type.Boolean(),
});

export const ComposerBackgroundUpdateRequestSchema = Type.Object({
	enabled: Type.Boolean(),
});

export const ComposerBackgroundUpdateResponseSchema = Type.Object({
	success: Type.Boolean(),
	message: Type.String(),
});

export const ComposerApprovalModeSchema = Type.Union([
	Type.Literal("auto"),
	Type.Literal("prompt"),
	Type.Literal("fail"),
]);

export const ComposerApprovalsStatusResponseSchema = Type.Object({
	mode: ComposerApprovalModeSchema,
	availableModes: Type.Array(ComposerApprovalModeSchema),
});

export const ComposerApprovalsUpdateRequestSchema = Type.Object({
	mode: ComposerApprovalModeSchema,
	sessionId: Type.Optional(Type.String()),
});

export const ComposerApprovalsUpdateResponseSchema = Type.Object({
	success: Type.Boolean(),
	mode: ComposerApprovalModeSchema,
	message: Type.String(),
});

export const ComposerFrameworkScopeSchema = Type.Union([
	Type.Literal("user"),
	Type.Literal("workspace"),
]);

export const ComposerFrameworkStatusResponseSchema = Type.Object({
	framework: Type.String(),
	source: Type.String(),
	locked: Type.Boolean(),
	scope: ComposerFrameworkScopeSchema,
});

export const ComposerFrameworkListEntrySchema = Type.Object({
	id: Type.String(),
	summary: Type.String(),
});

export const ComposerFrameworkListResponseSchema = Type.Object({
	frameworks: Type.Array(ComposerFrameworkListEntrySchema),
});

export const ComposerFrameworkUpdateRequestSchema = Type.Object({
	framework: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	scope: Type.Optional(ComposerFrameworkScopeSchema),
});

export const ComposerFrameworkUpdateResponseSchema = Type.Object({
	success: Type.Boolean(),
	message: Type.String(),
	framework: Type.Union([Type.String(), Type.Null()]),
	summary: Type.Optional(Type.String()),
	scope: Type.Optional(ComposerFrameworkScopeSchema),
});

export const ComposerChangeTypeSchema = Type.Union([
	Type.Literal("create"),
	Type.Literal("modify"),
	Type.Literal("delete"),
]);

export const ComposerFileChangeSchema = Type.Object({
	id: Type.String(),
	type: ComposerChangeTypeSchema,
	path: Type.String(),
	before: Type.Union([Type.String(), Type.Null()]),
	after: Type.Union([Type.String(), Type.Null()]),
	toolName: Type.String(),
	toolCallId: Type.String(),
	timestamp: Type.Number(),
	isGitTracked: Type.Boolean(),
	messageId: Type.Optional(Type.String()),
});

export const ComposerUndoRestoreActionSchema = Type.Union([
	Type.Literal("restore"),
	Type.Literal("delete"),
	Type.Literal("recreate"),
]);

export const ComposerUndoPreviewSchema = Type.Object({
	changes: Type.Array(ComposerFileChangeSchema),
	restores: Type.Array(
		Type.Object({
			path: Type.String(),
			action: ComposerUndoRestoreActionSchema,
		}),
	),
	conflicts: Type.Array(
		Type.Object({
			path: Type.String(),
			reason: Type.String(),
		}),
	),
});

export const ComposerUndoCheckpointSchema = Type.Object({
	name: Type.String(),
	description: Type.Optional(Type.String()),
	changeCount: Type.Number(),
	timestamp: Type.Number(),
});

export const ComposerUndoStatusResponseSchema = Type.Object({
	totalChanges: Type.Number(),
	canUndo: Type.Boolean(),
	checkpoints: Type.Array(ComposerUndoCheckpointSchema),
});

export const ComposerUndoHistoryEntrySchema = Type.Object({
	description: Type.String(),
	fileCount: Type.Number(),
	timestamp: Type.Number(),
});

export const ComposerUndoHistoryResponseSchema = Type.Object({
	history: Type.Array(ComposerUndoHistoryEntrySchema),
});

export const ComposerUndoRequestSchema = Type.Object({
	action: Type.Optional(
		Type.Union([
			Type.Literal("undo"),
			Type.Literal("checkpoint"),
			Type.Literal("restore"),
		]),
	),
	count: Type.Optional(Type.Number()),
	preview: Type.Optional(Type.Boolean()),
	force: Type.Optional(Type.Boolean()),
	name: Type.Optional(Type.String()),
	description: Type.Optional(Type.String()),
});

export const ComposerUndoPreviewMessageSchema = Type.Object({
	message: Type.String(),
	fileCount: Type.Optional(Type.Number()),
	description: Type.Optional(Type.String()),
});

export const ComposerUndoPreviewResponseSchema = Type.Object({
	preview: Type.Union([
		ComposerUndoPreviewSchema,
		ComposerUndoPreviewMessageSchema,
	]),
});

export const ComposerUndoCheckpointSaveResponseSchema = Type.Object({
	success: Type.Boolean(),
	checkpoint: Type.Object({
		name: Type.String(),
		changeCount: Type.Number(),
		timestamp: Type.Number(),
	}),
});

export const ComposerUndoCheckpointListResponseSchema = Type.Object({
	checkpoints: Type.Array(ComposerUndoCheckpointSchema),
});

export const ComposerUndoOperationResponseSchema = Type.Union([
	Type.Object({
		success: Type.Boolean(),
		undone: Type.Number(),
		errors: Type.Array(Type.String()),
	}),
	Type.Object({
		success: Type.Boolean(),
		message: Type.String(),
		files: Type.Optional(Type.Array(Type.String())),
	}),
	Type.Object({
		message: Type.String(),
	}),
	ComposerUndoPreviewResponseSchema,
	ComposerUndoCheckpointSaveResponseSchema,
	ComposerUndoCheckpointListResponseSchema,
]);

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
	maestro: Type.Optional(ComposerErrorPayloadSchema),
});
