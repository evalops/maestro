import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MaestroBusEventType } from "../../src/telemetry/maestro-event-bus.js";
import {
	CANONICAL_MAESTRO_PLATFORM_REPLAY_FIXTURE_NAME,
	buildCanonicalMaestroPlatformReplayFixture,
	canonicalMaestroPlatformReplayFixtureJson,
} from "../../src/telemetry/maestro-platform-replay-fixture.js";

describe("canonical Maestro Platform replay fixture", () => {
	const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

	it("emits deterministic Platform replay events with stable join keys", () => {
		const fixture = buildCanonicalMaestroPlatformReplayFixture();

		expect(fixture).toMatchObject({
			fixture_version: "maestro-platform-replay/v1",
			name: CANONICAL_MAESTRO_PLATFORM_REPLAY_FIXTURE_NAME,
			event_count: 11,
			correlation: {
				organization_id: "org_evalops_fixture",
				workspace_id: "workspace_platform_replay",
				session_id: "session_platform_replay_001",
				agent_run_id: "agent_run_platform_replay_001",
				tool_call_id: "tool_call_platform_replay_bash_001",
				tool_execution_id: "tool_exec_platform_replay_bash_001",
				skill_tool_call_id: "tool_call_platform_replay_skill_001",
				skill_tool_execution_id: "tool_exec_platform_replay_skill_001",
				approval_request_id: "approval_platform_replay_001",
			},
		});

		expect(fixture.subjects).toEqual([
			MaestroBusEventType.SessionStarted,
			MaestroBusEventType.PromptVariantSelected,
			MaestroBusEventType.ToolCallAttempted,
			MaestroBusEventType.ToolCallCompleted,
			MaestroBusEventType.SkillInvoked,
			MaestroBusEventType.ApprovalHit,
			MaestroBusEventType.ToolCallAttempted,
			MaestroBusEventType.ToolCallCompleted,
			MaestroBusEventType.EvalScored,
			MaestroBusEventType.SkillFailed,
			MaestroBusEventType.SessionClosed,
		]);

		expect(fixture.events.map((event) => event.id)).toEqual([
			"evt_maestro_replay_001_session_started",
			"evt_maestro_replay_002_prompt_variant_selected",
			"evt_maestro_replay_003_skill_tool_call_attempted",
			"evt_maestro_replay_004_skill_tool_call_completed",
			"evt_maestro_replay_005_skill_invoked",
			"evt_maestro_replay_006_approval_hit",
			"evt_maestro_replay_007_eval_tool_call_attempted",
			"evt_maestro_replay_008_eval_tool_call_completed",
			"evt_maestro_replay_009_eval_scored",
			"evt_maestro_replay_010_skill_failed",
			"evt_maestro_replay_011_session_closed",
		]);

		for (const event of fixture.events) {
			expect(event).toMatchObject({
				spec_version: "1.0",
				source: "maestro-fixture",
				tenant_id: "org_evalops_fixture",
				data_content_type: "application/protobuf",
				data: {
					correlation: {
						organization_id: "org_evalops_fixture",
						workspace_id: "workspace_platform_replay",
						session_id: "session_platform_replay_001",
						agent_run_id: "agent_run_platform_replay_001",
						trace_id: "trace_platform_replay_001",
						request_id: "request_platform_replay_001",
					},
				},
			});
			expect(event.subject).toBe(event.type);
			expect(event.extensions.dataschema).toMatch(
				/^buf\.build\/evalops\/proto\/maestro\.v1\./,
			);
			expect(event.time).toMatch(/^2026-04-23T18:/);
		}
	});

	it("uses production Maestro metadata shapes for prompt, skill, and eval assertions", () => {
		const fixture = buildCanonicalMaestroPlatformReplayFixture();
		const byType = new Map(fixture.events.map((event) => [event.type, event]));

		const promptVariantSelected = byType.get(
			MaestroBusEventType.PromptVariantSelected,
		)?.data;
		expect(promptVariantSelected).toMatchObject({
			"@type": "type.googleapis.com/maestro.v1.PromptVariantSelected",
			prompt_metadata: {
				name: "maestro-system",
				label: "production",
				surface: "web",
				version: 9,
				versionId: "prompt_version_9",
				hash: "sha256:prompt-platform-replay",
				source: "service",
			},
			selected_at: "2026-04-23T18:01:00.000Z",
		});
		expect(promptVariantSelected).not.toHaveProperty("prompt_id");
		expect(promptVariantSelected).not.toHaveProperty("version_id");
		const toolAttempts = fixture.events
			.filter((event) => event.type === MaestroBusEventType.ToolCallAttempted)
			.map((event) => event.data);
		expect(toolAttempts).toHaveLength(2);
		expect(toolAttempts[0]).toMatchObject({
			tool_call_id: "tool_call_platform_replay_skill_001",
			tool_execution_id: "tool_exec_platform_replay_skill_001",
			tool_name: "Skill",
			prompt_metadata: {
				name: "maestro-system",
				label: "production",
			},
		});
		expect(toolAttempts[0]).not.toHaveProperty("skill_metadata");
		expect(toolAttempts[1]).toMatchObject({
			tool_call_id: "tool_call_platform_replay_bash_001",
			tool_execution_id: "tool_exec_platform_replay_bash_001",
			tool_name: "Bash",
			prompt_metadata: {
				name: "maestro-system",
				label: "production",
			},
		});
		expect(toolAttempts[1]).not.toHaveProperty("skill_metadata");
		expect(byType.get(MaestroBusEventType.SkillInvoked)?.data).toMatchObject({
			"@type": "type.googleapis.com/maestro.v1.SkillInvocation",
			prompt_metadata: {
				name: "maestro-system",
				label: "production",
			},
			skill_metadata: {
				name: "incident-review",
				hash: "sha256:skill-incident-review",
				source: "service",
				artifactId: "skill_incident_review",
				version: "3",
			},
			tool_call_id: "tool_call_platform_replay_skill_001",
			tool_execution_id: "tool_exec_platform_replay_skill_001",
			invoked_at: "2026-04-23T18:04:00.000Z",
		});
		expect(
			byType.get(MaestroBusEventType.SkillInvoked)?.data,
		).not.toHaveProperty("invocation_id");
		expect(
			byType.get(MaestroBusEventType.SkillInvoked)?.data,
		).not.toHaveProperty("skill_id");
		expect(byType.get(MaestroBusEventType.SkillFailed)?.data).toMatchObject({
			"@type": "type.googleapis.com/maestro.v1.SkillOutcome",
			prompt_metadata: {
				name: "maestro-system",
				label: "production",
			},
			skill_metadata: {
				name: "incident-review",
				hash: "sha256:skill-incident-review",
				source: "service",
				artifactId: "skill_incident_review",
				version: "3",
			},
			tool_call_id: "tool_call_platform_replay_skill_001",
			tool_execution_id: "tool_exec_platform_replay_skill_001",
			turn_status: "evaluation_failed",
			error_category: "evaluation",
			error_message: "formatting checks failed",
			evaluation_tool_name: "Bash",
			evaluation_tool_call_id: "tool_call_platform_replay_bash_001",
			evaluation_tool_execution_id: "tool_exec_platform_replay_bash_001",
			evaluation_score: 0.82,
			evaluation_threshold: 0.9,
			evaluation_assertion_count: 1,
			evaluation_rationale: "formatting checks failed",
			outcome_at: "2026-04-23T18:09:00.000Z",
		});
		expect(
			byType.get(MaestroBusEventType.SkillFailed)?.data,
		).not.toHaveProperty("invocation_id");
		expect(
			byType.get(MaestroBusEventType.SkillFailed)?.data,
		).not.toHaveProperty("status");
		expect(
			byType.get(MaestroBusEventType.ToolCallCompleted)?.data,
		).not.toHaveProperty("estimated_cost");
		expect(byType.get(MaestroBusEventType.ApprovalHit)?.data).toMatchObject({
			context: {
				tool_name: "Bash",
				display_name: "Bash",
				summary_label: "Bash",
				args: {
					command: "bunx vitest --run test/telemetry",
				},
			},
		});
		expect(
			byType.get(MaestroBusEventType.ApprovalHit)?.data.context,
		).not.toHaveProperty("tool_call_id");
		expect(byType.get(MaestroBusEventType.EvalScored)?.data).toMatchObject({
			"@type": "type.googleapis.com/maestro.v1.MaestroEvalScore",
			tool_call_id: "tool_call_platform_replay_bash_001",
			tool_execution_id: "tool_exec_platform_replay_bash_001",
			tool_name: "Bash",
			score: 0.82,
			passed: false,
			threshold: 0.9,
			rationale: "formatting checks failed",
			assertion_count: 1,
			scored_at: "2026-04-23T18:08:00.000Z",
		});
		expect(byType.get(MaestroBusEventType.EvalScored)?.data).not.toHaveProperty(
			"eval_run_id",
		);
		expect(byType.get(MaestroBusEventType.EvalScored)?.data).not.toHaveProperty(
			"scenario_id",
		);
		expect(byType.get(MaestroBusEventType.EvalScored)?.data).not.toHaveProperty(
			"suite_id",
		);

		expect(fixture.expected_assertions).toMatchObject({
			required_event_types: fixture.subjects,
			required_subjects: fixture.subjects,
			platform_join_keys: {
				agent_run_id: "agent_run_platform_replay_001",
				prompt_id: "maestro-system",
				prompt_version_id: "prompt_version_9",
				prompt_artifact_hash: "sha256:prompt-platform-replay",
				tool_call_id: "tool_call_platform_replay_bash_001",
				tool_execution_id: "tool_exec_platform_replay_bash_001",
				evaluation_tool_call_id: "tool_call_platform_replay_bash_001",
				evaluation_tool_execution_id: "tool_exec_platform_replay_bash_001",
				skill_tool_call_id: "tool_call_platform_replay_skill_001",
				skill_tool_execution_id: "tool_exec_platform_replay_skill_001",
				approval_request_id: "approval_platform_replay_001",
				skill_id: "skill_incident_review",
			},
		});
	});

	it("uses event-specific Maestro correlation step ids", () => {
		const fixture = buildCanonicalMaestroPlatformReplayFixture();

		expect(
			fixture.events.map((event) => event.data.correlation.agent_run_step_id),
		).toEqual([
			"agent_run_step_platform_replay_001",
			"agent_run_step_platform_replay_001",
			"tool_call_platform_replay_skill_001",
			"tool_call_platform_replay_skill_001",
			"tool_call_platform_replay_skill_001",
			"tool_call_platform_replay_bash_001",
			"tool_call_platform_replay_bash_001",
			"tool_call_platform_replay_bash_001",
			"tool_call_platform_replay_bash_001",
			"agent_run_step_platform_replay_001",
			"agent_run_step_platform_replay_001",
		]);
	});

	it("serializes the fixture as stable JSON for Platform replay tests", () => {
		const serialized = canonicalMaestroPlatformReplayFixtureJson();
		const parsed = JSON.parse(serialized);

		expect(serialized.endsWith("\n")).toBe(true);
		expect(serialized).toBe(canonicalMaestroPlatformReplayFixtureJson());
		expect(parsed).toMatchObject({
			fixture_version: "maestro-platform-replay/v1",
			name: CANONICAL_MAESTRO_PLATFORM_REPLAY_FIXTURE_NAME,
			event_count: 11,
		});
		expect(parsed.events).toHaveLength(11);
	});

	it("provides a one-command JSON fixture generator for Platform tests", () => {
		const output = execFileSync(
			resolve(repoRoot, "node_modules/.bin/tsx"),
			["scripts/generate-maestro-platform-replay-fixture.ts"],
			{
				cwd: repoRoot,
				encoding: "utf8",
			},
		);
		const parsed = JSON.parse(output);

		expect(parsed).toMatchObject({
			fixture_version: "maestro-platform-replay/v1",
			name: CANONICAL_MAESTRO_PLATFORM_REPLAY_FIXTURE_NAME,
			event_count: 11,
		});
		expect(parsed.events.map((event: { type: string }) => event.type)).toEqual(
			parsed.subjects,
		);
	});

	it("exports the fixture builder from the telemetry boundary", async () => {
		const telemetry = await import("../../src/telemetry/index.js");

		expect(
			telemetry.buildCanonicalMaestroPlatformReplayFixture(),
		).toMatchObject({
			name: CANONICAL_MAESTRO_PLATFORM_REPLAY_FIXTURE_NAME,
			event_count: 11,
		});
	});
});
