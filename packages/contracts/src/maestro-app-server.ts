import { type Static, Type } from "@sinclair/typebox";
import { stringLiteralUnion } from "./typebox-utils.js";

export const maestroAppServerProtocolVersion = "maestro-app-server.v1" as const;

export const maestroAppServerClientMethods = [
	"initialize",
	"model/list",
	"modelProvider/capabilities/read",
	"thread/list",
	"thread/read",
	"thread/metadata/update",
	"thread/name/set",
	"thread/goal/get",
	"thread/goal/set",
	"thread/goal/clear",
	"thread/turns/list",
] as const;
export type MaestroAppServerClientMethod =
	(typeof maestroAppServerClientMethods)[number];

export const maestroAppServerThreadStatuses = [
	"notLoaded",
	"loaded",
	"running",
	"interrupted",
	"completed",
] as const;
export type MaestroAppServerThreadStatus =
	(typeof maestroAppServerThreadStatuses)[number];

export const maestroAppServerTurnStatuses = [
	"completed",
	"running",
	"interrupted",
	"failed",
] as const;
export type MaestroAppServerTurnStatus =
	(typeof maestroAppServerTurnStatuses)[number];

export const MaestroAppServerJsonRpcIdSchema = Type.Union([
	Type.String(),
	Type.Number(),
]);
const MaestroAppServerJsonRpcResponseIdSchema = Type.Union([
	MaestroAppServerJsonRpcIdSchema,
	Type.Null(),
]);

export const MaestroAppServerClientRequestSchema = Type.Object({
	jsonrpc: Type.Literal("2.0"),
	id: MaestroAppServerJsonRpcIdSchema,
	method: Type.String(),
	params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});
export type MaestroAppServerClientRequest = Static<
	typeof MaestroAppServerClientRequestSchema
>;

export const MaestroAppServerCapabilitiesSchema = Type.Object({
	sessions: Type.Boolean(),
	modelList: Type.Boolean(),
	modelProviderCapabilities: Type.Boolean(),
	threadList: Type.Boolean(),
	threadRead: Type.Boolean(),
	threadMetadataUpdate: Type.Boolean(),
	threadNameSet: Type.Boolean(),
	threadGoals: Type.Boolean(),
	turnsList: Type.Boolean(),
});
export type MaestroAppServerCapabilities = Static<
	typeof MaestroAppServerCapabilitiesSchema
>;

export const MaestroAppServerInitializeResultSchema = Type.Object({
	protocolVersion: Type.Literal(maestroAppServerProtocolVersion),
	serverInfo: Type.Object({
		name: Type.String(),
		version: Type.Optional(Type.String()),
	}),
	capabilities: MaestroAppServerCapabilitiesSchema,
});
export type MaestroAppServerInitializeResult = Static<
	typeof MaestroAppServerInitializeResultSchema
>;

export const MaestroAppServerThreadStatusSchema = stringLiteralUnion(
	maestroAppServerThreadStatuses,
);
export const MaestroAppServerTurnStatusSchema = stringLiteralUnion(
	maestroAppServerTurnStatuses,
);

export const MaestroAppServerThreadSummarySchema = Type.Object({
	id: Type.String(),
	source: Type.Literal("session"),
	status: MaestroAppServerThreadStatusSchema,
	title: Type.Optional(Type.String()),
	summary: Type.Optional(Type.String()),
	resumeSummary: Type.Optional(Type.String()),
	memoryExtractionHash: Type.Optional(Type.String()),
	subject: Type.Optional(Type.String()),
	path: Type.Optional(Type.String()),
	createdAt: Type.String(),
	updatedAt: Type.String(),
	messageCount: Type.Number(),
	favorite: Type.Boolean(),
	tags: Type.Optional(Type.Array(Type.String())),
});
export type MaestroAppServerThreadSummary = Static<
	typeof MaestroAppServerThreadSummarySchema
>;

export const MaestroAppServerThreadGoalStatuses = [
	"active",
	"complete",
	"cancelled",
] as const;
export const MaestroAppServerThreadGoalStatusSchema = stringLiteralUnion(
	MaestroAppServerThreadGoalStatuses,
);
export const MaestroAppServerThreadGoalSchema = Type.Object({
	objective: Type.String(),
	status: MaestroAppServerThreadGoalStatusSchema,
	tokenBudget: Type.Optional(Type.Number()),
	createdAt: Type.String(),
	updatedAt: Type.String(),
});
export type MaestroAppServerThreadGoal = Static<
	typeof MaestroAppServerThreadGoalSchema
>;

export const MaestroAppServerThreadItemSchema = Type.Object({
	id: Type.String(),
	type: Type.String(),
	timestamp: Type.Optional(Type.String()),
	parentId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	role: Type.Optional(Type.String()),
	content: Type.Optional(Type.Unknown()),
	data: Type.Optional(Type.Unknown()),
});
export type MaestroAppServerThreadItem = Static<
	typeof MaestroAppServerThreadItemSchema
>;

export const MaestroAppServerCompactionSpanSchema = Type.Object({
	id: Type.String(),
	firstKeptEntryId: Type.String(),
	summary: Type.String(),
	tokensBefore: Type.Number(),
	sourceEntryIds: Type.Array(Type.String()),
});
export type MaestroAppServerCompactionSpan = Static<
	typeof MaestroAppServerCompactionSpanSchema
>;

export const MaestroAppServerThreadGraphSchema = Type.Object({
	branchId: Type.String(),
	leafEntryId: Type.Optional(Type.String()),
	activeEntryIds: Type.Array(Type.String()),
	compactionSpans: Type.Array(MaestroAppServerCompactionSpanSchema),
});
export type MaestroAppServerThreadGraph = Static<
	typeof MaestroAppServerThreadGraphSchema
>;

export const MaestroAppServerTurnSchema = Type.Object({
	id: Type.String(),
	parentTurnId: Type.Optional(Type.String()),
	status: MaestroAppServerTurnStatusSchema,
	startedAt: Type.Optional(Type.String()),
	completedAt: Type.Optional(Type.String()),
	sourceEntryIds: Type.Optional(Type.Array(Type.String())),
	toolCallIds: Type.Optional(Type.Array(Type.String())),
	items: Type.Array(MaestroAppServerThreadItemSchema),
});
export type MaestroAppServerTurn = Static<typeof MaestroAppServerTurnSchema>;

export const MaestroAppServerThreadSchema = Type.Intersect([
	MaestroAppServerThreadSummarySchema,
	Type.Object({
		messagesView: Type.Union([
			Type.Literal("full"),
			Type.Literal("summary"),
			Type.Literal("notLoaded"),
		]),
		turns: Type.Optional(Type.Array(MaestroAppServerTurnSchema)),
		graph: Type.Optional(MaestroAppServerThreadGraphSchema),
	}),
]);
export type MaestroAppServerThread = Static<
	typeof MaestroAppServerThreadSchema
>;

export const MaestroAppServerThreadListResultSchema = Type.Object({
	threads: Type.Array(MaestroAppServerThreadSummarySchema),
	nextCursor: Type.Union([Type.String(), Type.Null()]),
});
export type MaestroAppServerThreadListResult = Static<
	typeof MaestroAppServerThreadListResultSchema
>;

export const MaestroAppServerThreadReadResultSchema = Type.Object({
	thread: MaestroAppServerThreadSchema,
});
export type MaestroAppServerThreadReadResult = Static<
	typeof MaestroAppServerThreadReadResultSchema
>;

export const MaestroAppServerThreadMetadataUpdateResultSchema = Type.Object({
	thread: MaestroAppServerThreadSummarySchema,
});
export type MaestroAppServerThreadMetadataUpdateResult = Static<
	typeof MaestroAppServerThreadMetadataUpdateResultSchema
>;

export const MaestroAppServerThreadGoalResultSchema = Type.Object({
	threadId: Type.String(),
	goal: Type.Union([MaestroAppServerThreadGoalSchema, Type.Null()]),
});
export type MaestroAppServerThreadGoalResult = Static<
	typeof MaestroAppServerThreadGoalResultSchema
>;

export const MaestroAppServerTurnsListResultSchema = Type.Object({
	threadId: Type.String(),
	turns: Type.Array(MaestroAppServerTurnSchema),
	nextCursor: Type.Union([Type.String(), Type.Null()]),
	graph: Type.Optional(MaestroAppServerThreadGraphSchema),
});
export type MaestroAppServerTurnsListResult = Static<
	typeof MaestroAppServerTurnsListResultSchema
>;

export const MaestroAppServerModelCapabilitiesSchema = Type.Object({
	streaming: Type.Boolean(),
	tools: Type.Boolean(),
	vision: Type.Boolean(),
	reasoning: Type.Boolean(),
	responsesApi: Type.Boolean(),
	codexBackend: Type.Boolean(),
	local: Type.Boolean(),
});
export const MaestroAppServerReasoningEffortSchema = Type.Union([
	Type.Literal("minimal"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("ultra"),
]);
export const MaestroAppServerModelSchema = Type.Object({
	id: Type.String(),
	provider: Type.String(),
	name: Type.String(),
	api: Type.String(),
	contextWindow: Type.Optional(Type.Number()),
	maxTokens: Type.Optional(Type.Number()),
	cost: Type.Optional(Type.Record(Type.String(), Type.Number())),
	source: Type.Optional(
		Type.Union([Type.Literal("builtin"), Type.Literal("custom")]),
	),
	supportedReasoningEfforts: Type.Optional(
		Type.Array(MaestroAppServerReasoningEffortSchema),
	),
	defaultReasoningEffort: Type.Optional(MaestroAppServerReasoningEffortSchema),
	capabilities: MaestroAppServerModelCapabilitiesSchema,
});
export type MaestroAppServerModel = Static<typeof MaestroAppServerModelSchema>;

export const MaestroAppServerModelListResultSchema = Type.Object({
	models: Type.Array(MaestroAppServerModelSchema),
});
export type MaestroAppServerModelListResult = Static<
	typeof MaestroAppServerModelListResultSchema
>;

export const MaestroAppServerModelProviderCapabilitiesSchema = Type.Object({
	id: Type.String(),
	name: Type.String(),
	apis: Type.Array(Type.String()),
	modelCount: Type.Number(),
	capabilities: MaestroAppServerModelCapabilitiesSchema,
});
export type MaestroAppServerModelProviderCapabilities = Static<
	typeof MaestroAppServerModelProviderCapabilitiesSchema
>;

export const MaestroAppServerModelProviderCapabilitiesReadResultSchema =
	Type.Object({
		providers: Type.Array(MaestroAppServerModelProviderCapabilitiesSchema),
	});
export type MaestroAppServerModelProviderCapabilitiesReadResult = Static<
	typeof MaestroAppServerModelProviderCapabilitiesReadResultSchema
>;

export const MaestroAppServerResponseSchema = Type.Object({
	jsonrpc: Type.Literal("2.0"),
	id: MaestroAppServerJsonRpcResponseIdSchema,
	result: Type.Optional(
		Type.Union([
			MaestroAppServerInitializeResultSchema,
			MaestroAppServerModelListResultSchema,
			MaestroAppServerModelProviderCapabilitiesReadResultSchema,
			MaestroAppServerThreadListResultSchema,
			MaestroAppServerThreadReadResultSchema,
			MaestroAppServerThreadMetadataUpdateResultSchema,
			MaestroAppServerThreadGoalResultSchema,
			MaestroAppServerTurnsListResultSchema,
		]),
	),
	error: Type.Optional(
		Type.Object({
			code: Type.Number(),
			message: Type.String(),
		}),
	),
});
export type MaestroAppServerResponse = Static<
	typeof MaestroAppServerResponseSchema
>;
