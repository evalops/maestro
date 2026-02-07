import { Type } from "@sinclair/typebox";
import { ToolRetryService } from "../../src/agent/tool-retry.js";
import {
	type ToolExecutionContext,
	createToolExecutionPromise,
} from "../../src/agent/transport/tool-execution.js";
import { ToolUpdateQueue } from "../../src/agent/transport/tool-update-queue.js";
import type {
	AgentTool,
	AgentToolResult,
	ToolCall,
} from "../../src/agent/types.js";
import type { AdaptiveThresholds } from "../../src/safety/adaptive-thresholds.js";
import type { SafetyMiddleware } from "../../src/safety/safety-middleware.js";
import type { Clock } from "../../src/utils/clock.js";

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

const stubClock: Clock = {
	now: () => Date.now(),
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (id) => clearTimeout(id),
};

const stubSafety: SafetyMiddleware = {
	postExecution: () => {},
	sanitizeForLogging: (args) => args,
} as unknown as SafetyMiddleware;

const stubThresholds: AdaptiveThresholds = {
	recordObservation: () => {},
} as unknown as AdaptiveThresholds;

const toolCall: ToolCall = {
	type: "toolCall",
	id: "call_test",
	name: "test_tool",
	arguments: {},
};

function makeServerTool(
	overrides: Partial<AgentTool> & { execute: AgentTool["execute"] },
): AgentTool {
	return {
		name: "test_tool",
		description: "A test tool",
		parameters: Type.Object({}),
		...overrides,
	} as AgentTool;
}

function makeCtx(
	tool: AgentTool,
	extras?: Partial<ToolExecutionContext>,
): ToolExecutionContext {
	return {
		toolCall,
		effectiveToolCall: toolCall,
		tool,
		validatedArgs: {},
		sanitizedExecutionArgs: {},
		cfg: {
			systemPrompt: "",
			tools: [],
			model: {},
		} as unknown as ToolExecutionContext["cfg"],
		clock: stubClock,
		safetyMiddleware: stubSafety,
		adaptiveThresholds: stubThresholds,
		toolUpdateQueue: new ToolUpdateQueue(),
		...extras,
	};
}

const ok: AgentToolResult = {
	content: [{ type: "text", text: "ok" }],
	isError: false,
};

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("tool execution retry", () => {
	it("retries up to maxRetries using tool-level config", async () => {
		let calls = 0;
		const tool = makeServerTool({
			maxRetries: 2,
			retryDelayMs: 0,
			shouldRetry: () => true,
			execute: async () => {
				calls += 1;
				if (calls < 3) {
					throw new Error("transient failure");
				}
				return ok;
			},
		});

		const outcome = await createToolExecutionPromise(makeCtx(tool));

		expect(calls).toBe(3); // 1 initial + 2 retries
		expect(outcome.isError).toBe(false);
	});

	it("does not retry when tool shouldRetry returns false", async () => {
		let calls = 0;
		const tool = makeServerTool({
			maxRetries: 2,
			retryDelayMs: 0,
			shouldRetry: () => false,
			execute: async () => {
				calls += 1;
				throw new Error("permanent failure");
			},
		});

		const outcome = await createToolExecutionPromise(makeCtx(tool));

		// Should execute once, fail, and since shouldRetry returns false,
		// no auto-retries. Falls through to error handling in the outer catch.
		expect(calls).toBe(1);
		expect(outcome.isError).toBe(true);
	});

	it("falls back to transport maxAutoRetries when tool defines only shouldRetry", async () => {
		let calls = 0;
		const tool = makeServerTool({
			// Only shouldRetry defined, no maxRetries
			shouldRetry: () => true,
			execute: async () => {
				calls += 1;
				if (calls < 3) {
					throw new Error("transient failure");
				}
				return ok;
			},
		});

		// Transport config allows 2 auto-retries (3 total attempts)
		const ctx = makeCtx(tool, {
			toolRetryConfig: { maxAutoRetries: 2 },
		});

		const outcome = await createToolExecutionPromise(ctx);

		expect(calls).toBe(3); // Falls back to transport maxAutoRetries
		expect(outcome.isError).toBe(false);
	});

	it("client tool failure reaches user-prompt retry flow", async () => {
		const retryService = new ToolRetryService("prompt");

		const tool = makeServerTool({
			name: "client_tool",
			executionLocation: "client",
			execute: async () => ok, // won't be called — clientToolExecPromise is used
		});

		const failingClientPromise = Promise.reject(new Error("timeout error"));

		const ctx = makeCtx(tool, {
			toolRetryService: retryService,
			clientToolExecPromise: failingClientPromise.catch((e) => {
				throw e;
			}) as ToolExecutionContext["clientToolExecPromise"],
		});

		// The client tool will fail. Since toolRetryService is in "prompt" mode,
		// it should push a tool_retry_required event and wait for a decision.
		// We'll resolve the pending decision as "skip" to let the test complete.
		const outcomePromise = createToolExecutionPromise(ctx);

		// Wait a tick for the retry request to be registered
		await new Promise((resolve) => setTimeout(resolve, 50));

		const pending = retryService.getPendingRequests();
		expect(pending.length).toBe(1);

		// Skip the retry to let the execution complete
		retryService.skip(pending[0]!.id);

		const outcome = await outcomePromise;
		expect(outcome.isError).toBe(true);
	});

	it("client tool retry decision throws instead of re-awaiting stale promise", async () => {
		const retryService = new ToolRetryService("prompt");

		const tool = makeServerTool({
			name: "client_tool",
			executionLocation: "client",
			execute: async () => ok,
		});

		const failingClientPromise = Promise.reject(new Error("timeout error"));

		const ctx = makeCtx(tool, {
			toolRetryService: retryService,
			clientToolExecPromise: failingClientPromise.catch((e) => {
				throw e;
			}) as ToolExecutionContext["clientToolExecPromise"],
		});

		const outcomePromise = createToolExecutionPromise(ctx);

		await new Promise((resolve) => setTimeout(resolve, 50));

		const pending = retryService.getPendingRequests();
		expect(pending.length).toBe(1);

		// User chooses "retry" — for client tools this should NOT re-await
		// the same promise; it should throw so the client can handle re-dispatch.
		retryService.retry(pending[0]!.id);

		const outcome = await outcomePromise;
		// Should surface the error (not loop forever)
		expect(outcome.isError).toBe(true);
	});
});
