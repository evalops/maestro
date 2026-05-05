import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spanAttributes: Record<string, unknown>[] = [];

vi.mock("../../src/opentelemetry.js", () => ({
	getTelemetryTracer: () => ({
		startActiveSpan: (
			_name: string,
			callback: (span: {
				setAttributes(attributes: Record<string, unknown>): void;
				setStatus(status: Record<string, unknown>): void;
				end(): void;
			}) => void,
		) => {
			const attributes: Record<string, unknown> = {};
			callback({
				setAttributes(next) {
					Object.assign(attributes, next);
				},
				setStatus() {},
				end() {
					spanAttributes.push(attributes);
				},
			});
		},
	}),
	initOpenTelemetry: vi.fn(),
	isOpenTelemetryEnabled: () => true,
}));

const ENV_KEYS = [
	"MAESTRO_EVALOPS_WORKSPACE_ID",
	"MAESTRO_SESSION_ID",
	"MAESTRO_AGENT_RUN_ID",
];

const originalEnv = new Map(
	ENV_KEYS.map((key) => [key, process.env[key] as string | undefined]),
);

describe("OpenTelemetry correlation", () => {
	beforeEach(() => {
		spanAttributes.length = 0;
		process.env.MAESTRO_EVALOPS_WORKSPACE_ID = "workspace_process";
		process.env.MAESTRO_SESSION_ID = "session_process";
		process.env.MAESTRO_AGENT_RUN_ID = "run_process";
	});

	afterEach(() => {
		for (const key of ENV_KEYS) {
			const value = originalEnv.get(key);
			if (value === undefined) {
				Reflect.deleteProperty(process.env, key);
			} else {
				process.env[key] = value;
			}
		}
	});

	it("lets per-event metadata override process defaults on spans", async () => {
		const { recordTelemetry } = await import("../../src/telemetry.js");

		await recordTelemetry({
			type: "api-request",
			timestamp: "2026-05-05T19:00:00.000Z",
			method: "POST",
			path: "/api/chat",
			statusCode: 200,
			durationMs: 42,
			metadata: {
				workspaceId: "workspace_event",
				sessionId: "session_event",
				agentRunId: "run_event",
			},
		});

		expect(spanAttributes).toHaveLength(1);
		expect(spanAttributes[0]).toMatchObject({
			"workspace.id": "workspace_event",
			"evalops.workspace_id": "workspace_event",
			"maestro.session_id": "session_event",
			"maestro.agent_run_id": "run_event",
			"maestro.telemetry.type": "api-request",
		});
	});

	it("omits undefined llm attributes for base canonical turn events", async () => {
		const { recordTelemetry } = await import("../../src/telemetry.js");

		await recordTelemetry({
			type: "canonical-turn",
			timestamp: "2026-05-05T19:00:00.000Z",
			sessionId: "session_event",
			turnId: "turn_event",
			turnNumber: 3,
		});

		expect(spanAttributes).toHaveLength(1);
		expect(spanAttributes[0]).toMatchObject({
			"maestro.turn.id": "turn_event",
			"maestro.turn.number": 3,
			"maestro.turn.session_id": "session_event",
			"agent.session.id": "session_event",
		});
		expect(spanAttributes[0]).not.toHaveProperty("llm.model.id");
		expect(spanAttributes[0]).not.toHaveProperty("llm.model.provider");
		expect(Object.values(spanAttributes[0])).not.toContain(undefined);
	});

	it("uses top-level canonical turn trace ids for span correlation", async () => {
		const { recordTelemetry } = await import("../../src/telemetry.js");

		await recordTelemetry({
			type: "canonical-turn",
			timestamp: "2026-05-05T19:00:00.000Z",
			sessionId: "session_event",
			turnId: "turn_event",
			turnNumber: 4,
			traceId: "trace_top_level",
		});

		expect(spanAttributes).toHaveLength(1);
		expect(spanAttributes[0]).toMatchObject({
			"trace.id": "trace_top_level",
			"maestro.turn.id": "turn_event",
			"maestro.telemetry.type": "canonical-turn",
		});
	});

	it("falls back to metadata trace ids when canonical turn trace ids are blank", async () => {
		const { recordTelemetry } = await import("../../src/telemetry.js");

		await recordTelemetry({
			type: "canonical-turn",
			timestamp: "2026-05-05T19:00:00.000Z",
			sessionId: "session_event",
			turnId: "turn_event",
			turnNumber: 5,
			traceId: "  ",
			metadata: {
				traceId: "trace_metadata",
			},
		});

		expect(spanAttributes).toHaveLength(1);
		expect(spanAttributes[0]).toMatchObject({
			"trace.id": "trace_metadata",
			"maestro.turn.id": "turn_event",
		});
	});
});
