import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import {
	type ReusableToolResultCacheGeneration,
	type ReusableToolResultEntry,
	hasPendingMutatingToolExecution,
	invalidateReusableToolResultsAfterMutation,
} from "../../src/agent/transport/reusable-tool-results.js";
import type {
	PendingExecution,
	ToolExecutionOutcome,
} from "../../src/agent/transport/tool-update-queue.js";
import type {
	AgentTool,
	ToolCall,
	ToolResultMessage,
} from "../../src/agent/types.js";

function makeTool(
	name: string,
	annotations?: AgentTool["annotations"],
): AgentTool {
	return {
		name,
		description: "Test tool",
		parameters: Type.Object({}),
		annotations,
	};
}

function makeToolCall(name: string): ToolCall {
	return {
		type: "toolCall",
		id: `call-${name}`,
		name,
		arguments: {},
	};
}

const message: ToolResultMessage = {
	role: "toolResult",
	toolCallId: "call-read",
	toolName: "read",
	content: [{ type: "text", text: "cached" }],
	isError: false,
	timestamp: 0,
};

const outcome: ToolExecutionOutcome = {
	message,
	isError: false,
};

describe("reusable tool result cache invalidation", () => {
	it("does not clear reusable caches for read-only hinted MCP calls", () => {
		const cache = new Map<string, ReusableToolResultEntry>([
			["run:read", { message }],
		]);
		const pending = new Map<string, Promise<ToolExecutionOutcome>>([
			["run:pending", Promise.resolve(outcome)],
		]);
		const policyCheckedKeys = new Set(["run:checked"]);
		const pendingSafetyChecks = new Map([["run:safety", 1]]);
		const cacheGeneration: ReusableToolResultCacheGeneration = { value: 0 };

		invalidateReusableToolResultsAfterMutation(
			makeToolCall("mcp__workspace__inspect"),
			[
				makeTool("mcp__workspace__inspect", {
					readOnlyHint: true,
				}),
			],
			cache,
			pending,
			policyCheckedKeys,
			pendingSafetyChecks,
			cacheGeneration,
		);

		expect(cache.has("run:read")).toBe(true);
		expect(pending.has("run:pending")).toBe(true);
		expect(policyCheckedKeys.has("run:checked")).toBe(true);
		expect(pendingSafetyChecks.get("run:safety")).toBe(1);
		expect(cacheGeneration.value).toBe(0);
	});

	it("still clears reusable caches for unhinted MCP calls", () => {
		const cache = new Map<string, ReusableToolResultEntry>([
			["run:read", { message }],
		]);
		const pending = new Map<string, Promise<ToolExecutionOutcome>>([
			["run:pending", Promise.resolve(outcome)],
		]);
		const policyCheckedKeys = new Set(["run:checked"]);
		const pendingSafetyChecks = new Map([["run:safety", 1]]);
		const cacheGeneration: ReusableToolResultCacheGeneration = { value: 0 };

		invalidateReusableToolResultsAfterMutation(
			makeToolCall("mcp__workspace__mutate"),
			[makeTool("mcp__workspace__mutate")],
			cache,
			pending,
			policyCheckedKeys,
			pendingSafetyChecks,
			cacheGeneration,
		);

		expect(cache.size).toBe(0);
		expect(pending.size).toBe(0);
		expect(policyCheckedKeys.size).toBe(0);
		expect(pendingSafetyChecks.size).toBe(0);
		expect(cacheGeneration.value).toBe(1);
	});

	it("does not count read-only hinted MCP calls as pending mutations", () => {
		const pendingExecutions: PendingExecution[] = [
			{
				toolCall: makeToolCall("mcp__workspace__inspect"),
				promise: Promise.resolve(outcome),
			},
		];

		expect(
			hasPendingMutatingToolExecution(pendingExecutions, [
				makeTool("mcp__workspace__inspect", {
					readOnlyHint: true,
				}),
			]),
		).toBe(false);
		expect(
			hasPendingMutatingToolExecution(pendingExecutions, [
				makeTool("mcp__workspace__inspect"),
			]),
		).toBe(true);
	});
});
