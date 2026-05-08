import { type Static, Type } from "@sinclair/typebox";
import { stringLiteralUnion } from "./typebox-utils.js";

export const maestroAppServerProtocolVersion = "maestro-app-server.v1" as const;

export const maestroAppServerClientMethods = [
	"initialize",
	"thread/list",
	"thread/read",
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
	threadList: Type.Boolean(),
	threadRead: Type.Boolean(),
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

export const MaestroAppServerTurnSchema = Type.Object({
	id: Type.String(),
	status: MaestroAppServerTurnStatusSchema,
	startedAt: Type.Optional(Type.String()),
	completedAt: Type.Optional(Type.String()),
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

export const MaestroAppServerTurnsListResultSchema = Type.Object({
	threadId: Type.String(),
	turns: Type.Array(MaestroAppServerTurnSchema),
	nextCursor: Type.Union([Type.String(), Type.Null()]),
});
export type MaestroAppServerTurnsListResult = Static<
	typeof MaestroAppServerTurnsListResultSchema
>;

export const MaestroAppServerResponseSchema = Type.Object({
	jsonrpc: Type.Literal("2.0"),
	id: MaestroAppServerJsonRpcResponseIdSchema,
	result: Type.Optional(
		Type.Union([
			MaestroAppServerInitializeResultSchema,
			MaestroAppServerThreadListResultSchema,
			MaestroAppServerThreadReadResultSchema,
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
