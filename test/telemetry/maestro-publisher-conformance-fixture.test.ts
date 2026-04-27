import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MaestroBusEventType } from "../../src/telemetry/maestro-event-bus.js";
import {
	CANONICAL_MAESTRO_PUBLISHER_CONFORMANCE_FIXTURE_NAME,
	buildCanonicalMaestroPublisherConformanceFixture,
	canonicalMaestroPublisherConformanceFixtureJson,
} from "../../src/telemetry/maestro-publisher-conformance-fixture.js";

function sortedKeys(value: unknown): string[] {
	return Object.keys(value as Record<string, unknown>).sort();
}

function toolCallId(value: unknown): string | undefined {
	return value &&
		typeof value === "object" &&
		typeof (value as Record<string, unknown>).tool_call_id === "string"
		? ((value as Record<string, unknown>).tool_call_id as string)
		: undefined;
}

describe("canonical Maestro publisher conformance fixture", () => {
	const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

	it("emits Platform publisher conformance events through shared telemetry publishers", async () => {
		const fixture = await buildCanonicalMaestroPublisherConformanceFixture({
			sourceRevision: "test-revision",
		});

		expect(fixture).toMatchObject({
			fixture_version: "maestro-publisher-conformance/v1",
			name: CANONICAL_MAESTRO_PUBLISHER_CONFORMANCE_FIXTURE_NAME,
			event_count: 4,
			origin: {
				repository: "evalops/maestro",
				issue: "evalops/maestro#49",
				publisher_package: "packages/ai",
				generated_by:
					"scripts/generate-maestro-publisher-conformance-fixture.ts",
				source_revision: "test-revision",
			},
		});

		expect(fixture.subjects).toEqual([
			MaestroBusEventType.ApprovalHit,
			MaestroBusEventType.ToolCallAttempted,
			MaestroBusEventType.ToolCallCompleted,
			MaestroBusEventType.SkillFailed,
		]);
		expect(fixture.events.map((event) => event.id)).toEqual([
			"evt_maestro_publisher_001_approval_hit",
			"evt_maestro_publisher_002_tool_call_attempted",
			"evt_maestro_publisher_003_tool_call_completed",
			"evt_maestro_publisher_004_skill_failed",
		]);

		for (const event of fixture.events) {
			expect(event).toMatchObject({
				spec_version: "1.0",
				source: "maestro-publisher-fixture",
				subject: event.type,
				data_content_type: "application/protobuf",
				tenant_id: "org_evalops_fixture",
				data: {
					correlation: {
						organization_id: "org_evalops_fixture",
						workspace_id: "workspace_publisher_fixture",
						session_id: "session_publisher_fixture_001",
						agent_run_id: "agent_run_publisher_fixture_001",
						agent_id: "agent_maestro_publisher_fixture",
						actor_id: "user_publisher_fixture",
						principal_id: "principal_publisher_fixture",
						trace_id: "trace_publisher_fixture_001",
						attributes: {
							fixture: "maestro-publisher-conformance",
							publisher_contract: "maestro.v1",
						},
					},
				},
			});
			expect(event.extensions.dataschema).toMatch(
				/^buf\.build\/evalops\/proto\/maestro\.v1\./,
			);
		}
	});

	it("keeps Platform's critical publisher fields and stable metadata keys", async () => {
		const fixture = await buildCanonicalMaestroPublisherConformanceFixture();
		const byType = new Map(fixture.events.map((event) => [event.type, event]));

		const approvalHit = byType.get(MaestroBusEventType.ApprovalHit)?.data;
		expect(approvalHit).toMatchObject({
			"@type": "type.googleapis.com/maestro.v1.ApprovalHit",
			approval_request_id: "approval_publisher_fixture_001",
			governance_decision_id: "governance_decision_publisher_fixture_001",
			action: "Run workspace test command",
			command: "bunx vitest --run test/telemetry",
			risk_level: "RISK_LEVEL_MEDIUM",
			decision_mode: "MAESTRO_DECISION_MODE_REQUIRE_APPROVAL",
			policy_id: "policy_workspace_test_approval",
			reason: "publisher fixture approval path",
		});

		const toolAttempt = byType.get(MaestroBusEventType.ToolCallAttempted)?.data;
		expect(toolAttempt).toMatchObject({
			"@type": "type.googleapis.com/maestro.v1.ToolCallAttempt",
			tool_call_id: "tool_call_publisher_fixture_bash_001",
			tool_execution_id: "tool_exec_publisher_fixture_bash_001",
			tool_namespace: "builtin",
			tool_name: "Bash",
			tool_version: "1",
			capability: "workspace:test",
			risk_level: "RISK_LEVEL_MEDIUM",
			safe_arguments: {
				command_summary: "bunx vitest --run test/telemetry",
			},
			prompt_metadata: {
				name: "maestro-system",
				label: "production",
				surface: "web",
				version: 9,
				versionId: "prompt_version_9",
				hash: "sha256:prompt-platform-replay",
				source: "service",
			},
		});

		const toolCompleted = byType.get(
			MaestroBusEventType.ToolCallCompleted,
		)?.data;
		expect(toolCompleted).toMatchObject({
			"@type": "type.googleapis.com/maestro.v1.ToolCallResult",
			tool_call_id: "tool_call_publisher_fixture_bash_001",
			tool_execution_id: "tool_exec_publisher_fixture_bash_001",
			status: "MAESTRO_TOOL_CALL_STATUS_SUCCEEDED",
			approval_request_id: "approval_publisher_fixture_001",
			safe_output: {
				exit_code: 0,
				summary: "8 telemetry tests passed",
			},
			skill_metadata: {
				artifactId: "skill_incident_review",
				name: "incident-review",
				version: "3",
				hash: "sha256:skill-incident-review",
				source: "service",
			},
		});

		const skillFailed = byType.get(MaestroBusEventType.SkillFailed)?.data;
		expect(skillFailed).toMatchObject({
			"@type": "type.googleapis.com/maestro.v1.SkillOutcome",
			invocation_id: "skill_invocation_publisher_fixture_001",
			skill_id: "skill_incident_review",
			status: "MAESTRO_SKILL_OUTCOME_STATUS_EVALUATION_FAILED",
			tool_call_id: "tool_call_publisher_fixture_skill_001",
			tool_execution_id: "tool_exec_publisher_fixture_skill_001",
			turn_status: "evaluation_failed",
			error_category: "evaluation",
			error_message: "formatting checks failed",
			evaluation_tool_name: "Bash",
			evaluation_tool_call_id: "tool_call_publisher_fixture_bash_001",
			evaluation_tool_execution_id: "tool_exec_publisher_fixture_bash_001",
			evaluation_score: 0.82,
			evaluation_threshold: 0.9,
			evaluation_assertion_count: 1,
			evaluation_rationale: "formatting checks failed",
		});

		expect(sortedKeys(toolAttempt?.prompt_metadata)).toEqual(
			fixture.stable_untyped_keys.prompt_metadata,
		);
		expect(sortedKeys(toolCompleted?.skill_metadata)).toEqual(
			fixture.stable_untyped_keys.skill_metadata,
		);
		expect(sortedKeys(toolAttempt?.safe_arguments)).toEqual(
			fixture.stable_untyped_keys.safe_arguments,
		);
		expect(sortedKeys(toolCompleted?.safe_output)).toEqual(
			fixture.stable_untyped_keys.safe_output,
		);
		expect(fixture.expected_assertions).toMatchObject({
			required_event_types: fixture.subjects,
			required_subjects: fixture.subjects,
		});
	});

	it("uses standalone agent run step ids instead of aliasing tool call ids", async () => {
		const fixture = await buildCanonicalMaestroPublisherConformanceFixture();

		for (const event of fixture.events) {
			const stepId = event.data.correlation.agent_run_step_id;
			const currentToolCallId = toolCallId(event.data);

			if (typeof stepId === "string" && typeof currentToolCallId === "string") {
				expect(stepId).not.toBe(currentToolCallId);
			}
		}
	});

	it("serializes stable publisher conformance JSON for Platform tests", async () => {
		const serialized = await canonicalMaestroPublisherConformanceFixtureJson({
			sourceRevision: "test-revision",
		});
		const parsed = JSON.parse(serialized);

		expect(serialized.endsWith("\n")).toBe(true);
		expect(serialized).toBe(
			await canonicalMaestroPublisherConformanceFixtureJson({
				sourceRevision: "test-revision",
			}),
		);
		expect(parsed).toMatchObject({
			fixture_version: "maestro-publisher-conformance/v1",
			name: CANONICAL_MAESTRO_PUBLISHER_CONFORMANCE_FIXTURE_NAME,
			event_count: 4,
		});
		expect(parsed.events).toHaveLength(4);
	});

	it("provides a one-command JSON fixture generator", () => {
		const output = execFileSync(
			resolve(repoRoot, "node_modules/.bin/tsx"),
			["scripts/generate-maestro-publisher-conformance-fixture.ts"],
			{
				cwd: repoRoot,
				encoding: "utf8",
			},
		);
		const parsed = JSON.parse(output);

		expect(parsed).toMatchObject({
			fixture_version: "maestro-publisher-conformance/v1",
			name: CANONICAL_MAESTRO_PUBLISHER_CONFORMANCE_FIXTURE_NAME,
			event_count: 4,
		});
		expect(parsed.events.map((event: { type: string }) => event.type)).toEqual(
			parsed.subjects,
		);
	});

	it("exports the fixture builder from the telemetry boundary", async () => {
		const telemetry = await import("../../src/telemetry/index.js");

		await expect(
			telemetry.buildCanonicalMaestroPublisherConformanceFixture({
				sourceRevision: "test-revision",
			}),
		).resolves.toMatchObject({
			name: CANONICAL_MAESTRO_PUBLISHER_CONFORMANCE_FIXTURE_NAME,
			event_count: 4,
		});
		expect(telemetry.recordMaestroSkillOutcome).toBeTypeOf("function");
		expect(telemetry.recordMaestroEvalScored).toBeTypeOf("function");
	});
});
