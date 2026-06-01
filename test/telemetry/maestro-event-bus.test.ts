import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as oauthStorage from "../../src/oauth/storage.js";
import { recordSessionDuration } from "../../src/telemetry.js";
import { maestroCorrelationToChronicleMetadata } from "../../src/telemetry/index.js";
import {
	MaestroBusEventType,
	buildMaestroCloudEvent,
	closeMaestroEventBusTransport,
	getMaestroEventBusStatus,
	hashA2AEndpointUrl,
	mirrorTelemetryToMaestroEventBus,
	publishMaestroCloudEvent,
	publishMaestroCloudEventStrict,
	recordMaestroA2ADelegationEvent,
	recordMaestroEvalScored,
	recordMaestroLearnedContext,
	recordMaestroPromptVariantSelected,
	recordMaestroSkillInvoked,
	recordMaestroSkillOutcome,
	recordMaestroSubagentDispatch,
	recordMaestroToolCallCompleted,
	resolveMaestroEventBusConfig,
	setMaestroEventBusTransportForTests,
	withMaestroEventBusTransportOverride,
} from "../../src/telemetry/maestro-event-bus.js";

describe("maestro event bus", () => {
	afterEach(async () => {
		setMaestroEventBusTransportForTests(undefined);
		await closeMaestroEventBusTransport();
	});

	function writeFlagSnapshot(flags: Array<{ key: string; enabled: boolean }>) {
		const dir = mkdtempSync(join(tmpdir(), "maestro-event-bus-flags-"));
		const path = join(dir, "flags.json");
		writeFileSync(path, JSON.stringify({ flags, schema_version: 1 }), "utf8");
		return {
			path,
			cleanup: () => rmSync(dir, { force: true, recursive: true }),
		};
	}

	function managedEventBusEnv(snapshotPath: string) {
		return {
			EVALOPS_FEATURE_FLAGS_PATH: snapshotPath,
			MAESTRO_EVENT_BUS_URL: "nats://bus.example:4222",
			MAESTRO_EVENT_BUS_SOURCE: "maestro.web",
			MAESTRO_EVALOPS_ORG_ID: "org_evalops",
			MAESTRO_EVALOPS_WORKSPACE_ID: "workspace_evalops",
			MAESTRO_EVALOPS_ACCESS_TOKEN: "token_evalops",
			MAESTRO_AGENT_RUN_ID: "run_evalops",
		};
	}

	it("uses an audit-bus consent scope independent of training telemetry", () => {
		const config = resolveMaestroEventBusConfig({
			MAESTRO_TELEMETRY: "0",
			MAESTRO_EVENT_BUS_URL: "nats://bus.example:4222",
			MAESTRO_EVALOPS_ORG_ID: "org_123",
			MAESTRO_EVALOPS_USER_ID: "user_123",
			MAESTRO_EVALOPS_WORKSPACE_ID: "workspace_123",
			MAESTRO_SESSION_ID: "session_123",
		});

		expect(config.enabled).toBe(true);
		expect(config.reason).toBe("nats");
		expect(config.natsUrl).toBe("nats://bus.example:4222");
		expect(config.defaultCorrelation).toMatchObject({
			organization_id: "org_123",
			user_id: "user_123",
			workspace_id: "workspace_123",
			session_id: "session_123",
		});
	});

	it("honors the internal telemetry kill switch before audit-bus routing", () => {
		const config = resolveMaestroEventBusConfig({
			MAESTRO_INTERNAL_TELEMETRY_DISABLED: "1",
			MAESTRO_TELEMETRY: "1",
			MAESTRO_EVENT_BUS_URL: "nats://bus.example:4222",
			MAESTRO_EVALOPS_ORG_ID: "org_123",
		});

		expect(config.enabled).toBe(false);
		expect(config.reason).toBe("internal telemetry disabled");
		expect(config.natsUrl).toBe("nats://bus.example:4222");
	});

	it("requires the managed rollout flag when a feature flag snapshot is mounted", () => {
		const snapshot = writeFlagSnapshot([
			{ key: "platform.kill_switches.maestro.platform_events", enabled: false },
			{ key: "maestro.platform_events.publisher_enabled", enabled: false },
		]);
		try {
			expect(
				getMaestroEventBusStatus(managedEventBusEnv(snapshot.path)),
			).toMatchObject({
				enabled: false,
				reason: "platform events rollout disabled",
			});
		} finally {
			snapshot.cleanup();
		}
	});

	it("honors the managed platform-events kill switch when a snapshot is mounted", () => {
		const snapshot = writeFlagSnapshot([
			{ key: "platform.kill_switches.maestro.platform_events", enabled: true },
			{ key: "maestro.platform_events.publisher_enabled", enabled: true },
		]);
		try {
			expect(
				getMaestroEventBusStatus(managedEventBusEnv(snapshot.path)),
			).toMatchObject({
				enabled: false,
				reason: "platform events kill switch enabled",
			});
		} finally {
			snapshot.cleanup();
		}
	});

	it("allows managed event publishing when rollout is enabled and kill switch is off", () => {
		const snapshot = writeFlagSnapshot([
			{ key: "platform.kill_switches.maestro.platform_events", enabled: false },
			{ key: "maestro.platform_events.publisher_enabled", enabled: true },
		]);
		try {
			expect(
				getMaestroEventBusStatus(managedEventBusEnv(snapshot.path)),
			).toMatchObject({
				enabled: true,
				reason: "nats",
			});
		} finally {
			snapshot.cleanup();
		}
	});

	it("does not apply managed rollout flags to manual NATS configuration", () => {
		const snapshot = writeFlagSnapshot([
			{ key: "platform.kill_switches.maestro.platform_events", enabled: false },
			{ key: "maestro.platform_events.publisher_enabled", enabled: false },
		]);
		try {
			expect(
				getMaestroEventBusStatus({
					EVALOPS_FEATURE_FLAGS_PATH: snapshot.path,
					MAESTRO_EVENT_BUS_URL: "nats://bus.example:4222",
				}),
			).toMatchObject({
				enabled: true,
				reason: "nats",
			});
		} finally {
			snapshot.cleanup();
		}
	});

	it("does not apply managed rollout flags to NATS publishers with identity metadata", () => {
		const snapshot = writeFlagSnapshot([
			{ key: "platform.kill_switches.maestro.platform_events", enabled: false },
			{ key: "maestro.platform_events.publisher_enabled", enabled: false },
		]);
		try {
			expect(
				getMaestroEventBusStatus({
					EVALOPS_FEATURE_FLAGS_PATH: snapshot.path,
					MAESTRO_EVENT_BUS_URL: "nats://bus.example:4222",
					MAESTRO_EVENT_BUS_SOURCE: "maestro.web",
					MAESTRO_EVALOPS_ORG_ID: "org_evalops",
					MAESTRO_EVALOPS_WORKSPACE_ID: "workspace_evalops",
				}),
			).toMatchObject({
				enabled: true,
				reason: "nats",
			});
		} finally {
			snapshot.cleanup();
		}
	});

	it("prefers EvalOps-scoped user identity over legacy Maestro user identity", () => {
		const config = resolveMaestroEventBusConfig({
			MAESTRO_EVENT_BUS_URL: "nats://bus.example:4222",
			MAESTRO_EVALOPS_ORG_ID: "org_123",
			MAESTRO_EVALOPS_USER_ID: "user_evalops",
			MAESTRO_USER_ID: "user_legacy",
			MAESTRO_SESSION_ID: "session_123",
			MAESTRO_PRINCIPAL_SUBJECT: "subject_123",
		});

		expect(config.defaultCorrelation.user_id).toBe("user_evalops");
		expect(config.defaultPrincipal).toMatchObject({
			subject: "subject_123",
			user_id: "user_evalops",
			organization_id: "org_123",
		});
	});

	it("loads EvalOps oauth credentials only once per config resolution", () => {
		const loadCredentials = vi
			.spyOn(oauthStorage, "loadOAuthCredentials")
			.mockReturnValue({
				type: "oauth",
				refresh: "refresh-token",
				access: "access-token",
				expires: Date.now() + 60_000,
				metadata: {
					organizationId: "org_123",
					userId: "user_123",
					agentMcp: {
						agentId: "agent_123",
						apiKey: "api_key_123",
						runId: "run_123",
						workspaceId: "workspace_123",
					},
				},
			});
		const previousSubject = process.env.MAESTRO_PRINCIPAL_SUBJECT;
		const previousSessionId = process.env.MAESTRO_SESSION_ID;
		try {
			process.env.MAESTRO_PRINCIPAL_SUBJECT = "subject_123";
			process.env.MAESTRO_SESSION_ID = "session_123";

			const config = resolveMaestroEventBusConfig();

			expect(loadCredentials).toHaveBeenCalledTimes(1);
			expect(loadCredentials).toHaveBeenCalledWith("evalops");
			expect(config.defaultCorrelation).toMatchObject({
				organization_id: "org_123",
				user_id: "user_123",
				workspace_id: "workspace_123",
				agent_id: "agent_123",
				agent_run_id: "run_123",
				session_id: "session_123",
			});
			expect(config.defaultPrincipal).toMatchObject({
				subject: "subject_123",
				user_id: "user_123",
				organization_id: "org_123",
				workspace_id: "workspace_123",
			});
		} finally {
			loadCredentials.mockRestore();
			if (previousSubject === undefined) {
				delete process.env.MAESTRO_PRINCIPAL_SUBJECT;
			} else {
				process.env.MAESTRO_PRINCIPAL_SUBJECT = previousSubject;
			}
			if (previousSessionId === undefined) {
				delete process.env.MAESTRO_SESSION_ID;
			} else {
				process.env.MAESTRO_SESSION_ID = previousSessionId;
			}
		}
	});

	it("carries managed EvalOps org and workspace aliases into CloudEvent context", () => {
		const event = buildMaestroCloudEvent(
			MaestroBusEventType.ToolCallAttempted,
			{
				tool_call_id: "tool_1",
				tool_name: "bash",
				attempted_at: "2026-05-06T01:00:00.000Z",
			},
			{
				env: {
					MAESTRO_EVALOPS_ACCESS_TOKEN: "evalops-token",
					EVALOPS_ORGANIZATION_ID: "org_alias",
					EVALOPS_WORKSPACE_ID: "workspace_alias",
					MAESTRO_AGENT_ID: "coding-agent",
					MAESTRO_AGENT_RUN_ID: "run_alias",
					MAESTRO_SESSION_ID: "session_alias",
				},
				eventId: "event_alias",
				time: "2026-05-06T01:00:00.000Z",
			},
		);

		expect(event.tenant_id).toBe("org_alias");
		expect(event.data.correlation).toMatchObject({
			organization_id: "org_alias",
			workspace_id: "workspace_alias",
			session_id: "session_alias",
			agent_id: "coding-agent",
			agent_run_id: "run_alias",
		});
		expect(event.extensions).toMatchObject({
			organization_id: "org_alias",
			workspace_id: "workspace_alias",
			maestro_session_id: "session_alias",
			agent_run_id: "run_alias",
		});
	});

	it("builds platform catalog compatible CloudEvents", () => {
		const event = buildMaestroCloudEvent(
			MaestroBusEventType.ToolCallAttempted,
			{
				correlation: {
					workspace_id: "workspace_123",
					session_id: "session_123",
					traceparent:
						"00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
					tracestate: "evalops=maestro-test",
				},
				tool_call_id: "tool_1",
				tool_name: "bash",
				attempted_at: "2026-04-22T16:00:00.000Z",
			},
			{
				env: {
					MAESTRO_EVENT_BUS_URL: "nats://bus.example:4222",
					MAESTRO_EVENT_BUS_SOURCE: "maestro-test",
					MAESTRO_EVALOPS_ORG_ID: "org_123",
					MAESTRO_EVALOPS_USER_ID: "user_123",
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
				evalops_context_version: "evalops.context.v1",
				organization_id: "org_123",
				user_id: "user_123",
				workspace_id: "workspace_123",
				maestro_session_id: "session_123",
				traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
				tracestate: "evalops=maestro-test",
			},
		});
		expect(event.data.correlation).not.toHaveProperty("traceparent");
		expect(event.data.correlation).not.toHaveProperty("tracestate");
		expect(event.data["@type"]).toBe(
			"type.googleapis.com/maestro.v1.ToolCallAttempt",
		);
		expect(event.data.tool_call_id).toBe("tool_1");
	});

	it("publishes learned context CloudEvents for Cerebro recall", async () => {
		const published: Array<{ subject: string; payload: string }> = [];
		setMaestroEventBusTransportForTests({
			async publish(subject, payload) {
				published.push({ subject, payload });
			},
		});

		recordMaestroLearnedContext({
			event_id: "event_learned_1",
			learning_id: "learned_evalops_1",
			subject_thing_id: "maestro_repository_evalops_platform",
			statement:
				"Platform trace budgets must be scoped by EvalOps organization.",
			dimension: "traceability.org_budget_scope",
			confidence_score: 0.86,
			confidence_reason:
				"The coding session confirmed org identifiers are propagated through telemetry.",
			evidence: [
				{
					source: "maestro-session",
					source_id: "session_123",
					excerpt: "Org identifiers are present in trace context.",
				},
			],
			tool_call_id: "tool_call_123",
			tool_execution_id: "tool_exec_123",
			correlation: {
				organization_id: "org_123",
				user_id: "user_123",
				workspace_id: "workspace_123",
				session_id: "session_123",
				agent_run_id: "run_123",
				agent_id: "maestro",
			},
			learned_at: "2026-05-02T18:12:00.000Z",
			env: { MAESTRO_EVENT_BUS_URL: "nats://bus.example:4222" },
		});

		await Promise.resolve();

		expect(published).toHaveLength(1);
		expect(published[0]?.subject).toBe("maestro.events.context.learned");
		expect(JSON.parse(published[0]?.payload ?? "{}")).toMatchObject({
			id: "event_learned_1",
			type: "maestro.events.context.learned",
			data: {
				"@type": "type.googleapis.com/maestro.v1.MaestroLearnedContext",
				learning_id: "learned_evalops_1",
				subject_thing_id: "maestro_repository_evalops_platform",
				statement:
					"Platform trace budgets must be scoped by EvalOps organization.",
				dimension: "traceability.org_budget_scope",
				confidence_score: 0.86,
				confidence_reason:
					"The coding session confirmed org identifiers are propagated through telemetry.",
				evidence: [
					{
						source: "maestro-session",
						source_id: "session_123",
						excerpt: "Org identifiers are present in trace context.",
					},
				],
				tool_call_id: "tool_call_123",
				tool_execution_id: "tool_exec_123",
				correlation: {
					organization_id: "org_123",
					user_id: "user_123",
					workspace_id: "workspace_123",
					session_id: "session_123",
					agent_run_id: "run_123",
					agent_id: "maestro",
				},
			},
			extensions: {
				dataschema: "buf.build/evalops/proto/maestro.v1.MaestroLearnedContext",
				organization_id: "org_123",
				user_id: "user_123",
				workspace_id: "workspace_123",
				maestro_session_id: "session_123",
				agent_run_id: "run_123",
				tool_execution_id: "tool_exec_123",
			},
		});
	});

	it("serializes Maestro correlation into Chronicle metadata keys", () => {
		const metadata = maestroCorrelationToChronicleMetadata({
			organization_id: "org_123",
			user_id: "user_123",
			workspace_id: "workspace_123",
			session_id: "session_123",
			agent_run_id: "run_123",
			agent_run_step_id: "step_123",
			agent_id: "agent_123",
			actor_id: "user_123",
			principal_id: "principal_123",
			trace_id: "trace_123",
			traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
			tracestate: "evalops=maestro-test",
			request_id: "request_123",
			parent_event_id: "event_parent",
			attributes: {
				maestro_session_id: "spoofed_session",
				user_id: "spoofed_user",
				task_id: "task_123",
				task_type: "pr-review",
				source_issue: "42",
				trace_id: "spoofed_trace",
				empty: " ",
			},
		});

		expect(metadata).toMatchObject({
			organization_id: "org_123",
			user_id: "user_123",
			workspace_id: "workspace_123",
			maestro_session_id: "session_123",
			agent_run_id: "run_123",
			agent_run_step_id: "step_123",
			agent_id: "agent_123",
			actor_id: "user_123",
			principal_id: "principal_123",
			trace_id: "trace_123",
			traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
			tracestate: "evalops=maestro-test",
			request_id: "request_123",
			parent_event_id: "event_parent",
			task_id: "task_123",
			task_type: "pr-review",
			source_issue: "42",
		});
		expect(metadata.maestro_session_id).toBe("session_123");
		expect(metadata.user_id).toBe("user_123");
		expect(metadata.trace_id).toBe("trace_123");
		expect(metadata.empty).toBeUndefined();
	});

	it("maps session duration metadata to a close lifecycle CloudEvent", async () => {
		const published: Array<{ subject: string; payload: string }> = [];
		setMaestroEventBusTransportForTests({
			async publish(subject, payload) {
				published.push({ subject, payload });
			},
		});
		const previousUrl = process.env.MAESTRO_EVENT_BUS_URL;
		const previousSource = process.env.MAESTRO_EVENT_BUS_SOURCE;
		process.env.MAESTRO_EVENT_BUS_URL = "nats://bus.example:4222";
		process.env.MAESTRO_EVENT_BUS_SOURCE = "maestro-tui-test";
		try {
			await recordSessionDuration("session_tui", 1234, {
				closeReason: "MAESTRO_CLOSE_REASON_USER_STOPPED",
				closeMessage: "TUI stopped",
			});
			for (let i = 0; i < 10 && published.length === 0; i++) {
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
		} finally {
			if (previousUrl === undefined) {
				delete process.env.MAESTRO_EVENT_BUS_URL;
			} else {
				process.env.MAESTRO_EVENT_BUS_URL = previousUrl;
			}
			if (previousSource === undefined) {
				delete process.env.MAESTRO_EVENT_BUS_SOURCE;
			} else {
				process.env.MAESTRO_EVENT_BUS_SOURCE = previousSource;
			}
		}

		expect(published).toHaveLength(1);
		expect(published[0]?.subject).toBe("maestro.sessions.session.closed");
		expect(JSON.parse(published[0]?.payload ?? "{}")).toMatchObject({
			type: "maestro.sessions.session.closed",
			source: "maestro-tui-test",
			data: {
				correlation: {
					session_id: "session_tui",
				},
				state: "MAESTRO_SESSION_STATE_CLOSED",
				close_reason: "MAESTRO_CLOSE_REASON_USER_STOPPED",
				close_message: "TUI stopped",
				metadata: {
					metric: "session.duration",
					value: 1234,
				},
			},
		});
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
				prompt_id: "maestro-system",
				prompt_name: "maestro-system",
				version_id: "ver_9",
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

	it("publishes failed tool result CloudEvents on the failure subject", async () => {
		const published: Array<{ subject: string; payload: string }> = [];
		setMaestroEventBusTransportForTests({
			async publish(subject, payload) {
				published.push({ subject, payload });
			},
		});

		recordMaestroToolCallCompleted({
			tool_call_id: "tool_failed_1",
			tool_execution_id: "texec_failed_1",
			status: "MAESTRO_TOOL_CALL_STATUS_FAILED",
			error_code: "exit_1",
			error_message: "command failed",
			completed_at: "2026-04-23T18:02:00.000Z",
			env: { MAESTRO_EVENT_BUS_URL: "nats://bus.example:4222" },
		});

		await Promise.resolve();

		expect(published).toHaveLength(1);
		expect(published[0]?.subject).toBe("maestro.events.tool_call.failed");
		expect(JSON.parse(published[0]?.payload ?? "{}")).toMatchObject({
			type: "maestro.events.tool_call.failed",
			data: {
				tool_call_id: "tool_failed_1",
				tool_execution_id: "texec_failed_1",
				status: "MAESTRO_TOOL_CALL_STATUS_FAILED",
				error_code: "exit_1",
				error_message: "command failed",
			},
		});
	});

	it("publishes denied and cancelled tool outcomes on the completion subject", async () => {
		const published: Array<{ subject: string; payload: string }> = [];
		setMaestroEventBusTransportForTests({
			async publish(subject, payload) {
				published.push({ subject, payload });
			},
		});

		for (const status of [
			"MAESTRO_TOOL_CALL_STATUS_DENIED",
			"MAESTRO_TOOL_CALL_STATUS_CANCELLED",
		] as const) {
			recordMaestroToolCallCompleted({
				tool_call_id: `tool_${status.toLowerCase()}`,
				status,
				completed_at: "2026-04-23T18:03:00.000Z",
				env: { MAESTRO_EVENT_BUS_URL: "nats://bus.example:4222" },
			});
		}

		await Promise.resolve();

		expect(published).toHaveLength(2);
		for (const [index, status] of [
			"MAESTRO_TOOL_CALL_STATUS_DENIED",
			"MAESTRO_TOOL_CALL_STATUS_CANCELLED",
		].entries()) {
			expect(published[index]?.subject).toBe(
				"maestro.events.tool_call.completed",
			);
			expect(JSON.parse(published[index]?.payload ?? "{}")).toMatchObject({
				type: "maestro.events.tool_call.completed",
				data: { status },
			});
		}
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

	it("publishes subagent dispatch CloudEvents for audit replay", async () => {
		const published: Array<{ subject: string; payload: string }> = [];
		setMaestroEventBusTransportForTests({
			async publish(subject, payload) {
				published.push({ subject, payload });
			},
		});

		recordMaestroSubagentDispatch({
			dispatch_id: "dispatch_1",
			mode: "smart",
			subagent_type: "coder",
			model: "gpt-5.5",
			provider: "openai-codex",
			reasoning_effort: "medium",
			source: "mode",
			success: true,
			latency_ms: 7,
			parent_mode: "smart",
			parent_model_provider: "anthropic",
			swarm_id: "swarm_1",
			task_id: "task_1",
			teammate_id: "teammate_1",
			dispatched_at: "2026-05-19T17:00:00.000Z",
			env: { MAESTRO_EVENT_BUS_URL: "nats://bus.example:4222" },
		});

		await Promise.resolve();

		expect(published).toHaveLength(1);
		expect(published[0]?.subject).toBe("maestro.events.subagent.dispatched");
		expect(JSON.parse(published[0]?.payload ?? "{}")).toMatchObject({
			type: "maestro.events.subagent.dispatched",
			data: {
				"@type": "type.googleapis.com/maestro.v1.SubagentDispatch",
				dispatch_id: "dispatch_1",
				mode: "smart",
				subagent_type: "coder",
				model: "gpt-5.5",
				provider: "openai-codex",
				reasoning_effort: "medium",
				source: "mode",
				success: true,
				latency_ms: 7,
				parent_mode: "smart",
				parent_model_provider: "anthropic",
				swarm_id: "swarm_1",
				task_id: "task_1",
				teammate_id: "teammate_1",
				dispatched_at: "2026-05-19T17:00:00.000Z",
			},
		});
	});

	it("publishes A2A delegation CloudEvents with redacted endpoint correlation", async () => {
		const published: Array<{ subject: string; payload: string }> = [];
		setMaestroEventBusTransportForTests({
			async publish(subject, payload) {
				published.push({ subject, payload });
			},
		});

		recordMaestroA2ADelegationEvent({
			event_type: MaestroBusEventType.A2ATaskDispatched,
			event_id: "event_a2a_1",
			swarm_id: "swarm_1",
			lane_id: "lane_alpha",
			parent_task_id: "task_parent",
			a2a_task_id: "a2a_task_1",
			a2a_message_id: "a2a_message_1",
			context_id: "ctx_1",
			peer_agent_id: "agent_alpha",
			peer_name: "Alpha",
			peer_endpoint_url: "https://alpha.internal/a2a?token=secret",
			peer_endpoint_kind: "internal",
			skill_id: "maestro.subagent.code-review",
			task_class: "code.review",
			source: "platform-agent-registry",
			status: "TASK_STATE_SUBMITTED",
			success: true,
			latency_ms: 11,
			metadata: {
				platformAgentRunId: "run_platform_1",
				workerQueue: "queue-a2a",
			},
			correlation: {
				workspace_id: "workspace_123",
				session_id: "session_123",
				traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
				attributes: {
					platform_agent_run_id: "run_platform_1",
				},
			},
			occurred_at: "2026-05-23T18:00:00.000Z",
			env: { MAESTRO_EVENT_BUS_URL: "nats://bus.example:4222" },
		});

		await Promise.resolve();

		expect(published).toHaveLength(1);
		expect(published[0]?.subject).toBe("maestro.events.a2a.task.dispatched");
		const event = JSON.parse(published[0]?.payload ?? "{}");
		expect(event).toMatchObject({
			type: "maestro.events.a2a.task.dispatched",
			data: {
				"@type": "type.googleapis.com/maestro.v1.MaestroA2ADelegationEvent",
				swarm_id: "swarm_1",
				lane_id: "lane_alpha",
				parent_task_id: "task_parent",
				a2a_task_id: "a2a_task_1",
				a2a_message_id: "a2a_message_1",
				context_id: "ctx_1",
				peer_agent_id: "agent_alpha",
				peer_endpoint_kind: "internal",
				skill_id: "maestro.subagent.code-review",
				task_class: "code.review",
				source: "platform-agent-registry",
				status: "TASK_STATE_SUBMITTED",
				success: true,
				latency_ms: 11,
			},
			extensions: {
				traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
				workspace_id: "workspace_123",
				maestro_session_id: "session_123",
			},
		});
		expect(event.data.peer_endpoint_hash).toBe(
			`sha256:${createHash("sha256")
				.update("https://alpha.internal/a2a")
				.digest("hex")}`,
		);
		expect(JSON.stringify(event)).not.toContain("token=secret");
		expect(JSON.stringify(event)).not.toContain("alpha.internal/a2a");
		expect(event.data.correlation).not.toHaveProperty("traceparent");
	});

	it("normalizes A2A endpoint URLs before hashing telemetry identity", () => {
		const expectedHash = `sha256:${createHash("sha256")
			.update("https://alpha.internal/a2a")
			.digest("hex")}`;

		expect(
			hashA2AEndpointUrl(
				"https://user:secret@alpha.internal/a2a?token=one#fragment",
			),
		).toBe(expectedHash);
		expect(hashA2AEndpointUrl("https://alpha.internal/a2a?token=two")).toBe(
			expectedHash,
		);
	});

	it("mirrors subagent dispatch telemetry into audit CloudEvents", async () => {
		const published: Array<{ subject: string; payload: string }> = [];
		setMaestroEventBusTransportForTests({
			async publish(subject, payload) {
				published.push({ subject, payload });
			},
		});

		const telemetryEvent = {
			type: "subagent-dispatch",
			timestamp: "2026-05-19T17:01:00.000Z",
			mode: "smart",
			subagentType: "planner",
			model: "claude-sonnet-4-5",
			provider: "anthropic",
			reasoningEffort: "medium",
			source: "tier",
			success: false,
			latencyMs: 3,
			metadata: {
				dispatchId: "dispatch_2",
				swarmId: "swarm_2",
				taskId: "task_2",
				reason: "missing_parent_model_provider",
			},
		} as Parameters<typeof mirrorTelemetryToMaestroEventBus>[0] &
			Record<string, unknown>;
		await mirrorTelemetryToMaestroEventBus(telemetryEvent);

		expect(published).toHaveLength(1);
		expect(JSON.parse(published[0]?.payload ?? "{}")).toMatchObject({
			type: "maestro.events.subagent.dispatched",
			data: {
				dispatch_id: "dispatch_2",
				subagent_type: "planner",
				success: false,
				latency_ms: 3,
				swarm_id: "swarm_2",
				task_id: "task_2",
				reason: "missing_parent_model_provider",
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
			scorer: "fermata.replay.score",
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
				eval_run_id: "exec_eval_1",
				scenario_id: "skill_remote_1",
				tool_call_id: "tool_eval_1",
				tool_execution_id: "exec_eval_1",
				tool_name: "Bash",
				score: 0.82,
				threshold: 0.9,
				passed: false,
				scorer: "fermata.replay.score",
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

	it("keeps runtime publish best-effort but exposes a strict smoke path", async () => {
		setMaestroEventBusTransportForTests({
			async publish() {
				throw new Error("nats unavailable");
			},
		});
		const data = {
			correlation: {
				workspace_id: "workspace_123",
				session_id: "session_123",
			},
			action: "Smoke approval",
			decision_mode: "MAESTRO_DECISION_MODE_REQUIRE_APPROVAL" as const,
			occurred_at: "2026-04-22T16:00:00.000Z",
		};
		const options = {
			env: { MAESTRO_EVENT_BUS_URL: "nats://bus.example:4222" },
			eventId: "event_strict",
			time: "2026-04-22T16:00:00.000Z",
		};

		await expect(
			publishMaestroCloudEvent(MaestroBusEventType.ApprovalHit, data, options),
		).resolves.toBeUndefined();
		await expect(
			publishMaestroCloudEventStrict(
				MaestroBusEventType.ApprovalHit,
				data,
				options,
			),
		).rejects.toThrow("nats unavailable");
	});

	it("fails strict smoke publishing when bus routing is not configured", async () => {
		await expect(
			publishMaestroCloudEventStrict(
				MaestroBusEventType.ApprovalHit,
				{
					correlation: {
						workspace_id: "workspace_123",
						session_id: "session_123",
					},
					action: "Smoke approval",
					decision_mode: "MAESTRO_DECISION_MODE_REQUIRE_APPROVAL",
					occurred_at: "2026-04-22T16:00:00.000Z",
				},
				{ env: {} },
			),
		).rejects.toThrow("Maestro event bus is not enabled: disabled");
	});

	it("allows strict smoke publishing when an explicit NATS URL is configured", async () => {
		const published: Array<{ subject: string; payload: string }> = [];
		await withMaestroEventBusTransportOverride(
			{
				async publish(subject, payload) {
					published.push({ subject, payload });
				},
			},
			async () => {
				await publishMaestroCloudEventStrict(
					MaestroBusEventType.ApprovalHit,
					{
						correlation: {
							workspace_id: "workspace_123",
							session_id: "session_123",
						},
						action: "Smoke approval",
						decision_mode: "MAESTRO_DECISION_MODE_REQUIRE_APPROVAL",
						occurred_at: "2026-04-22T16:00:00.000Z",
					},
					{
						env: {
							MAESTRO_EVENT_BUS: "false",
							MAESTRO_EVENT_BUS_URL: "nats://bus.example:4222",
						},
					},
				);
			},
		);

		expect(published).toHaveLength(1);
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
