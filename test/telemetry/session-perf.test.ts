import { describe, expect, it } from "vitest";
import type { AgentEvent, AppMessage, Usage } from "../../src/agent/types.js";
import {
	SessionPerfCollector,
	type SessionPerfSnapshot,
	formatPerfReport,
} from "../../src/telemetry/session-perf.js";
import type {
	CanonicalTurnEvent,
	ModelInfo,
	TokenUsage,
	ToolExecution,
} from "../../src/telemetry/wide-events.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeUsage(overrides?: Partial<Usage>): Usage {
	return {
		input: 100,
		output: 50,
		cacheRead: 10,
		cacheWrite: 5,
		cost: {
			input: 0.001,
			output: 0.002,
			cacheRead: 0.0001,
			cacheWrite: 0.0002,
			total: 0.0033,
		},
		...overrides,
	};
}

const defaultModel: ModelInfo = {
	id: "claude-opus-4-6",
	provider: "anthropic",
	thinkingLevel: "off",
};

const defaultTokens: TokenUsage = {
	input: 1000,
	output: 500,
	cacheRead: 200,
	cacheWrite: 0,
};

function makeTool(
	name: string,
	durationMs: number,
	success = true,
): ToolExecution {
	return { name, callId: `call-${name}-${durationMs}`, durationMs, success };
}

function makeCanonicalEvent(
	overrides?: Partial<CanonicalTurnEvent>,
): CanonicalTurnEvent {
	return {
		type: "canonical-turn",
		timestamp: new Date().toISOString(),
		sessionId: "test-session",
		turnId: "turn-1",
		turnNumber: 1,
		model: defaultModel,
		totalDurationMs: 5000,
		llmDurationMs: 3000,
		toolDurationMs: 1500,
		tools: [makeTool("Read", 500), makeTool("Write", 1000)],
		toolCount: 2,
		toolSuccessCount: 2,
		toolFailureCount: 0,
		tokens: defaultTokens,
		costUsd: 0.05,
		sandboxMode: "none",
		approvalMode: "prompt",
		mcpServerCount: 0,
		contextSourceCount: 3,
		messageCount: 5,
		inputSizeBytes: 5000,
		outputSizeBytes: 2000,
		features: {
			safeMode: false,
			guardianEnabled: true,
			compactionEnabled: true,
			hookCount: 0,
		},
		status: "success",
		sampled: true,
		sampleReason: "always",
		...overrides,
	};
}

/** Create a minimal AppMessage for testing agent event handlers. */
function makeMessage(
	role: "assistant" | "user",
	extra?: Record<string, unknown>,
): AppMessage {
	return {
		role,
		content: [],
		timestamp: Date.now(),
		...extra,
	} as AppMessage;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("SessionPerfCollector", () => {
	describe("CanonicalTurnEvent mode", () => {
		it("records a single turn event", () => {
			const collector = new SessionPerfCollector();
			collector.record(makeCanonicalEvent());

			const snap = collector.snapshot();
			expect(snap.turnCount).toBe(1);
			expect(snap.totalDurationMs).toBe(5000);
			expect(snap.tokens.totalInput).toBe(1000);
			expect(snap.tokens.totalOutput).toBe(500);
			expect(snap.tokens.totalCacheRead).toBe(200);
			expect(snap.costUsd).toBe(0.05);
			expect(snap.errors).toBe(0);
		});

		it("aggregates multiple turn events", () => {
			const collector = new SessionPerfCollector();
			collector.record(
				makeCanonicalEvent({
					totalDurationMs: 3000,
					llmDurationMs: 2000,
					costUsd: 0.03,
					tokens: { input: 500, output: 200, cacheRead: 100, cacheWrite: 0 },
				}),
			);
			collector.record(
				makeCanonicalEvent({
					totalDurationMs: 7000,
					llmDurationMs: 4000,
					costUsd: 0.07,
					tokens: {
						input: 1500,
						output: 800,
						cacheRead: 300,
						cacheWrite: 0,
					},
				}),
			);

			const snap = collector.snapshot();
			expect(snap.turnCount).toBe(2);
			expect(snap.totalDurationMs).toBe(10000);
			expect(snap.tokens.totalInput).toBe(2000);
			expect(snap.tokens.totalOutput).toBe(1000);
			expect(snap.tokens.totalCacheRead).toBe(400);
			expect(snap.costUsd).toBe(0.1);
		});

		it("tracks min/max/avg for turn latency", () => {
			const collector = new SessionPerfCollector();
			collector.record(makeCanonicalEvent({ totalDurationMs: 2000 }));
			collector.record(makeCanonicalEvent({ totalDurationMs: 8000 }));

			const snap = collector.snapshot();
			expect(snap.turns.minMs).toBe(2000);
			expect(snap.turns.maxMs).toBe(8000);
			expect(snap.turns.count).toBe(2);
		});

		it("tracks LLM latency stats", () => {
			const collector = new SessionPerfCollector();
			collector.record(makeCanonicalEvent({ llmDurationMs: 1000 }));
			collector.record(makeCanonicalEvent({ llmDurationMs: 5000 }));

			const snap = collector.snapshot();
			expect(snap.llm.minMs).toBe(1000);
			expect(snap.llm.maxMs).toBe(5000);
			expect(snap.llm.count).toBe(2);
		});

		it("skips LLM recording when llmDurationMs is 0", () => {
			const collector = new SessionPerfCollector();
			collector.record(makeCanonicalEvent({ llmDurationMs: 0 }));

			const snap = collector.snapshot();
			expect(snap.llm.count).toBe(0);
		});

		it("tracks per-tool latency stats", () => {
			const collector = new SessionPerfCollector();
			collector.record(
				makeCanonicalEvent({
					tools: [
						makeTool("Read", 100),
						makeTool("Read", 200),
						makeTool("Write", 500),
					],
				}),
			);

			const snap = collector.snapshot();
			const readStats = snap.tools.get("Read");
			expect(readStats).toBeDefined();
			expect(readStats!.count).toBe(2);
			expect(readStats!.minMs).toBe(100);
			expect(readStats!.maxMs).toBe(200);

			const writeStats = snap.tools.get("Write");
			expect(writeStats).toBeDefined();
			expect(writeStats!.count).toBe(1);
		});

		it("counts errors", () => {
			const collector = new SessionPerfCollector();
			collector.record(makeCanonicalEvent({ status: "error" }));
			collector.record(makeCanonicalEvent({ status: "success" }));
			collector.record(makeCanonicalEvent({ status: "error" }));

			const snap = collector.snapshot();
			expect(snap.errors).toBe(2);
		});
	});

	describe("raw AgentEvent mode", () => {
		it("tracks a complete turn lifecycle", () => {
			const collector = new SessionPerfCollector();
			const usage = makeUsage({ input: 800, output: 400, cacheRead: 50 });

			collector.handleAgentEvent({ type: "agent_start" });
			collector.handleAgentEvent({
				type: "message_start",
				message: makeMessage("assistant"),
			});
			collector.handleAgentEvent({
				type: "message_end",
				message: makeMessage("assistant", { usage }),
			});
			collector.handleAgentEvent({
				type: "agent_end",
				messages: [],
			});

			const snap = collector.snapshot();
			expect(snap.turnCount).toBe(1);
			expect(snap.totalDurationMs).toBeGreaterThan(0);
			expect(snap.tokens.totalInput).toBe(800);
			expect(snap.tokens.totalOutput).toBe(400);
			expect(snap.tokens.totalCacheRead).toBe(50);
		});

		it("tracks tool execution timing", () => {
			const collector = new SessionPerfCollector();

			collector.handleAgentEvent({ type: "agent_start" });
			collector.handleAgentEvent({
				type: "tool_execution_start",
				toolCallId: "tc1",
				toolName: "Read",
				args: {},
			} as AgentEvent);
			collector.handleAgentEvent({
				type: "tool_execution_end",
				toolCallId: "tc1",
				toolName: "Read",
				result: { type: "text", text: "" },
				isError: false,
			} as unknown as AgentEvent);
			collector.handleAgentEvent({ type: "agent_end", messages: [] });

			const snap = collector.snapshot();
			const readStats = snap.tools.get("Read");
			expect(readStats).toBeDefined();
			expect(readStats!.count).toBe(1);
			expect(readStats!.minMs).toBeGreaterThanOrEqual(0);
		});

		it("accumulates usage across multiple messages in a turn", () => {
			const collector = new SessionPerfCollector();
			const u1 = makeUsage({ input: 100, output: 50, cacheRead: 10 });
			const u2 = makeUsage({ input: 200, output: 100, cacheRead: 20 });

			collector.handleAgentEvent({ type: "agent_start" });
			collector.handleAgentEvent({
				type: "message_start",
				message: makeMessage("assistant"),
			});
			collector.handleAgentEvent({
				type: "message_end",
				message: makeMessage("assistant", { usage: u1 }),
			});
			collector.handleAgentEvent({
				type: "message_start",
				message: makeMessage("assistant"),
			});
			collector.handleAgentEvent({
				type: "message_end",
				message: makeMessage("assistant", { usage: u2 }),
			});
			collector.handleAgentEvent({ type: "agent_end", messages: [] });

			const snap = collector.snapshot();
			expect(snap.tokens.totalInput).toBe(300);
			expect(snap.tokens.totalOutput).toBe(150);
			expect(snap.tokens.totalCacheRead).toBe(30);
		});

		it("counts errors from agent_end events", () => {
			const collector = new SessionPerfCollector();

			collector.handleAgentEvent({ type: "agent_start" });
			collector.handleAgentEvent({
				type: "agent_end",
				messages: [],
				error: new Error("boom"),
			} as unknown as AgentEvent);

			const snap = collector.snapshot();
			expect(snap.errors).toBe(1);
		});

		it("ignores non-assistant messages", () => {
			const collector = new SessionPerfCollector();

			collector.handleAgentEvent({ type: "agent_start" });
			collector.handleAgentEvent({
				type: "message_start",
				message: makeMessage("user"),
			});
			collector.handleAgentEvent({
				type: "message_end",
				message: makeMessage("user"),
			});
			collector.handleAgentEvent({ type: "agent_end", messages: [] });

			const snap = collector.snapshot();
			expect(snap.llm.count).toBe(0);
		});
	});

	describe("snapshot", () => {
		it("returns a fresh snapshot each time", () => {
			const collector = new SessionPerfCollector();
			collector.record(makeCanonicalEvent());

			const snap1 = collector.snapshot();
			collector.record(makeCanonicalEvent());
			const snap2 = collector.snapshot();

			expect(snap1.turnCount).toBe(1);
			expect(snap2.turnCount).toBe(2);
		});

		it("returns empty stats when no data recorded", () => {
			const collector = new SessionPerfCollector();
			const snap = collector.snapshot();

			expect(snap.turnCount).toBe(0);
			expect(snap.totalDurationMs).toBe(0);
			expect(snap.errors).toBe(0);
			expect(snap.costUsd).toBe(0);
			expect(snap.tools.size).toBe(0);
		});
	});
});

describe("formatPerfReport", () => {
	it("shows 'no turns' message for empty snapshot", () => {
		const snap: SessionPerfSnapshot = {
			turnCount: 0,
			totalDurationMs: 0,
			turns: {
				count: 0,
				totalMs: 0,
				minMs: Number.POSITIVE_INFINITY,
				maxMs: 0,
				samples: [],
			},
			llm: {
				count: 0,
				totalMs: 0,
				minMs: Number.POSITIVE_INFINITY,
				maxMs: 0,
				samples: [],
			},
			tools: new Map(),
			tokens: { totalInput: 0, totalOutput: 0, totalCacheRead: 0 },
			costUsd: 0,
			errors: 0,
		};

		const report = formatPerfReport(snap);
		expect(report).toContain("No turns recorded");
	});

	it("includes key sections for a populated snapshot", () => {
		const snap: SessionPerfSnapshot = {
			turnCount: 5,
			totalDurationMs: 25000,
			turns: {
				count: 5,
				totalMs: 25000,
				minMs: 3000,
				maxMs: 8000,
				samples: [3000, 4000, 5000, 6000, 8000],
			},
			llm: {
				count: 5,
				totalMs: 15000,
				minMs: 2000,
				maxMs: 5000,
				samples: [2000, 2500, 3000, 3500, 5000],
			},
			tools: new Map([
				[
					"Read",
					{
						count: 10,
						totalMs: 5000,
						minMs: 100,
						maxMs: 1200,
						samples: [100, 200, 300, 400, 500, 600, 700, 800, 900, 1200],
					},
				],
			]),
			tokens: { totalInput: 50000, totalOutput: 10000, totalCacheRead: 20000 },
			costUsd: 0.5,
			errors: 1,
		};

		const report = formatPerfReport(snap);
		expect(report).toContain("Performance");
		expect(report).toContain("5"); // turn count
		expect(report).toContain("1 errors");
		expect(report).toContain("Turn Latency");
		expect(report).toContain("Tool Latency");
		expect(report).toContain("Read");
		expect(report).toContain("Tokens");
		expect(report).toContain("50.0K"); // input tokens
		expect(report).toContain("10.0K"); // output tokens
		expect(report).toContain("tok/s");
		expect(report).toContain("$0.5000");
	});

	it("omits cost section when costUsd is 0", () => {
		const snap: SessionPerfSnapshot = {
			turnCount: 1,
			totalDurationMs: 1000,
			turns: {
				count: 1,
				totalMs: 1000,
				minMs: 1000,
				maxMs: 1000,
				samples: [1000],
			},
			llm: {
				count: 1,
				totalMs: 800,
				minMs: 800,
				maxMs: 800,
				samples: [800],
			},
			tools: new Map(),
			tokens: { totalInput: 100, totalOutput: 50, totalCacheRead: 0 },
			costUsd: 0,
			errors: 0,
		};

		const report = formatPerfReport(snap);
		expect(report).not.toContain("Cost");
	});

	it("limits tool display to top 10", () => {
		const tools = new Map<
			string,
			{
				count: number;
				totalMs: number;
				minMs: number;
				maxMs: number;
				samples: number[];
			}
		>();
		for (let i = 0; i < 15; i++) {
			tools.set(`Tool${i}`, {
				count: 1,
				totalMs: 100 * (15 - i),
				minMs: 100,
				maxMs: 100,
				samples: [100],
			});
		}

		const snap: SessionPerfSnapshot = {
			turnCount: 1,
			totalDurationMs: 5000,
			turns: {
				count: 1,
				totalMs: 5000,
				minMs: 5000,
				maxMs: 5000,
				samples: [5000],
			},
			llm: {
				count: 1,
				totalMs: 3000,
				minMs: 3000,
				maxMs: 3000,
				samples: [3000],
			},
			tools,
			tokens: { totalInput: 1000, totalOutput: 500, totalCacheRead: 0 },
			costUsd: 0.01,
			errors: 0,
		};

		const report = formatPerfReport(snap);
		expect(report).toContain("and 5 more tools");
	});
});
