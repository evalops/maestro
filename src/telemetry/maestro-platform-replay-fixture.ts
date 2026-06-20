import { isRecord } from "../utils/json.js";
import {
	buildAgentOperatingPlaneContext,
	buildAgentOperatingPlaneCorrelation,
} from "./agent-operating-plane-context.js";
import {
	MaestroBusEventType,
	type MaestroCloudEvent,
	type MaestroCorrelation,
	type MaestroPrincipal,
	buildMaestroCloudEvent,
} from "./maestro-event-bus.js";

export const CANONICAL_MAESTRO_PLATFORM_REPLAY_FIXTURE_NAME =
	"canonical-maestro-session-platform-replay";

const ORGANIZATION_ID = "org_evalops_fixture";
const WORKSPACE_ID = "workspace_platform_replay";
const SESSION_ID = "session_platform_replay_001";
const AGENT_RUN_ID = "agent_run_platform_replay_001";
const BASH_TOOL_CALL_ID = "tool_call_platform_replay_bash_001";
const BASH_TOOL_EXECUTION_ID = "tool_exec_platform_replay_bash_001";
const SKILL_TOOL_CALL_ID = "tool_call_platform_replay_skill_001";
const SKILL_TOOL_EXECUTION_ID = "tool_exec_platform_replay_skill_001";
const APPROVAL_REQUEST_ID = "approval_platform_replay_001";
const SKILL_ID = "skill_incident_review";
const DATA_CLASSIFICATION = "internal";
const RETENTION_CLASS = "operational_audit";
const MODEL_USAGE_OBSERVED_AT = "2026-04-23T18:01:30.000Z";

const promptMetadata = {
	name: "maestro-system",
	label: "production",
	surface: "web",
	version: 9,
	versionId: "prompt_version_9",
	hash: "sha256:prompt-platform-replay",
	source: "service",
};

const skillMetadata = {
	name: "incident-review",
	hash: "sha256:skill-incident-review",
	source: "service",
	artifactId: SKILL_ID,
	version: "3",
};

const baseCorrelation: MaestroCorrelation = buildAgentOperatingPlaneCorrelation(
	{
		organization_id: ORGANIZATION_ID,
		workspace_id: WORKSPACE_ID,
		session_id: SESSION_ID,
		agent_run_id: AGENT_RUN_ID,
		agent_run_step_id: "agent_run_step_platform_replay_001",
		agent_id: "agent_maestro_platform_replay",
		actor_id: "user_platform_replay",
		principal_id: "principal_platform_replay",
		trace_id: "trace_platform_replay_001",
		request_id: "request_platform_replay_001",
		remote_runner_session_id: "remote_runner_platform_replay_001",
		objective_id: "objective_platform_replay_001",
		conversation_id: "conversation_platform_replay_001",
		tracestate: "evalops=maestro-platform-replay",
		attributes: {
			fixture: CANONICAL_MAESTRO_PLATFORM_REPLAY_FIXTURE_NAME,
			scenario_id: CANONICAL_MAESTRO_PLATFORM_REPLAY_FIXTURE_NAME,
		},
	},
);

const principal: MaestroPrincipal = {
	subject: "user:platform-replay@example.com",
	user_id: "user_platform_replay",
	organization_id: ORGANIZATION_ID,
	workspace_id: WORKSPACE_ID,
	roles: ["developer"],
	scopes: ["maestro:run", "tool:execute"],
	claims: {
		auth_provider: "fixture",
	},
};

const fixtureEnv: NodeJS.ProcessEnv = {
	MAESTRO_EVENT_BUS_URL: "nats://maestro-fixture.invalid:4222",
	MAESTRO_EVENT_BUS_SOURCE: "maestro-fixture",
	MAESTRO_EVALOPS_ORG_ID: ORGANIZATION_ID,
	MAESTRO_EVALOPS_WORKSPACE_ID: WORKSPACE_ID,
	MAESTRO_SESSION_ID: SESSION_ID,
	MAESTRO_AGENT_RUN_ID: AGENT_RUN_ID,
	MAESTRO_AGENT_ID: baseCorrelation.agent_id,
	MAESTRO_ACTOR_ID: baseCorrelation.actor_id,
	MAESTRO_PRINCIPAL_ID: baseCorrelation.principal_id,
	MAESTRO_REQUEST_ID: baseCorrelation.request_id,
	MAESTRO_REMOTE_RUNNER_SESSION_ID: baseCorrelation.remote_runner_session_id,
	MAESTRO_OBJECTIVE_ID: baseCorrelation.objective_id,
	MAESTRO_CONVERSATION_ID: baseCorrelation.conversation_id,
	TRACESTATE: baseCorrelation.tracestate,
	MAESTRO_SURFACE: "web",
	MAESTRO_RUNTIME_MODE: "hosted",
};

const eventPlan = [
	{
		type: MaestroBusEventType.SessionStarted,
		id: "evt_maestro_replay_001_session_started",
		time: "2026-04-23T18:00:00.000Z",
	},
	{
		type: MaestroBusEventType.PromptVariantSelected,
		id: "evt_maestro_replay_002_prompt_variant_selected",
		time: "2026-04-23T18:01:00.000Z",
	},
	{
		type: MaestroBusEventType.ToolCallAttempted,
		id: "evt_maestro_replay_003_skill_tool_call_attempted",
		time: "2026-04-23T18:02:00.000Z",
	},
	{
		type: MaestroBusEventType.ToolCallCompleted,
		id: "evt_maestro_replay_004_skill_tool_call_completed",
		time: "2026-04-23T18:03:00.000Z",
	},
	{
		type: MaestroBusEventType.SkillInvoked,
		id: "evt_maestro_replay_005_skill_invoked",
		time: "2026-04-23T18:04:00.000Z",
	},
	{
		type: MaestroBusEventType.ApprovalHit,
		id: "evt_maestro_replay_006_approval_hit",
		time: "2026-04-23T18:05:00.000Z",
	},
	{
		type: MaestroBusEventType.ToolCallAttempted,
		id: "evt_maestro_replay_007_eval_tool_call_attempted",
		time: "2026-04-23T18:06:00.000Z",
	},
	{
		type: MaestroBusEventType.ToolCallCompleted,
		id: "evt_maestro_replay_008_eval_tool_call_completed",
		time: "2026-04-23T18:07:00.000Z",
	},
	{
		type: MaestroBusEventType.EvalScored,
		id: "evt_maestro_replay_009_eval_scored",
		time: "2026-04-23T18:08:00.000Z",
	},
	{
		type: MaestroBusEventType.SkillFailed,
		id: "evt_maestro_replay_010_skill_failed",
		time: "2026-04-23T18:09:00.000Z",
	},
	{
		type: MaestroBusEventType.SessionClosed,
		id: "evt_maestro_replay_011_session_closed",
		time: "2026-04-23T18:10:00.000Z",
	},
] as const;

const TOOL_CALL_CORRELATED_EVENT_TYPES = new Set<MaestroBusEventType>([
	MaestroBusEventType.ToolCallAttempted,
	MaestroBusEventType.ToolCallCompleted,
	MaestroBusEventType.SkillInvoked,
	MaestroBusEventType.EvalScored,
]);

export type MaestroPlatformReplayFixtureEvent = MaestroCloudEvent<
	Record<string, unknown>
>;

type AgentRuntimeRecordRunEventType =
	| "RUNTIME_EVENT_TYPE_TOOL_CALL_RECORDED"
	| "RUNTIME_EVENT_TYPE_TOOL_RESULT_RECORDED"
	| "RUNTIME_EVENT_TYPE_APPROVAL_REQUESTED"
	| "RUNTIME_EVENT_TYPE_MODEL_RESPONSE_RECORDED";

type NativeEvidencePrimitive =
	| "NativeToolAttemptEvidence"
	| "NativeAgentEventEvidence";

type NativeEvidenceState =
	| "RUNTIME_EVIDENCE_STATE_NATIVE_OBSERVED"
	| "RUNTIME_EVIDENCE_STATE_MISSING";

type SafeProjectionGapKind = "principal" | "credential" | "cost" | "approval";

interface SafeProjectionGapAssertion {
	gap: SafeProjectionGapKind;
	evidence_state: NativeEvidenceState;
	reason:
		| "RUNTIME_EVIDENCE_GAP_REASON_PRINCIPAL_UNRESOLVED"
		| "RUNTIME_EVIDENCE_GAP_REASON_CREDENTIAL_UNVERIFIED"
		| "RUNTIME_EVIDENCE_GAP_REASON_COST_UNRECORDED"
		| "approval_record_unjoined";
	approval_blocking: boolean;
	join_required:
		| "Identity principal resolver"
		| "Secret Broker/Gateway credential evidence"
		| "Meter cost record"
		| "Platform approval record";
}

interface SafeProjectionMappingAssertion {
	source:
		| MaestroBusEventType.ToolCallAttempted
		| MaestroBusEventType.ToolCallCompleted
		| MaestroBusEventType.ApprovalHit
		| "maestro.native.model_usage.observed";
	source_event_id: string;
	source_event_time: string;
	record_run_event_type: AgentRuntimeRecordRunEventType;
	native_evidence: NativeEvidencePrimitive;
	native_kind:
		| "maestro_tool_attempt"
		| "maestro_tool_result"
		| "maestro_approval_observation"
		| "maestro_model_usage";
	evidence_state: "RUNTIME_EVIDENCE_STATE_NATIVE_OBSERVED";
	principal_evidence_state: "RUNTIME_EVIDENCE_STATE_MISSING";
	credential_evidence_state: "RUNTIME_EVIDENCE_STATE_MISSING";
	cost_evidence_state: "RUNTIME_EVIDENCE_STATE_MISSING";
	approval_readiness_state: "RUNTIME_EVIDENCE_STATE_MISSING";
	joins_required: readonly SafeProjectionGapAssertion["join_required"][];
	product_payload_fields: readonly string[];
}

export interface MaestroPlatformReplayFixture {
	fixture_version: "maestro-platform-replay/v1";
	name: typeof CANONICAL_MAESTRO_PLATFORM_REPLAY_FIXTURE_NAME;
	event_count: number;
	correlation: Record<string, string>;
	subjects: MaestroBusEventType[];
	events: MaestroPlatformReplayFixtureEvent[];
	expected_assertions: {
		required_event_types: MaestroBusEventType[];
		required_subjects: MaestroBusEventType[];
		platform_join_keys: Record<string, string>;
		timeline: Array<{
			type: MaestroBusEventType;
			title: string;
			visible: boolean;
		}>;
		agent_runtime_safe_projection: {
			platform_reference: {
				service: "agentruntime.v1.AgentRuntimeService";
				rpc: "RecordRunEvent";
				request: "agentruntime.v1.RecordRunEventRequest";
				native_primitives: readonly NativeEvidencePrimitive[];
			};
			authority_boundary: string;
			required_gaps: SafeProjectionGapAssertion[];
			mappings: SafeProjectionMappingAssertion[];
			product_payload_policy: {
				allowed_payload_basis: "redaction-safe identifiers, counts, summaries, and digest refs only";
				forbidden_payload_classes: readonly string[];
			};
		};
	};
}

function eventFor(
	type: MaestroBusEventType,
	data: Record<string, unknown>,
	index: number,
	agentRunStepId?: string,
): MaestroPlatformReplayFixtureEvent {
	const plan = eventPlan[index];
	if (!plan) {
		throw new Error(
			`missing Maestro platform replay event plan at index ${index}`,
		);
	}
	const stepId =
		agentRunStepId ??
		(TOOL_CALL_CORRELATED_EVENT_TYPES.has(type) &&
		typeof data.tool_call_id === "string"
			? data.tool_call_id
			: undefined) ??
		baseCorrelation.agent_run_step_id;
	return buildMaestroCloudEvent(
		type,
		{
			...withOperatingPlaneContext(type, data, {
				...baseCorrelation,
				agent_run_step_id: stepId,
				traceparent: fixtureTraceparent(index),
				tracestate: fixtureTracestate(index),
			}),
		},
		{
			env: fixtureEnv,
			eventId: plan.id,
			time: plan.time,
		},
	);
}

function fixtureTraceparent(index: number): string {
	return `00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-${String(index + 1).padStart(16, "0")}-01`;
}

function fixtureTracestate(index: number): string {
	return `evalops=maestro-platform-replay-${String(index + 1).padStart(2, "0")}`;
}

function withOperatingPlaneContext(
	type: MaestroBusEventType,
	data: Record<string, unknown>,
	correlation: MaestroCorrelation,
): Record<string, unknown> {
	const { metadata, ...eventData } = data;
	const context = buildAgentOperatingPlaneContext({
		correlation,
		metadata: {
			dataClassification: DATA_CLASSIFICATION,
			retentionClass: RETENTION_CLASS,
			safeSummary: safeSummaryFor(type),
		},
	});
	return {
		correlation: context.correlation,
		metadata: {
			...context.metadata,
			...(isRecord(metadata) ? metadata : {}),
		},
		...eventData,
	};
}

function safeSummaryFor(type: MaestroBusEventType): string {
	switch (type) {
		case MaestroBusEventType.SessionStarted:
			return "Hosted Maestro session started";
		case MaestroBusEventType.PromptVariantSelected:
			return "Prompt variant selected by stable artifact identity";
		case MaestroBusEventType.ToolCallAttempted:
			return "Tool call attempt recorded with safe argument summary";
		case MaestroBusEventType.ToolCallCompleted:
			return "Tool call completed with safe output summary";
		case MaestroBusEventType.SkillInvoked:
			return "Skill invocation linked to tool execution";
		case MaestroBusEventType.ApprovalHit:
			return "Governance approval requested for workspace command";
		case MaestroBusEventType.EvalScored:
			return "Evaluation result linked to tool execution";
		case MaestroBusEventType.SkillFailed:
			return "Skill outcome failed the evaluation threshold";
		case MaestroBusEventType.SessionClosed:
			return "Hosted Maestro session closed";
		default:
			return "Maestro operating-plane event recorded";
	}
}

function buildEvents(): MaestroPlatformReplayFixtureEvent[] {
	return [
		eventFor(
			MaestroBusEventType.SessionStarted,
			{
				state: "MAESTRO_SESSION_STATE_STARTED",
				surface: "MAESTRO_SURFACE_WEB",
				runtime_mode: "MAESTRO_RUNTIME_MODE_HOSTED",
				principal,
				workspace_root: "/workspace/evalops/platform-replay",
				repository: "evalops/maestro-internal",
				git_ref: "refs/heads/codex/maestro-platform-replay-fixture",
				runtime_version: "0.0.0-fixture",
				runner_profile: "hosted-standard",
				started_at: eventPlan[0].time,
				metadata: {
					fixture: CANONICAL_MAESTRO_PLATFORM_REPLAY_FIXTURE_NAME,
					scenario_id: CANONICAL_MAESTRO_PLATFORM_REPLAY_FIXTURE_NAME,
				},
			},
			0,
		),
		eventFor(
			MaestroBusEventType.PromptVariantSelected,
			{
				prompt_id: "prompt_platform_replay_system",
				prompt_name: "maestro-system",
				version_id: "prompt_version_9",
				prompt_metadata: promptMetadata,
				selected_at: eventPlan[1].time,
			},
			1,
		),
		eventFor(
			MaestroBusEventType.ToolCallAttempted,
			{
				tool_call_id: SKILL_TOOL_CALL_ID,
				tool_execution_id: SKILL_TOOL_EXECUTION_ID,
				prompt_metadata: promptMetadata,
				tool_namespace: "builtin",
				tool_name: "Skill",
				tool_version: "1",
				capability: "skill:invoke",
				mutates_resource: false,
				risk_level: "RISK_LEVEL_LOW",
				safe_arguments: {
					skill_id: SKILL_ID,
				},
				idempotency_key: "idempotency_platform_replay_skill_001",
				attempted_at: eventPlan[2].time,
			},
			2,
		),
		eventFor(
			MaestroBusEventType.ToolCallCompleted,
			{
				tool_call_id: SKILL_TOOL_CALL_ID,
				tool_execution_id: SKILL_TOOL_EXECUTION_ID,
				prompt_metadata: promptMetadata,
				skill_metadata: skillMetadata,
				status: "MAESTRO_TOOL_CALL_STATUS_SUCCEEDED",
				duration: "1.111s",
				safe_output: {
					summary: "Skill selected incident review workflow",
				},
				completed_at: eventPlan[3].time,
			},
			3,
		),
		eventFor(
			MaestroBusEventType.SkillInvoked,
			{
				invocation_id: "invocation_platform_replay_skill_001",
				skill_id: SKILL_ID,
				prompt_metadata: promptMetadata,
				skill_metadata: skillMetadata,
				tool_call_id: SKILL_TOOL_CALL_ID,
				tool_execution_id: SKILL_TOOL_EXECUTION_ID,
				invoked_at: eventPlan[4].time,
			},
			4,
		),
		eventFor(
			MaestroBusEventType.ApprovalHit,
			{
				approval_request_id: APPROVAL_REQUEST_ID,
				governance_decision_id: "governance_decision_platform_replay_001",
				action: "Run workspace test command",
				command: "workspace test command",
				risk_level: "RISK_LEVEL_MEDIUM",
				decision_mode: "MAESTRO_DECISION_MODE_REQUIRE_APPROVAL",
				policy_id: "policy_workspace_test_approval",
				reason: "fixture approval path",
				context: {
					tool_name: "Bash",
					display_name: "Bash",
					summary_label: "Bash",
					safe_arguments: {
						command_summary: "Run telemetry test suite",
					},
				},
				occurred_at: eventPlan[5].time,
			},
			5,
			BASH_TOOL_CALL_ID,
		),
		eventFor(
			MaestroBusEventType.ToolCallAttempted,
			{
				tool_call_id: BASH_TOOL_CALL_ID,
				tool_execution_id: BASH_TOOL_EXECUTION_ID,
				prompt_metadata: promptMetadata,
				tool_namespace: "builtin",
				tool_name: "Bash",
				tool_version: "1",
				capability: "workspace:test",
				mutates_resource: false,
				risk_level: "RISK_LEVEL_MEDIUM",
				safe_arguments: {
					command_summary: "Run telemetry test suite",
				},
				redactions: ["raw_command"],
				idempotency_key: "idempotency_platform_replay_bash_001",
				attempted_at: eventPlan[6].time,
			},
			6,
		),
		eventFor(
			MaestroBusEventType.ToolCallCompleted,
			{
				tool_call_id: BASH_TOOL_CALL_ID,
				tool_execution_id: BASH_TOOL_EXECUTION_ID,
				prompt_metadata: promptMetadata,
				skill_metadata: skillMetadata,
				approval_request_id: APPROVAL_REQUEST_ID,
				status: "MAESTRO_TOOL_CALL_STATUS_SUCCEEDED",
				duration: "2.345s",
				safe_output: {
					exit_code: 0,
					summary: "8 telemetry tests passed",
				},
				redactions: ["stdout"],
				completed_at: eventPlan[7].time,
			},
			7,
		),
		eventFor(
			MaestroBusEventType.EvalScored,
			{
				eval_run_id: "eval_run_platform_replay_001",
				scenario_id: CANONICAL_MAESTRO_PLATFORM_REPLAY_FIXTURE_NAME,
				prompt_metadata: promptMetadata,
				skill_metadata: skillMetadata,
				tool_call_id: BASH_TOOL_CALL_ID,
				tool_execution_id: BASH_TOOL_EXECUTION_ID,
				tool_name: "Bash",
				score: 0.82,
				passed: false,
				threshold: 0.9,
				scorer: "fermata.replay.score",
				rationale: "formatting checks failed",
				assertion_count: 1,
				scored_at: eventPlan[8].time,
			},
			8,
		),
		eventFor(
			MaestroBusEventType.SkillFailed,
			{
				invocation_id: "invocation_platform_replay_skill_001",
				skill_id: SKILL_ID,
				prompt_metadata: promptMetadata,
				skill_metadata: skillMetadata,
				tool_call_id: SKILL_TOOL_CALL_ID,
				tool_execution_id: SKILL_TOOL_EXECUTION_ID,
				turn_status: "evaluation_failed",
				error_category: "evaluation",
				error_message: "formatting checks failed",
				evaluation_tool_name: "Bash",
				evaluation_tool_call_id: BASH_TOOL_CALL_ID,
				evaluation_tool_execution_id: BASH_TOOL_EXECUTION_ID,
				evaluation_score: 0.82,
				evaluation_threshold: 0.9,
				evaluation_assertion_count: 1,
				evaluation_rationale: "formatting checks failed",
				outcome_at: eventPlan[9].time,
			},
			9,
		),
		eventFor(
			MaestroBusEventType.SessionClosed,
			{
				state: "MAESTRO_SESSION_STATE_CLOSED",
				surface: "MAESTRO_SURFACE_WEB",
				runtime_mode: "MAESTRO_RUNTIME_MODE_HOSTED",
				principal,
				workspace_root: "/workspace/evalops/platform-replay",
				repository: "evalops/maestro-internal",
				git_ref: "refs/heads/codex/maestro-platform-replay-fixture",
				runtime_version: "0.0.0-fixture",
				runner_profile: "hosted-standard",
				closed_at: eventPlan[10].time,
				close_reason: "MAESTRO_CLOSE_REASON_COMPLETED",
				close_message: "fixture run complete",
			},
			10,
		),
	];
}

export function buildCanonicalMaestroPlatformReplayFixture(): MaestroPlatformReplayFixture {
	const events = buildEvents();
	const subjects = eventPlan.map((event) => event.type);
	const requiredGaps = buildSafeProjectionGaps();
	return {
		fixture_version: "maestro-platform-replay/v1",
		name: CANONICAL_MAESTRO_PLATFORM_REPLAY_FIXTURE_NAME,
		event_count: events.length,
		correlation: {
			organization_id: ORGANIZATION_ID,
			workspace_id: WORKSPACE_ID,
			session_id: SESSION_ID,
			agent_run_id: AGENT_RUN_ID,
			agent_id: baseCorrelation.agent_id ?? "",
			actor_id: baseCorrelation.actor_id ?? "",
			principal_id: baseCorrelation.principal_id ?? "",
			request_id: baseCorrelation.request_id ?? "",
			remote_runner_session_id: baseCorrelation.remote_runner_session_id ?? "",
			objective_id: baseCorrelation.objective_id ?? "",
			conversation_id: baseCorrelation.conversation_id ?? "",
			tool_call_id: BASH_TOOL_CALL_ID,
			tool_execution_id: BASH_TOOL_EXECUTION_ID,
			skill_tool_call_id: SKILL_TOOL_CALL_ID,
			skill_tool_execution_id: SKILL_TOOL_EXECUTION_ID,
			approval_request_id: APPROVAL_REQUEST_ID,
			scenario_id: CANONICAL_MAESTRO_PLATFORM_REPLAY_FIXTURE_NAME,
		},
		subjects,
		events,
		expected_assertions: {
			required_event_types: subjects,
			required_subjects: subjects,
			platform_join_keys: {
				agent_run_id: AGENT_RUN_ID,
				prompt_id: "prompt_platform_replay_system",
				prompt_version_id: promptMetadata.versionId,
				prompt_artifact_hash: promptMetadata.hash,
				tool_call_id: BASH_TOOL_CALL_ID,
				tool_execution_id: BASH_TOOL_EXECUTION_ID,
				evaluation_tool_call_id: BASH_TOOL_CALL_ID,
				evaluation_tool_execution_id: BASH_TOOL_EXECUTION_ID,
				eval_run_id: "eval_run_platform_replay_001",
				scenario_id: CANONICAL_MAESTRO_PLATFORM_REPLAY_FIXTURE_NAME,
				skill_tool_call_id: SKILL_TOOL_CALL_ID,
				skill_tool_execution_id: SKILL_TOOL_EXECUTION_ID,
				skill_invocation_id: "invocation_platform_replay_skill_001",
				approval_request_id: APPROVAL_REQUEST_ID,
				skill_id: SKILL_ID,
			},
			timeline: [
				{
					type: MaestroBusEventType.SessionStarted,
					title: "Session started",
					visible: true,
				},
				{
					type: MaestroBusEventType.ApprovalHit,
					title: "Approval required",
					visible: true,
				},
				{
					type: MaestroBusEventType.ToolCallCompleted,
					title: "Tool completed",
					visible: true,
				},
				{
					type: MaestroBusEventType.EvalScored,
					title: "Evaluation scored",
					visible: true,
				},
				{
					type: MaestroBusEventType.SessionClosed,
					title: "Session closed",
					visible: true,
				},
			],
			agent_runtime_safe_projection: {
				platform_reference: {
					service: "agentruntime.v1.AgentRuntimeService",
					rpc: "RecordRunEvent",
					request: "agentruntime.v1.RecordRunEventRequest",
					native_primitives: [
						"NativeToolAttemptEvidence",
						"NativeAgentEventEvidence",
					],
				},
				authority_boundary:
					"Maestro native chronology is observation. Approval readiness requires fresh Platform joins to Identity, AgentRuntime, Secret Broker/Gateway, Meter, and approval records.",
				required_gaps: requiredGaps,
				mappings: [
					{
						source: "maestro.native.model_usage.observed",
						source_event_id: "native_maestro_replay_model_usage_observed_001",
						source_event_time: MODEL_USAGE_OBSERVED_AT,
						record_run_event_type: "RUNTIME_EVENT_TYPE_MODEL_RESPONSE_RECORDED",
						native_evidence: "NativeAgentEventEvidence",
						native_kind: "maestro_model_usage",
						evidence_state: "RUNTIME_EVIDENCE_STATE_NATIVE_OBSERVED",
						principal_evidence_state: "RUNTIME_EVIDENCE_STATE_MISSING",
						credential_evidence_state: "RUNTIME_EVIDENCE_STATE_MISSING",
						cost_evidence_state: "RUNTIME_EVIDENCE_STATE_MISSING",
						approval_readiness_state: "RUNTIME_EVIDENCE_STATE_MISSING",
						joins_required: requiredGaps.map((gap) => gap.join_required),
						product_payload_fields: [
							"source_event_id",
							"source_event_type",
							"workspace_id",
							"session_id",
							"agent_run_id",
							"agent_run_step_id",
							"provider",
							"model",
							"input_tokens",
							"output_tokens",
							"total_tokens",
							"meter_ref",
							"evidence_gaps",
						],
					},
					{
						source: MaestroBusEventType.ToolCallAttempted,
						source_event_id: "evt_maestro_replay_003_skill_tool_call_attempted",
						source_event_time: eventPlan[2].time,
						record_run_event_type: "RUNTIME_EVENT_TYPE_TOOL_CALL_RECORDED",
						native_evidence: "NativeToolAttemptEvidence",
						native_kind: "maestro_tool_attempt",
						evidence_state: "RUNTIME_EVIDENCE_STATE_NATIVE_OBSERVED",
						principal_evidence_state: "RUNTIME_EVIDENCE_STATE_MISSING",
						credential_evidence_state: "RUNTIME_EVIDENCE_STATE_MISSING",
						cost_evidence_state: "RUNTIME_EVIDENCE_STATE_MISSING",
						approval_readiness_state: "RUNTIME_EVIDENCE_STATE_MISSING",
						joins_required: requiredGaps.map((gap) => gap.join_required),
						product_payload_fields: [
							"source_event_id",
							"source_event_type",
							"workspace_id",
							"session_id",
							"agent_run_id",
							"agent_run_step_id",
							"tool_call_id",
							"tool_execution_id",
							"tool_name",
							"capability",
							"risk_level",
							"safe_arguments_ref",
							"safe_arguments_sha256",
							"safe_arguments_key_count",
							"redactions",
							"evidence_gaps",
						],
					},
					{
						source: MaestroBusEventType.ToolCallCompleted,
						source_event_id: "evt_maestro_replay_004_skill_tool_call_completed",
						source_event_time: eventPlan[3].time,
						record_run_event_type: "RUNTIME_EVENT_TYPE_TOOL_RESULT_RECORDED",
						native_evidence: "NativeAgentEventEvidence",
						native_kind: "maestro_tool_result",
						evidence_state: "RUNTIME_EVIDENCE_STATE_NATIVE_OBSERVED",
						principal_evidence_state: "RUNTIME_EVIDENCE_STATE_MISSING",
						credential_evidence_state: "RUNTIME_EVIDENCE_STATE_MISSING",
						cost_evidence_state: "RUNTIME_EVIDENCE_STATE_MISSING",
						approval_readiness_state: "RUNTIME_EVIDENCE_STATE_MISSING",
						joins_required: requiredGaps.map((gap) => gap.join_required),
						product_payload_fields: [
							"source_event_id",
							"source_event_type",
							"workspace_id",
							"session_id",
							"agent_run_id",
							"agent_run_step_id",
							"tool_call_id",
							"tool_execution_id",
							"tool_name",
							"status",
							"safe_output_ref",
							"safe_output_sha256",
							"safe_output_key_count",
							"redactions",
							"evidence_gaps",
						],
					},
					{
						source: MaestroBusEventType.ApprovalHit,
						source_event_id: "evt_maestro_replay_006_approval_hit",
						source_event_time: eventPlan[5].time,
						record_run_event_type: "RUNTIME_EVENT_TYPE_APPROVAL_REQUESTED",
						native_evidence: "NativeAgentEventEvidence",
						native_kind: "maestro_approval_observation",
						evidence_state: "RUNTIME_EVIDENCE_STATE_NATIVE_OBSERVED",
						principal_evidence_state: "RUNTIME_EVIDENCE_STATE_MISSING",
						credential_evidence_state: "RUNTIME_EVIDENCE_STATE_MISSING",
						cost_evidence_state: "RUNTIME_EVIDENCE_STATE_MISSING",
						approval_readiness_state: "RUNTIME_EVIDENCE_STATE_MISSING",
						joins_required: requiredGaps.map((gap) => gap.join_required),
						product_payload_fields: [
							"source_event_id",
							"source_event_type",
							"workspace_id",
							"session_id",
							"agent_run_id",
							"agent_run_step_id",
							"tool_call_id",
							"tool_name",
							"approval_request_id",
							"risk_level",
							"policy_id",
							"safe_arguments_ref",
							"safe_arguments_sha256",
							"evidence_gaps",
						],
					},
					{
						source: MaestroBusEventType.ToolCallAttempted,
						source_event_id: "evt_maestro_replay_007_eval_tool_call_attempted",
						source_event_time: eventPlan[6].time,
						record_run_event_type: "RUNTIME_EVENT_TYPE_TOOL_CALL_RECORDED",
						native_evidence: "NativeToolAttemptEvidence",
						native_kind: "maestro_tool_attempt",
						evidence_state: "RUNTIME_EVIDENCE_STATE_NATIVE_OBSERVED",
						principal_evidence_state: "RUNTIME_EVIDENCE_STATE_MISSING",
						credential_evidence_state: "RUNTIME_EVIDENCE_STATE_MISSING",
						cost_evidence_state: "RUNTIME_EVIDENCE_STATE_MISSING",
						approval_readiness_state: "RUNTIME_EVIDENCE_STATE_MISSING",
						joins_required: requiredGaps.map((gap) => gap.join_required),
						product_payload_fields: [
							"source_event_id",
							"source_event_type",
							"workspace_id",
							"session_id",
							"agent_run_id",
							"agent_run_step_id",
							"tool_call_id",
							"tool_execution_id",
							"tool_name",
							"capability",
							"risk_level",
							"safe_arguments_ref",
							"safe_arguments_sha256",
							"safe_arguments_key_count",
							"redactions",
							"evidence_gaps",
						],
					},
					{
						source: MaestroBusEventType.ToolCallCompleted,
						source_event_id: "evt_maestro_replay_008_eval_tool_call_completed",
						source_event_time: eventPlan[7].time,
						record_run_event_type: "RUNTIME_EVENT_TYPE_TOOL_RESULT_RECORDED",
						native_evidence: "NativeAgentEventEvidence",
						native_kind: "maestro_tool_result",
						evidence_state: "RUNTIME_EVIDENCE_STATE_NATIVE_OBSERVED",
						principal_evidence_state: "RUNTIME_EVIDENCE_STATE_MISSING",
						credential_evidence_state: "RUNTIME_EVIDENCE_STATE_MISSING",
						cost_evidence_state: "RUNTIME_EVIDENCE_STATE_MISSING",
						approval_readiness_state: "RUNTIME_EVIDENCE_STATE_MISSING",
						joins_required: requiredGaps.map((gap) => gap.join_required),
						product_payload_fields: [
							"source_event_id",
							"source_event_type",
							"workspace_id",
							"session_id",
							"agent_run_id",
							"agent_run_step_id",
							"tool_call_id",
							"tool_execution_id",
							"tool_name",
							"status",
							"safe_output_ref",
							"safe_output_sha256",
							"safe_output_key_count",
							"redactions",
							"evidence_gaps",
						],
					},
				],
				product_payload_policy: {
					allowed_payload_basis:
						"redaction-safe identifiers, counts, summaries, and digest refs only",
					forbidden_payload_classes: [
						"prompts",
						"tool args/results",
						"MCP bodies/results",
						"transcripts",
						"images",
						"provider raw payloads",
						"env",
						"secrets",
						"token values",
						"stdout/stderr",
					],
				},
			},
		},
	};
}

function buildSafeProjectionGaps(): SafeProjectionGapAssertion[] {
	return [
		{
			gap: "principal",
			evidence_state: "RUNTIME_EVIDENCE_STATE_MISSING",
			reason: "RUNTIME_EVIDENCE_GAP_REASON_PRINCIPAL_UNRESOLVED",
			approval_blocking: true,
			join_required: "Identity principal resolver",
		},
		{
			gap: "credential",
			evidence_state: "RUNTIME_EVIDENCE_STATE_MISSING",
			reason: "RUNTIME_EVIDENCE_GAP_REASON_CREDENTIAL_UNVERIFIED",
			approval_blocking: true,
			join_required: "Secret Broker/Gateway credential evidence",
		},
		{
			gap: "cost",
			evidence_state: "RUNTIME_EVIDENCE_STATE_MISSING",
			reason: "RUNTIME_EVIDENCE_GAP_REASON_COST_UNRECORDED",
			approval_blocking: true,
			join_required: "Meter cost record",
		},
		{
			gap: "approval",
			evidence_state: "RUNTIME_EVIDENCE_STATE_MISSING",
			reason: "approval_record_unjoined",
			approval_blocking: true,
			join_required: "Platform approval record",
		},
	];
}

export function canonicalMaestroPlatformReplayFixtureJson(): string {
	return `${JSON.stringify(buildCanonicalMaestroPlatformReplayFixture(), null, 2)}\n`;
}
