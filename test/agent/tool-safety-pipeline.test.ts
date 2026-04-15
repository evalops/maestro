import { Type } from "@sinclair/typebox";
import { describe, expect, it, vi } from "vitest";

import type {
	ActionApprovalRequest,
	ActionApprovalService,
} from "../../src/agent/action-approval.js";
import { evaluateToolSafety } from "../../src/agent/transport/tool-safety-pipeline.js";
import type {
	AgentEvent,
	AgentRunConfig,
	AgentTool,
	Message,
	ToolResultMessage,
} from "../../src/agent/types.js";
import {
	clearHookConfigCache,
	clearRegisteredHooks,
	createToolHookService,
	registerHook,
} from "../../src/hooks/index.js";
import { ActionFirewall } from "../../src/safety/action-firewall.js";
import { AdaptiveThresholds } from "../../src/safety/adaptive-thresholds.js";
import { SafetyMiddleware } from "../../src/safety/safety-middleware.js";
import { WorkflowStateTracker } from "../../src/safety/workflow-state.js";

async function collectSafetyResult(
	context: Parameters<typeof evaluateToolSafety>[0],
) {
	const events: AgentEvent[] = [];
	const iterator = evaluateToolSafety(context);
	while (true) {
		const step = await iterator.next();
		if (step.done) {
			return { events, result: step.value };
		}
		events.push(step.value);
	}
}

describe("evaluateToolSafety permission hooks", () => {
	it("allows trusted PermissionRequest hooks to bypass user approval", async () => {
		clearHookConfigCache();
		clearRegisteredHooks();

		registerHook("PermissionRequest", {
			type: "callback",
			callback: async () => ({
				reason: "Trusted read policy",
				hookSpecificOutput: {
					hookEventName: "PermissionRequest",
					decision: {
						behavior: "allow",
						updatedInput: { path: "/tmp/approved.txt" },
					},
				},
			}),
		});

		const readTool: AgentTool = {
			name: "read",
			description: "Read a file",
			parameters: Type.Object({
				path: Type.String(),
			}),
			execute: async () => ({
				content: [{ type: "text", text: "ok" }],
			}),
		};
		const approvalService: Pick<
			ActionApprovalService,
			"requiresUserInteraction" | "requestApproval"
		> = {
			requiresUserInteraction: () => true,
			requestApproval: vi.fn(
				async (_request: ActionApprovalRequest) =>
					({
						approved: true,
						resolvedBy: "user",
					}) as const,
			),
		};
		const { result } = await collectSafetyResult({
			toolCall: {
				type: "toolCall",
				id: "call-1",
				name: "read",
				arguments: { path: "/tmp/original.txt" },
			},
			tools: [readTool],
			userMessage: {
				role: "user",
				content: "Read the file",
				timestamp: Date.now(),
			} satisfies Message,
			cfg: { tools: [readTool] } as AgentRunConfig,
			clock: { now: () => Date.now() },
			safetyMiddleware: new SafetyMiddleware({
				enableContextFirewall: false,
				enableLoopDetection: false,
				enableSequenceAnalysis: false,
			}),
			workflowState: new WorkflowStateTracker(),
			adaptiveThresholds: new AdaptiveThresholds(),
			approvalService,
			hookService: createToolHookService({
				cwd: "/tmp/test",
				resolveTool: (toolName) => (toolName === "read" ? readTool : undefined),
			}),
			firewall: new ActionFirewall([
				{
					name: "require-approval",
					description: "require approval",
					action: "require_approval",
					evaluate: async () => ({
						allowed: false,
						reason: "Approval required",
					}),
				},
			]),
			rateLimitState: {
				recentToolTimestamps: new Map(),
				toolCallsThisMinute: 0,
				minuteWindowStart: 0,
				rateWindowMs: 10_000,
				rateLimit: 10,
			},
			emitToolResult: (message: ToolResultMessage, toolCall, isError) => [
				{
					type: "tool_execution_end",
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					result: message,
					isError,
				},
			],
		});

		expect(result.verdict.outcome).toBe("proceed");
		if (result.verdict.outcome !== "proceed") {
			throw new Error("Expected approval hook to allow execution");
		}
		expect(result.verdict.effectiveToolCall.arguments).toEqual({
			path: "/tmp/approved.txt",
		});
		expect(approvalService.requestApproval).not.toHaveBeenCalled();
	});

	it("blocks when PermissionRequest hooks deny before approval UI", async () => {
		clearHookConfigCache();
		clearRegisteredHooks();

		registerHook("PermissionRequest", {
			type: "callback",
			callback: async () => ({
				reason: "Denied by policy hook",
				hookSpecificOutput: {
					hookEventName: "PermissionRequest",
					decision: {
						behavior: "deny",
					},
				},
			}),
		});

		const readTool: AgentTool = {
			name: "read",
			description: "Read a file",
			parameters: Type.Object({
				path: Type.String(),
			}),
			execute: async () => ({
				content: [{ type: "text", text: "ok" }],
			}),
		};
		const approvalService: Pick<
			ActionApprovalService,
			"requiresUserInteraction" | "requestApproval"
		> = {
			requiresUserInteraction: () => true,
			requestApproval: vi.fn(
				async (_request: ActionApprovalRequest) =>
					({
						approved: true,
						resolvedBy: "user",
					}) as const,
			),
		};

		const { result } = await collectSafetyResult({
			toolCall: {
				type: "toolCall",
				id: "call-1",
				name: "read",
				arguments: { path: "/tmp/original.txt" },
			},
			tools: [readTool],
			userMessage: {
				role: "user",
				content: "Read the file",
				timestamp: Date.now(),
			} satisfies Message,
			cfg: { tools: [readTool] } as AgentRunConfig,
			clock: { now: () => Date.now() },
			safetyMiddleware: new SafetyMiddleware({
				enableContextFirewall: false,
				enableLoopDetection: false,
				enableSequenceAnalysis: false,
			}),
			workflowState: new WorkflowStateTracker(),
			adaptiveThresholds: new AdaptiveThresholds(),
			approvalService,
			hookService: createToolHookService({
				cwd: "/tmp/test",
				resolveTool: (toolName) => (toolName === "read" ? readTool : undefined),
			}),
			firewall: new ActionFirewall([
				{
					name: "require-approval",
					description: "require approval",
					action: "require_approval",
					evaluate: async () => ({
						allowed: false,
						reason: "Approval required",
					}),
				},
			]),
			rateLimitState: {
				recentToolTimestamps: new Map(),
				toolCallsThisMinute: 0,
				minuteWindowStart: 0,
				rateWindowMs: 10_000,
				rateLimit: 10,
			},
			emitToolResult: (message: ToolResultMessage, toolCall, isError) => [
				{
					type: "tool_execution_end",
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					result: message,
					isError,
				},
			],
		});

		expect(result.verdict.outcome).toBe("blocked");
		if (result.verdict.outcome !== "blocked") {
			throw new Error("Expected permission hook denial to block execution");
		}
		expect(approvalService.requestApproval).not.toHaveBeenCalled();
		const toolResultEvent = result.verdict.events.find(
			(event) => event.type === "tool_execution_end",
		);
		expect(toolResultEvent).toMatchObject({
			type: "tool_execution_end",
			result: {
				content: [
					{
						type: "text",
						text: "Denied by policy hook",
					},
				],
			},
		});
	});
});
