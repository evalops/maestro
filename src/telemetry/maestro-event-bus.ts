import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { JetStreamClient, NatsConnection } from "nats";
import {
	areMaestroPlatformEventsDisabled,
	isFeatureFlagSnapshotConfigured,
	isMaestroPlatformEventsPublisherEnabled,
} from "../config/feature-flags.js";
import {
	type EvalOpsManagedContext,
	resolveManagedEvalOpsContext,
} from "../evalops/managed-context.js";
import type { PromptMetadata } from "../prompts/types.js";
import type { SkillArtifactMetadata } from "../skills/artifact-metadata.js";
import { isInternalTelemetryDisabled } from "./disablement.js";
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

export type MaestroSkillOutcomeProtoStatus =
	| "MAESTRO_SKILL_OUTCOME_STATUS_SUCCEEDED"
	| "MAESTRO_SKILL_OUTCOME_STATUS_FAILED"
	| "MAESTRO_SKILL_OUTCOME_STATUS_DENIED"
	| "MAESTRO_SKILL_OUTCOME_STATUS_CANCELLED"
	| "MAESTRO_SKILL_OUTCOME_STATUS_EVALUATION_FAILED"
	| "MAESTRO_SKILL_OUTCOME_STATUS_RATE_LIMITED";

export interface MaestroCorrelation {
	organization_id?: string;
	user_id?: string;
	workspace_id: string;
	session_id: string;
	agent_run_id?: string;
	agent_run_step_id?: string;
	agent_id?: string;
	actor_id?: string;
	principal_id?: string;
	trace_id?: string;
	traceparent?: string;
	tracestate?: string;
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
		evalops_context_version: "evalops.context.v1";
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
	metadata?: Record<string, unknown>;
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
	metadata?: Record<string, unknown>;
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
	metadata?: Record<string, unknown>;
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
	prompt_id: string;
	prompt_name: string;
	version_id: string;
	prompt_metadata: PromptMetadata;
	selected_at: string;
}

export interface MaestroLearnedContextEvidence extends Record<string, unknown> {
	source: string;
	source_id?: string;
	uri?: string;
	excerpt?: string;
}

export interface MaestroLearnedContextEventData
	extends Record<string, unknown> {
	correlation: MaestroCorrelation;
	learning_id: string;
	subject_thing_id?: string;
	subject_key?: string;
	statement: string;
	dimension: string;
	confidence_score: number;
	confidence_reason: string;
	evidence: MaestroLearnedContextEvidence[];
	tool_call_id?: string;
	tool_execution_id?: string;
	learned_at: string;
}

export interface SkillInvocationEventData extends Record<string, unknown> {
	correlation: MaestroCorrelation;
	prompt_metadata?: PromptMetadata;
	skill_metadata: SkillArtifactMetadata;
	invocation_id?: string;
	skill_id?: string;
	tool_call_id: string;
	tool_execution_id?: string;
	invoked_at: string;
}

export type MaestroSkillOutcomeStatus =
	| "success"
	| "error"
	| "aborted"
	| "evaluation_failed"
	| "rate_limited";

export interface SkillOutcomeEventData extends Record<string, unknown> {
	correlation: MaestroCorrelation;
	prompt_metadata?: PromptMetadata;
	skill_metadata: SkillArtifactMetadata;
	invocation_id?: string;
	skill_id?: string;
	status?: MaestroSkillOutcomeProtoStatus;
	tool_call_id?: string;
	tool_execution_id?: string;
	turn_status: MaestroSkillOutcomeStatus;
	error_category?: string;
	error_message?: string;
	evaluation_tool_name?: string;
	evaluation_tool_call_id?: string;
	evaluation_tool_execution_id?: string;
	evaluation_score?: number;
	evaluation_threshold?: number;
	evaluation_assertion_count?: number;
	evaluation_rationale?: string;
	stop_reason?: string;
	metadata?: Record<string, unknown>;
	outcome_at: string;
}

export interface EvalScoredEventData extends Record<string, unknown> {
	correlation: MaestroCorrelation;
	eval_run_id: string;
	scenario_id: string;
	prompt_metadata?: PromptMetadata;
	skill_metadata?: SkillArtifactMetadata;
	tool_call_id: string;
	tool_execution_id?: string;
	tool_name?: string;
	score?: number;
	threshold?: number;
	passed?: boolean;
	scorer?: string;
	rationale?: string;
	assertion_count?: number;
	scored_at: string;
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
	event_id?: string;
	approval_request_id?: string;
	governance_decision_id?: string;
	action: string;
	command?: string;
	risk_level?: string;
	decision_mode: MaestroDecisionMode;
	policy_id?: string;
	reason?: string;
	context?: Record<string, unknown>;
	metadata?: Record<string, unknown>;
	correlation?: Partial<MaestroCorrelation>;
	occurred_at?: string;
	env?: Env;
}

export interface RecordMaestroFirewallBlockInput {
	event_id?: string;
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
	event_id?: string;
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
	metadata?: Record<string, unknown>;
	correlation?: Partial<MaestroCorrelation>;
	attempted_at?: string;
	env?: Env;
}

export interface RecordMaestroToolCallCompletedInput {
	event_id?: string;
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
	metadata?: Record<string, unknown>;
	correlation?: Partial<MaestroCorrelation>;
	completed_at?: string;
	env?: Env;
}

export interface RecordMaestroPromptVariantSelectedInput {
	event_id?: string;
	prompt_id?: string;
	prompt_name?: string;
	version_id?: string;
	prompt_metadata: PromptMetadata;
	correlation?: Partial<MaestroCorrelation>;
	selected_at?: string;
	env?: Env;
}

export interface RecordMaestroLearnedContextInput {
	event_id?: string;
	learning_id: string;
	subject_thing_id?: string;
	subject_key?: string;
	statement: string;
	dimension: string;
	confidence_score: number;
	confidence_reason: string;
	evidence: MaestroLearnedContextEvidence[];
	tool_call_id?: string;
	tool_execution_id?: string;
	correlation?: Partial<MaestroCorrelation>;
	learned_at?: string;
	env?: Env;
}

export interface RecordMaestroSkillInvokedInput {
	event_id?: string;
	prompt_metadata?: PromptMetadata;
	skill_metadata: SkillArtifactMetadata;
	invocation_id?: string;
	skill_id?: string;
	tool_call_id: string;
	tool_execution_id?: string;
	correlation?: Partial<MaestroCorrelation>;
	invoked_at?: string;
	env?: Env;
}

export interface RecordMaestroSkillOutcomeInput {
	event_id?: string;
	prompt_metadata?: PromptMetadata;
	skill_metadata: SkillArtifactMetadata;
	invocation_id?: string;
	skill_id?: string;
	status?: MaestroSkillOutcomeProtoStatus;
	tool_call_id?: string;
	tool_execution_id?: string;
	turn_status: MaestroSkillOutcomeStatus;
	error_category?: string;
	error_message?: string;
	evaluation_tool_name?: string;
	evaluation_tool_call_id?: string;
	evaluation_tool_execution_id?: string;
	evaluation_score?: number;
	evaluation_threshold?: number;
	evaluation_assertion_count?: number;
	evaluation_rationale?: string;
	stop_reason?: string;
	metadata?: Record<string, unknown>;
	correlation?: Partial<MaestroCorrelation>;
	outcome_at?: string;
	env?: Env;
}

export interface RecordMaestroEvalScoredInput {
	event_id?: string;
	eval_run_id?: string;
	scenario_id?: string;
	prompt_metadata?: PromptMetadata;
	skill_metadata?: SkillArtifactMetadata;
	tool_call_id: string;
	tool_execution_id?: string;
	tool_name?: string;
	score?: number;
	threshold?: number;
	passed?: boolean;
	scorer?: string;
	rationale?: string;
	assertion_count?: number;
	correlation?: Partial<MaestroCorrelation>;
	scored_at?: string;
	env?: Env;
}

let transportOverride: MaestroEventBusTransport | null | undefined;
const scopedTransportOverride =
	new AsyncLocalStorage<MaestroEventBusTransport | null>();
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

function defaultCorrelation(
	env: Env,
	managedContext: EvalOpsManagedContext,
): MaestroCorrelation {
	const workspaceId = managedContext.workspaceId ?? env.PWD ?? process.cwd();
	const sessionId = readEnv(env, ["MAESTRO_SESSION_ID"]) ?? "unknown";

	return {
		organization_id: managedContext.organizationId,
		user_id: managedContext.userId,
		workspace_id: workspaceId,
		session_id: sessionId,
		agent_run_id: managedContext.runId,
		agent_run_step_id: readEnv(env, ["MAESTRO_AGENT_RUN_STEP_ID"]),
		agent_id: managedContext.agentId,
		actor_id: readEnv(env, ["MAESTRO_ACTOR_ID"]),
		principal_id: readEnv(env, ["MAESTRO_PRINCIPAL_ID"]),
		trace_id: readEnv(env, ["TRACE_ID", "OTEL_TRACE_ID"]),
		traceparent: readEnv(env, ["TRACEPARENT", "TRACE_PARENT"]),
		tracestate: readEnv(env, ["TRACESTATE", "TRACE_STATE"]),
		request_id: readEnv(env, ["MAESTRO_REQUEST_ID"]),
		remote_runner_session_id: readEnv(env, [
			"MAESTRO_REMOTE_RUNNER_SESSION_ID",
		]),
		objective_id: readEnv(env, ["MAESTRO_OBJECTIVE_ID"]),
		conversation_id: readEnv(env, ["MAESTRO_CONVERSATION_ID"]),
		attributes: readStringRecord(env, "MAESTRO_EVENT_BUS_ATTR_"),
	};
}

function defaultPrincipal(
	env: Env,
	managedContext: EvalOpsManagedContext,
): MaestroPrincipal | undefined {
	const subject = readEnv(env, [
		"MAESTRO_PRINCIPAL_SUBJECT",
		"MAESTRO_USER_SUBJECT",
		"USER",
	]);
	if (!subject) return undefined;
	return {
		subject,
		user_id: managedContext.userId,
		organization_id: managedContext.organizationId,
		workspace_id: managedContext.workspaceId,
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

function resolveEventBusFeatureGate(
	env: Env,
	managedContext: EvalOpsManagedContext,
): {
	allowed: boolean;
	reason?: string;
} {
	if (!isFeatureFlagSnapshotConfigured(env)) {
		return { allowed: true };
	}
	if (!managedContext.managed) {
		return { allowed: true };
	}
	if (areMaestroPlatformEventsDisabled(env)) {
		return {
			allowed: false,
			reason: "platform events kill switch enabled",
		};
	}
	if (!isMaestroPlatformEventsPublisherEnabled(env)) {
		return {
			allowed: false,
			reason: "platform events rollout disabled",
		};
	}
	return { allowed: true };
}

export function resolveMaestroEventBusConfig(
	env: Env = process.env,
): MaestroEventBusConfig {
	const managedContext = resolveManagedEvalOpsContext(env);
	const internalTelemetryDisabled = isInternalTelemetryDisabled(env);
	const flag = readBoolean(
		readEnv(env, ["MAESTRO_EVENT_BUS", "MAESTRO_AUDIT_BUS"]),
	);
	const natsUrl = readEnv(env, [
		"MAESTRO_EVENT_BUS_URL",
		"EVALOPS_NATS_URL",
		"NATS_URL",
	]);
	const managedRouting = managedContext.managed;
	const baseEnabled =
		flag === false ? false : (flag ?? Boolean(natsUrl || managedRouting));
	const featureGate = resolveEventBusFeatureGate(env, managedContext);
	const enabled =
		!internalTelemetryDisabled && baseEnabled && featureGate.allowed;
	let reason = "disabled";
	if (internalTelemetryDisabled) reason = "internal telemetry disabled";
	else if (flag === false) reason = "flag disabled";
	else if (baseEnabled && !featureGate.allowed)
		reason = featureGate.reason ?? "feature flag disabled";
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
		tenantId: managedContext.organizationId,
		defaultSurface: normalizeSurface(
			readEnv(env, ["MAESTRO_SURFACE", "MAESTRO_EVENT_SURFACE"]),
		),
		defaultRuntimeMode: normalizeRuntimeMode(
			readEnv(env, ["MAESTRO_RUNTIME_MODE"]),
		),
		defaultCorrelation: defaultCorrelation(env, managedContext),
		defaultPrincipal: defaultPrincipal(env, managedContext),
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

export async function withMaestroEventBusTransportOverride<T>(
	transport: MaestroEventBusTransport | null,
	callback: () => Promise<T>,
): Promise<T> {
	return scopedTransportOverride.run(transport, callback);
}

export async function closeMaestroEventBusTransport(): Promise<void> {
	const scopedTransport = scopedTransportOverride.getStore();
	if (scopedTransport?.close) await scopedTransport.close();
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
	const scopedTransport = scopedTransportOverride.getStore();
	if (scopedTransport !== undefined) return scopedTransport;
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

export function maestroCorrelationToChronicleMetadata(
	correlation: MaestroCorrelation,
): Record<string, string> {
	const metadata: Record<string, string> = {};
	const canonicalKeys = new Set<string>();
	const putCanonicalMetadata = (
		key: string,
		value: string | undefined,
	): void => {
		canonicalKeys.add(key);
		putMetadata(metadata, key, value);
	};
	putCanonicalMetadata("organization_id", correlation.organization_id);
	putCanonicalMetadata("user_id", correlation.user_id);
	putCanonicalMetadata("workspace_id", correlation.workspace_id);
	putCanonicalMetadata("maestro_session_id", correlation.session_id);
	putCanonicalMetadata("agent_run_id", correlation.agent_run_id);
	putCanonicalMetadata("agent_run_step_id", correlation.agent_run_step_id);
	putCanonicalMetadata("agent_id", correlation.agent_id);
	putCanonicalMetadata("actor_id", correlation.actor_id);
	putCanonicalMetadata("principal_id", correlation.principal_id);
	putCanonicalMetadata("trace_id", correlation.trace_id);
	putCanonicalMetadata("traceparent", correlation.traceparent);
	putCanonicalMetadata("tracestate", correlation.tracestate);
	putCanonicalMetadata("request_id", correlation.request_id);
	putCanonicalMetadata(
		"remote_runner_session_id",
		correlation.remote_runner_session_id,
	);
	putCanonicalMetadata("objective_id", correlation.objective_id);
	putCanonicalMetadata("conversation_id", correlation.conversation_id);
	putCanonicalMetadata("parent_event_id", correlation.parent_event_id);
	for (const [key, value] of Object.entries(correlation.attributes ?? {})) {
		if (canonicalKeys.has(key)) continue;
		putMetadata(metadata, key, value);
	}
	return metadata;
}

function putMetadata(
	metadata: Record<string, string>,
	key: string,
	value: string | undefined,
): void {
	const cleanValue = value?.trim();
	if (!cleanValue) return;
	metadata[key] = cleanValue;
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
	const contextCorrelation =
		"correlation" in data && data.correlation
			? mergeCorrelation(
					correlation,
					data.correlation as Partial<MaestroCorrelation>,
				)
			: correlation;
	const dataCorrelation = maestroDataCorrelation(
		contextCorrelation as MaestroCorrelation,
	);
	const typedData = {
		...data,
		"@type": protoAnyTypeFor(type),
		correlation: dataCorrelation,
	} as TData & { "@type": string };
	const contextExtensions = maestroContextExtensions(
		contextCorrelation as MaestroCorrelation,
		typedData,
	);

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
		extensions: {
			dataschema: dataSchemaFor(type),
			evalops_context_version: "evalops.context.v1",
			...contextExtensions,
		},
	};
}

function maestroDataCorrelation(
	correlation: MaestroCorrelation,
): MaestroCorrelation {
	const {
		traceparent: _traceparent,
		tracestate: _tracestate,
		...dataCorrelation
	} = correlation;
	return dataCorrelation;
}

function maestroContextExtensions(
	correlation: MaestroCorrelation,
	data: Record<string, unknown>,
): Record<string, string> {
	const extensions: Record<string, string> = {};
	putMetadata(extensions, "organization_id", correlation.organization_id);
	putMetadata(extensions, "user_id", correlation.user_id);
	putMetadata(extensions, "workspace_id", correlation.workspace_id);
	putMetadata(extensions, "maestro_session_id", correlation.session_id);
	putMetadata(extensions, "agent_run_id", correlation.agent_run_id);
	putMetadata(extensions, "agent_run_step_id", correlation.agent_run_step_id);
	putMetadata(extensions, "trace_id", correlation.trace_id);
	putMetadata(extensions, "traceparent", correlation.traceparent);
	putMetadata(extensions, "tracestate", correlation.tracestate);
	putMetadata(extensions, "request_id", correlation.request_id);
	putMetadata(extensions, "source_issue", correlation.attributes?.source_issue);
	putMetadata(extensions, "task_id", correlation.attributes?.task_id);
	putMetadata(
		extensions,
		"tool_execution_id",
		stringRecordValue(data, "tool_execution_id"),
	);
	return extensions;
}

function stringRecordValue(
	record: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
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

export async function publishMaestroCloudEventStrict<
	TData extends Record<string, unknown>,
>(
	type: MaestroBusEventType,
	data: TData,
	options: PublishMaestroEventOptions = {},
): Promise<void> {
	const config = resolveMaestroEventBusConfig(options.env);
	if (!config.enabled && !config.natsUrl) {
		throw new Error(`Maestro event bus is not enabled: ${config.reason}`);
	}
	const transport = await getTransport(config);
	if (!transport) {
		throw new Error("Maestro event bus transport is unavailable");
	}
	const event = buildMaestroCloudEvent(type, data, options);
	await transport.publish(type, JSON.stringify(event));
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
		organization_id:
			typeof record.organizationId === "string"
				? record.organizationId
				: typeof record.organization_id === "string"
					? record.organization_id
					: undefined,
		user_id:
			typeof record.userId === "string"
				? record.userId
				: typeof record.user_id === "string"
					? record.user_id
					: undefined,
		agent_id:
			typeof record.agentId === "string"
				? record.agentId
				: typeof record.agent_id === "string"
					? record.agent_id
					: undefined,
		actor_id:
			typeof record.actorId === "string"
				? record.actorId
				: typeof record.actor_id === "string"
					? record.actor_id
					: undefined,
		principal_id:
			typeof record.principalId === "string"
				? record.principalId
				: typeof record.principal_id === "string"
					? record.principal_id
					: undefined,
		trace_id:
			typeof record.traceId === "string"
				? record.traceId
				: typeof record.trace_id === "string"
					? record.trace_id
					: undefined,
		traceparent:
			typeof record.traceparent === "string"
				? record.traceparent
				: typeof record.trace_parent === "string"
					? record.trace_parent
					: undefined,
		tracestate:
			typeof record.tracestate === "string"
				? record.tracestate
				: typeof record.trace_state === "string"
					? record.trace_state
					: undefined,
		request_id:
			typeof record.requestId === "string"
				? record.requestId
				: typeof record.request_id === "string"
					? record.request_id
					: undefined,
		remote_runner_session_id:
			typeof record.remoteRunnerSessionId === "string"
				? record.remoteRunnerSessionId
				: typeof record.remote_runner_session_id === "string"
					? record.remote_runner_session_id
					: undefined,
		objective_id:
			typeof record.objectiveId === "string"
				? record.objectiveId
				: typeof record.objective_id === "string"
					? record.objective_id
					: undefined,
		conversation_id:
			typeof record.conversationId === "string"
				? record.conversationId
				: typeof record.conversation_id === "string"
					? record.conversation_id
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

function closeReasonFromMetadata(
	metadata: unknown,
): MaestroCloseReason | undefined {
	const value =
		stringMetadata(metadata, "closeReason") ??
		stringMetadata(metadata, "close_reason");
	switch (value) {
		case "MAESTRO_CLOSE_REASON_COMPLETED":
		case "MAESTRO_CLOSE_REASON_USER_STOPPED":
		case "MAESTRO_CLOSE_REASON_IDLE_TIMEOUT":
		case "MAESTRO_CLOSE_REASON_TTL_EXPIRED":
		case "MAESTRO_CLOSE_REASON_ERROR":
		case "MAESTRO_CLOSE_REASON_POLICY_DENIED":
			return value;
		default:
			return undefined;
	}
}

function durationFromMs(value: unknown): string | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return undefined;
	}
	return `${Number((value / 1000).toFixed(3))}s`;
}

function protoSkillOutcomeStatusFromTurnStatus(
	status: MaestroSkillOutcomeStatus,
): MaestroSkillOutcomeProtoStatus {
	switch (status) {
		case "success":
			return "MAESTRO_SKILL_OUTCOME_STATUS_SUCCEEDED";
		case "aborted":
			return "MAESTRO_SKILL_OUTCOME_STATUS_CANCELLED";
		case "evaluation_failed":
			return "MAESTRO_SKILL_OUTCOME_STATUS_EVALUATION_FAILED";
		case "rate_limited":
			return "MAESTRO_SKILL_OUTCOME_STATUS_RATE_LIMITED";
		case "error":
			return "MAESTRO_SKILL_OUTCOME_STATUS_FAILED";
	}
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
			metadata: event.metadata,
			occurred_at: occurredAt,
		},
		{ env: event.env, eventId: event.event_id, time: occurredAt },
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
		{ env: event.env, eventId: event.event_id, time: occurredAt },
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
			metadata: event.metadata,
			attempted_at: attemptedAt,
		},
		{ env: event.env, eventId: event.event_id, time: attemptedAt },
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
			metadata: event.metadata,
			completed_at: completedAt,
		},
		{ env: event.env, eventId: event.event_id, time: completedAt },
	);
}

export function recordMaestroPromptVariantSelected(
	event: RecordMaestroPromptVariantSelectedInput,
): void {
	const selectedAt = event.selected_at ?? new Date().toISOString();
	const promptID = event.prompt_id ?? event.prompt_metadata.name;
	const promptName = event.prompt_name ?? event.prompt_metadata.name;
	const versionID =
		event.version_id ??
		event.prompt_metadata.versionId ??
		event.prompt_metadata.hash;
	void publishMaestroCloudEvent<PromptVariantSelectedEventData>(
		MaestroBusEventType.PromptVariantSelected,
		{
			correlation: mergeCorrelation(
				resolveMaestroEventBusConfig(event.env).defaultCorrelation,
				event.correlation,
			),
			prompt_id: promptID,
			prompt_name: promptName,
			version_id: versionID,
			prompt_metadata: event.prompt_metadata,
			selected_at: selectedAt,
		},
		{ env: event.env, eventId: event.event_id, time: selectedAt },
	);
}

export function recordMaestroLearnedContext(
	event: RecordMaestroLearnedContextInput,
): void {
	const learnedAt = event.learned_at ?? new Date().toISOString();
	void publishMaestroCloudEvent<MaestroLearnedContextEventData>(
		MaestroBusEventType.ContextLearned,
		{
			correlation: mergeCorrelation(
				resolveMaestroEventBusConfig(event.env).defaultCorrelation,
				event.correlation,
			),
			learning_id: event.learning_id,
			subject_thing_id: event.subject_thing_id,
			subject_key: event.subject_key,
			statement: event.statement,
			dimension: event.dimension,
			confidence_score: event.confidence_score,
			confidence_reason: event.confidence_reason,
			evidence: event.evidence,
			tool_call_id: event.tool_call_id,
			tool_execution_id: event.tool_execution_id,
			learned_at: learnedAt,
		},
		{ env: event.env, eventId: event.event_id, time: learnedAt },
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
			invocation_id: event.invocation_id,
			skill_id: event.skill_id ?? event.skill_metadata.artifactId,
			tool_call_id: event.tool_call_id,
			tool_execution_id: event.tool_execution_id,
			invoked_at: invokedAt,
		},
		{ env: event.env, eventId: event.event_id, time: invokedAt },
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
			invocation_id: event.invocation_id,
			skill_id: event.skill_id ?? event.skill_metadata.artifactId,
			status:
				event.status ??
				protoSkillOutcomeStatusFromTurnStatus(event.turn_status),
			tool_call_id: event.tool_call_id,
			tool_execution_id: event.tool_execution_id,
			turn_status: event.turn_status,
			error_category: event.error_category,
			error_message: event.error_message,
			evaluation_tool_name: event.evaluation_tool_name,
			evaluation_tool_call_id: event.evaluation_tool_call_id,
			evaluation_tool_execution_id: event.evaluation_tool_execution_id,
			evaluation_score: event.evaluation_score,
			evaluation_threshold: event.evaluation_threshold,
			evaluation_assertion_count: event.evaluation_assertion_count,
			evaluation_rationale: event.evaluation_rationale,
			stop_reason: event.stop_reason,
			metadata: event.metadata,
			outcome_at: outcomeAt,
		},
		{ env: event.env, eventId: event.event_id, time: outcomeAt },
	);
}

export function recordMaestroEvalScored(
	event: RecordMaestroEvalScoredInput,
): void {
	const scoredAt = event.scored_at ?? new Date().toISOString();
	const evalRunID =
		event.eval_run_id ?? event.tool_execution_id ?? event.tool_call_id;
	const scenarioID =
		event.scenario_id ??
		event.skill_metadata?.artifactId ??
		event.skill_metadata?.name ??
		event.tool_name ??
		event.tool_call_id;
	void publishMaestroCloudEvent<EvalScoredEventData>(
		MaestroBusEventType.EvalScored,
		{
			correlation: mergeCorrelation(
				resolveMaestroEventBusConfig(event.env).defaultCorrelation,
				event.correlation,
			),
			eval_run_id: evalRunID,
			scenario_id: scenarioID,
			prompt_metadata: event.prompt_metadata,
			skill_metadata: event.skill_metadata,
			tool_call_id: event.tool_call_id,
			tool_execution_id: event.tool_execution_id,
			tool_name: event.tool_name,
			score: event.score,
			threshold: event.threshold,
			passed: event.passed,
			scorer: event.scorer,
			rationale: event.rationale,
			assertion_count: event.assertion_count,
			scored_at: scoredAt,
		},
		{ env: event.env, eventId: event.event_id, time: scoredAt },
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
						? (closeReasonFromMetadata(fields.metadata) ??
							"MAESTRO_CLOSE_REASON_COMPLETED")
						: undefined,
				close_message:
					eventType === MaestroBusEventType.SessionClosed
						? (stringMetadata(fields.metadata, "closeMessage") ??
							stringMetadata(fields.metadata, "close_message"))
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
