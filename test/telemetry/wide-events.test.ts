import { describe, expect, it, vi } from "vitest";
import {
	type CanonicalTurnEvent,
	TurnCollector,
	createTurnCollector,
	getSamplingConfigFromEnv,
} from "../../src/telemetry/wide-events.js";

describe("TurnCollector", () => {
	it("creates a canonical turn event with basic properties", () => {
		const collector = new TurnCollector("session-123", 1);

		collector.setModel({
			id: "claude-opus-4-6",
			provider: "anthropic",
			thinkingLevel: "medium",
		});

		const event = collector.complete(
			"success",
			{
				input: 1000,
				output: 500,
				cacheRead: 0,
				cacheWrite: 200,
			},
			0.05,
		);

		expect(event.type).toBe("canonical-turn");
		expect(event.sessionId).toBe("session-123");
		expect(event.turnNumber).toBe(1);
		expect(event.model.id).toBe("claude-opus-4-6");
		expect(event.model.provider).toBe("anthropic");
		expect(event.tokens.input).toBe(1000);
		expect(event.tokens.output).toBe(500);
		expect(event.costUsd).toBe(0.05);
		expect(event.status).toBe("success");
	});

	it("tracks tool executions", () => {
		const collector = new TurnCollector("session-123", 1);

		collector.recordToolStart("bash", "call-1", 100);
		collector.recordToolEnd("call-1", true, 50);

		collector.recordToolStart("read", "call-2", 200);
		collector.recordToolEnd("call-2", false, undefined, "permission_denied");

		const event = collector.complete(
			"success",
			{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			0,
		);

		expect(event.toolCount).toBe(2);
		expect(event.toolSuccessCount).toBe(1);
		expect(event.toolFailureCount).toBe(1);
		expect(event.tools).toHaveLength(2);
		expect(event.tools[0]?.name).toBe("bash");
		expect(event.tools[0]?.success).toBe(true);
		expect(event.tools[1]?.name).toBe("read");
		expect(event.tools[1]?.success).toBe(false);
		expect(event.tools[1]?.errorCode).toBe("permission_denied");
	});

	it("sets business context fields", () => {
		const collector = new TurnCollector("session-123", 1);

		collector
			.setSandboxMode("docker")
			.setApprovalMode("auto")
			.setMcpServers(["context7", "filesystem"])
			.setContextSourceCount(5)
			.setMessageCount(10)
			.setInputSize(5000)
			.addOutputSize(2000)
			.addOutputSize(1000)
			.setFeatures({
				safeMode: true,
				guardianEnabled: true,
				compactionEnabled: false,
				hookCount: 3,
			});

		const event = collector.complete(
			"success",
			{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			0,
		);

		expect(event.sandboxMode).toBe("docker");
		expect(event.approvalMode).toBe("auto");
		expect(event.mcpServers).toEqual(["context7", "filesystem"]);
		expect(event.mcpServerCount).toBe(2);
		expect(event.contextSourceCount).toBe(5);
		expect(event.messageCount).toBe(10);
		expect(event.inputSizeBytes).toBe(5000);
		expect(event.outputSizeBytes).toBe(3000);
		expect(event.features.safeMode).toBe(true);
		expect(event.features.hookCount).toBe(3);
	});

	it("carries prompt artifact identity on canonical turn events", () => {
		const collector = new TurnCollector("session-123", 1);

		collector
			.setModel({
				id: "claude-opus-4-6",
				provider: "anthropic",
				thinkingLevel: "medium",
			})
			.setPromptMetadata({
				name: "maestro-system",
				label: "production",
				surface: "maestro",
				version: 9,
				versionId: "ver_9",
				hash: "hash_123",
				source: "service",
			});

		const event = collector.complete(
			"success",
			{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			0,
		);

		expect(event.promptMetadata).toEqual({
			name: "maestro-system",
			label: "production",
			surface: "maestro",
			version: 9,
			versionId: "ver_9",
			hash: "hash_123",
			source: "service",
		});
	});

	it("records error details", () => {
		const collector = new TurnCollector("session-123", 1);

		const event = collector.complete(
			"error",
			{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			0,
			{ category: "network", message: "Connection timeout" },
		);

		expect(event.status).toBe("error");
		expect(event.errorCategory).toBe("network");
		expect(event.errorMessage).toBe("Connection timeout");
	});

	it("records abort reason", () => {
		const collector = new TurnCollector("session-123", 1);

		const event = collector.complete(
			"aborted",
			{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			0,
			undefined,
			"user",
		);

		expect(event.status).toBe("aborted");
		expect(event.abortReason).toBe("user");
	});
});

describe("Tail Sampling", () => {
	it("always samples errors", () => {
		const collector = new TurnCollector("session-123", 100);

		const event = collector.complete(
			"error",
			{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			0,
		);

		expect(event.sampled).toBe(true);
		expect(event.sampleReason).toBe("error");
	});

	it("always samples first turn", () => {
		const collector = new TurnCollector("session-123", 1);

		const event = collector.complete(
			"success",
			{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			0,
		);

		expect(event.sampled).toBe(true);
		expect(event.sampleReason).toBe("first_turn");
	});

	it("samples slow turns", async () => {
		vi.useFakeTimers();
		try {
			const collector = new TurnCollector("session-123", 100, {
				slowThresholdMs: 10, // Very low threshold for testing
				successSampleRate: 0, // Disable random sampling
				alwaysSampleFirstN: 0, // Disable first turn sampling
			});

			// Advance the fake clock past the slow threshold.
			await vi.advanceTimersByTimeAsync(20);

			const event = collector.complete(
				"success",
				{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				0,
			);

			expect(event.sampled).toBe(true);
			expect(event.sampleReason).toBe("slow");
		} finally {
			vi.useRealTimers();
		}
	});

	it("respects random sampling rate", () => {
		// Mock Math.random to control sampling
		const originalRandom = Math.random;

		// Test with random below threshold (should sample)
		Math.random = () => 0.01;
		const collector1 = new TurnCollector("session-123", 100, {
			successSampleRate: 0.05,
			slowThresholdMs: 999999,
			alwaysSampleFirstN: 0,
		});
		const event1 = collector1.complete(
			"success",
			{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			0,
		);
		expect(event1.sampled).toBe(true);
		expect(event1.sampleReason).toBe("random");

		// Test with random above threshold (should not sample)
		Math.random = () => 0.5;
		const collector2 = new TurnCollector("session-123", 100, {
			successSampleRate: 0.05,
			slowThresholdMs: 999999,
			alwaysSampleFirstN: 0,
		});
		const event2 = collector2.complete(
			"success",
			{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			0,
		);
		expect(event2.sampled).toBe(false);

		// Restore original Math.random
		Math.random = originalRandom;
	});
});

describe("createTurnCollector", () => {
	it("creates a collector with default config", () => {
		const collector = createTurnCollector("session-456", 2);
		const event = collector.complete(
			"success",
			{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			0,
		);

		expect(event.sessionId).toBe("session-456");
		expect(event.turnNumber).toBe(2);
	});
});

describe("getSamplingConfigFromEnv", () => {
	it("returns empty object when env vars not set", () => {
		const config = getSamplingConfigFromEnv();
		expect(config).toEqual({});
	});

	it("parses sample rate from env", () => {
		const originalEnv = process.env.MAESTRO_WIDE_EVENT_SAMPLE_RATE;
		process.env.MAESTRO_WIDE_EVENT_SAMPLE_RATE = "0.25";

		const config = getSamplingConfigFromEnv();
		expect(config.successSampleRate).toBe(0.25);

		// Restore
		if (originalEnv === undefined) {
			process.env.MAESTRO_WIDE_EVENT_SAMPLE_RATE = undefined;
		} else {
			process.env.MAESTRO_WIDE_EVENT_SAMPLE_RATE = originalEnv;
		}
	});

	it("parses slow threshold from env", () => {
		const originalEnv = process.env.MAESTRO_WIDE_EVENT_SLOW_THRESHOLD_MS;
		process.env.MAESTRO_WIDE_EVENT_SLOW_THRESHOLD_MS = "10000";

		const config = getSamplingConfigFromEnv();
		expect(config.slowThresholdMs).toBe(10000);

		// Restore
		if (originalEnv === undefined) {
			process.env.MAESTRO_WIDE_EVENT_SLOW_THRESHOLD_MS = undefined;
		} else {
			process.env.MAESTRO_WIDE_EVENT_SLOW_THRESHOLD_MS = originalEnv;
		}
	});
});
