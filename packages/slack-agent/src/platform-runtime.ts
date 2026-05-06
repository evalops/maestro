import type { SlackContext } from "./slack/bot.js";

type JsonRecord = Record<string, unknown>;

export interface PlatformRuntimeConfig {
	baseUrl: string;
	token?: string;
	organizationId?: string;
	workspaceId?: string;
	agentId: string;
	timeoutMs: number;
	fetchImpl: typeof fetch;
	now: () => Date;
}

export interface SlackRuntimeTriggerOptions {
	workingDir?: string | undefined;
	channelDir: string;
	prompt: string;
	model?: string | undefined;
	config?: PlatformRuntimeConfig | null | undefined;
}

export interface PlatformRuntimeTriggerResult {
	runId?: string;
	idempotentReplay?: boolean;
}

export type SlackRuntimeEventType =
	| "RUNTIME_EVENT_TYPE_CHANNEL_MESSAGE_RECORDED"
	| "RUNTIME_EVENT_TYPE_MODEL_RESPONSE_RECORDED"
	| "RUNTIME_EVENT_TYPE_TOOL_CALL_RECORDED"
	| "RUNTIME_EVENT_TYPE_TOOL_RESULT_RECORDED"
	| "RUNTIME_EVENT_TYPE_APPROVAL_REQUESTED"
	| "RUNTIME_EVENT_TYPE_APPROVAL_RESOLVED"
	| "RUNTIME_EVENT_TYPE_AGENT_PROGRESS_RECORDED";

export interface SlackRuntimeEventOptions {
	runId: string;
	type: SlackRuntimeEventType;
	message: string;
	attributes?: JsonRecord | undefined;
	visibility?: JsonRecord | undefined;
	config?: PlatformRuntimeConfig | null | undefined;
}

export interface PlatformRuntimeEventResult {
	eventId?: string;
	sequence?: number;
}

const BASE_URL_ENV = [
	"SLACK_AGENT_PLATFORM_RUNTIME_URL",
	"MAESTRO_AGENT_RUNTIME_SERVICE_URL",
	"AGENT_RUNTIME_SERVICE_URL",
] as const;

const TOKEN_ENV = [
	"SLACK_AGENT_PLATFORM_RUNTIME_TOKEN",
	"MAESTRO_AGENT_RUNTIME_SERVICE_TOKEN",
	"AGENT_RUNTIME_SERVICE_TOKEN",
	"MAESTRO_EVALOPS_ACCESS_TOKEN",
	"EVALOPS_TOKEN",
] as const;

const WORKSPACE_ENV = [
	"SLACK_AGENT_PLATFORM_WORKSPACE_ID",
	"MAESTRO_AGENT_RUNTIME_WORKSPACE_ID",
	"AGENT_RUNTIME_WORKSPACE_ID",
	"MAESTRO_WORKSPACE_ID",
	"EVALOPS_WORKSPACE_ID",
] as const;

const ORGANIZATION_ENV = [
	"SLACK_AGENT_PLATFORM_ORGANIZATION_ID",
	"MAESTRO_AGENT_RUNTIME_ORG_ID",
	"MAESTRO_AGENT_RUNTIME_ORGANIZATION_ID",
	"AGENT_RUNTIME_ORGANIZATION_ID",
	"AGENT_RUNTIME_ORG_ID",
	"MAESTRO_EVALOPS_ORG_ID",
	"EVALOPS_ORGANIZATION_ID",
	"EVALOPS_ORG_ID",
] as const;

const AGENT_ENV = [
	"SLACK_AGENT_PLATFORM_AGENT_ID",
	"MAESTRO_AGENT_RUNTIME_AGENT_ID",
] as const;

const HANDLE_TRIGGER_PATH =
	"/agentruntime.v1.AgentRuntimeService/HandleTrigger";
const RECORD_RUN_EVENT_PATH =
	"/agentruntime.v1.AgentRuntimeService/RecordRunEvent";
const AGENT_RUNTIME_SERVICE_SUFFIX = "/agentruntime.v1.AgentRuntimeService";
const DEFAULT_AGENT_ID = "maestro-slack-agent";
const DEFAULT_TIMEOUT_MS = 2_000;

export function resolvePlatformRuntimeConfig(
	env: NodeJS.ProcessEnv = process.env,
	fetchImpl: typeof fetch = fetch,
): PlatformRuntimeConfig | null {
	const baseUrl = firstEnv(env, BASE_URL_ENV);
	if (!baseUrl) {
		return null;
	}
	return {
		baseUrl: normalizeAgentRuntimeBaseUrl(baseUrl),
		token: firstEnv(env, TOKEN_ENV),
		organizationId: firstEnv(env, ORGANIZATION_ENV),
		workspaceId: firstEnv(env, WORKSPACE_ENV),
		agentId: firstEnv(env, AGENT_ENV) ?? DEFAULT_AGENT_ID,
		timeoutMs:
			positiveInt(env.SLACK_AGENT_PLATFORM_RUNTIME_TIMEOUT_MS) ??
			DEFAULT_TIMEOUT_MS,
		fetchImpl,
		now: () => new Date(),
	};
}

export function buildSlackAgentRuntimeTrigger(
	ctx: SlackContext,
	options: SlackRuntimeTriggerOptions,
): JsonRecord | null {
	const config = options.config ?? resolvePlatformRuntimeConfig();
	if (!config) {
		return null;
	}

	const workspaceId = config.workspaceId ?? ctx.teamId;
	const messageTs =
		clean(ctx.message.ts) ?? clean(ctx.runId) ?? config.now().toISOString();
	const threadId =
		clean(ctx.threadKey) ?? clean(ctx.message.threadTs) ?? messageTs;
	const source = ctx.source ?? "channel";
	const sourceEventId = sourceEventIdFor(ctx, messageTs);
	const idempotencyKey = [
		"maestro-slack",
		workspaceId,
		ctx.message.channel,
		source,
		sourceEventId,
	].join(":");
	const envelopeKind =
		source === "dm"
			? "RUNTIME_WORK_ENVELOPE_KIND_DIRECT_CONVERSATION"
			: "RUNTIME_WORK_ENVELOPE_KIND_CONVERSATION_THREAD";

	return {
		workspaceId,
		agentId: config.agentId,
		surface: "slack",
		surfaceType: "SURFACE_SLACK",
		channelId: ctx.message.channel,
		idempotencyKey,
		sourceEventId,
		sourceEventType: slackSourceEventType(source),
		actorId: ctx.message.user,
		correlationId: ctx.message.user,
		receivedAt: config.now().toISOString(),
		triggerKind: slackTriggerKind(source),
		channelContext: {
			channelKind: "RUNTIME_CHANNEL_KIND_SLACK",
			providerWorkspaceId: ctx.teamId,
			channelId: ctx.message.channel,
			threadId,
			messageId: messageTs,
			actorId: ctx.message.user,
			attributes: compactStrings({
				channel_name: ctx.channelName,
				source,
				slack_user_name: ctx.message.userName,
				slack_team_id: ctx.teamId,
				source_event_id: sourceEventId,
				maestro_run_id: ctx.runId,
				task_id: ctx.taskId,
			}),
		},
		workEnvelope: {
			id: ["slack", ctx.teamId, ctx.message.channel, threadId].join(":"),
			kind: envelopeKind,
			rootId: threadId,
			attributes: compactStrings({
				source,
				channel_id: ctx.message.channel,
				channel_name: ctx.channelName,
				thread_ts: ctx.message.threadTs ?? threadId,
			}),
		},
		payload: {
			slack_agent: {
				runId: ctx.runId,
				taskId: ctx.taskId,
				sourceEventId,
				source,
				useThread: ctx.useThread,
			},
			message: {
				text: options.prompt,
				rawText: ctx.message.rawText,
				ts: ctx.message.ts,
				threadTs: ctx.message.threadTs,
				channel: ctx.message.channel,
				user: ctx.message.user,
				userName: ctx.message.userName,
				attachmentCount: ctx.message.attachments.length,
			},
			execution: compactStrings({
				workingDir: options.workingDir,
				channelDir: options.channelDir,
				model: options.model,
			}),
		},
	};
}

export async function recordSlackAgentRuntimeTrigger(
	ctx: SlackContext,
	options: SlackRuntimeTriggerOptions,
): Promise<PlatformRuntimeTriggerResult | null> {
	const config = options.config ?? resolvePlatformRuntimeConfig();
	if (!config) {
		return null;
	}
	const trigger = buildSlackAgentRuntimeTrigger(ctx, { ...options, config });
	if (!trigger) {
		return null;
	}

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
	try {
		const response = await config.fetchImpl(
			`${config.baseUrl}${HANDLE_TRIGGER_PATH}`,
			{
				method: "POST",
				headers: buildRuntimeHeaders(config),
				body: JSON.stringify({ trigger }),
				signal: controller.signal,
			},
		);
		if (!response.ok) {
			throw new Error(`AgentRuntime returned ${response.status}`);
		}
		const body = (await response.json()) as JsonRecord;
		const run = readRecord(body.run);
		return {
			runId: readString(run?.id),
			idempotentReplay: readBoolean(body.idempotentReplay),
		};
	} finally {
		clearTimeout(timeout);
	}
}

export function buildSlackAgentRuntimeEvent(
	ctx: SlackContext,
	options: SlackRuntimeEventOptions,
): JsonRecord | null {
	const config = options.config ?? resolvePlatformRuntimeConfig();
	const runId = clean(options.runId);
	const message = clean(options.message);
	if (!config || !runId || !message) {
		return null;
	}
	const messageTs =
		clean(ctx.message.ts) ?? clean(ctx.runId) ?? config.now().toISOString();
	const sourceEventId = sourceEventIdFor(ctx, messageTs);
	const baseAttributes: JsonRecord = compactJson({
		adapter: "maestro-slack-agent",
		surface: "slack",
		source: ctx.source ?? "channel",
		source_event_id: sourceEventId,
		maestro_run_id: ctx.runId,
		task_id: ctx.taskId,
		slack_team_id: ctx.teamId,
		slack_channel_id: ctx.message.channel,
		slack_channel_name: ctx.channelName,
		slack_thread_ts: ctx.message.threadTs ?? ctx.threadKey ?? messageTs,
		slack_message_ts: messageTs,
		slack_actor_id: ctx.message.user,
		slack_actor_name: ctx.message.userName,
	});
	return {
		runId,
		type: options.type,
		message,
		attributes: {
			...baseAttributes,
			...(options.attributes ?? {}),
		},
		visibility:
			options.visibility ??
			channelVisibleRuntimeVisibility(
				safeRuntimeSummary(message, options.attributes),
			),
	};
}

export async function recordSlackAgentRuntimeEvent(
	ctx: SlackContext,
	options: SlackRuntimeEventOptions,
): Promise<PlatformRuntimeEventResult | null> {
	const config = options.config ?? resolvePlatformRuntimeConfig();
	if (!config) {
		return null;
	}
	const event = buildSlackAgentRuntimeEvent(ctx, { ...options, config });
	if (!event) {
		return null;
	}

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
	try {
		const response = await config.fetchImpl(
			`${config.baseUrl}${RECORD_RUN_EVENT_PATH}`,
			{
				method: "POST",
				headers: buildRuntimeHeaders(config),
				body: JSON.stringify(event),
				signal: controller.signal,
			},
		);
		if (!response.ok) {
			throw new Error(`AgentRuntime returned ${response.status}`);
		}
		const body = (await response.json()) as JsonRecord;
		const recorded = readRecord(body.event);
		const sequence = readNumber(recorded?.sequence);
		return {
			eventId: readString(recorded?.id),
			sequence,
		};
	} finally {
		clearTimeout(timeout);
	}
}

function buildRuntimeHeaders(
	config: PlatformRuntimeConfig,
): Record<string, string> {
	return compactStrings({
		Authorization: config.token ? `Bearer ${config.token}` : undefined,
		"Content-Type": "application/json",
		"Connect-Protocol-Version": "1",
		"X-Organization-ID": config.organizationId,
	});
}

function normalizeAgentRuntimeBaseUrl(value: string): string {
	let normalized = value.trim().replace(/\/+$/, "");
	for (const suffix of [HANDLE_TRIGGER_PATH, AGENT_RUNTIME_SERVICE_SUFFIX]) {
		if (normalized.endsWith(suffix)) {
			normalized = normalized.slice(0, -suffix.length).replace(/\/+$/, "");
		}
	}
	return normalized;
}

function firstEnv(
	env: NodeJS.ProcessEnv,
	names: readonly string[],
): string | undefined {
	for (const name of names) {
		const value = clean(env[name]);
		if (value) {
			return value;
		}
	}
	return undefined;
}

function compactJson(values: Record<string, unknown>): JsonRecord {
	const result: JsonRecord = {};
	for (const [key, value] of Object.entries(values)) {
		if (typeof value === "string") {
			const cleaned = clean(value);
			if (cleaned) {
				result[key] = cleaned;
			}
			continue;
		}
		if (value !== undefined && value !== null) {
			result[key] = value;
		}
	}
	return result;
}

function channelVisibleRuntimeVisibility(safeSummary: string): JsonRecord {
	return {
		level: "RUNTIME_VISIBILITY_LEVEL_CHANNEL_VISIBLE",
		audiences: ["RUNTIME_AUDIENCE_CHANNEL", "RUNTIME_AUDIENCE_AUDIT"],
		sensitivity: "RUNTIME_SENSITIVITY_PUBLIC",
		safeSummary,
	};
}

function safeRuntimeSummary(
	message: string,
	attributes: JsonRecord | undefined,
): string {
	const raw =
		readString(attributes?.safeSummary) ??
		readString(attributes?.safe_summary) ??
		message;
	return raw.length > 240 ? `${raw.slice(0, 237)}...` : raw;
}

function clean(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function positiveInt(value: string | undefined): number | undefined {
	const parsed = Number.parseInt(value ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function sourceEventIdFor(ctx: SlackContext, messageTs: string): string {
	const configured = clean(ctx.sourceEventId);
	if (configured) {
		return configured;
	}
	if (ctx.source === "scheduled" && ctx.taskId) {
		return `scheduled:${ctx.taskId}`;
	}
	return messageTs;
}

function compactStrings(
	values: Record<string, string | undefined>,
): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(values)) {
		const cleaned = clean(value);
		if (cleaned) {
			result[key] = cleaned;
		}
	}
	return result;
}

function slackSourceEventType(source: SlackContext["source"]): string {
	switch (source) {
		case "dm":
			return "slack.direct_message";
		case "slash":
			return "slack.slash_command";
		case "scheduled":
			return "slack.scheduled_task";
		case "trigger":
			return "slack.webhook_trigger";
		default:
			return "slack.app_mention";
	}
}

function slackTriggerKind(source: SlackContext["source"]): string {
	switch (source) {
		case "dm":
			return "RUNTIME_TRIGGER_KIND_SLACK_DIRECT_MESSAGE";
		case "slash":
			return "RUNTIME_TRIGGER_KIND_SLACK_SLASH_COMMAND";
		case "scheduled":
			return "RUNTIME_TRIGGER_KIND_SCHEDULE";
		case "trigger":
			return "RUNTIME_TRIGGER_KIND_ENSEMBLE_WEBHOOK_EVENT";
		default:
			return "RUNTIME_TRIGGER_KIND_SLACK_APP_MENTION";
	}
}

function readRecord(value: unknown): JsonRecord | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as JsonRecord)
		: undefined;
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}
