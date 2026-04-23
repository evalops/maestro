import { randomUUID } from "node:crypto";
import type { JetStreamClient, NatsConnection } from "nats";
import type { PromptMetadata } from "../prompts/types.js";
import type { SkillArtifactMetadata } from "../skills/artifact-metadata.js";
import {
	MaestroBusEventType,
	getMaestroBusEventCatalogEntry,
} from "./maestro-event-catalog.js";
export { MaestroBusEventType } from "./maestro-event-catalog.js";

type Env = NodeJS.ProcessEnv;

export type MaestroSurface =
	| "MAESTRO_SURFACE_CLI"
	| "MAESTRO_SURFACE_TUI"
	| "MAESTRO_SURFACE_WEB"
	| "MAESTRO_SURFACE_IDE"
	| "MAESTRO_SURFACE_GITHUB_AGENT"
	| "MAESTRO_SURFACE_DESKTOP"
	| "MAESTRO_SURFACE_REMOTE_RUNNER";

export type MaestroRuntimeMode =
	| "MAESTRO_RUNTIME_MODE_LOCAL"
	| "MAESTRO_RUNTIME_MODE_HEADLESS"
	| "MAESTRO_RUNTIME_MODE_HOSTED"
	| "MAESTRO_RUNTIME_MODE_REMOTE_ATTACHED";

export type MaestroSessionState =
	| "MAESTRO_SESSION_STATE_STARTED"
	| "MAESTRO_SESSION_STATE_SUSPENDED"
	| "MAESTRO_SESSION_STATE_RESUMED"
	| "MAESTRO_SESSION_STATE_CLOSED";

export type MaestroCloseReason =
	| "MAESTRO_CLOSE_REASON_COMPLETED"
	| "MAESTRO_CLOSE_REASON_USER_STOPPED"
	| "MAESTRO_CLOSE_REASON_IDLE_TIMEOUT"
	| "MAESTRO_CLOSE_REASON_TTL_EXPIRED"
	| "MAESTRO_CLOSE_REASON_ERROR"
	| "MAESTRO_CLOSE_REASON_POLICY_DENIED";

export type MaestroDecisionMode =
	| "MAESTRO_DECISION_MODE_ALLOW"
	| "MAESTRO_DECISION_MODE_REQUIRE_APPROVAL"
	| "MAESTRO_DECISION_MODE_DENY"
	| "MAESTRO_DECISION_MODE_AUTO_APPROVED";

export type MaestroToolCallStatus =
	| "MAESTRO_TOOL_CALL_STATUS_SUCCEEDED"
	| "MAESTRO_TOOL_CALL_STATUS_FAILED"
	| "MAESTRO_TOOL_CALL_STATUS_DENIED"
	| "MAESTRO_TOOL_CALL_STATUS_CANCELLED";

export interface MaestroCorrelation {
	organization_id?: string;
	workspace_id: string;
	session_id: string;
	agent_run_id?: string;
	agent_run_step_id?: string;
	agent_id?: string;
	actor_id?: string;
	principal_id?: string;
	trace_id?: string;
	request_id?: string;
	parent_event_id?: string;
	remote_runner_session_id?: string;
	objective_id?: string;
	conversation_id?: string;
	attributes?: Record<string, string>;
}

export interface MaestroPrincipal {
	subject: string;
	user_id?: string;
	organization_id?: string;
	workspace_id?: string;
	roles?: string[];
	scopes?: string[];
	claims?: Record<string, string>;
}

export interface MaestroCloudEvent<TData extends Record<string, unknown>> {
	spec_version: "1.0";
	id: string;
	type: MaestroBusEventType;
	source: string;
	subject: string;
	time: string;
	data_content_type: "application/protobuf";
	tenant_id?: string;
	data: TData & { "@type": string };
	extensions: {
		dataschema: string;
		[key: string]: string;
	};
}

export interface MaestroSessionEventData extends Record<string, unknown> {
	correlation: MaestroCorrelation;
	state: MaestroSessionState;
	surface: MaestroSurface;
	runtime_mode: MaestroRuntimeMode;
	principal?: MaestroPrincipal;
	workspace_root?: string;
	repository?: string;
	git_ref?: string;
	runtime_version?: string;
	runner_profile?: string;
	started_at?: string;
	suspended_at?: string;
	resumed_at?: string;
	closed_at?: string;
	close_reason?: MaestroCloseReason;
	close_message?: string;
	metadata?: Record<string, unknown>;
}

export interface ApprovalHitEventData extends Record<string, unknown> {
	correlation: MaestroCorrelation;
	approval_request_id?: string;
	governance_decision_id?: string;
	action: string;
	command?: string;
	risk_level?: string;
	decision_mode: MaestroDecisionMode;
	policy_id?: string;
	reason?: string;
	context?: Record<string, unknown>;
	occurred_at: string;
}

export interface SandboxViolationEventData extends Record<string, unknown> {
	correlation: MaestroCorrelation;
	policy_id?: string;
	operation: string;
	resource: string;
	workspace_root?: string;
	attempted_path?: string;
	reason?: string;
	context?: Record<string, unknown>;
	occurred_at: string;
}

export interface FirewallBlockEventData extends Record<string, unknown> {
	correlation: MaestroCorrelation;
	rule_id?: string;
	operation: string;
	target: string;
	protocol?: string;
	port?: number;
	reason?: string;
	context?: Record<string, unknown>;
	occurred_at: string;
}

export interface ToolCallAttemptEventData extends Record<string, unknown> {
	correlation: MaestroCorrelation;
	tool_call_id: string;
	tool_execution_id?: string;
	prompt_metadata?: PromptMetadata;
	skill_metadata?: SkillArtifactMetadata;
	tool_namespace?: string;
	tool_name: string;
	tool_version?: string;
	capability?: string;
	connector_id?: string;
	mutates_resource?: boolean;
	risk_level?: string;
	safe_arguments?: Record<string, unknown>;
	redactions?: string[];
	idempotency_key?: string;
	attempted_at: string;
}

export interface ToolCallResultEventData extends Record<string, unknown> {
	correlation: MaestroCorrelation;
	tool_call_id: string;
	tool_execution_id?: string;
	prompt_metadata?: PromptMetadata;
	skill_metadata?: SkillArtifactMetadata;
	approval_request_id?: string;
	governed_outcome?: string;
	status: MaestroToolCallStatus;
	duration?: string;
	safe_output?: Record<string, unknown>;
	redactions?: string[];
	error_code?: string;
	error_message?: string;
	completed_at: string;
}

export interface MaestroEventBusConfig {
	enabled: boolean;
	reason: string;
	natsUrl?: string;
	natsToken?: string;
	natsUser?: string;
	natsPassword?: string;
	source: string;
	tenantId?: string;
	defaultSurface: MaestroSurface;
	defaultRuntimeMode: MaestroRuntimeMode;
	defaultCorrelation: MaestroCorrelation;
	defaultPrincipal?: MaestroPrincipal;
}

export interface MaestroEventBusStatus {
	enabled: boolean;
	reason: string;
	natsUrl?: string;
	source: string;
	tenantId?: string;
	defaultSurface: MaestroSurface;
	defaultRuntimeMode: MaestroRuntimeMode;
}

export interface PromptVariantSelectedEventData
	extends Record<string, unknown> {
	correlation: MaestroCorrelation;
	prompt_metadata: PromptMetadata;
	selected_at: string;
}

export interface SkillInvocationEventData extends Record<string, unknown> {
	correlation: MaestroCorrelation;
	prompt_metadata?: PromptMetadata;
	skill_metadata: SkillArtifactMetadata;
	tool_call_id: string;
	tool_execution_id?: string;
	invoked_at: string;
}

export type MaestroSkillOutcomeStatus =
	| "success"
	| "error"
	| "aborted"
	| "rate_limited";

export interface SkillOutcomeEventData extends Record<string, unknown> {
	correlation: MaestroCorrelation;
	prompt_metadata?: PromptMetadata;
	skill_metadata: SkillArtifactMetadata;
	tool_call_id?: string;
	tool_execution_id?: string;
	turn_status: MaestroSkillOutcomeStatus;
	error_category?: string;
	error_message?: string;
	stop_reason?: string;
	outcome_at: string;
}

export interface MaestroEventBusTransport {
	publish(subject: string, payload: string): Promise<void>;
	close?(): Promise<void>;
}

export interface PublishMaestroEventOptions {
	env?: Env;
	eventId?: string;
	source?: string;
	subject?: string;
	tenantId?: string;
	correlation?: Partial<MaestroCorrelation>;
	principal?: MaestroPrincipal | null;
	time?: string | Date;
}

export type MaestroTelemetryMirrorEvent = {
	type: string;
	timestamp: string;
};

export interface RecordMaestroApprovalHitInput {
	approval_request_id?: string;
	governance_decision_id?: string;
	action: string;
	command?: string;
	risk_level?: string;
	decision_mode: MaestroDecisionMode;
	policy_id?: string;
	reason?: string;
	context?: Record<string, unknown>;
	correlation?: Partial<MaestroCorrelation>;
	occurred_at?: string;
	env?: Env;
}

export interface RecordMaestroFirewallBlockInput {
	rule_id?: string;
	operation: string;
	target: string;
	protocol?: string;
	port?: number;
	reason?: string;
	context?: Record<string, unknown>;
	correlation?: Partial<MaestroCorrelation>;
	occurred_at?: string;
	env?: Env;
}

export interface RecordMaestroToolCallAttemptInput {
	tool_call_id: string;
	tool_execution_id?: string;
	prompt_metadata?: PromptMetadata;
	skill_metadata?: SkillArtifactMetadata;
	tool_namespace?: string;
	tool_name: string;
	tool_version?: string;
	capability?: string;
	connector_id?: string;
	mutates_resource?: boolean;
	risk_level?: string;
	safe_arguments?: Record<string, unknown>;
	redactions?: string[];
	idempotency_key?: string;
	correlation?: Partial<MaestroCorrelation>;
	attempted_at?: string;
	env?: Env;
}

export interface RecordMaestroToolCallCompletedInput {
	tool_call_id: string;
	tool_execution_id?: string;
	prompt_metadata?: PromptMetadata;
	skill_metadata?: SkillArtifactMetadata;
	approval_request_id?: string;
	governed_outcome?: string;
	status: MaestroToolCallStatus;
	duration?: string;
	safe_output?: Record<string, unknown>;
	redactions?: string[];
	error_code?: string;
	error_message?: string;
	correlation?: Partial<MaestroCorrelation>;
	completed_at?: string;
	env?: Env;
}

export interface RecordMaestroPromptVariantSelectedInput {
	prompt_metadata: PromptMetadata;
	correlation?: Partial<MaestroCorrelation>;
	selected_at?: string;
	env?: Env;
}

export interface RecordMaestroSkillInvokedInput {
	prompt_metadata?: PromptMetadata;
	skill_metadata: SkillArtifactMetadata;
	tool_call_id: string;
	tool_execution_id?: string;
	correlation?: Partial<MaestroCorrelation>;
	invoked_at?: string;
	env?: Env;
}

export interface RecordMaestroSkillOutcomeInput {
	prompt_metadata?: PromptMetadata;
	skill_metadata: SkillArtifactMetadata;
	tool_call_id?: string;
	tool_execution_id?: string;
	turn_status: MaestroSkillOutcomeStatus;
	error_category?: string;
	error_message?: string;
	stop_reason?: string;
	correlation?: Partial<MaestroCorrelation>;
	outcome_at?: string;
	env?: Env;
}

let transportOverride: MaestroEventBusTransport | null | undefined;
let natsTransportPromise:
	| Promise<{ key: string; transport: MaestroEventBusTransport }>
	| undefined;

function readEnv(env: Env, names: readonly string[]): string | undefined {
	for (const name of names) {
		const value = env[name]?.trim();
		if (value) return value;
	}
	return undefined;
}

function readBoolean(value: string | undefined): boolean | undefined {
	if (!value) return undefined;
	switch (value.toLowerCase()) {
		case "1":
		case "true":
		case "yes":
		case "on":
			return true;
		case "0":
		case "false":
		case "no":
		case "off":
			return false;
		default:
			return undefined;
	}
}

function readStringRecord(
	env: Env,
	prefix: string,
): Record<string, string> | undefined {
	const output: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (!key.startsWith(prefix) || typeof value !== "string" || !value.trim()) {
			continue;
		}
		output[key.slice(prefix.length).toLowerCase()] = value.trim();
	}
	return Object.keys(output).length > 0 ? output : undefined;
}

function normalizeSurface(value: string | undefined): MaestroSurface {
	switch (value?.toLowerCase()) {
		case "cli":
			return "MAESTRO_SURFACE_CLI";
		case "web":
			return "MAESTRO_SURFACE_WEB";
		case "ide":
		case "vscode":
		case "jetbrains":
			return "MAESTRO_SURFACE_IDE";
		case "github":
		case "github-agent":
			return "MAESTRO_SURFACE_GITHUB_AGENT";
		case "desktop":
			return "MAESTRO_SURFACE_DESKTOP";
		case "remote":
		case "remote-runner":
			return "MAESTRO_SURFACE_REMOTE_RUNNER";
		default:
			return "MAESTRO_SURFACE_TUI";
	}
}

function normalizeRuntimeMode(value: string | undefined): MaestroRuntimeMode {
	switch (value?.toLowerCase()) {
		case "headless":
			return "MAESTRO_RUNTIME_MODE_HEADLESS";
		case "hosted":
			return "MAESTRO_RUNTIME_MODE_HOSTED";
		case "remote":
		case "remote-attached":
			return "MAESTRO_RUNTIME_MODE_REMOTE_ATTACHED";
		default:
			return "MAESTRO_RUNTIME_MODE_LOCAL";
	}
}

function managedEvalOpsRoutingActive(env: Env): boolean {
	return Boolean(
		readEnv(env, ["MAESTRO_EVALOPS_ACCESS_TOKEN"]) &&
			readEnv(env, [
				"MAESTRO_EVALOPS_ORG_ID",
				"EVALOPS_ORGANIZATION_ID",
				"MAESTRO_ENTERPRISE_ORG_ID",
			]),
	);
}

function defaultCorrelation(env: Env): MaestroCorrelation {
	const workspaceId =
		readEnv(env, ["MAESTRO_EVALOPS_WORKSPACE_ID", "EVALOPS_WORKSPACE_ID"]) ??
		env.PWD ??
		process.cwd();
	const sessionId = readEnv(env, ["MAESTRO_SESSION_ID"]) ?? "unknown";

	return {
		organization_id: readEnv(env, [
			"MAESTRO_EVALOPS_ORG_ID",
			"EVALOPS_ORGANIZATION_ID",
			"MAESTRO_ENTERPRISE_ORG_ID",
		]),
		workspace_id: workspaceId,
		session_id: sessionId,
		agent_run_id: readEnv(env, ["MAESTRO_AGENT_RUN_ID"]),
		agent_id: readEnv(env, ["MAESTRO_AGENT_ID"]),
		actor_id: readEnv(env, ["MAESTRO_ACTOR_ID"]),
		principal_id: readEnv(env, ["MAESTRO_PRINCIPAL_ID"]),
		trace_id: readEnv(env, ["TRACE_ID", "OTEL_TRACE_ID"]),
		request_id: readEnv(env, ["MAESTRO_REQUEST_ID"]),
		remote_runner_session_id: readEnv(env, [
			"MAESTRO_REMOTE_RUNNER_SESSION_ID",
		]),
		objective_id: readEnv(env, ["MAESTRO_OBJECTIVE_ID"]),
		conversation_id: readEnv(env, ["MAESTRO_CONVERSATION_ID"]),
		attributes: readStringRecord(env, "MAESTRO_EVENT_BUS_ATTR_"),
	};
}

function defaultPrincipal(env: Env): MaestroPrincipal | undefined {
	const subject = readEnv(env, [
		"MAESTRO_PRINCIPAL_SUBJECT",
		"MAESTRO_USER_SUBJECT",
		"USER",
	]);
	if (!subject) return undefined;
	return {
		subject,
		user_id: readEnv(env, ["MAESTRO_USER_ID"]),
		organization_id: readEnv(env, [
			"MAESTRO_EVALOPS_ORG_ID",
			"EVALOPS_ORGANIZATION_ID",
		]),
		workspace_id: readEnv(env, [
			"MAESTRO_EVALOPS_WORKSPACE_ID",
			"EVALOPS_WORKSPACE_ID",
		]),
		roles: readEnv(env, ["MAESTRO_PRINCIPAL_ROLES"])
			?.split(",")
			.map((role) => role.trim())
			.filter(Boolean),
		scopes: readEnv(env, ["MAESTRO_PRINCIPAL_SCOPES"])
			?.split(",")
			.map((scope) => scope.trim())
			.filter(Boolean),
		claims: readStringRecord(env, "MAESTRO_PRINCIPAL_CLAIM_"),
	};
}

export function resolveMaestroEventBusConfig(
	env: Env = process.env,
): MaestroEventBusConfig {
	const flag = readBoolean(
		readEnv(env, ["MAESTRO_EVENT_BUS", "MAESTRO_AUDIT_BUS"]),
	);
	const natsUrl = readEnv(env, [
		"MAESTRO_EVENT_BUS_URL",
		"EVALOPS_NATS_URL",
		"NATS_URL",
	]);
	const managedRouting = managedEvalOpsRoutingActive(env);
	const enabled =
		flag === false ? false : (flag ?? Boolean(natsUrl || managedRouting));
	let reason = "disabled";
	if (flag === false) reason = "flag disabled";
	else if (natsUrl) reason = "nats";
	else if (managedRouting) reason = "managed evalops routing";
	else if (flag === true) reason = "flag enabled";

	return {
		enabled,
		reason,
		natsUrl,
		natsToken: readEnv(env, ["MAESTRO_EVENT_BUS_TOKEN", "NATS_TOKEN"]),
		natsUser: readEnv(env, ["MAESTRO_EVENT_BUS_USER", "NATS_USER"]),
		natsPassword: readEnv(env, ["MAESTRO_EVENT_BUS_PASSWORD", "NATS_PASSWORD"]),
		source: readEnv(env, ["MAESTRO_EVENT_BUS_SOURCE"]) ?? "maestro",
		tenantId: readEnv(env, [
			"MAESTRO_EVALOPS_ORG_ID",
			"EVALOPS_ORGANIZATION_ID",
			"MAESTRO_ENTERPRISE_ORG_ID",
		]),
		defaultSurface: normalizeSurface(
			readEnv(env, ["MAESTRO_SURFACE", "MAESTRO_EVENT_SURFACE"]),
		),
		defaultRuntimeMode: normalizeRuntimeMode(
			readEnv(env, ["MAESTRO_RUNTIME_MODE"]),
		),
		defaultCorrelation: defaultCorrelation(env),
		defaultPrincipal: defaultPrincipal(env),
	};
}

export function getMaestroEventBusStatus(
	env: Env = process.env,
): MaestroEventBusStatus {
	const config = resolveMaestroEventBusConfig(env);
	return {
		enabled: config.enabled,
		reason:
			config.enabled && !config.natsUrl ? "missing nats url" : config.reason,
		natsUrl: config.natsUrl,
		source: config.source,
		tenantId: config.tenantId,
		defaultSurface: config.defaultSurface,
		defaultRuntimeMode: config.defaultRuntimeMode,
	};
}

export function setMaestroEventBusTransportForTests(
	transport: MaestroEventBusTransport | null | undefined,
): void {
	transportOverride = transport;
}

export async function closeMaestroEventBusTransport(): Promise<void> {
	if (transportOverride?.close) await transportOverride.close();
	if (natsTransportPromise) {
		const { transport } = await natsTransportPromise;
		await transport.close?.();
		natsTransportPromise = undefined;
	}
}

async function createNatsTransport(
	config: MaestroEventBusConfig,
): Promise<MaestroEventBusTransport | null> {
	if (!config.natsUrl) return null;
	const key = JSON.stringify({
		url: config.natsUrl,
		token: config.natsToken,
		user: config.natsUser,
		password: config.natsPassword,
	});
	if (!natsTransportPromise) {
		const pendingTransport = (async () => {
			const nats = await import("nats");
			const codec = nats.StringCodec();
			const connection: NatsConnection = await nats.connect({
				servers: config.natsUrl,
				name: "maestro-event-bus",
				token: config.natsToken,
				user: config.natsUser,
				pass: config.natsPassword,
			});
			const jetstream: JetStreamClient = connection.jetstream();
			return {
				key,
				transport: {
					async publish(subject: string, payload: string): Promise<void> {
						await jetstream.publish(subject, codec.encode(payload));
					},
					async close(): Promise<void> {
						await connection.drain();
					},
				},
			};
		})();
		const trackedTransport = pendingTransport.catch((error) => {
			if (natsTransportPromise === trackedTransport) {
				natsTransportPromise = undefined;
			}
			throw error;
		});
		natsTransportPromise = trackedTransport;
	}
	const resolved = await natsTransportPromise;
	if (resolved.key === key) return resolved.transport;
	await resolved.transport.close?.();
	natsTransportPromise = undefined;
	return createNatsTransport(config);
}

async function getTransport(
	config: MaestroEventBusConfig,
): Promise<MaestroEventBusTransport | null> {
	if (transportOverride !== undefined) return transportOverride;
	return createNatsTransport(config);
}

function mergeCorrelation(
	base: MaestroCorrelation,
	overrides?: Partial<MaestroCorrelation>,
): MaestroCorrelation {
	const definedOverrides = Object.fromEntries(
		Object.entries(overrides ?? {}).filter(([, value]) => value !== undefined),
	) as Partial<MaestroCorrelation>;
	const attributes = {
		...base.attributes,
		...definedOverrides.attributes,
	};
	return {
		...base,
		...definedOverrides,
		workspace_id: definedOverrides.workspace_id ?? base.workspace_id,
		session_id: definedOverrides.session_id ?? base.session_id,
		attributes: Object.keys(attributes).length > 0 ? attributes : undefined,
	};
}

function normalizeTime(value: string | Date | undefined): string {
	if (value instanceof Date) return value.toISOString();
	return value ?? new Date().toISOString();
}

function dataSchemaFor(type: MaestroBusEventType): string {
	return getMaestroBusEventCatalogEntry(type).dataSchema;
}

function protoAnyTypeFor(type: MaestroBusEventType): string {
	return getMaestroBusEventCatalogEntry(type).protoAnyType;
}

export function buildMaestroCloudEvent<TData extends Record<string, unknown>>(
	type: MaestroBusEventType,
	data: TData,
	options: PublishMaestroEventOptions = {},
): MaestroCloudEvent<TData> {
	const config = resolveMaestroEventBusConfig(options.env);
	const correlation = mergeCorrelation(
		config.defaultCorrelation,
		options.correlation,
	);
	const dataCorrelation =
		"correlation" in data && data.correlation ? data.correlation : correlation;
	const typedData = {
		...data,
		"@type": protoAnyTypeFor(type),
		correlation: dataCorrelation,
	} as TData & { "@type": string };

	return {
		spec_version: "1.0",
		id: options.eventId ?? randomUUID(),
		type,
		source: options.source ?? config.source,
		subject: options.subject ?? type,
		time: normalizeTime(options.time),
		data_content_type: "application/protobuf",
		tenant_id: options.tenantId ?? config.tenantId,
		data: typedData,
		extensions: { dataschema: dataSchemaFor(type) },
	};
}

export async function publishMaestroCloudEvent<
	TData extends Record<string, unknown>,
>(
	type: MaestroBusEventType,
	data: TData,
	options: PublishMaestroEventOptions = {},
): Promise<void> {
	const config = resolveMaestroEventBusConfig(options.env);
	if (!config.enabled) return;
	try {
		const transport = await getTransport(config);
		if (!transport) return;
		const event = buildMaestroCloudEvent(type, data, options);
		await transport.publish(type, JSON.stringify(event));
	} catch {
		// Audit-bus publishing must never affect the local agent runtime.
	}
}

function contextFromMetadata(
	metadata: unknown,
	extra?: Record<string, unknown>,
): Record<string, unknown> | undefined {
	const context =
		metadata && typeof metadata === "object" && !Array.isArray(metadata)
			? { ...(metadata as Record<string, unknown>) }
			: {};
	if (extra) Object.assign(context, extra);
	return Object.keys(context).length > 0 ? context : undefined;
}

function correlationFromMetadata(
	metadata: unknown,
): Partial<MaestroCorrelation> | undefined {
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
		return undefined;
	}
	const record = metadata as Record<string, unknown>;
	return {
		session_id:
			typeof record.sessionId === "string"
				? record.sessionId
				: typeof record.session_id === "string"
					? record.session_id
					: undefined,
		workspace_id:
			typeof record.workspaceId === "string"
				? record.workspaceId
				: typeof record.workspace_id === "string"
					? record.workspace_id
					: undefined,
		agent_run_id:
			typeof record.agentRunId === "string"
				? record.agentRunId
				: typeof record.agent_run_id === "string"
					? record.agent_run_id
					: undefined,
		agent_run_step_id:
			typeof record.toolCallId === "string"
				? record.toolCallId
				: typeof record.tool_call_id === "string"
					? record.tool_call_id
					: undefined,
	};
}

function stringMetadata(metadata: unknown, name: string): string | undefined {
	return metadata &&
		typeof metadata === "object" &&
		!Array.isArray(metadata) &&
		typeof (metadata as Record<string, unknown>)[name] === "string"
		? ((metadata as Record<string, unknown>)[name] as string)
		: undefined;
}

function durationFromMs(value: unknown): string | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return undefined;
	}
	return `${Number((value / 1000).toFixed(3))}s`;
}

function sessionEventTypeForMetric(
	metric: unknown,
): MaestroBusEventType | undefined {
	switch (metric) {
		case "session.count":
			return MaestroBusEventType.SessionStarted;
		case "session.duration":
			return MaestroBusEventType.SessionClosed;
		default:
			return undefined;
	}
}

export function recordMaestroSessionEvent(
	state: MaestroSessionState,
	options: {
		sessionId?: string;
		metadata?: Record<string, unknown>;
		closeReason?: MaestroCloseReason;
		closeMessage?: string;
		correlation?: Partial<MaestroCorrelation>;
		env?: Env;
	} = {},
): void {
	const now = new Date().toISOString();
	const config = resolveMaestroEventBusConfig(options.env);
	const eventType =
		state === "MAESTRO_SESSION_STATE_CLOSED"
			? MaestroBusEventType.SessionClosed
			: state === "MAESTRO_SESSION_STATE_SUSPENDED"
				? MaestroBusEventType.SessionSuspended
				: state === "MAESTRO_SESSION_STATE_RESUMED"
					? MaestroBusEventType.SessionResumed
					: MaestroBusEventType.SessionStarted;
	void publishMaestroCloudEvent<MaestroSessionEventData>(
		eventType,
		{
			correlation: mergeCorrelation(config.defaultCorrelation, {
				...options.correlation,
				session_id: options.sessionId ?? options.correlation?.session_id,
			}),
			state,
			surface: config.defaultSurface,
			runtime_mode: config.defaultRuntimeMode,
			principal: config.defaultPrincipal,
			workspace_root: process.cwd(),
			runtime_version: process.env.npm_package_version,
			started_at: state === "MAESTRO_SESSION_STATE_STARTED" ? now : undefined,
			suspended_at:
				state === "MAESTRO_SESSION_STATE_SUSPENDED" ? now : undefined,
			resumed_at: state === "MAESTRO_SESSION_STATE_RESUMED" ? now : undefined,
			closed_at: state === "MAESTRO_SESSION_STATE_CLOSED" ? now : undefined,
			close_reason: options.closeReason,
			close_message: options.closeMessage,
			metadata: options.metadata,
		},
		{ env: options.env, time: now },
	);
}

export function recordMaestroApprovalHit(
	event: RecordMaestroApprovalHitInput,
): void {
	const occurredAt = event.occurred_at ?? new Date().toISOString();
	void publishMaestroCloudEvent<ApprovalHitEventData>(
		MaestroBusEventType.ApprovalHit,
		{
			correlation: mergeCorrelation(
				resolveMaestroEventBusConfig(event.env).defaultCorrelation,
				event.correlation,
			),
			approval_request_id: event.approval_request_id,
			governance_decision_id: event.governance_decision_id,
			action: event.action,
			command: event.command,
			risk_level: event.risk_level,
			decision_mode: event.decision_mode,
			policy_id: event.policy_id,
			reason: event.reason,
			context: event.context,
			occurred_at: occurredAt,
		},
		{ env: event.env, time: occurredAt },
	);
}

export function recordMaestroFirewallBlock(
	event: RecordMaestroFirewallBlockInput,
): void {
	const occurredAt = event.occurred_at ?? new Date().toISOString();
	void publishMaestroCloudEvent<FirewallBlockEventData>(
		MaestroBusEventType.FirewallBlock,
		{
			correlation: mergeCorrelation(
				resolveMaestroEventBusConfig(event.env).defaultCorrelation,
				event.correlation,
			),
			rule_id: event.rule_id,
			operation: event.operation,
			target: event.target,
			protocol: event.protocol,
			port: event.port,
			reason: event.reason,
			context: event.context,
			occurred_at: occurredAt,
		},
		{ env: event.env, time: occurredAt },
	);
}

export function recordMaestroToolCallAttempt(
	event: RecordMaestroToolCallAttemptInput,
): void {
	const attemptedAt = event.attempted_at ?? new Date().toISOString();
	void publishMaestroCloudEvent<ToolCallAttemptEventData>(
		MaestroBusEventType.ToolCallAttempted,
		{
			correlation: mergeCorrelation(
				resolveMaestroEventBusConfig(event.env).defaultCorrelation,
				event.correlation,
			),
			tool_call_id: event.tool_call_id,
			tool_execution_id: event.tool_execution_id,
			prompt_metadata: event.prompt_metadata,
			skill_metadata: event.skill_metadata,
			tool_namespace: event.tool_namespace,
			tool_name: event.tool_name,
			tool_version: event.tool_version,
			capability: event.capability,
			connector_id: event.connector_id,
			mutates_resource: event.mutates_resource,
			risk_level: event.risk_level,
			safe_arguments: event.safe_arguments,
			redactions: event.redactions,
			idempotency_key: event.idempotency_key,
			attempted_at: attemptedAt,
		},
		{ env: event.env, time: attemptedAt },
	);
}

export function recordMaestroToolCallCompleted(
	event: RecordMaestroToolCallCompletedInput,
): void {
	const completedAt = event.completed_at ?? new Date().toISOString();
	void publishMaestroCloudEvent<ToolCallResultEventData>(
		MaestroBusEventType.ToolCallCompleted,
		{
			correlation: mergeCorrelation(
				resolveMaestroEventBusConfig(event.env).defaultCorrelation,
				event.correlation,
			),
			tool_call_id: event.tool_call_id,
			tool_execution_id: event.tool_execution_id,
			prompt_metadata: event.prompt_metadata,
			skill_metadata: event.skill_metadata,
			approval_request_id: event.approval_request_id,
			governed_outcome: event.governed_outcome,
			status: event.status,
			duration: event.duration,
			safe_output: event.safe_output,
			redactions: event.redactions,
			error_code: event.error_code,
			error_message: event.error_message,
			completed_at: completedAt,
		},
		{ env: event.env, time: completedAt },
	);
}

export function recordMaestroPromptVariantSelected(
	event: RecordMaestroPromptVariantSelectedInput,
): void {
	const selectedAt = event.selected_at ?? new Date().toISOString();
	void publishMaestroCloudEvent<PromptVariantSelectedEventData>(
		MaestroBusEventType.PromptVariantSelected,
		{
			correlation: mergeCorrelation(
				resolveMaestroEventBusConfig(event.env).defaultCorrelation,
				event.correlation,
			),
			prompt_metadata: event.prompt_metadata,
			selected_at: selectedAt,
		},
		{ env: event.env, time: selectedAt },
	);
}

export function recordMaestroSkillInvoked(
	event: RecordMaestroSkillInvokedInput,
): void {
	const invokedAt = event.invoked_at ?? new Date().toISOString();
	void publishMaestroCloudEvent<SkillInvocationEventData>(
		MaestroBusEventType.SkillInvoked,
		{
			correlation: mergeCorrelation(
				resolveMaestroEventBusConfig(event.env).defaultCorrelation,
				event.correlation,
			),
			prompt_metadata: event.prompt_metadata,
			skill_metadata: event.skill_metadata,
			tool_call_id: event.tool_call_id,
			tool_execution_id: event.tool_execution_id,
			invoked_at: invokedAt,
		},
		{ env: event.env, time: invokedAt },
	);
}

export function recordMaestroSkillOutcome(
	event: RecordMaestroSkillOutcomeInput,
): void {
	const outcomeAt = event.outcome_at ?? new Date().toISOString();
	const eventType =
		event.turn_status === "success"
			? MaestroBusEventType.SkillSucceeded
			: MaestroBusEventType.SkillFailed;
	void publishMaestroCloudEvent<SkillOutcomeEventData>(
		eventType,
		{
			correlation: mergeCorrelation(
				resolveMaestroEventBusConfig(event.env).defaultCorrelation,
				event.correlation,
			),
			prompt_metadata: event.prompt_metadata,
			skill_metadata: event.skill_metadata,
			tool_call_id: event.tool_call_id,
			tool_execution_id: event.tool_execution_id,
			turn_status: event.turn_status,
			error_category: event.error_category,
			error_message: event.error_message,
			stop_reason: event.stop_reason,
			outcome_at: outcomeAt,
		},
		{ env: event.env, time: outcomeAt },
	);
}

export async function mirrorTelemetryToMaestroEventBus(
	event: MaestroTelemetryMirrorEvent,
): Promise<void> {
	const fields = event as Record<string, unknown>;
	if (event.type === "sandbox-violation") {
		const path = typeof fields.path === "string" ? fields.path : undefined;
		await publishMaestroCloudEvent<SandboxViolationEventData>(
			MaestroBusEventType.SandboxViolation,
			{
				correlation: mergeCorrelation(
					resolveMaestroEventBusConfig().defaultCorrelation,
					correlationFromMetadata(fields.metadata),
				),
				operation: String(fields.action ?? fields.tool ?? "unknown"),
				resource: path ?? String(fields.command ?? fields.tool ?? "unknown"),
				attempted_path: path,
				reason: typeof fields.reason === "string" ? fields.reason : undefined,
				context: contextFromMetadata(fields.metadata, {
					tool: fields.tool,
					command: fields.command,
					event: fields.event,
				}),
				occurred_at: event.timestamp,
			},
			{ time: event.timestamp },
		);
		return;
	}

	if (event.type === "business-metric") {
		const eventType = sessionEventTypeForMetric(fields.metric);
		if (!eventType) return;
		const config = resolveMaestroEventBusConfig();
		await publishMaestroCloudEvent<MaestroSessionEventData>(
			eventType,
			{
				correlation: mergeCorrelation(
					config.defaultCorrelation,
					correlationFromMetadata(fields.metadata),
				),
				state:
					eventType === MaestroBusEventType.SessionClosed
						? "MAESTRO_SESSION_STATE_CLOSED"
						: "MAESTRO_SESSION_STATE_STARTED",
				surface: config.defaultSurface,
				runtime_mode: config.defaultRuntimeMode,
				principal: config.defaultPrincipal,
				workspace_root: process.cwd(),
				runtime_version: process.env.npm_package_version,
				started_at:
					eventType === MaestroBusEventType.SessionStarted
						? event.timestamp
						: undefined,
				closed_at:
					eventType === MaestroBusEventType.SessionClosed
						? event.timestamp
						: undefined,
				close_reason:
					eventType === MaestroBusEventType.SessionClosed
						? "MAESTRO_CLOSE_REASON_COMPLETED"
						: undefined,
				metadata: contextFromMetadata(fields.metadata, {
					value: fields.value,
					metric: fields.metric,
				}),
			},
			{ time: event.timestamp },
		);
		return;
	}

	if (event.type === "tool-execution") {
		const metadata = fields.metadata;
		await publishMaestroCloudEvent<ToolCallResultEventData>(
			MaestroBusEventType.ToolCallCompleted,
			{
				correlation: mergeCorrelation(
					resolveMaestroEventBusConfig().defaultCorrelation,
					correlationFromMetadata(metadata),
				),
				tool_call_id:
					stringMetadata(metadata, "toolCallId") ??
					stringMetadata(metadata, "tool_call_id") ??
					`${String(fields.toolName ?? "tool")}:${event.timestamp}`,
				status: fields.success
					? "MAESTRO_TOOL_CALL_STATUS_SUCCEEDED"
					: "MAESTRO_TOOL_CALL_STATUS_FAILED",
				duration: durationFromMs(fields.durationMs),
				error_message: fields.success
					? undefined
					: stringMetadata(metadata, "error"),
				completed_at: event.timestamp,
			},
			{ time: event.timestamp },
		);
	}
}
