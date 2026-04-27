import type { PromptMetadata } from "../prompts/types.js";
import type { SkillArtifactMetadata } from "../skills/artifact-metadata.js";
import {
	MaestroBusEventType,
	type MaestroCloudEvent,
	type MaestroCorrelation,
	recordMaestroApprovalHit,
	recordMaestroSkillOutcome,
	recordMaestroToolCallAttempt,
	recordMaestroToolCallCompleted,
	withMaestroEventBusTransportOverride,
} from "./maestro-event-bus.js";

export const CANONICAL_MAESTRO_PUBLISHER_CONFORMANCE_FIXTURE_NAME =
	"maestro-publisher-critical-path";

const ORGANIZATION_ID = "org_evalops_fixture";
const WORKSPACE_ID = "workspace_publisher_fixture";
const SESSION_ID = "session_publisher_fixture_001";
const AGENT_RUN_ID = "agent_run_publisher_fixture_001";
const BASH_TOOL_CALL_ID = "tool_call_publisher_fixture_bash_001";
const BASH_TOOL_EXECUTION_ID = "tool_exec_publisher_fixture_bash_001";
const SKILL_TOOL_CALL_ID = "tool_call_publisher_fixture_skill_001";
const SKILL_TOOL_EXECUTION_ID = "tool_exec_publisher_fixture_skill_001";
const APPROVAL_REQUEST_ID = "approval_publisher_fixture_001";
const SKILL_INVOCATION_ID = "skill_invocation_publisher_fixture_001";
const SKILL_ID = "skill_incident_review";

const promptMetadata = {
	name: "maestro-system",
	label: "production",
	surface: "web",
	version: 9,
	versionId: "prompt_version_9",
	hash: "sha256:prompt-platform-replay",
	source: "service",
} satisfies PromptMetadata;

const skillMetadata = {
	artifactId: SKILL_ID,
	name: "incident-review",
	version: "3",
	hash: "sha256:skill-incident-review",
	source: "service",
} satisfies SkillArtifactMetadata;

const fixtureEnv: NodeJS.ProcessEnv = {
	MAESTRO_EVENT_BUS_URL: "nats://maestro-publisher-fixture.invalid:4222",
	MAESTRO_EVENT_BUS_SOURCE: "maestro-publisher-fixture",
	MAESTRO_EVALOPS_ORG_ID: ORGANIZATION_ID,
	MAESTRO_EVALOPS_WORKSPACE_ID: WORKSPACE_ID,
	MAESTRO_SESSION_ID: SESSION_ID,
	MAESTRO_AGENT_RUN_ID: AGENT_RUN_ID,
	MAESTRO_AGENT_ID: "agent_maestro_publisher_fixture",
	MAESTRO_ACTOR_ID: "user_publisher_fixture",
	MAESTRO_PRINCIPAL_ID: "principal_publisher_fixture",
	TRACE_ID: "trace_publisher_fixture_001",
	MAESTRO_EVENT_BUS_ATTR_FIXTURE: "maestro-publisher-conformance",
	MAESTRO_EVENT_BUS_ATTR_PUBLISHER_CONTRACT: "maestro.v1",
};

const baseCorrelation: MaestroCorrelation = {
	organization_id: ORGANIZATION_ID,
	workspace_id: WORKSPACE_ID,
	session_id: SESSION_ID,
	agent_run_id: AGENT_RUN_ID,
	agent_id: "agent_maestro_publisher_fixture",
	actor_id: "user_publisher_fixture",
	principal_id: "principal_publisher_fixture",
	trace_id: "trace_publisher_fixture_001",
	attributes: {
		fixture: "maestro-publisher-conformance",
		publisher_contract: "maestro.v1",
	},
};

const eventPlan = [
	{
		type: MaestroBusEventType.ApprovalHit,
		id: "evt_maestro_publisher_001_approval_hit",
		time: "2026-04-23T18:05:00.000Z",
	},
	{
		type: MaestroBusEventType.ToolCallAttempted,
		id: "evt_maestro_publisher_002_tool_call_attempted",
		time: "2026-04-23T18:06:00.000Z",
	},
	{
		type: MaestroBusEventType.ToolCallCompleted,
		id: "evt_maestro_publisher_003_tool_call_completed",
		time: "2026-04-23T18:07:00.000Z",
	},
	{
		type: MaestroBusEventType.SkillFailed,
		id: "evt_maestro_publisher_004_skill_failed",
		time: "2026-04-23T18:09:00.000Z",
	},
] as const;

export type MaestroPublisherConformanceFixtureEvent = MaestroCloudEvent<
	Record<string, unknown>
>;

export interface BuildMaestroPublisherConformanceFixtureOptions {
	sourceRevision?: string;
}

export interface MaestroPublisherConformanceFixture {
	fixture_version: "maestro-publisher-conformance/v1";
	name: typeof CANONICAL_MAESTRO_PUBLISHER_CONFORMANCE_FIXTURE_NAME;
	event_count: number;
	origin: {
		repository: "evalops/maestro";
		issue: "evalops/maestro#49";
		publisher_package: "packages/ai";
		source_paths: string[];
		generated_by: "scripts/generate-maestro-publisher-conformance-fixture.ts";
		source_revision: string;
	};
	subjects: MaestroBusEventType[];
	stable_untyped_keys: Record<string, string[]>;
	expected_assertions: {
		required_event_types: MaestroBusEventType[];
		required_subjects: MaestroBusEventType[];
	};
	events: MaestroPublisherConformanceFixtureEvent[];
}

function bashCorrelation(): MaestroCorrelation {
	return {
		...baseCorrelation,
		agent_run_step_id: BASH_TOOL_CALL_ID,
	};
}

function skillCorrelation(): MaestroCorrelation {
	return {
		...baseCorrelation,
		agent_run_step_id: SKILL_TOOL_CALL_ID,
	};
}

async function flushPublisherTasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

async function publishFixtureEvent(
	events: MaestroPublisherConformanceFixtureEvent[],
	record: () => void,
): Promise<void> {
	const previousLength = events.length;
	record();
	await flushPublisherTasks();
	if (events.length !== previousLength + 1) {
		throw new Error("Maestro publisher fixture did not capture an event");
	}
}

async function buildPublisherEvents(): Promise<
	MaestroPublisherConformanceFixtureEvent[]
> {
	const events: MaestroPublisherConformanceFixtureEvent[] = [];
	return withMaestroEventBusTransportOverride(
		{
			async publish(_subject, payload) {
				events.push(
					JSON.parse(payload) as MaestroPublisherConformanceFixtureEvent,
				);
			},
		},
		async () => {
			await publishFixtureEvent(events, () => {
				recordMaestroApprovalHit({
					event_id: eventPlan[0].id,
					approval_request_id: APPROVAL_REQUEST_ID,
					governance_decision_id: "governance_decision_publisher_fixture_001",
					action: "Run workspace test command",
					command: "bunx vitest --run test/telemetry",
					risk_level: "RISK_LEVEL_MEDIUM",
					decision_mode: "MAESTRO_DECISION_MODE_REQUIRE_APPROVAL",
					policy_id: "policy_workspace_test_approval",
					reason: "publisher fixture approval path",
					correlation: bashCorrelation(),
					occurred_at: eventPlan[0].time,
					env: fixtureEnv,
				});
			});
			await publishFixtureEvent(events, () => {
				recordMaestroToolCallAttempt({
					event_id: eventPlan[1].id,
					tool_call_id: BASH_TOOL_CALL_ID,
					tool_execution_id: BASH_TOOL_EXECUTION_ID,
					tool_namespace: "builtin",
					tool_name: "Bash",
					tool_version: "1",
					capability: "workspace:test",
					risk_level: "RISK_LEVEL_MEDIUM",
					safe_arguments: {
						command_summary: "bunx vitest --run test/telemetry",
					},
					prompt_metadata: promptMetadata,
					correlation: bashCorrelation(),
					attempted_at: eventPlan[1].time,
					env: fixtureEnv,
				});
			});
			await publishFixtureEvent(events, () => {
				recordMaestroToolCallCompleted({
					event_id: eventPlan[2].id,
					tool_call_id: BASH_TOOL_CALL_ID,
					tool_execution_id: BASH_TOOL_EXECUTION_ID,
					status: "MAESTRO_TOOL_CALL_STATUS_SUCCEEDED",
					approval_request_id: APPROVAL_REQUEST_ID,
					safe_output: {
						exit_code: 0,
						summary: "8 telemetry tests passed",
					},
					prompt_metadata: promptMetadata,
					skill_metadata: skillMetadata,
					correlation: bashCorrelation(),
					completed_at: eventPlan[2].time,
					env: fixtureEnv,
				});
			});
			await publishFixtureEvent(events, () => {
				recordMaestroSkillOutcome({
					event_id: eventPlan[3].id,
					invocation_id: SKILL_INVOCATION_ID,
					skill_id: SKILL_ID,
					status: "MAESTRO_SKILL_OUTCOME_STATUS_EVALUATION_FAILED",
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
					prompt_metadata: promptMetadata,
					skill_metadata: skillMetadata,
					correlation: skillCorrelation(),
					outcome_at: eventPlan[3].time,
					env: fixtureEnv,
				});
			});
			return events;
		},
	);
}

export async function buildCanonicalMaestroPublisherConformanceFixture(
	options: BuildMaestroPublisherConformanceFixtureOptions = {},
): Promise<MaestroPublisherConformanceFixture> {
	const events = await buildPublisherEvents();
	const subjects = eventPlan.map((event) => event.type);
	return {
		fixture_version: "maestro-publisher-conformance/v1",
		name: CANONICAL_MAESTRO_PUBLISHER_CONFORMANCE_FIXTURE_NAME,
		event_count: events.length,
		origin: {
			repository: "evalops/maestro",
			issue: "evalops/maestro#49",
			publisher_package: "packages/ai",
			source_paths: [
				"packages/ai/src/telemetry/index.ts",
				"src/telemetry/maestro-event-bus.ts",
				"src/telemetry/maestro-publisher-conformance-fixture.ts",
			],
			generated_by: "scripts/generate-maestro-publisher-conformance-fixture.ts",
			source_revision: options.sourceRevision ?? "maestro-publisher-generator",
		},
		subjects,
		stable_untyped_keys: {
			"correlation.attributes": ["fixture", "publisher_contract"],
			prompt_metadata: [
				"hash",
				"label",
				"name",
				"source",
				"surface",
				"version",
				"versionId",
			],
			skill_metadata: ["artifactId", "hash", "name", "source", "version"],
			safe_arguments: ["command_summary"],
			safe_output: ["exit_code", "summary"],
		},
		expected_assertions: {
			required_event_types: subjects,
			required_subjects: subjects,
		},
		events,
	};
}

export async function canonicalMaestroPublisherConformanceFixtureJson(
	options: BuildMaestroPublisherConformanceFixtureOptions = {},
): Promise<string> {
	return `${JSON.stringify(
		await buildCanonicalMaestroPublisherConformanceFixture(options),
		null,
		2,
	)}\n`;
}
