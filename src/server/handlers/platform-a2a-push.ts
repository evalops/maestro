import type { IncomingMessage, ServerResponse } from "node:http";
import type { HostedRunnerContext, WebServerContext } from "../app-context.js";
import {
	ApiError,
	getRequestHeader,
	readJsonBody,
	secureCompare,
	sendJson,
} from "../server-utils.js";

export const PLATFORM_A2A_PUSH_CALLBACK_PATH = "/api/platform/a2a/push";

const CALLBACK_TOKEN_ENV_VARS = [
	"MAESTRO_PLATFORM_A2A_CALLBACK_TOKEN",
	"MAESTRO_A2A_CALLBACK_TOKEN",
] as const;

export function platformA2APushAuthBoundaryExemptPaths(): readonly string[] {
	return callbackToken() ? [PLATFORM_A2A_PUSH_CALLBACK_PATH] : [];
}

type JsonObject = Record<string, unknown>;

interface PlatformA2APushSnapshot {
	kind: "statusUpdate" | "artifactUpdate" | "task" | "message";
	taskId?: string;
	messageId?: string;
	messageIds?: string[];
	contextId?: string;
	workspaceId?: string;
	organizationId?: string;
	tenantId?: string;
	state?: string;
	final?: boolean;
	receivedAt: string;
	runtimeEventId?: string;
	runtimeEventType?: string;
	traceparent?: string;
	tracestate?: string;
	agentId?: string;
	actorId?: string;
}

type PlatformA2APushContext = Pick<
	PlatformA2APushSnapshot,
	| "traceparent"
	| "tracestate"
	| "organizationId"
	| "workspaceId"
	| "agentId"
	| "actorId"
>;

export async function handlePlatformA2APushCallback(
	req: IncomingMessage,
	res: ServerResponse,
	context: WebServerContext,
): Promise<void> {
	if (req.method !== "POST") {
		throw new ApiError(405, "Method not allowed");
	}
	assertCallbackToken(req);
	const body = await readJsonBody<unknown>(req);
	const snapshot = platformA2APushSnapshot(body, req);
	if (!snapshot) {
		throw new ApiError(400, "Invalid A2A push notification payload");
	}
	const hostedRunner = context.hostedRunner;
	assertHostedRunnerA2APushBoundary(hostedRunner, snapshot);
	if (hostedRunner) {
		recordHostedRunnerA2APush(hostedRunner, snapshot);
	}
	sendJson(res, 202, { accepted: true, ...snapshot }, context.corsHeaders, req);
}

function assertCallbackToken(req: IncomingMessage): void {
	const expected = callbackToken();
	if (!expected) {
		return;
	}
	const provided = getRequestHeader(req, "x-a2a-notification-token");
	if (!provided || !secureCompare(provided, expected)) {
		throw new ApiError(401, "Invalid A2A notification token");
	}
}

function platformA2APushSnapshot(
	payload: unknown,
	req: IncomingMessage,
): PlatformA2APushSnapshot | null {
	if (!isJsonObject(payload)) {
		return null;
	}
	const requestContext = platformA2APushRequestContext(req);
	if (isJsonObject(payload.statusUpdate)) {
		const taskId = stringField(payload.statusUpdate, "taskId");
		if (!taskId) {
			return null;
		}
		return withPlatformA2APushContext(
			{
				kind: "statusUpdate",
				taskId,
				...messageIdFields(payload, payload.statusUpdate),
				contextId: stringField(payload.statusUpdate, "contextId"),
				...ownershipFields(payload, payload.statusUpdate),
				state: statusState(payload.statusUpdate),
				final: booleanField(payload.statusUpdate, "final"),
				receivedAt: new Date().toISOString(),
				runtimeEventId: metadataString(payload.statusUpdate, "runtimeEventId"),
				runtimeEventType: metadataString(
					payload.statusUpdate,
					"runtimeEventType",
				),
			},
			payload.statusUpdate,
			requestContext,
		);
	}
	if (isJsonObject(payload.task)) {
		const taskId = stringField(payload.task, "id");
		if (!taskId) {
			return null;
		}
		return withPlatformA2APushContext(
			{
				kind: "task",
				taskId,
				...messageIdFields(payload, payload.task),
				contextId: stringField(payload.task, "contextId"),
				...ownershipFields(payload, payload.task),
				state: statusState(payload.task),
				receivedAt: new Date().toISOString(),
			},
			payload.task,
			requestContext,
		);
	}
	if (isJsonObject(payload.artifactUpdate)) {
		const taskId = stringField(payload.artifactUpdate, "taskId");
		if (!taskId) {
			return null;
		}
		return withPlatformA2APushContext(
			{
				kind: "artifactUpdate",
				taskId,
				...messageIdFields(payload, payload.artifactUpdate),
				contextId: stringField(payload.artifactUpdate, "contextId"),
				...ownershipFields(payload, payload.artifactUpdate),
				receivedAt: new Date().toISOString(),
			},
			payload.artifactUpdate,
			requestContext,
		);
	}
	if (isJsonObject(payload.message)) {
		const taskId = stringField(payload.message, "taskId");
		const messageFields = messageIdFields(payload, payload.message);
		if (!messageFields.messageId) {
			return null;
		}
		return withPlatformA2APushContext(
			{
				kind: "message",
				...optionalField("taskId", taskId),
				...messageFields,
				contextId: stringField(payload.message, "contextId"),
				...ownershipFields(payload, payload.message),
				receivedAt: new Date().toISOString(),
			},
			payload.message,
			requestContext,
		);
	}
	return null;
}

function withPlatformA2APushContext(
	snapshot: PlatformA2APushSnapshot,
	payload: JsonObject,
	requestContext: PlatformA2APushContext,
): PlatformA2APushSnapshot {
	const metadataContext = platformA2APushMetadataContext(payload);
	const payloadAgentId = snapshot.agentId ?? metadataContext.agentId;
	assertCompatibleAgentContext(payloadAgentId, requestContext.agentId);
	return {
		...snapshot,
		...metadataContext,
		...requestContext,
		organizationId:
			snapshot.organizationId ??
			metadataContext.organizationId ??
			requestContext.organizationId,
		workspaceId:
			snapshot.workspaceId ??
			metadataContext.workspaceId ??
			requestContext.workspaceId,
		agentId: payloadAgentId ?? requestContext.agentId,
	};
}

function platformA2APushRequestContext(
	req: IncomingMessage,
): PlatformA2APushContext {
	return compactPlatformA2APushContext({
		traceparent: getRequestHeader(req, "traceparent") ?? undefined,
		tracestate: getRequestHeader(req, "tracestate") ?? undefined,
		organizationId:
			getRequestHeader(req, "x-organization-id", "x-evalops-organization-id") ??
			undefined,
		workspaceId:
			getRequestHeader(req, "x-workspace-id", "x-evalops-workspace-id") ??
			undefined,
		agentId:
			getRequestHeader(req, "x-evalops-agent-id", "x-maestro-agent-id") ??
			undefined,
		actorId:
			getRequestHeader(req, "x-evalops-actor-id", "x-evalops-user-id") ??
			undefined,
	});
}

function platformA2APushMetadataContext(
	value: JsonObject,
): PlatformA2APushContext {
	const metadata = isJsonObject(value.metadata) ? value.metadata : undefined;
	if (!metadata) {
		return {};
	}
	return compactPlatformA2APushContext({
		traceparent:
			stringField(metadata, "traceparent") ??
			stringField(metadata, "traceParent") ??
			stringField(metadata, "trace_parent"),
		tracestate:
			stringField(metadata, "tracestate") ??
			stringField(metadata, "traceState") ??
			stringField(metadata, "trace_state"),
		organizationId:
			stringField(metadata, "organizationId") ??
			stringField(metadata, "organization_id"),
		workspaceId:
			stringField(metadata, "workspaceId") ??
			stringField(metadata, "workspace_id"),
		agentId:
			stringField(metadata, "agentId") ?? stringField(metadata, "agent_id"),
		actorId:
			stringField(metadata, "actorId") ?? stringField(metadata, "actor_id"),
	});
}

function compactPlatformA2APushContext(
	context: PlatformA2APushContext,
): PlatformA2APushContext {
	return Object.fromEntries(
		Object.entries(context).filter(
			([, value]) => typeof value === "string" && value.length > 0,
		),
	) as PlatformA2APushContext;
}

function assertHostedRunnerA2APushBoundary(
	hostedRunner: HostedRunnerContext | undefined,
	snapshot: PlatformA2APushSnapshot,
): void {
	if (
		hostedRunner?.a2aTaskId &&
		snapshot.taskId &&
		hostedRunner.a2aTaskId !== snapshot.taskId
	) {
		throw new ApiError(404, "A2A task not found");
	}
	if (
		hostedRunner?.a2aMessageId &&
		snapshotHasBoundaryMessageIdEvidence(snapshot) &&
		!snapshotIncludesMessageId(snapshot, hostedRunner.a2aMessageId)
	) {
		throw new ApiError(404, "A2A message not found");
	}
	if (
		hostedRunner?.agentId &&
		snapshot.agentId &&
		!sameExactIdentifier(snapshot.agentId, hostedRunner.agentId)
	) {
		throw new ApiError(403, "A2A push notification agent mismatch");
	}
	if (
		hostedRunner &&
		snapshot.kind === "message" &&
		!hostedRunner.a2aMessageId &&
		!snapshotHasMessageBindingCorrelation(snapshot)
	) {
		throw new ApiError(403, "A2A message push is missing correlation metadata");
	}
	if (!hostedRunner?.workspaceId) {
		return;
	}

	const workspaceMarker = snapshot.workspaceId;
	if (workspaceMarker) {
		if (!sameIdentifier(workspaceMarker, hostedRunner.workspaceId)) {
			throw new ApiError(403, "A2A push notification workspace mismatch");
		}
		return;
	}

	if (!hostedRunner.a2aTaskId) {
		throw new ApiError(
			403,
			"A2A push notification is missing workspace metadata",
		);
	}
}

function recordHostedRunnerA2APush(
	hostedRunner: HostedRunnerContext,
	snapshot: PlatformA2APushSnapshot,
): void {
	hostedRunner.lastPlatformA2APush = snapshot;
	if (snapshot.taskId && !hostedRunner.a2aTaskId) {
		hostedRunner.a2aTaskId = snapshot.taskId;
	}
	if (
		snapshot.messageId &&
		!hostedRunner.a2aMessageId &&
		snapshot.kind === "message" &&
		snapshotHasMessageBindingCorrelation(snapshot)
	) {
		hostedRunner.a2aMessageId = snapshot.messageId;
	}
}

function statusState(value: JsonObject): string | undefined {
	const status = isJsonObject(value.status) ? value.status : undefined;
	return status ? stringField(status, "state") : undefined;
}

function metadataString(value: JsonObject, key: string): string | undefined {
	const metadata = isJsonObject(value.metadata) ? value.metadata : undefined;
	return metadata ? stringField(metadata, key) : undefined;
}

function ownershipFields(
	payload: JsonObject,
	value: JsonObject,
): Pick<
	PlatformA2APushSnapshot,
	"workspaceId" | "organizationId" | "tenantId" | "agentId"
> {
	const agentIds = ownershipStrings(payload, value, ["agentId", "agent_id"]);
	assertCompatiblePayloadAgentContext(agentIds);
	return {
		...optionalField(
			"workspaceId",
			ownershipString(payload, value, ["workspaceId", "workspace_id"]),
		),
		...optionalField(
			"organizationId",
			ownershipString(payload, value, [
				"organizationId",
				"organization_id",
				"orgId",
				"org_id",
			]),
		),
		...optionalField(
			"tenantId",
			ownershipString(payload, value, ["tenantId", "tenant_id", "tenant"]),
		),
		...optionalField("agentId", agentIds[0]),
	};
}

function ownershipStrings(
	payload: JsonObject,
	value: JsonObject,
	keys: readonly string[],
): string[] {
	const result: string[] = [];
	for (const source of ownershipSources(payload, value)) {
		for (const key of keys) {
			pushUniqueIdentifier(result, stringField(source, key));
			pushUniqueIdentifier(result, metadataString(source, key));
		}
	}
	return result;
}

function messageIdFields(
	payload: JsonObject,
	value: JsonObject,
): Pick<PlatformA2APushSnapshot, "messageId" | "messageIds"> {
	const messageIds = messageIdsFromSources(payload, value);
	return {
		...optionalField("messageId", messageIds[0]),
		...(messageIds.length > 0 ? { messageIds } : {}),
	};
}

function messageIdsFromSources(
	payload: JsonObject,
	value: JsonObject,
): string[] {
	const result: string[] = [];
	for (const source of messageIdSources(payload, value)) {
		pushIdentifierStrings(result, source, [
			"messageId",
			"message_id",
			"a2aMessageId",
			"a2a_message_id",
		]);
		pushIdentifierArrayStrings(result, source, ["messageIds", "message_ids"]);
	}
	const payloadMessage = isJsonObject(payload.message)
		? payload.message
		: undefined;
	if (payloadMessage) {
		pushMessageObjectIdentifier(result, payloadMessage);
	}
	return result;
}

function messageIdSources(
	payload: JsonObject,
	value: JsonObject,
): JsonObject[] {
	const sources = [value, payload];
	if (isJsonObject(value.artifact)) {
		sources.push(value.artifact);
	}
	return sources;
}

function pushMessageObjectIdentifier(
	target: string[],
	message: JsonObject,
): void {
	pushUniqueIdentifier(target, stringField(message, "id"));
	pushIdentifierStrings(target, message, [
		"messageId",
		"message_id",
		"a2aMessageId",
		"a2a_message_id",
	]);
}

function pushIdentifierStrings(
	target: string[],
	value: JsonObject,
	keys: readonly string[],
): void {
	for (const key of keys) {
		pushUniqueIdentifier(target, stringField(value, key));
		const metadata = metadataString(value, key);
		pushUniqueIdentifier(target, metadata);
	}
}

function pushIdentifierArrayStrings(
	target: string[],
	value: JsonObject,
	keys: readonly string[],
): void {
	for (const key of keys) {
		const direct = value[key];
		if (Array.isArray(direct)) {
			for (const entry of direct) {
				pushUniqueIdentifier(
					target,
					typeof entry === "string" ? entry.trim() : undefined,
				);
			}
		}
		const metadata = isJsonObject(value.metadata)
			? value.metadata[key]
			: undefined;
		if (Array.isArray(metadata)) {
			for (const entry of metadata) {
				pushUniqueIdentifier(
					target,
					typeof entry === "string" ? entry.trim() : undefined,
				);
			}
		}
	}
}

function pushUniqueIdentifier(
	target: string[],
	value: string | undefined,
): void {
	if (!value || target.some((entry) => sameMessageIdentifier(entry, value))) {
		return;
	}
	target.push(value);
}

function snapshotHasBoundaryMessageIdEvidence(
	snapshot: PlatformA2APushSnapshot,
): boolean {
	return (
		snapshot.kind === "message" ||
		(snapshot.kind === "task" && Boolean(snapshot.messageIds?.length))
	);
}

function snapshotHasMessageBindingCorrelation(
	snapshot: PlatformA2APushSnapshot,
): boolean {
	return Boolean(snapshot.taskId || snapshot.workspaceId);
}

function snapshotIncludesMessageId(
	snapshot: PlatformA2APushSnapshot,
	messageId: string,
): boolean {
	return (
		(snapshot.messageId
			? sameMessageIdentifier(snapshot.messageId, messageId)
			: false) ||
		(snapshot.messageIds ?? []).some((candidate) =>
			sameMessageIdentifier(candidate, messageId),
		)
	);
}

function ownershipString(
	payload: JsonObject,
	value: JsonObject,
	keys: readonly string[],
): string | undefined {
	for (const source of ownershipSources(payload, value)) {
		for (const key of keys) {
			const direct = stringField(source, key);
			if (direct) {
				return direct;
			}
			const metadata = metadataString(source, key);
			if (metadata) {
				return metadata;
			}
		}
	}
	return undefined;
}

function ownershipSources(
	payload: JsonObject,
	value: JsonObject,
): JsonObject[] {
	const sources = [value, payload];
	const status = isJsonObject(value.status) ? value.status : undefined;
	if (status) {
		sources.push(status);
		if (isJsonObject(status.message)) {
			sources.push(status.message);
		}
	}
	if (isJsonObject(value.artifact)) {
		sources.push(value.artifact);
	}
	return sources;
}

function optionalField<K extends string>(
	key: K,
	value: string | undefined,
): Partial<Record<K, string>> {
	return value ? ({ [key]: value } as Partial<Record<K, string>>) : {};
}

function sameIdentifier(left: string, right: string): boolean {
	return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function sameMessageIdentifier(left: string, right: string): boolean {
	return left.trim() === right.trim();
}

function assertCompatibleAgentContext(
	metadataAgentId: string | undefined,
	requestAgentId: string | undefined,
): void {
	if (
		metadataAgentId &&
		requestAgentId &&
		!sameExactIdentifier(metadataAgentId, requestAgentId)
	) {
		throw new ApiError(403, "A2A push notification agent mismatch");
	}
}

function assertCompatiblePayloadAgentContext(
	agentIds: readonly string[],
): void {
	if (
		agentIds.length > 1 &&
		agentIds.some((agentId) => !sameExactIdentifier(agentId, agentIds[0] ?? ""))
	) {
		throw new ApiError(403, "A2A push notification agent mismatch");
	}
}

function sameExactIdentifier(left: string, right: string): boolean {
	return left.trim() === right.trim();
}

function stringField(value: JsonObject, key: string): string | undefined {
	const field = value[key];
	return typeof field === "string" && field.trim().length > 0
		? field.trim()
		: undefined;
}

function booleanField(value: JsonObject, key: string): boolean | undefined {
	const field = value[key];
	return typeof field === "boolean" ? field : undefined;
}

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function callbackToken(): string | undefined {
	for (const name of CALLBACK_TOKEN_ENV_VARS) {
		const value = process.env[name]?.trim();
		if (value) {
			return value;
		}
	}
	return undefined;
}
