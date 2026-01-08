import { describe, expect, it } from "vitest";
import {
	ComposerAgentEventSchema,
	ComposerChatRequestSchema,
	ComposerMessageSchema,
	ComposerStatusResponseSchema,
	ComposerUsageResponseSchema,
} from "../../packages/contracts/src/schemas.js";
import {
	assertComposerChatRequest,
	isComposerAgentEvent,
	validateSchema,
} from "../../packages/contracts/src/validators.js";

describe("contracts validators", () => {
	it("accepts a minimal chat request", () => {
		const request = {
			messages: [{ role: "user", content: "Hello" }],
		};
		const result = validateSchema(ComposerChatRequestSchema, request);
		expect(result.ok).toBe(true);
		assertComposerChatRequest(request);
	});

	it("rejects invalid roles", () => {
		const request = {
			messages: [{ role: "invalid", content: "Hello" }],
		};
		const result = validateSchema(ComposerChatRequestSchema, request);
		expect(result.ok).toBe(false);
	});

	it("allows empty content arrays for streaming messages", () => {
		const message = { role: "assistant", content: [] };
		const result = validateSchema(ComposerMessageSchema, message);
		expect(result.ok).toBe(true);
	});

	it("validates agent events with required fields", () => {
		expect(isComposerAgentEvent({ type: "heartbeat" })).toBe(true);
		expect(isComposerAgentEvent({ type: "message_start" })).toBe(false);
		const eventResult = validateSchema(ComposerAgentEventSchema, {
			type: "message_start",
			message: { role: "assistant", content: "Hi" },
		});
		expect(eventResult.ok).toBe(true);
	});

	it("accepts a minimal status response", () => {
		const status = {
			cwd: "/tmp/project",
			git: null,
			context: { agentMd: false, claudeMd: false },
			server: { uptime: 1, version: "v20.0.0" },
			database: { configured: false, connected: false },
			backgroundTasks: null,
			hooks: {
				asyncInFlight: 0,
				concurrency: { max: 0, active: 0, queued: 0 },
			},
			lastUpdated: 1,
			lastLatencyMs: 1,
		};
		const result = validateSchema(ComposerStatusResponseSchema, status);
		expect(result.ok).toBe(true);
	});

	it("accepts a usage response with breakdowns", () => {
		const totals = {
			input: 1,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			total: 3,
		};
		const breakdown = {
			cost: 0.01,
			requests: 2,
			tokens: 3,
			tokensDetailed: totals,
			calls: 2,
			cachedTokens: 0,
		};
		const usage = {
			summary: {
				totalCost: 0.01,
				totalRequests: 2,
				totalTokens: 3,
				tokensDetailed: totals,
				totalTokensDetailed: totals,
				totalTokensBreakdown: totals,
				totalCachedTokens: 0,
				byProvider: { demo: breakdown },
				byModel: { demo: breakdown },
			},
			hasData: true,
		};
		const result = validateSchema(ComposerUsageResponseSchema, usage);
		expect(result.ok).toBe(true);
	});
});
