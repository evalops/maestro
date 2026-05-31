import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function createCanonicalTurnEvent() {
	return {
		type: "canonical-turn" as const,
		timestamp: "2026-05-07T07:00:00.000Z",
		sessionId: "session-123",
		turnId: "turn-456",
		turnNumber: 3,
		model: {
			id: "claude-opus-4-6",
			provider: "anthropic",
		},
		tokens: {
			input: 120,
			output: 48,
			cacheRead: 4,
			cacheWrite: 2,
		},
		totalDurationMs: 620,
		status: "success" as const,
		toolCount: 0,
	};
}

describe("telemetry OTel metric routing", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.unstubAllEnvs();
	});

	afterEach(() => {
		vi.resetModules();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it("does not duplicate turn or token metrics from telemetry replay paths", async () => {
		const recordAgentTurnMetric = vi.fn();
		const recordCompactionMetric = vi.fn();
		const recordLlmRequestMetric = vi.fn();
		const recordLlmTokenUsageMetric = vi.fn();
		const recordSubagentDispatchMetric = vi.fn();
		const recordToolInvocationMetric = vi.fn();

		vi.doMock("../../src/opentelemetry.js", () => ({
			getTelemetryTracer: () => ({
				startActiveSpan: (
					_name: string,
					callback: (span: {
						setAttributes(attributes: Record<string, unknown>): void;
						setAttribute(name: string, value: unknown): void;
						setStatus(status: Record<string, unknown>): void;
						end(): void;
					}) => void,
				) => {
					callback({
						setAttributes() {},
						setAttribute() {},
						setStatus() {},
						end() {},
					});
				},
			}),
			initOpenTelemetry: vi.fn(),
			isOpenTelemetryEnabled: () => true,
		}));
		vi.doMock("../../src/telemetry/metrics.js", () => ({
			recordAgentTurnMetric,
			recordCompactionMetric,
			recordLlmRequestMetric,
			recordLlmTokenUsageMetric,
			recordSubagentDispatchMetric,
			recordToolInvocationMetric,
		}));
		vi.doMock("../../src/telemetry/maestro-event-bus.js", () => ({
			mirrorTelemetryToMaestroEventBus: vi.fn(() => Promise.resolve()),
			resolveMaestroEventBusConfig: () => ({
				defaultCorrelation: {},
				defaultPrincipal: undefined,
				defaultSurface: "cli",
			}),
		}));
		vi.doMock("../../src/telemetry/meter-service-client.js", () => ({
			hasRemoteMeterDestination: () => false,
			mirrorCanonicalTurnEventToMeter: vi.fn(() => Promise.resolve()),
		}));

		const { recordTelemetry } = await import("../../src/telemetry.js");
		const event = createCanonicalTurnEvent();

		await recordTelemetry(event);
		await recordTelemetry({
			type: "business-metric",
			timestamp: "2026-05-07T07:00:01.000Z",
			metric: "tokens.input",
			value: event.tokens.input,
			metadata: {
				sessionId: event.sessionId,
				model: event.model.id,
				provider: event.model.provider,
			},
		});

		expect(recordAgentTurnMetric).not.toHaveBeenCalled();
		expect(recordLlmRequestMetric).not.toHaveBeenCalled();
		expect(recordLlmTokenUsageMetric).not.toHaveBeenCalled();
		expect(recordCompactionMetric).not.toHaveBeenCalled();
		expect(recordToolInvocationMetric).not.toHaveBeenCalled();
	});

	it("skips OTel and event-bus routing when internal telemetry is disabled", async () => {
		vi.stubEnv("MAESTRO_INTERNAL_TELEMETRY_DISABLED", "1");
		vi.stubEnv("MAESTRO_TELEMETRY", "1");

		const recordCompactionMetric = vi.fn();
		const recordSubagentDispatchMetric = vi.fn();
		const recordToolInvocationMetric = vi.fn();
		const mirrorTelemetryToMaestroEventBus = vi.fn(() => Promise.resolve());

		vi.doMock("../../src/opentelemetry.js", () => ({
			getTelemetryTracer: () => ({
				startActiveSpan: vi.fn(),
			}),
			initOpenTelemetry: vi.fn(),
			isOpenTelemetryEnabled: () => true,
		}));
		vi.doMock("../../src/telemetry/metrics.js", () => ({
			recordCompactionMetric,
			recordSubagentDispatchMetric,
			recordToolInvocationMetric,
		}));
		vi.doMock("../../src/telemetry/maestro-event-bus.js", () => ({
			mirrorTelemetryToMaestroEventBus,
			resolveMaestroEventBusConfig: () => ({
				defaultCorrelation: {},
				defaultPrincipal: undefined,
				defaultSurface: "cli",
			}),
		}));
		vi.doMock("../../src/telemetry/meter-service-client.js", () => ({
			hasRemoteMeterDestination: () => false,
			mirrorCanonicalTurnEventToMeter: vi.fn(() => Promise.resolve()),
		}));

		const { recordTelemetry } = await import("../../src/telemetry.js");

		await recordTelemetry({
			type: "tool-execution",
			timestamp: "2026-05-07T07:00:02.000Z",
			toolName: "bash",
			success: true,
			durationMs: 125,
		});

		expect(recordToolInvocationMetric).not.toHaveBeenCalled();
		expect(recordCompactionMetric).not.toHaveBeenCalled();
		expect(mirrorTelemetryToMaestroEventBus).not.toHaveBeenCalled();
	});

	it("populates skill metrics from tool skill metadata", async () => {
		const recordAgentTurnMetric = vi.fn();
		const recordCompactionMetric = vi.fn();
		const recordLlmRequestMetric = vi.fn();
		const recordLlmTokenUsageMetric = vi.fn();
		const recordSubagentDispatchMetric = vi.fn();
		const recordToolInvocationMetric = vi.fn();

		vi.doMock("../../src/opentelemetry.js", () => ({
			getTelemetryTracer: () => ({
				startActiveSpan: (
					_name: string,
					callback: (span: {
						setAttributes(attributes: Record<string, unknown>): void;
						setAttribute(name: string, value: unknown): void;
						setStatus(status: Record<string, unknown>): void;
						end(): void;
					}) => void,
				) => {
					callback({
						setAttributes() {},
						setAttribute() {},
						setStatus() {},
						end() {},
					});
				},
			}),
			initOpenTelemetry: vi.fn(),
			isOpenTelemetryEnabled: () => true,
		}));
		vi.doMock("../../src/telemetry/metrics.js", () => ({
			recordAgentTurnMetric,
			recordCompactionMetric,
			recordLlmRequestMetric,
			recordLlmTokenUsageMetric,
			recordSubagentDispatchMetric,
			recordToolInvocationMetric,
		}));
		vi.doMock("../../src/telemetry/maestro-event-bus.js", () => ({
			mirrorTelemetryToMaestroEventBus: vi.fn(() => Promise.resolve()),
			resolveMaestroEventBusConfig: () => ({
				defaultCorrelation: {},
				defaultPrincipal: undefined,
				defaultSurface: "cli",
			}),
		}));
		vi.doMock("../../src/telemetry/meter-service-client.js", () => ({
			hasRemoteMeterDestination: () => false,
			mirrorCanonicalTurnEventToMeter: vi.fn(() => Promise.resolve()),
		}));

		const { recordTelemetry } = await import("../../src/telemetry.js");

		await recordTelemetry({
			type: "tool-execution",
			timestamp: "2026-05-07T07:00:02.000Z",
			toolName: "Skill",
			success: true,
			durationMs: 125,
			metadata: {
				toolCallId: "call-123",
				skillMetadata: {
					name: "incident-review",
					hash: "hash_skill_123",
					source: "service",
				},
			},
		});

		expect(recordToolInvocationMetric).toHaveBeenCalledWith({
			toolName: "Skill",
			durationMs: 125,
			success: true,
			agentRunId: undefined,
			skillName: "incident-review",
		});
		expect(recordAgentTurnMetric).not.toHaveBeenCalled();
		expect(recordLlmRequestMetric).not.toHaveBeenCalled();
		expect(recordLlmTokenUsageMetric).not.toHaveBeenCalled();
		expect(recordCompactionMetric).not.toHaveBeenCalled();
	});

	it("routes subagent dispatch telemetry to first-class OTel metrics", async () => {
		const spanAttributes: Record<string, unknown> = {};
		const spanStatuses: Record<string, unknown>[] = [];
		const recordAgentTurnMetric = vi.fn();
		const recordCompactionMetric = vi.fn();
		const recordLlmRequestMetric = vi.fn();
		const recordLlmTokenUsageMetric = vi.fn();
		const recordSubagentDispatchMetric = vi.fn();
		const recordToolInvocationMetric = vi.fn();

		vi.doMock("../../src/opentelemetry.js", () => ({
			getTelemetryTracer: () => ({
				startActiveSpan: (
					_name: string,
					callback: (span: {
						setAttributes(attributes: Record<string, unknown>): void;
						setAttribute(name: string, value: unknown): void;
						setStatus(status: Record<string, unknown>): void;
						end(): void;
					}) => void,
				) => {
					callback({
						setAttributes(attributes) {
							Object.assign(spanAttributes, attributes);
						},
						setAttribute(name, value) {
							spanAttributes[name] = value;
						},
						setStatus(status) {
							spanStatuses.push(status);
						},
						end() {},
					});
				},
			}),
			initOpenTelemetry: vi.fn(),
			isOpenTelemetryEnabled: () => true,
		}));
		vi.doMock("../../src/telemetry/metrics.js", () => ({
			recordAgentTurnMetric,
			recordCompactionMetric,
			recordLlmRequestMetric,
			recordLlmTokenUsageMetric,
			recordSubagentDispatchMetric,
			recordToolInvocationMetric,
		}));
		vi.doMock("../../src/telemetry/maestro-event-bus.js", () => ({
			mirrorTelemetryToMaestroEventBus: vi.fn(() => Promise.resolve()),
			resolveMaestroEventBusConfig: () => ({
				defaultCorrelation: {},
				defaultPrincipal: undefined,
				defaultSurface: "cli",
			}),
		}));
		vi.doMock("../../src/telemetry/meter-service-client.js", () => ({
			hasRemoteMeterDestination: () => false,
			mirrorCanonicalTurnEventToMeter: vi.fn(() => Promise.resolve()),
		}));

		const { recordTelemetry } = await import("../../src/telemetry.js");

		await recordTelemetry({
			type: "subagent-dispatch",
			event: "subagent_dispatched",
			timestamp: "2026-05-19T17:05:00.000Z",
			mode: "smart",
			subagentType: "coder",
			model: "gpt-5.5",
			provider: "openai-codex",
			reasoningEffort: "medium",
			latencyMs: 7,
			success: true,
			source: "mode",
			metadata: {
				agentRunId: "run_123",
			},
		});

		expect(recordSubagentDispatchMetric).toHaveBeenCalledWith({
			mode: "smart",
			subagentType: "coder",
			provider: "openai-codex",
			model: "gpt-5.5",
			reasoningEffort: "medium",
			source: "mode",
			success: true,
			latencyMs: 7,
			agentRunId: "run_123",
		});
		expect(spanAttributes).toMatchObject({
			"maestro.subagent.event": "subagent_dispatched",
			"maestro.subagent.mode": "smart",
			"maestro.subagent.type": "coder",
			"llm.model.provider": "openai-codex",
			"llm.model.id": "gpt-5.5",
		});
		expect(spanStatuses).toHaveLength(1);
	});
});
