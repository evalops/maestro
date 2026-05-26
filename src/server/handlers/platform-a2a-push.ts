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
		if (!taskId) {
			return null;
		}
		return withPlatformA2APushContext(
			{
				kind: "message",
				taskId,
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
	"workspaceId" | "organizationId" | "tenantId"
> {
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
	};
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
