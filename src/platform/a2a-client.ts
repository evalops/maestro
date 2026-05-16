import {
	EVALOPS_ORGANIZATION_ID_ENV_VARS,
	EVALOPS_WORKSPACE_ID_ENV_VARS,
} from "../evalops/env-aliases.js";
import { fetchDownstream } from "../utils/downstream-http.js";
import {
	type PlatformServiceConfig,
	buildPlatformJsonHeaders,
	getEnvValue,
	resolvePlatformServiceConfig,
	trimString,
} from "./client.js";

const DEFAULT_TIMEOUT_MS = 2_500;
const DEFAULT_MAX_ATTEMPTS = 2;

const A2A_BASE_URL_ENV_VARS = [
	"MAESTRO_PLATFORM_A2A_URL",
	"MAESTRO_A2A_URL",
	"MAESTRO_AGENT_RUNTIME_SERVICE_URL",
	"PLATFORM_AGENT_RUNTIME_URL",
	"AGENT_RUNTIME_SERVICE_URL",
	"MAESTRO_PLATFORM_BASE_URL",
	"MAESTRO_EVALOPS_BASE_URL",
	"EVALOPS_BASE_URL",
] as const;

const A2A_TOKEN_ENV_VARS = [
	"MAESTRO_PLATFORM_A2A_TOKEN",
	"MAESTRO_A2A_TOKEN",
	"MAESTRO_AGENT_RUNTIME_SERVICE_TOKEN",
	"AGENT_RUNTIME_SERVICE_TOKEN",
] as const;

const A2A_ORGANIZATION_ENV_VARS = [
	"MAESTRO_PLATFORM_A2A_ORG_ID",
	"MAESTRO_A2A_ORG_ID",
	"MAESTRO_AGENT_RUNTIME_ORG_ID",
	"AGENT_RUNTIME_ORGANIZATION_ID",
	...EVALOPS_ORGANIZATION_ID_ENV_VARS,
] as const;

const A2A_WORKSPACE_ENV_VARS = [
	"MAESTRO_PLATFORM_A2A_WORKSPACE_ID",
	"MAESTRO_A2A_WORKSPACE_ID",
	"MAESTRO_AGENT_RUNTIME_WORKSPACE_ID",
	"AGENT_RUNTIME_WORKSPACE_ID",
	...EVALOPS_WORKSPACE_ID_ENV_VARS,
] as const;

const A2A_TIMEOUT_ENV_VARS = [
	"MAESTRO_PLATFORM_A2A_TIMEOUT_MS",
	"MAESTRO_A2A_TIMEOUT_MS",
	"MAESTRO_AGENT_RUNTIME_TIMEOUT_MS",
	"AGENT_RUNTIME_SERVICE_TIMEOUT_MS",
] as const;

const A2A_MAX_ATTEMPTS_ENV_VARS = [
	"MAESTRO_PLATFORM_A2A_MAX_ATTEMPTS",
	"MAESTRO_A2A_MAX_ATTEMPTS",
	"MAESTRO_AGENT_RUNTIME_MAX_ATTEMPTS",
	"AGENT_RUNTIME_SERVICE_MAX_ATTEMPTS",
] as const;

const A2A_BASE_URL_SUFFIXES = [
	"/.well-known/agent-card.json",
	"/message:send",
	"/message:stream",
	"/agentruntime.v1.AgentRuntimeService/HandleTrigger",
	"/agentruntime.v1.AgentRuntimeService",
] as const;

export interface A2AServiceConfig extends PlatformServiceConfig {
	agentId?: string;
	sessionId?: string;
	actorId?: string;
	traceparent?: string;
	tracestate?: string;
}

export interface A2AAgentCard {
	name: string;
	description: string;
	supportedInterfaces: A2AAgentInterface[];
	provider?: {
		url: string;
		organization: string;
	};
	version: string;
	capabilities: {
		streaming?: boolean;
		pushNotifications?: boolean;
		extendedAgentCard?: boolean;
	};
	defaultInputModes: string[];
	defaultOutputModes: string[];
	skills: A2AAgentSkill[];
}

export interface A2AAgentInterface {
	url: string;
	protocolBinding: string;
	tenant?: string;
	protocolVersion: string;
}

export interface A2AAgentSkill {
	id: string;
	name: string;
	description: string;
	tags: string[];
	examples?: string[];
	inputModes?: string[];
	outputModes?: string[];
}

export interface A2APart {
	text?: string;
	url?: string;
	data?: unknown;
	metadata?: Record<string, unknown>;
	filename?: string;
	mediaType?: string;
}

export interface A2AMessage {
	messageId: string;
	contextId?: string;
	taskId?: string;
	role: "ROLE_USER" | "ROLE_AGENT" | "user" | "agent";
	parts: A2APart[];
	metadata?: Record<string, unknown>;
	extensions?: string[];
	referenceTaskIds?: string[];
}

export interface A2ATaskStatus {
	state: string;
	message?: A2AMessage;
	timestamp?: string;
}

export interface A2ATask {
	id: string;
	contextId?: string;
	status: A2ATaskStatus;
	artifacts?: A2AArtifact[];
	history?: A2AMessage[];
	metadata?: Record<string, unknown>;
}

export interface A2AArtifact {
	artifactId: string;
	name?: string;
	description?: string;
	parts: A2APart[];
	metadata?: Record<string, unknown>;
}

export interface SendA2AMessageInput {
	message: A2AMessage;
	configuration?: {
		acceptedOutputModes?: string[];
		returnImmediately?: boolean;
	};
	metadata?: Record<string, unknown>;
	traceContext?: A2ATraceContext;
}

export interface SendA2AMessageResult {
	task: A2ATask;
}

export type A2AStreamEventType =
	| "task"
	| "message"
	| "statusUpdate"
	| "artifactUpdate";

export interface A2ATaskStreamEvent {
	type: "task";
	task: A2ATask;
}

export interface A2AMessageStreamEvent {
	type: "message";
	message: A2AMessage;
}

export interface A2AStatusUpdateStreamEvent {
	type: "statusUpdate";
	taskId?: string;
	contextId?: string;
	status: A2ATaskStatus;
	final?: boolean;
	metadata?: Record<string, unknown>;
}

export interface A2AArtifactUpdateStreamEvent {
	type: "artifactUpdate";
	taskId?: string;
	contextId?: string;
	artifact: A2AArtifact;
	append?: boolean;
	lastChunk?: boolean;
	metadata?: Record<string, unknown>;
}

export type A2AStreamEvent =
	| A2ATaskStreamEvent
	| A2AMessageStreamEvent
	| A2AStatusUpdateStreamEvent
	| A2AArtifactUpdateStreamEvent;

export interface A2ATraceContext {
	traceparent?: string;
	tracestate?: string;
}

export function normalizeA2ABaseUrl(baseUrl: string): string {
	let normalized = baseUrl.trim().replace(/\/+$/u, "");
	for (const suffix of A2A_BASE_URL_SUFFIXES) {
		if (normalized.endsWith(suffix)) {
			normalized = normalized.slice(0, -suffix.length).replace(/\/+$/u, "");
		}
	}
	return normalized;
}

export async function resolveA2AServiceConfig(
	overrides: Partial<A2AServiceConfig> = {},
): Promise<A2AServiceConfig | null> {
	const config = await resolvePlatformServiceConfig({
		baseUrlEnvVars: A2A_BASE_URL_ENV_VARS,
		tokenEnvVars: A2A_TOKEN_ENV_VARS,
		organizationEnvVars: A2A_ORGANIZATION_ENV_VARS,
		workspaceEnvVars: A2A_WORKSPACE_ENV_VARS,
		timeoutEnvVars: A2A_TIMEOUT_ENV_VARS,
		maxAttemptsEnvVars: A2A_MAX_ATTEMPTS_ENV_VARS,
		baseUrlSuffixes: A2A_BASE_URL_SUFFIXES,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		defaultMaxAttempts: DEFAULT_MAX_ATTEMPTS,
		requireBaseUrl: false,
		requireOrganizationId: false,
		requireToken: false,
		allowOAuthTokenFallback: false,
	});
	const baseUrl = trimString(overrides.baseUrl ?? config?.baseUrl);
	const workspaceId = trimString(overrides.workspaceId ?? config?.workspaceId);
	if (!baseUrl || !workspaceId) {
		return null;
	}
	return {
		...(config ?? {
			baseUrl,
			timeoutMs: DEFAULT_TIMEOUT_MS,
			maxAttempts: DEFAULT_MAX_ATTEMPTS,
		}),
		baseUrl: normalizeA2ABaseUrl(baseUrl),
		organizationId:
			trimString(overrides.organizationId ?? config?.organizationId) ??
			config?.organizationId,
		workspaceId,
		token: trimString(overrides.token ?? config?.token) ?? config?.token,
		timeoutMs: overrides.timeoutMs ?? config?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		maxAttempts:
			overrides.maxAttempts ?? config?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
		agentId:
			trimString(overrides.agentId) ??
			getEnvValue(["MAESTRO_AGENT_ID", "MAESTRO_EVALOPS_AGENT_ID"]) ??
			"maestro",
		sessionId:
			trimString(overrides.sessionId) ?? getEnvValue(["MAESTRO_SESSION_ID"]),
		actorId:
			trimString(overrides.actorId) ??
			getEnvValue(["MAESTRO_USER_ID", "MAESTRO_ACTOR_ID"]),
	};
}

export function buildA2AUserMessage(input: {
	text: string;
	messageId: string;
	contextId?: string;
	taskId?: string;
	metadata?: Record<string, unknown>;
}): A2AMessage {
	return {
		messageId: input.messageId,
		contextId: input.contextId,
		taskId: input.taskId,
		role: "ROLE_USER",
		parts: [{ text: input.text, mediaType: "text/plain" }],
		metadata: input.metadata,
	};
}

export async function discoverA2AAgentCard(
	config: A2AServiceConfig,
	options: { signal?: AbortSignal } = {},
): Promise<A2AAgentCard> {
	const response = await fetchDownstream(
		`${config.baseUrl}/.well-known/agent-card.json`,
		{
			method: "GET",
			headers: buildA2AHeaders(config),
			signal: options.signal,
		},
		{
			serviceName: "platform-a2a",
			failureMode: "required",
			timeoutMs: config.timeoutMs,
			maxAttempts: config.maxAttempts,
		},
	);
	await throwForA2AError(response, "discover agent card");
	return (await response.json()) as A2AAgentCard;
}

export async function sendA2AMessage(
	config: A2AServiceConfig,
	input: SendA2AMessageInput,
	options: { signal?: AbortSignal } = {},
): Promise<SendA2AMessageResult> {
	const { body, traceContext } = buildA2AMessageRequestBody(config, input);
	const response = await fetchDownstream(
		`${config.baseUrl}/message:send`,
		{
			method: "POST",
			headers: buildA2AHeaders(config, traceContext),
			body: JSON.stringify(body),
			signal: options.signal,
		},
		{
			serviceName: "platform-a2a",
			failureMode: "required",
			timeoutMs: config.timeoutMs,
			maxAttempts: config.maxAttempts,
		},
	);
	await throwForA2AError(response, "send message");
	return (await response.json()) as SendA2AMessageResult;
}

export async function* streamA2AMessage(
	config: A2AServiceConfig,
	input: SendA2AMessageInput,
	options: { signal?: AbortSignal } = {},
): AsyncIterable<A2AStreamEvent> {
	const { body, traceContext } = buildA2AMessageRequestBody(config, input);
	const response = await fetchDownstream(
		`${config.baseUrl}/message:stream`,
		{
			method: "POST",
			headers: {
				...buildA2AHeaders(config, traceContext),
				Accept: "text/event-stream",
			},
			body: JSON.stringify(body),
			signal: options.signal,
		},
		{
			serviceName: "platform-a2a",
			failureMode: "required",
			timeoutMs: config.timeoutMs,
			maxAttempts: config.maxAttempts,
		},
	);
	await throwForA2AError(response, "stream message");
	yield* parseA2AStreamEvents(response);
}

export async function* subscribeA2ATask(
	config: A2AServiceConfig,
	taskId: string,
	options: { signal?: AbortSignal; traceContext?: A2ATraceContext } = {},
): AsyncIterable<A2AStreamEvent> {
	const trimmedTaskId = trimString(taskId);
	if (!trimmedTaskId) {
		throw new Error("A2A task id is required");
	}
	const response = await fetchDownstream(
		`${config.baseUrl}/tasks/${encodeURIComponent(trimmedTaskId)}:subscribe`,
		{
			method: "POST",
			headers: {
				...buildA2AHeaders(config, options.traceContext),
				Accept: "text/event-stream",
			},
			signal: options.signal,
		},
		{
			serviceName: "platform-a2a",
			failureMode: "required",
			timeoutMs: config.timeoutMs,
			maxAttempts: config.maxAttempts,
		},
	);
	await throwForA2AError(response, "subscribe task");
	yield* parseA2AStreamEvents(response);
}

function buildA2AMessageRequestBody(
	config: A2AServiceConfig,
	input: SendA2AMessageInput,
): {
	body: Omit<SendA2AMessageInput, "traceContext">;
	traceContext?: A2ATraceContext;
} {
	// `traceContext` is caller control data, not part of the A2A request body.
	// Project it into headers and message metadata so Platform can join
	// the task to traces without receiving a Maestro-private wrapper field.
	const { traceContext: inputTraceContext, ...messageInput } = input;
	const traceContext = resolveA2ATraceContext(inputTraceContext ?? config, {
		envFallback: !inputTraceContext,
	});
	const body = {
		...messageInput,
		message: {
			...input.message,
			metadata: {
				...(input.message.metadata ?? {}),
				workspaceId: config.workspaceId,
				agentId: config.agentId,
				sessionId: config.sessionId,
				actorId: config.actorId,
				...(traceContext?.traceparent
					? { traceparent: traceContext.traceparent }
					: {}),
				...(traceContext?.tracestate
					? { tracestate: traceContext.tracestate }
					: {}),
			},
		},
	};
	return { body, traceContext };
}

export function resolveA2ATraceContext(
	input?: A2ATraceContext,
	options: { envFallback?: boolean } = {},
): A2ATraceContext | undefined {
	const envFallback = options.envFallback ?? true;
	// Explicit trace input wins as a unit. A caller-provided traceparent with no
	// tracestate should not inherit a stale process-level TRACESTATE value.
	const traceparent =
		trimString(input?.traceparent) ??
		(envFallback
			? getEnvValue(["TRACEPARENT", "TRACE_PARENT", "MAESTRO_TRACEPARENT"])
			: undefined);
	const tracestate =
		trimString(input?.tracestate) ??
		(envFallback
			? getEnvValue(["TRACESTATE", "TRACE_STATE", "MAESTRO_TRACESTATE"])
			: undefined);
	if (!traceparent) {
		return undefined;
	}
	return {
		traceparent,
		...(tracestate ? { tracestate } : {}),
	};
}

export async function getA2ATask(
	config: A2AServiceConfig,
	taskId: string,
	options: { signal?: AbortSignal; traceContext?: A2ATraceContext } = {},
): Promise<A2ATask> {
	const trimmedTaskId = trimString(taskId);
	if (!trimmedTaskId) {
		throw new Error("A2A task id is required");
	}
	const response = await fetchDownstream(
		`${config.baseUrl}/tasks/${encodeURIComponent(trimmedTaskId)}`,
		{
			method: "GET",
			headers: buildA2AHeaders(config, options.traceContext),
			signal: options.signal,
		},
		{
			serviceName: "platform-a2a",
			failureMode: "required",
			timeoutMs: config.timeoutMs,
			maxAttempts: config.maxAttempts,
		},
	);
	await throwForA2AError(response, "get task");
	return (await response.json()) as A2ATask;
}

async function* parseA2AStreamEvents(
	response: Response,
): AsyncIterable<A2AStreamEvent> {
	if (!response.body) {
		return;
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let completed = false;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				completed = true;
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			const parsed = splitCompleteServerSentEvents(buffer);
			buffer = parsed.remainder;
			for (const frame of parsed.frames) {
				const event = parseA2AStreamEventFrame(frame);
				if (event) {
					yield event;
				}
			}
		}

		buffer += decoder.decode();
		if (buffer.trim()) {
			const event = parseA2AStreamEventFrame(buffer);
			if (event) {
				yield event;
			}
		}
	} finally {
		if (!completed) {
			await reader.cancel().catch(() => undefined);
		}
		reader.releaseLock();
	}
}

function splitCompleteServerSentEvents(input: string): {
	frames: string[];
	remainder: string;
} {
	const frames: string[] = [];
	let cursor = 0;
	while (cursor < input.length) {
		const lineBreakIndex = findServerSentEventBoundary(input, cursor);
		if (lineBreakIndex === -1) {
			break;
		}
		frames.push(input.slice(cursor, lineBreakIndex.start));
		cursor = lineBreakIndex.end;
	}
	return { frames, remainder: input.slice(cursor) };
}

function findServerSentEventBoundary(
	input: string,
	startIndex: number,
): { start: number; end: number } | -1 {
	for (let index = startIndex; index < input.length; index += 1) {
		const firstLineEndingLength = getServerSentEventLineEndingLength(
			input,
			index,
		);
		if (firstLineEndingLength === 0) {
			continue;
		}
		const secondLineEndingLength = getServerSentEventLineEndingLength(
			input,
			index + firstLineEndingLength,
		);
		if (secondLineEndingLength > 0) {
			return {
				start: index,
				end: index + firstLineEndingLength + secondLineEndingLength,
			};
		}
	}
	return -1;
}

function getServerSentEventLineEndingLength(
	input: string,
	index: number,
): number {
	if (input[index] === "\r") {
		return input[index + 1] === "\n" ? 2 : 1;
	}
	return input[index] === "\n" ? 1 : 0;
}

function parseA2AStreamEventFrame(frame: string): A2AStreamEvent | undefined {
	let eventType: A2AStreamEventType | undefined;
	const dataLines: string[] = [];
	for (const line of frame.split(/\r\n|\n|\r/u)) {
		if (!line || line.startsWith(":")) {
			continue;
		}
		const separatorIndex = line.indexOf(":");
		const field = separatorIndex === -1 ? line : line.slice(0, separatorIndex);
		const rawValue =
			separatorIndex === -1 ? "" : line.slice(separatorIndex + 1);
		const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
		if (field === "event") {
			eventType = parseA2AStreamEventType(value);
		}
		if (field === "data") {
			dataLines.push(value);
		}
	}
	if (dataLines.length === 0) {
		return undefined;
	}

	let payload: Record<string, unknown>;
	try {
		const parsed = JSON.parse(dataLines.join("\n")) as unknown;
		if (!isRecord(parsed)) {
			return undefined;
		}
		payload = parsed;
	} catch {
		return undefined;
	}
	payload = unwrapA2AStreamPayload(payload);
	eventType ??= inferA2AStreamEventType(payload);
	if (!eventType) {
		return undefined;
	}
	return normalizeA2AStreamEvent(eventType, payload);
}

function parseA2AStreamEventType(
	value: string,
): A2AStreamEventType | undefined {
	if (
		value === "task" ||
		value === "message" ||
		value === "statusUpdate" ||
		value === "artifactUpdate"
	) {
		return value;
	}
	return undefined;
}

function inferA2AStreamEventType(
	payload: Record<string, unknown>,
): A2AStreamEventType | undefined {
	if (isRecord(payload.task)) {
		return "task";
	}
	if (isRecord(payload.message)) {
		return "message";
	}
	if (isRecord(payload.statusUpdate)) {
		return "statusUpdate";
	}
	if (isRecord(payload.artifactUpdate) || isRecord(payload.artifact)) {
		return "artifactUpdate";
	}
	if (isRecord(payload.status) && typeof payload.id === "string") {
		return "task";
	}
	if (isRecord(payload.status)) {
		return "statusUpdate";
	}
	if (
		typeof payload.messageId === "string" &&
		typeof payload.role === "string"
	) {
		return "message";
	}
	return undefined;
}

function unwrapA2AStreamPayload(
	payload: Record<string, unknown>,
): Record<string, unknown> {
	return payload.jsonrpc === "2.0" && isRecord(payload.result)
		? payload.result
		: payload;
}

function normalizeA2AStreamEvent(
	eventType: A2AStreamEventType,
	payload: Record<string, unknown>,
): A2AStreamEvent {
	if (eventType === "task") {
		return {
			type: "task",
			task: (payload.task ?? payload) as A2ATask,
		};
	}
	if (eventType === "message") {
		return {
			type: "message",
			message: (payload.message ?? payload) as A2AMessage,
		};
	}
	if (eventType === "statusUpdate") {
		const statusUpdatePayload = isRecord(payload.statusUpdate)
			? payload.statusUpdate
			: payload;
		return {
			...statusUpdatePayload,
			type: "statusUpdate",
			status: statusUpdatePayload.status as A2ATaskStatus,
		};
	}
	const artifactUpdatePayload = isRecord(payload.artifactUpdate)
		? payload.artifactUpdate
		: payload;
	return {
		...artifactUpdatePayload,
		type: "artifactUpdate",
		artifact: artifactUpdatePayload.artifact as A2AArtifact,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildA2AHeaders(
	config: A2AServiceConfig,
	traceContext?: A2ATraceContext,
): Record<string, string> {
	// Header projection mirrors message metadata projection: intermediaries can
	// route and trace the HTTP request, while the task itself keeps durable
	// correlation metadata for later lookup.
	const resolvedTraceContext = resolveA2ATraceContext(traceContext ?? config, {
		envFallback: !traceContext,
	});
	return buildPlatformJsonHeaders(config, {
		"X-EvalOps-Workspace-Id": config.workspaceId,
		"X-EvalOps-Agent-Id": config.agentId,
		"X-EvalOps-Session-Id": config.sessionId,
		"X-EvalOps-Actor-Id": config.actorId,
		traceparent: resolvedTraceContext?.traceparent,
		tracestate: resolvedTraceContext?.tracestate,
	});
}

async function throwForA2AError(
	response: Response,
	operation: string,
): Promise<void> {
	if (response.ok) {
		return;
	}
	let detail = "";
	try {
		const payload = (await response.json()) as {
			error?: { code?: string; message?: string };
		};
		detail = payload.error?.message ?? payload.error?.code ?? "";
	} catch {
		detail = await response.text().catch(() => "");
	}
	throw new Error(
		`Platform A2A ${operation} failed with ${response.status}${
			detail ? `: ${detail}` : ""
		}`,
	);
}
