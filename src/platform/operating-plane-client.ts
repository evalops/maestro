import {
	EVALOPS_ACCESS_TOKEN_ENV_VARS,
	EVALOPS_ORGANIZATION_ID_ENV_VARS,
	EVALOPS_WORKSPACE_ID_ENV_VARS,
} from "../evalops/env-aliases.js";
import { fetchDownstream } from "../utils/downstream-http.js";
import {
	type PlatformServiceConfig,
	buildPlatformJsonHeaders,
	resolvePlatformServiceConfig,
	trimString,
} from "./client.js";
import { PLATFORM_HTTP_ROUTES } from "./core-services.js";

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_ATTEMPTS = 2;
const OPERATING_PLANE_RUNS_PATH =
	PLATFORM_HTTP_ROUTES.agentRuntime.operatingPlaneRuns;

const OPERATING_PLANE_BASE_URL_ENV_VARS = [
	"MAESTRO_AGENT_OPERATING_PLANE_URL",
	"AGENT_OPERATING_PLANE_URL",
	"MAESTRO_AGENT_RUNTIME_SERVICE_URL",
	"AGENT_RUNTIME_SERVICE_URL",
] as const;

const OPERATING_PLANE_TOKEN_ENV_VARS = [
	"MAESTRO_AGENT_OPERATING_PLANE_TOKEN",
	"AGENT_OPERATING_PLANE_TOKEN",
	"MAESTRO_AGENT_RUNTIME_SERVICE_TOKEN",
	"AGENT_RUNTIME_SERVICE_TOKEN",
	...EVALOPS_ACCESS_TOKEN_ENV_VARS,
] as const;

const OPERATING_PLANE_ORGANIZATION_ENV_VARS = [
	"MAESTRO_AGENT_OPERATING_PLANE_ORG_ID",
	"AGENT_OPERATING_PLANE_ORGANIZATION_ID",
	"MAESTRO_AGENT_RUNTIME_ORG_ID",
	"AGENT_RUNTIME_ORGANIZATION_ID",
	...EVALOPS_ORGANIZATION_ID_ENV_VARS,
] as const;

const OPERATING_PLANE_WORKSPACE_ENV_VARS = [
	"MAESTRO_AGENT_OPERATING_PLANE_WORKSPACE_ID",
	"AGENT_OPERATING_PLANE_WORKSPACE_ID",
	"MAESTRO_AGENT_RUNTIME_WORKSPACE_ID",
	"AGENT_RUNTIME_WORKSPACE_ID",
	"MAESTRO_WORKSPACE_ID",
	...EVALOPS_WORKSPACE_ID_ENV_VARS.filter(
		(name) => name !== "MAESTRO_WORKSPACE_ID",
	),
] as const;

const OPERATING_PLANE_TIMEOUT_ENV_VARS = [
	"MAESTRO_AGENT_OPERATING_PLANE_TIMEOUT_MS",
	"AGENT_OPERATING_PLANE_TIMEOUT_MS",
	"MAESTRO_AGENT_RUNTIME_TIMEOUT_MS",
	"AGENT_RUNTIME_SERVICE_TIMEOUT_MS",
] as const;

const OPERATING_PLANE_MAX_ATTEMPTS_ENV_VARS = [
	"MAESTRO_AGENT_OPERATING_PLANE_MAX_ATTEMPTS",
	"AGENT_OPERATING_PLANE_MAX_ATTEMPTS",
	"MAESTRO_AGENT_RUNTIME_MAX_ATTEMPTS",
	"AGENT_RUNTIME_SERVICE_MAX_ATTEMPTS",
] as const;

const OPERATING_PLANE_BASE_URL_SUFFIXES = [
	OPERATING_PLANE_RUNS_PATH,
	"/v1/agent-operating-plane",
] as const;

export type OperatingPlaneAudience =
	| "agent"
	| "trigger_actor"
	| "user"
	| "actor"
	| "channel"
	| "slack"
	| "workspace_admins"
	| "admins"
	| "admin"
	| "audit"
	| "system";

export interface OperatingPlaneRunQuery {
	workspaceId?: string;
	runId?: string;
	workEnvelopeId?: string;
	autonomySessionId?: string;
	agentId?: string;
	threadId?: string;
	channelThreadId?: string;
	traceId?: string;
	sessionId?: string;
	evidenceId?: string;
	gatewayAuthenticatedSubject?: string;
	authSubject?: string;
	audience?: OperatingPlaneAudience;
	includeGates?: boolean;
	limit?: number;
}

export interface InspectOperatingPlaneRunsOptions {
	config?: PlatformServiceConfig;
	signal?: AbortSignal;
}

export interface OperatingPlaneInspection {
	contract_version: string;
	generated_at: string;
	unavailable_sources?: string[];
	runs: OperatingPlaneRun[];
}

export interface OperatingPlaneRun {
	agent_run_id: string;
	agent_run_step_id?: string;
	title: string;
	status: string;
	surface: string;
	channel_thread_id?: string;
	trace_id?: string;
	traceparent?: string;
	tracestate?: string;
	tool_execution_id?: string;
	approval_request_id?: string;
	started_at?: string;
	updated_at?: string;
	identity?: OperatingPlaneIdentity;
	data_classification?: string;
	retention_class?: string;
	shareability?: string;
	safe_summary_present?: boolean;
	redaction_count?: number;
	withholding_reasons?: string[];
	unavailable_sources?: string[];
	release_gate?: OperatingPlaneGate;
	replay_gate?: OperatingPlaneGate;
	evidence_refs?: OperatingPlaneEvidence[];
	work_items?: OperatingPlaneWorkItem[];
	model_calls?: OperatingPlaneModelCall[];
	tool_calls?: OperatingPlaneToolCall[];
	approvals?: OperatingPlaneApproval[];
	usage?: OperatingPlaneUsage;
	value_proof?: OperatingPlaneValueProof;
	canonical_attributes?: Record<string, unknown>;
}

export interface OperatingPlaneIdentity {
	workspace_id: string;
	tenant_id?: string;
	actor_id?: string;
	principal_id?: string;
	agent_id?: string;
	agent_instance_id?: string;
	gateway_authenticated_subject?: string;
	gateway_authenticated_user_subject?: string;
	gateway_authenticated_service?: string;
	gateway_authenticated_token_type?: string;
}

export interface OperatingPlaneGate {
	id: string;
	label: string;
	state: string;
	reason: string;
	last_checked_at: string;
}

export interface OperatingPlaneEvidence {
	id: string;
	source: string;
	kind: string;
	uri?: string;
	revision?: string;
	available: boolean;
	summary: string;
}

export interface OperatingPlaneWorkItem {
	id?: string;
	parent_id?: string;
	kind: string;
	state: string;
	title?: string;
	goal?: string;
	next_action?: string;
	blocker?: string;
	wait_id?: string;
	tool_execution_id?: string;
	evidence_refs?: string[];
	completion_gate?: string;
	updated_at?: string;
}

export interface OperatingPlaneModelCall {
	id?: string;
	provider?: string;
	model?: string;
	step_id?: string;
	tool_call_id?: string;
	cost_id?: string;
	trace_id?: string;
	input_tokens?: number;
	output_tokens?: number;
	total_tokens?: number;
	estimated_cost_micros?: number;
	currency?: string;
}

export interface OperatingPlaneToolCall {
	tool_execution_id: string;
	step_id?: string;
	state?: string;
	approval_request_id?: string;
}

export interface OperatingPlaneApproval {
	approval_request_id: string;
	wait_id?: string;
	state?: string;
	reason?: string;
	available: boolean;
}

export interface OperatingPlaneUsage {
	input_tokens?: number;
	output_tokens?: number;
	total_tokens?: number;
	estimated_cost_micros?: number;
	currency?: string;
}

export interface OperatingPlaneValueProof {
	operation_id: string;
	operator_summary: string;
	identity_bound: boolean;
	model_observed: boolean;
	tool_observed: boolean;
	approval_observed: boolean;
	trace_linked: boolean;
	evidence_linked: boolean;
	cost_attributed: boolean;
	proof_points?: string[];
	missing_proof?: string[];
}

export async function resolveOperatingPlaneServiceConfig(): Promise<PlatformServiceConfig | null> {
	return await resolvePlatformServiceConfig({
		baseUrlEnvVars: OPERATING_PLANE_BASE_URL_ENV_VARS,
		tokenEnvVars: OPERATING_PLANE_TOKEN_ENV_VARS,
		organizationEnvVars: OPERATING_PLANE_ORGANIZATION_ENV_VARS,
		workspaceEnvVars: OPERATING_PLANE_WORKSPACE_ENV_VARS,
		timeoutEnvVars: OPERATING_PLANE_TIMEOUT_ENV_VARS,
		maxAttemptsEnvVars: OPERATING_PLANE_MAX_ATTEMPTS_ENV_VARS,
		baseUrlSuffixes: OPERATING_PLANE_BASE_URL_SUFFIXES,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		defaultMaxAttempts: DEFAULT_MAX_ATTEMPTS,
		requireOrganizationId: true,
		requireToken: true,
	});
}

export function buildOperatingPlaneRunsUrl(
	config: Pick<PlatformServiceConfig, "baseUrl" | "workspaceId">,
	query: OperatingPlaneRunQuery = {},
): string {
	const url = new URL(
		`${config.baseUrl.trim().replace(/\/+$/u, "")}${OPERATING_PLANE_RUNS_PATH}`,
	);
	const params = url.searchParams;

	addStringParam(
		params,
		"workspace_id",
		query.workspaceId ?? config.workspaceId,
	);
	addStringParam(params, "run_id", query.runId);
	addStringParam(params, "work_envelope_id", query.workEnvelopeId);
	addStringParam(params, "autonomy_session_id", query.autonomySessionId);
	addStringParam(params, "agent_id", query.agentId);
	addStringParam(params, "thread_id", query.threadId);
	addStringParam(params, "channel_thread_id", query.channelThreadId);
	addStringParam(params, "trace_id", query.traceId);
	addStringParam(params, "session_id", query.sessionId);
	addStringParam(params, "evidence_id", query.evidenceId);
	addStringParam(
		params,
		"gateway_authenticated_subject",
		query.gatewayAuthenticatedSubject,
	);
	addStringParam(params, "auth_subject", query.authSubject);
	addStringParam(params, "audience", query.audience);
	addBooleanParam(params, "include_gates", query.includeGates);
	addNonNegativeIntParam(params, "limit", query.limit);

	return url.toString();
}

export async function inspectOperatingPlaneRuns(
	query: OperatingPlaneRunQuery = {},
	options: InspectOperatingPlaneRunsOptions = {},
): Promise<OperatingPlaneInspection> {
	const config = options.config ?? (await resolveOperatingPlaneServiceConfig());
	if (!config) {
		throw new Error("agent operating plane service is not configured");
	}

	const response = await fetchDownstream(
		buildOperatingPlaneRunsUrl(config, query),
		{
			method: "GET",
			headers: buildPlatformJsonHeaders(config),
			signal: options.signal,
		},
		{
			serviceName: "agent operating plane service",
			failureMode: "optional",
			timeoutMs: config.timeoutMs,
			maxAttempts: config.maxAttempts,
		},
	);
	return await parseOperatingPlaneResponse(response);
}

function addStringParam(
	params: URLSearchParams,
	name: string,
	value: string | undefined,
): void {
	const normalized = trimString(value);
	if (normalized) {
		params.set(name, normalized);
	}
}

function addBooleanParam(
	params: URLSearchParams,
	name: string,
	value: boolean | undefined,
): void {
	if (typeof value === "boolean") {
		params.set(name, value ? "true" : "false");
	}
}

function addNonNegativeIntParam(
	params: URLSearchParams,
	name: string,
	value: number | undefined,
): void {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return;
	}
	params.set(name, String(Math.trunc(value)));
}

async function parseOperatingPlaneResponse(
	response: Response,
): Promise<OperatingPlaneInspection> {
	const text = await response.text();
	if (!response.ok) {
		throw new Error(
			`agent operating plane service returned ${response.status}: ${text || response.statusText}`,
		);
	}
	if (!text.trim()) {
		throw new Error("agent operating plane service returned empty response");
	}
	return JSON.parse(text) as OperatingPlaneInspection;
}
