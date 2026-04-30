import { type Static, Type } from "@sinclair/typebox";
import { stringLiteralUnion } from "./typebox-utils.js";

export const runtimeServerRequestKinds = [
	"approval",
	"client_tool",
	"mcp_elicitation",
	"user_input",
	"tool_retry",
] as const;
export type RuntimeServerRequestKind =
	(typeof runtimeServerRequestKinds)[number];

export const runtimeServerRequestResolutions = [
	"approved",
	"denied",
	"completed",
	"failed",
	"answered",
	"retried",
	"skipped",
	"aborted",
	"cancelled",
] as const;
export type RuntimeServerRequestResolution =
	(typeof runtimeServerRequestResolutions)[number];

export const runtimeServerRequestResolvedBy = [
	"user",
	"policy",
	"client",
	"runtime",
] as const;
export type RuntimeServerRequestResolvedBy =
	(typeof runtimeServerRequestResolvedBy)[number];

export const RuntimeServerRequestKindSchema = stringLiteralUnion(
	runtimeServerRequestKinds,
);
export const RuntimeServerRequestResolutionSchema = stringLiteralUnion(
	runtimeServerRequestResolutions,
);
export const RuntimeServerRequestResolvedBySchema = stringLiteralUnion(
	runtimeServerRequestResolvedBy,
);

export const RuntimeServerRequestPlatformRefSchema = Type.Object({
	source: Type.Union([
		Type.Literal("approvals_service"),
		Type.Literal("tool_execution"),
	]),
	toolExecutionId: Type.Optional(Type.String()),
	approvalRequestId: Type.Optional(Type.String()),
});
export type RuntimeServerRequestPlatformRef = Static<
	typeof RuntimeServerRequestPlatformRefSchema
>;

export const RuntimeServerRequestSnapshotSchema = Type.Object({
	id: Type.String(),
	kind: RuntimeServerRequestKindSchema,
	sessionId: Type.Optional(Type.String()),
	callId: Type.String(),
	toolName: Type.String(),
	displayName: Type.Optional(Type.String()),
	summaryLabel: Type.Optional(Type.String()),
	actionDescription: Type.Optional(Type.String()),
	args: Type.Unknown(),
	reason: Type.String(),
	timestamp: Type.Number(),
	timeoutMs: Type.Number(),
	platform: Type.Optional(RuntimeServerRequestPlatformRefSchema),
});
export type RuntimeServerRequestSnapshot = Static<
	typeof RuntimeServerRequestSnapshotSchema
>;

export const RuntimeServerRequestRegisteredEventSchema = Type.Object({
	type: Type.Literal("registered"),
	request: RuntimeServerRequestSnapshotSchema,
});
export type RuntimeServerRequestRegisteredEvent = Static<
	typeof RuntimeServerRequestRegisteredEventSchema
>;

export const RuntimeServerRequestResolvedEventSchema = Type.Object({
	type: Type.Literal("resolved"),
	request: RuntimeServerRequestSnapshotSchema,
	resolution: RuntimeServerRequestResolutionSchema,
	reason: Type.Optional(Type.String()),
	resolvedBy: RuntimeServerRequestResolvedBySchema,
});
export type RuntimeServerRequestResolvedEvent = Static<
	typeof RuntimeServerRequestResolvedEventSchema
>;

export const RuntimeServerRequestLifecycleEventSchema = Type.Union([
	RuntimeServerRequestRegisteredEventSchema,
	RuntimeServerRequestResolvedEventSchema,
]);
export type RuntimeServerRequestLifecycleEvent = Static<
	typeof RuntimeServerRequestLifecycleEventSchema
>;
