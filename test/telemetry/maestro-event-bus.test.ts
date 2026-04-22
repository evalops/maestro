import { afterEach, describe, expect, it, vi } from "vitest";

const { connectMock } = vi.hoisted(() => ({
	connectMock: vi.fn(),
}));

vi.mock("nats", () => ({
	StringCodec: () => ({
		encode: (value: string) => value,
	}),
	connect: connectMock,
}));
import {
	MaestroBusEventType,
	type MaestroTelemetryMirrorEvent,
	buildMaestroCloudEvent,
	closeMaestroEventBusTransport,
	getMaestroEventBusStatus,
	mirrorTelemetryToMaestroEventBus,
	publishMaestroCloudEvent,
	resolveMaestroEventBusConfig,
	setMaestroEventBusTransportForTests,
} from "../../src/telemetry/maestro-event-bus.js";

describe("maestro event bus", () => {
	const originalEventBusFlag = process.env.MAESTRO_EVENT_BUS;
	const originalAgentRunId = process.env.MAESTRO_AGENT_RUN_ID;

	afterEach(async () => {
		if (originalEventBusFlag === undefined) {
			delete process.env.MAESTRO_EVENT_BUS;
		} else {
			process.env.MAESTRO_EVENT_BUS = originalEventBusFlag;
		}
		if (originalAgentRunId === undefined) {
			delete process.env.MAESTRO_AGENT_RUN_ID;
		} else {
			process.env.MAESTRO_AGENT_RUN_ID = originalAgentRunId;
		}
		connectMock.mockReset();
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

	it("preserves agent run correlation when mirrored metadata omits it", async () => {
		process.env.MAESTRO_EVENT_BUS = "true";
		process.env.MAESTRO_AGENT_RUN_ID = "run_env";
		const published: Array<{ subject: string; payload: string }> = [];
		setMaestroEventBusTransportForTests({
			async publish(subject, payload) {
				published.push({ subject, payload });
			},
		});

		await mirrorTelemetryToMaestroEventBus({
			type: "tool-execution",
			timestamp: "2026-04-22T16:00:00.000Z",
			toolName: "bash",
			success: true,
			durationMs: 25,
			metadata: {
				sessionId: "session_meta",
			},
		} as MaestroTelemetryMirrorEvent);

		expect(published).toHaveLength(1);
		expect(JSON.parse(published[0]?.payload ?? "{}")).toMatchObject({
			data: {
				correlation: {
					session_id: "session_meta",
					agent_run_id: "run_env",
				},
			},
		});
	});

	it("retries NATS connection after an initial failure", async () => {
		const publishMock = vi.fn().mockResolvedValue(undefined);
		connectMock.mockImplementationOnce(async () => {
			throw new Error("nats unavailable");
		});
		connectMock.mockResolvedValue({
			jetstream: () => ({
				publish: publishMock,
			}),
			drain: vi.fn().mockResolvedValue(undefined),
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
				eventId: "event_3",
				time: "2026-04-22T16:00:00.000Z",
			},
		);
		await publishMaestroCloudEvent(
			MaestroBusEventType.ApprovalHit,
			{
				correlation: {
					workspace_id: "workspace_123",
					session_id: "session_123",
				},
				action: "Run shell command",
				decision_mode: "MAESTRO_DECISION_MODE_REQUIRE_APPROVAL",
				occurred_at: "2026-04-22T16:00:01.000Z",
			},
			{
				env: { MAESTRO_EVENT_BUS_URL: "nats://bus.example:4222" },
				eventId: "event_4",
				time: "2026-04-22T16:00:01.000Z",
			},
		);

		expect(connectMock).toHaveBeenCalledTimes(2);
		expect(publishMock).toHaveBeenCalledTimes(1);
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
