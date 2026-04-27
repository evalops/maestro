import { afterEach, describe, expect, it } from "vitest";
import {
	MaestroBusEventType,
	buildMaestroCloudEvent,
	closeMaestroEventBusTransport,
	getMaestroEventBusStatus,
	publishMaestroCloudEvent,
	recordMaestroEvalScored,
	recordMaestroPromptVariantSelected,
	recordMaestroSkillInvoked,
	recordMaestroSkillOutcome,
	recordMaestroToolCallCompleted,
	resolveMaestroEventBusConfig,
	setMaestroEventBusTransportForTests,
} from "../../src/telemetry/maestro-event-bus.js";

describe("maestro event bus", () => {
	afterEach(async () => {
		setMaestroEventBusTransportForTests(undefined);
		await closeMaestroEventBusTransport();
	});

	it("uses an audit-bus consent scope independent of training telemetry", () => {
		const config = resolveMaestroEventBusConfig({
			MAESTRO_TELEMETRY: "0",
			MAESTRO_EVENT_BUS_URL: "nats://bus.example:4222",
			MAESTRO_EVALOPS_ORG_ID: "org_123",
			MAESTRO_EVALOPS_WORKSPACE_ID: "workspace_123",
			MAESTRO_SESSION_ID: "session_123",
		});

		expect(config.enabled).toBe(true);
		expect(config.reason).toBe("nats");
		expect(config.natsUrl).toBe("nats://bus.example:4222");
		expect(config.defaultCorrelation).toMatchObject({
			organization_id: "org_123",
			workspace_id: "workspace_123",
			session_id: "session_123",
		});
	});

	it("builds platform catalog compatible CloudEvents", () => {
		const event = buildMaestroCloudEvent(
			MaestroBusEventType.ToolCallAttempted,
			{
				correlation: {
					workspace_id: "workspace_123",
					session_id: "session_123",
				},
				tool_call_id: "tool_1",
				tool_name: "bash",
				attempted_at: "2026-04-22T16:00:00.000Z",
			},
			{
				env: {
					MAESTRO_EVENT_BUS_URL: "nats://bus.example:4222",
					MAESTRO_EVENT_BUS_SOURCE: "maestro-test",
				},
				eventId: "event_1",
				time: "2026-04-22T16:00:00.000Z",
			},
		);

		expect(event).toMatchObject({
			spec_version: "1.0",
			id: "event_1",
			type: "maestro.events.tool_call.attempted",
			source: "maestro-test",
			subject: "maestro.events.tool_call.attempted",
			data_content_type: "application/protobuf",
			extensions: {
				dataschema: "buf.build/evalops/proto/maestro.v1.ToolCallAttempt",
			},
		});
		expect(event.data["@type"]).toBe(
			"type.googleapis.com/maestro.v1.ToolCallAttempt",
		);
		expect(event.data.tool_call_id).toBe("tool_1");
	});

	it("publishes prompt variant selected CloudEvents with prompt identity", async () => {
		const published: Array<{ subject: string; payload: string }> = [];
		setMaestroEventBusTransportForTests({
			async publish(subject, payload) {
				published.push({ subject, payload });
			},
		});

		recordMaestroPromptVariantSelected({
			prompt_metadata: {
				name: "maestro-system",
				label: "production",
				surface: "maestro",
				version: 9,
				versionId: "ver_9",
				hash: "hash_123",
				source: "service",
			},
			correlation: {
				workspace_id: "workspace_123",
				session_id: "session_123",
			},
			selected_at: "2026-04-23T17:00:00.000Z",
			env: { MAESTRO_EVENT_BUS_URL: "nats://bus.example:4222" },
		});

		await Promise.resolve();

		expect(published).toHaveLength(1);
		expect(published[0]?.subject).toBe(
			"maestro.events.prompt_variant.selected",
		);
		expect(JSON.parse(published[0]?.payload ?? "{}")).toMatchObject({
			type: "maestro.events.prompt_variant.selected",
			data: {
				prompt_metadata: {
					name: "maestro-system",
					versionId: "ver_9",
					source: "service",
				},
				selected_at: "2026-04-23T17:00:00.000Z",
			},
		});
	});

	it("publishes tool completion CloudEvents with selected skill identity", async () => {
		const published: Array<{ subject: string; payload: string }> = [];
		setMaestroEventBusTransportForTests({
			async publish(subject, payload) {
				published.push({ subject, payload });
			},
		});

		recordMaestroToolCallCompleted({
			tool_call_id: "tool_1",
			status: "MAESTRO_TOOL_CALL_STATUS_SUCCEEDED",
			skill_metadata: {
				name: "incident-review",
				artifactId: "skill_remote_1",
				version: "3",
				hash: "hash_skill_123",
				source: "service",
			},
			completed_at: "2026-04-23T18:00:00.000Z",
			env: { MAESTRO_EVENT_BUS_URL: "nats://bus.example:4222" },
		});

		await Promise.resolve();

		expect(published).toHaveLength(1);
		expect(JSON.parse(published[0]?.payload ?? "{}")).toMatchObject({
			type: "maestro.events.tool_call.completed",
			data: {
				tool_call_id: "tool_1",
				skill_metadata: {
					name: "incident-review",
					artifactId: "skill_remote_1",
					version: "3",
					source: "service",
				},
			},
		});
	});

	it("publishes skill invocation CloudEvents with selected skill identity", async () => {
		const published: Array<{ subject: string; payload: string }> = [];
		setMaestroEventBusTransportForTests({
			async publish(subject, payload) {
				published.push({ subject, payload });
			},
		});

		recordMaestroSkillInvoked({
			invocation_id: "skill_invocation_1",
			skill_id: "skill_remote_1",
			tool_call_id: "tool_skill_1",
			skill_metadata: {
				name: "incident-review",
				artifactId: "skill_remote_1",
				version: "3",
				hash: "hash_skill_123",
				source: "service",
			},
			invoked_at: "2026-04-23T18:05:00.000Z",
			env: { MAESTRO_EVENT_BUS_URL: "nats://bus.example:4222" },
		});

		await Promise.resolve();

		expect(published).toHaveLength(1);
		expect(JSON.parse(published[0]?.payload ?? "{}")).toMatchObject({
			type: "maestro.events.skill.invoked",
			data: {
				invocation_id: "skill_invocation_1",
				skill_id: "skill_remote_1",
				tool_call_id: "tool_skill_1",
				skill_metadata: {
					name: "incident-review",
					artifactId: "skill_remote_1",
					version: "3",
					source: "service",
				},
			},
		});
	});

	it("publishes skill outcome CloudEvents for failed turns", async () => {
		const published: Array<{ subject: string; payload: string }> = [];
		setMaestroEventBusTransportForTests({
			async publish(subject, payload) {
				published.push({ subject, payload });
			},
		});

		recordMaestroSkillOutcome({
			tool_call_id: "tool_skill_1",
			skill_metadata: {
				name: "incident-review",
				artifactId: "skill_remote_1",
				version: "3",
				hash: "hash_skill_123",
				source: "service",
			},
			turn_status: "error",
			error_message: "turn failed",
			outcome_at: "2026-04-23T18:10:00.000Z",
			env: { MAESTRO_EVENT_BUS_URL: "nats://bus.example:4222" },
		});

		await Promise.resolve();

		expect(published).toHaveLength(1);
		expect(JSON.parse(published[0]?.payload ?? "{}")).toMatchObject({
			type: "maestro.events.skill.failed",
			data: {
				tool_call_id: "tool_skill_1",
				turn_status: "error",
				error_message: "turn failed",
				skill_metadata: {
					name: "incident-review",
					artifactId: "skill_remote_1",
					source: "service",
				},
			},
		});
	});

	it("publishes evaluation-failed skill outcomes with eval details", async () => {
		const published: Array<{ subject: string; payload: string }> = [];
		setMaestroEventBusTransportForTests({
			async publish(subject, payload) {
				published.push({ subject, payload });
			},
		});

		recordMaestroSkillOutcome({
			invocation_id: "skill_invocation_1",
			skill_id: "skill_remote_1",
			tool_call_id: "tool_skill_1",
			tool_execution_id: "exec_skill_1",
			skill_metadata: {
				name: "incident-review",
				artifactId: "skill_remote_1",
				version: "3",
				hash: "hash_skill_123",
				source: "service",
			},
			turn_status: "evaluation_failed",
			error_category: "evaluation",
			error_message: "formatting checks failed",
			evaluation_tool_name: "Bash",
			evaluation_tool_call_id: "tool_eval_1",
			evaluation_tool_execution_id: "exec_eval_1",
			evaluation_score: 0.82,
			evaluation_threshold: 0.9,
			evaluation_assertion_count: 1,
			evaluation_rationale: "formatting checks failed",
			outcome_at: "2026-04-23T18:12:00.000Z",
			env: { MAESTRO_EVENT_BUS_URL: "nats://bus.example:4222" },
		});

		await Promise.resolve();

		expect(published).toHaveLength(1);
		expect(JSON.parse(published[0]?.payload ?? "{}")).toMatchObject({
			type: "maestro.events.skill.failed",
			data: {
				invocation_id: "skill_invocation_1",
				skill_id: "skill_remote_1",
				status: "MAESTRO_SKILL_OUTCOME_STATUS_EVALUATION_FAILED",
				tool_call_id: "tool_skill_1",
				tool_execution_id: "exec_skill_1",
				turn_status: "evaluation_failed",
				error_category: "evaluation",
				error_message: "formatting checks failed",
				evaluation_tool_name: "Bash",
				evaluation_tool_call_id: "tool_eval_1",
				evaluation_tool_execution_id: "exec_eval_1",
				evaluation_score: 0.82,
				evaluation_threshold: 0.9,
				evaluation_assertion_count: 1,
				evaluation_rationale: "formatting checks failed",
				skill_metadata: {
					name: "incident-review",
					artifactId: "skill_remote_1",
					source: "service",
				},
			},
		});
	});

	it("publishes eval scored CloudEvents with prompt and skill identity", async () => {
		const published: Array<{ subject: string; payload: string }> = [];
		setMaestroEventBusTransportForTests({
			async publish(subject, payload) {
				published.push({ subject, payload });
			},
		});

		recordMaestroEvalScored({
			tool_call_id: "tool_eval_1",
			tool_execution_id: "exec_eval_1",
			tool_name: "Bash",
			score: 0.82,
			threshold: 0.9,
			passed: false,
			rationale: "formatting checks failed",
			assertion_count: 1,
			prompt_metadata: {
				name: "maestro-system",
				label: "prod",
				surface: "maestro",
				version: 9,
				versionId: "ver_9",
				hash: "hash_prompt_123",
				source: "service",
			},
			skill_metadata: {
				name: "incident-review",
				artifactId: "skill_remote_1",
				version: "3",
				hash: "hash_skill_123",
				source: "service",
			},
			scored_at: "2026-04-23T18:15:00.000Z",
			env: { MAESTRO_EVENT_BUS_URL: "nats://bus.example:4222" },
		});

		await Promise.resolve();

		expect(published).toHaveLength(1);
		expect(JSON.parse(published[0]?.payload ?? "{}")).toMatchObject({
			type: "maestro.events.eval.scored",
			data: {
				tool_call_id: "tool_eval_1",
				tool_execution_id: "exec_eval_1",
				tool_name: "Bash",
				score: 0.82,
				threshold: 0.9,
				passed: false,
				rationale: "formatting checks failed",
				assertion_count: 1,
				prompt_metadata: {
					name: "maestro-system",
					versionId: "ver_9",
					source: "service",
				},
				skill_metadata: {
					name: "incident-review",
					artifactId: "skill_remote_1",
					source: "service",
				},
			},
		});
	});

	it("does not let undefined correlation overrides erase env defaults", () => {
		const event = buildMaestroCloudEvent(
			MaestroBusEventType.ToolCallCompleted,
			{
				tool_call_id: "tool_1",
				status: "MAESTRO_TOOL_CALL_STATUS_SUCCEEDED",
				completed_at: "2026-04-22T16:00:00.000Z",
			},
			{
				env: {
					MAESTRO_EVENT_BUS_URL: "nats://bus.example:4222",
					MAESTRO_EVALOPS_WORKSPACE_ID: "workspace_123",
					MAESTRO_SESSION_ID: "session_123",
					MAESTRO_AGENT_RUN_ID: "agent_run_123",
				},
				correlation: {
					agent_run_id: undefined,
					agent_run_step_id: undefined,
				},
			},
		);

		expect(event.data.correlation).toMatchObject({
			workspace_id: "workspace_123",
			session_id: "session_123",
			agent_run_id: "agent_run_123",
		});
	});

	it("publishes to the CloudEvent type subject", async () => {
		const published: Array<{ subject: string; payload: string }> = [];
		setMaestroEventBusTransportForTests({
			async publish(subject, payload) {
				published.push({ subject, payload });
			},
		});

		await publishMaestroCloudEvent(
			MaestroBusEventType.ApprovalHit,
			{
				correlation: {
					workspace_id: "workspace_123",
					session_id: "session_123",
				},
				action: "Run shell command",
				decision_mode: "MAESTRO_DECISION_MODE_REQUIRE_APPROVAL",
				occurred_at: "2026-04-22T16:00:00.000Z",
			},
			{
				env: { MAESTRO_EVENT_BUS_URL: "nats://bus.example:4222" },
				eventId: "event_2",
				time: "2026-04-22T16:00:00.000Z",
			},
		);

		expect(published).toHaveLength(1);
		expect(published[0]?.subject).toBe("maestro.events.approval_hit");
		expect(JSON.parse(published[0]?.payload ?? "{}")).toMatchObject({
			id: "event_2",
			type: "maestro.events.approval_hit",
			data: {
				action: "Run shell command",
				decision_mode: "MAESTRO_DECISION_MODE_REQUIRE_APPROVAL",
			},
		});
	});

	it("reports missing NATS URL separately from disabled bus state", () => {
		expect(
			getMaestroEventBusStatus({
				MAESTRO_EVENT_BUS: "true",
			}),
		).toMatchObject({
			enabled: true,
			reason: "missing nats url",
		});

		expect(
			getMaestroEventBusStatus({
				MAESTRO_EVENT_BUS: "false",
				MAESTRO_EVENT_BUS_URL: "nats://bus.example:4222",
			}),
		).toMatchObject({
			enabled: false,
			reason: "flag disabled",
		});
	});
});
