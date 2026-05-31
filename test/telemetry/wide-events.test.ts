import { describe, expect, it, vi } from "vitest";
import type { ToolPhaseSummary } from "../../src/agent/types.js";
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

	it("summarizes tool scheduling decisions without recording tool arguments", () => {
		const collector = new TurnCollector("session-123", 1);

		collector.recordToolStart("read", "call-1", 100);
		collector.recordToolSchedulingDecision({
			callId: "call-1",
			toolName: "read",
			emittedIndex: 0,
			waveIndex: 1,
			decision: "scheduled",
			reason: "read_only_wave_start",
			schedulerWaitMs: 3,
		});
		collector.recordToolEnd("call-1", true, 50);

		collector.recordToolStart("mcp__trusted_fs__probe", "call-2", 100);
		collector.recordToolSchedulingDecision({
			callId: "call-2",
			toolName: "mcp__trusted_fs__probe",
			emittedIndex: 1,
			waveIndex: 1,
			decision: "parallelized",
			reason: "mcp_parallel_opt_in",
			schedulerWaitMs: 4,
			mcpOptIn: true,
		});
		collector.recordToolEnd("call-2", true, 50);

		collector.recordToolStart("write", "call-3", 100);
		collector.recordToolSchedulingDecision({
			callId: "call-3",
			toolName: "write",
			emittedIndex: 2,
			waveIndex: 2,
			decision: "delayed",
			reason: "mutation_unknown_write_set",
			schedulerWaitMs: 23,
			blockedByMutation: true,
		});
		collector.recordToolEnd("call-3", true, 50);

		collector.recordToolStart("read", "call-4", 100);
		collector.recordToolSchedulingDecision({
			callId: "call-4",
			toolName: "read",
			emittedIndex: 3,
			decision: "cached",
			reason: "reusable_tool_result_ready",
			schedulerWaitMs: 1,
			cacheHit: true,
		});
		collector.recordToolEnd("call-4", true, 50);

		const event = collector.complete(
			"success",
			{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			0,
		);

		expect(event.toolScheduling).toMatchObject({
			modelToolCallCount: 4,
			schedulableWaveCount: 2,
			parallelizedCallCount: 2,
			serializedCallCount: 1,
			blockedByMutationCount: 1,
			mcpOptInCallCount: 1,
			cacheHitCount: 1,
			totalToolWaitMs: 31,
			topSerializationReasons: [
				{ reason: "mutation_unknown_write_set", count: 1 },
			],
		});
		expect(event.tools[1]?.scheduling).toMatchObject({
			decision: "parallelized",
			reason: "mcp_parallel_opt_in",
		});
		expect(event.tools[2]?.scheduling).toMatchObject({
			decision: "delayed",
			reason: "mutation_unknown_write_set",
		});
		expect(JSON.stringify(event.toolScheduling)).not.toContain("file_path");
		expect(JSON.stringify(event.toolScheduling)).not.toContain(
			"src/private.ts",
		);
	});

	it("classifies scheduled fallback decisions before rollup", () => {
		const collector = new TurnCollector("session-123", 1);

		collector.recordToolSchedulingDecision({
			callId: "read-1",
			toolName: "read",
			emittedIndex: 0,
			waveIndex: 1,
			decision: "scheduled",
			reason: "read_only_wave_start",
			schedulerWaitMs: 5,
		});
		collector.recordToolSchedulingDecision({
			callId: "write-1",
			toolName: "write",
			emittedIndex: 1,
			waveIndex: 2,
			decision: "delayed",
			reason: "mutation_unknown_write_set",
			schedulerWaitMs: 10,
			blockedByMutation: true,
		});

		const event = collector.complete(
			"success",
			{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			0,
		);

		expect(event.toolScheduling).toMatchObject({
			modelToolCallCount: 2,
			modelEmittedToolCallCount: 2,
			schedulableWaveCount: 2,
			parallelizedCallCount: 0,
			serializedCallCount: 2,
			delayedCallCount: 1,
			totalToolWaitMs: 15,
			serializationReasons: {
				read_only_wave_start: 1,
				mutation_unknown_write_set: 1,
			},
			topSerializationReasons: [
				{ reason: "read_only_wave_start", count: 1 },
				{ reason: "mutation_unknown_write_set", count: 1 },
			],
		});
	});

	it("preserves workflow fallback reasons for MCP opt-in calls", () => {
		const collector = new TurnCollector("session-123", 1);

		collector.recordToolSchedulingDecision({
			callId: "mcp-1",
			toolName: "mcp__trusted_remote__mutate",
			emittedIndex: 0,
			waveIndex: 1,
			decision: "serialized",
			reason: "workflow_state_serialized",
			schedulerWaitMs: 4,
			mcpOptIn: true,
		});

		const event = collector.complete(
			"success",
			{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			0,
		);

		expect(event.toolScheduling).toMatchObject({
			modelToolCallCount: 1,
			serializedCallCount: 1,
			mcpOptInCallCount: 1,
			serializationReasons: {
				workflow_state_serialized: 1,
			},
			topSerializationReasons: [
				{ reason: "workflow_state_serialized", count: 1 },
			],
		});
		expect(event.toolScheduling?.serializationReasons).not.toHaveProperty(
			"mcp_parallel_opt_in",
		);
	});

	it("aggregates tool phase summaries across the full turn", () => {
		const collector = new TurnCollector("session-123", 1);
		const firstPhase: ToolPhaseSummary = {
			type: "tool_phase_summary",
			modelToolCallCount: 2,
			modelEmittedToolCallCount: 2,
			schedulableWaveCount: 1,
			parallelizedCallCount: 2,
			actuallyParallelizedCallCount: 2,
			serializedCallCount: 0,
			delayedCallCount: 0,
			blockedByMutationCount: 0,
			mcpOptInCallCount: 0,
			mcpOptInUseCount: 0,
			cacheHitCount: 0,
			totalToolWaitMs: 3,
			toolWaitTimeMs: 3,
			serializationReasons: {},
			decisions: [
				{
					toolCallId: "read-1",
					toolName: "read",
					emittedIndex: 0,
					outcome: "parallelized",
					decision: "parallelized",
					reason: "read_only_parallel_safe",
					waveIndex: 0,
					waitMs: 1,
					schedulerWaitMs: 1,
				},
				{
					toolCallId: "read-2",
					toolName: "read",
					emittedIndex: 1,
					outcome: "parallelized",
					decision: "parallelized",
					reason: "read_only_parallel_safe",
					waveIndex: 0,
					waitMs: 2,
					schedulerWaitMs: 2,
				},
			],
		};
		const secondPhase: ToolPhaseSummary = {
			type: "tool_phase_summary",
			modelToolCallCount: 2,
			modelEmittedToolCallCount: 2,
			schedulableWaveCount: 1,
			parallelizedCallCount: 0,
			actuallyParallelizedCallCount: 0,
			serializedCallCount: 1,
			delayedCallCount: 0,
			blockedByMutationCount: 0,
			mcpOptInCallCount: 0,
			mcpOptInUseCount: 0,
			cacheHitCount: 0,
			totalToolWaitMs: 7,
			toolWaitTimeMs: 7,
			serializationReasons: {
				single_read_only_call: 1,
			},
			decisions: [
				{
					toolCallId: "read-3",
					toolName: "read",
					emittedIndex: 0,
					outcome: "serialized",
					decision: "serialized",
					reason: "single_read_only_call",
					waveIndex: 0,
					waitMs: 7,
					schedulerWaitMs: 7,
				},
				{
					toolCallId: "write-blocked",
					toolName: "write",
					emittedIndex: 1,
					outcome: "skipped",
					decision: "skipped",
					reason: "safety_blocked",
					waitMs: 0,
					schedulerWaitMs: 0,
				},
			],
		};

		collector.recordToolPhaseSummary(firstPhase);
		collector.recordToolPhaseSummary(secondPhase);

		const event = collector.complete(
			"success",
			{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			0,
		);

		expect(event.toolScheduling).toMatchObject({
			modelToolCallCount: 4,
			modelEmittedToolCallCount: 4,
			schedulableWaveCount: 2,
			parallelizedCallCount: 2,
			actuallyParallelizedCallCount: 2,
			serializedCallCount: 1,
			totalToolWaitMs: 10,
			toolWaitTimeMs: 10,
			serializationReasons: {
				single_read_only_call: 1,
			},
			topSerializationReasons: [{ reason: "single_read_only_call", count: 1 }],
		});
	});

	it("merges per-call scheduling decisions missing from emitted phase summaries", () => {
		const collector = new TurnCollector("session-123", 1);

		collector.recordToolPhaseSummary({
			type: "tool_phase_summary",
			modelToolCallCount: 1,
			modelEmittedToolCallCount: 1,
			schedulableWaveCount: 1,
			parallelizedCallCount: 0,
			actuallyParallelizedCallCount: 0,
			serializedCallCount: 1,
			delayedCallCount: 0,
			blockedByMutationCount: 0,
			mcpOptInCallCount: 0,
			mcpOptInUseCount: 0,
			cacheHitCount: 0,
			totalToolWaitMs: 2,
			toolWaitTimeMs: 2,
			serializationReasons: {
				single_read_only_call: 1,
			},
			decisions: [
				{
					toolCallId: "read-1",
					toolName: "read",
					emittedIndex: 0,
					outcome: "serialized",
					decision: "serialized",
					reason: "single_read_only_call",
					waveIndex: 0,
					waitMs: 2,
					schedulerWaitMs: 2,
				},
			],
		});
		collector.recordToolSchedulingDecision({
			callId: "write-1",
			toolName: "write",
			emittedIndex: 1,
			waveIndex: 2,
			decision: "delayed",
			reason: "mutation_unknown_write_set",
			schedulerWaitMs: 13,
			blockedByMutation: true,
		});

		const event = collector.complete(
			"success",
			{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			0,
		);

		expect(event.toolScheduling).toMatchObject({
			modelToolCallCount: 2,
			modelEmittedToolCallCount: 2,
			schedulableWaveCount: 2,
			serializedCallCount: 2,
			delayedCallCount: 1,
			blockedByMutationCount: 1,
			totalToolWaitMs: 15,
			serializationReasons: {
				single_read_only_call: 1,
				mutation_unknown_write_set: 1,
			},
		});
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

	it("records selected skill artifact identity on canonical turn events", () => {
		const collector = new TurnCollector("session-123", 1);

		collector.recordSkillMetadata({
			name: "incident-review",
			artifactId: "skill_remote_1",
			version: "3",
			hash: "hash_skill_123",
			source: "service",
			scope: "workspace",
		});

		const event = collector.complete(
			"success",
			{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			0,
		);

		expect(event.skillMetadata).toEqual([
			{
				name: "incident-review",
				artifactId: "skill_remote_1",
				version: "3",
				hash: "hash_skill_123",
				source: "service",
				scope: "workspace",
			},
		]);
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
