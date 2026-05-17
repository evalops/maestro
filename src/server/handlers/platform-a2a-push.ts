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
	state?: string;
	final?: boolean;
	receivedAt: string;
	runtimeEventId?: string;
	runtimeEventType?: string;
}

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
	const snapshot = platformA2APushSnapshot(body);
	if (!snapshot) {
		throw new ApiError(400, "Invalid A2A push notification payload");
	}
	const hostedRunner = context.hostedRunner;
	if (
		hostedRunner?.a2aTaskId &&
		snapshot.taskId &&
		hostedRunner.a2aTaskId !== snapshot.taskId
	) {
		throw new ApiError(404, "A2A task not found");
	}
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
): PlatformA2APushSnapshot | null {
	if (!isJsonObject(payload)) {
		return null;
	}
	if (isJsonObject(payload.statusUpdate)) {
		const taskId = stringField(payload.statusUpdate, "taskId");
		if (!taskId) {
			return null;
		}
		return {
			kind: "statusUpdate",
			taskId,
			contextId: stringField(payload.statusUpdate, "contextId"),
			state: statusState(payload.statusUpdate),
			final: booleanField(payload.statusUpdate, "final"),
			receivedAt: new Date().toISOString(),
			runtimeEventId: metadataString(payload.statusUpdate, "runtimeEventId"),
			runtimeEventType: metadataString(
				payload.statusUpdate,
				"runtimeEventType",
			),
		};
	}
	if (isJsonObject(payload.task)) {
		const taskId = stringField(payload.task, "id");
		if (!taskId) {
			return null;
		}
		return {
			kind: "task",
			taskId,
			contextId: stringField(payload.task, "contextId"),
			state: statusState(payload.task),
			receivedAt: new Date().toISOString(),
		};
	}
	if (isJsonObject(payload.artifactUpdate)) {
		const taskId = stringField(payload.artifactUpdate, "taskId");
		if (!taskId) {
			return null;
		}
		return {
			kind: "artifactUpdate",
			taskId,
			contextId: stringField(payload.artifactUpdate, "contextId"),
			receivedAt: new Date().toISOString(),
		};
	}
	if (isJsonObject(payload.message)) {
		const taskId = stringField(payload.message, "taskId");
		if (!taskId) {
			return null;
		}
		return {
			kind: "message",
			taskId,
			contextId: stringField(payload.message, "contextId"),
			receivedAt: new Date().toISOString(),
		};
	}
	return null;
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
