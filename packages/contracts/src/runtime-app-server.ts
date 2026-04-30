import { type Static, Type } from "@sinclair/typebox";
import { RuntimeServerRequestLifecycleEventSchema } from "./runtime-server-request.js";
import { stringLiteralUnion } from "./typebox-utils.js";

export const runtimeAppServerProtocolVersion = "runtime-app-server.v1" as const;

export const runtimeAppServerClientMethods = [
	"runtime.initialize",
	"runtime.model_provider_capabilities.read",
	"runtime.ping",
] as const;
export type RuntimeAppServerClientMethod =
	(typeof runtimeAppServerClientMethods)[number];

export const runtimeAppServerServerMethods = [
	"runtime.initialized",
	"runtime.server_request.registered",
	"runtime.server_request.resolved",
] as const;
export type RuntimeAppServerServerMethod =
	(typeof runtimeAppServerServerMethods)[number];

const RuntimeJsonRpcIdSchema = Type.Union([Type.String(), Type.Number()]);
const RuntimeJsonRpcResponseIdSchema = Type.Union([
	RuntimeJsonRpcIdSchema,
	Type.Null(),
]);

export const RuntimeAppServerClientRequestSchema = Type.Object({
	jsonrpc: Type.Literal("2.0"),
	id: RuntimeJsonRpcIdSchema,
	method: stringLiteralUnion(runtimeAppServerClientMethods),
	params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});
export type RuntimeAppServerClientRequest = Static<
	typeof RuntimeAppServerClientRequestSchema
>;

export const RuntimeAppServerCapabilitiesSchema = Type.Object({
	chat: Type.Boolean(),
	serverRequests: Type.Boolean(),
	modelCapabilities: Type.Boolean(),
});
export type RuntimeAppServerCapabilities = Static<
	typeof RuntimeAppServerCapabilitiesSchema
>;

export const RuntimeAppServerInitializeResultSchema = Type.Object({
	protocolVersion: Type.Literal(runtimeAppServerProtocolVersion),
	serverInfo: Type.Object({
		name: Type.String(),
	}),
	capabilities: RuntimeAppServerCapabilitiesSchema,
});
export type RuntimeAppServerInitializeResult = Static<
	typeof RuntimeAppServerInitializeResultSchema
>;

export const RuntimeAppServerModelCapabilitiesSchema = Type.Object({
	streaming: Type.Boolean(),
	tools: Type.Boolean(),
	vision: Type.Boolean(),
	reasoning: Type.Boolean(),
	local: Type.Boolean(),
});
export type RuntimeAppServerModelCapabilities = Static<
	typeof RuntimeAppServerModelCapabilitiesSchema
>;

export const RuntimeAppServerProviderModelSchema = Type.Object({
	id: Type.String(),
	name: Type.String(),
	api: Type.String(),
	provider: Type.String(),
	source: Type.Union([Type.Literal("builtin"), Type.Literal("custom")]),
	contextWindow: Type.Optional(Type.Number()),
	maxTokens: Type.Optional(Type.Number()),
	capabilities: RuntimeAppServerModelCapabilitiesSchema,
});
export type RuntimeAppServerProviderModel = Static<
	typeof RuntimeAppServerProviderModelSchema
>;

export const RuntimeAppServerModelProviderCapabilitiesResultSchema =
	Type.Object({
		providers: Type.Array(
			Type.Object({
				id: Type.String(),
				name: Type.String(),
				models: Type.Array(RuntimeAppServerProviderModelSchema),
			}),
		),
	});
export type RuntimeAppServerModelProviderCapabilitiesResult = Static<
	typeof RuntimeAppServerModelProviderCapabilitiesResultSchema
>;

export const RuntimeAppServerResponseSchema = Type.Object({
	jsonrpc: Type.Literal("2.0"),
	id: RuntimeJsonRpcResponseIdSchema,
	result: Type.Optional(
		Type.Union([
			RuntimeAppServerInitializeResultSchema,
			RuntimeAppServerModelProviderCapabilitiesResultSchema,
			Type.Unknown(),
		]),
	),
	error: Type.Optional(
		Type.Object({
			code: Type.Number(),
			message: Type.String(),
		}),
	),
});
export type RuntimeAppServerResponse = Static<
	typeof RuntimeAppServerResponseSchema
>;

export const RuntimeAppServerServerNotificationSchema = Type.Object({
	jsonrpc: Type.Literal("2.0"),
	method: stringLiteralUnion(runtimeAppServerServerMethods),
	params: Type.Optional(
		Type.Union([
			RuntimeAppServerInitializeResultSchema,
			RuntimeServerRequestLifecycleEventSchema,
		]),
	),
});
export type RuntimeAppServerServerNotification = Static<
	typeof RuntimeAppServerServerNotificationSchema
>;
