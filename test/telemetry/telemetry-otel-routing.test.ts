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

	it("populates skill metrics from tool skill metadata", async () => {
		const recordAgentTurnMetric = vi.fn();
		const recordCompactionMetric = vi.fn();
		const recordLlmRequestMetric = vi.fn();
		const recordLlmTokenUsageMetric = vi.fn();
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
});
