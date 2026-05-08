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

export interface A2ATraceContext {
	traceparent?: string;
	tracestate?: string;
}

function normalizeA2ABaseUrl(baseUrl: string): string {
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
