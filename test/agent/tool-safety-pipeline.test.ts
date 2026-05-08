import { Type } from "@sinclair/typebox";
import { describe, expect, it, vi } from "vitest";

import {
	type ActionApprovalRequest,
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
import {
	ActionFirewall,
	defaultFirewallRules,
} from "../../src/safety/action-firewall.js";
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

function createReadTool(): AgentTool {
	return {
		name: "read",
		description: "Read a file",
		parameters: Type.Object({
			path: Type.String(),
		}),
		execute: async () => ({
			content: [{ type: "text", text: "ok" }],
		}),
	};
}

function createBaseSafetyContext(options: {
	tool: AgentTool;
	path: string;
	approvalService?: Parameters<typeof evaluateToolSafety>[0]["approvalService"];
	hookService?: Parameters<typeof evaluateToolSafety>[0]["hookService"];
	firewall?: ActionFirewall;
	cfg?: Partial<AgentRunConfig>;
}): Parameters<typeof evaluateToolSafety>[0] {
	return {
		toolCall: {
			type: "toolCall",
			id: "call-1",
			name: options.tool.name,
			arguments: { path: options.path },
		},
		tools: [options.tool],
		userMessage: {
			role: "user",
			content: "Read the file",
			timestamp: Date.now(),
		} satisfies Message,
		cfg: { tools: [options.tool], ...options.cfg } as AgentRunConfig,
		clock: { now: () => Date.now() },
		safetyMiddleware: new SafetyMiddleware({
			enableContextFirewall: false,
			enableLoopDetection: false,
			enableSequenceAnalysis: false,
		}),
		workflowState: new WorkflowStateTracker(),
		adaptiveThresholds: new AdaptiveThresholds(),
		approvalService: options.approvalService,
		hookService: options.hookService,
		firewall: options.firewall ?? new ActionFirewall(),
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
	};
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

describe("evaluateToolSafety guarded files", () => {
	it("blocks guarded files instead of auto approving them", async () => {
		const readTool = createReadTool();
		const approvalService = new ActionApprovalService("auto");
		const requestApproval = vi.spyOn(approvalService, "requestApproval");

		const { result } = await collectSafetyResult(
			createBaseSafetyContext({
				tool: readTool,
				path: "~/.ssh/config",
				approvalService,
			}),
		);

		expect(result.verdict.outcome).toBe("blocked");
		expect(requestApproval).not.toHaveBeenCalled();
		const toolResultEvent = result.verdict.events.find(
			(event) => event.type === "tool_execution_end",
		);
		expect(toolResultEvent).toMatchObject({
			type: "tool_execution_end",
			result: {
				content: [
					{
						type: "text",
						text: expect.stringContaining(
							"Approval mode must be prompt for guarded file access",
						),
					},
				],
			},
		});
	});

	it("does not let PermissionRequest hooks allow guarded files without user approval", async () => {
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

		const readTool = createReadTool();
		const approvalService = {
			requiresUserInteraction: () => true,
			requestApproval: vi.fn(async (_request: ActionApprovalRequest) => ({
				approved: true,
				resolvedBy: "user" as const,
			})),
		};

		const { result } = await collectSafetyResult(
			createBaseSafetyContext({
				tool: readTool,
				path: "~/.ssh/config",
				approvalService,
				hookService: createToolHookService({
					cwd: "/tmp/test",
					resolveTool: (toolName) =>
						toolName === "read" ? readTool : undefined,
				}),
			}),
		);

		expect(result.verdict.outcome).toBe("proceed");
		if (result.verdict.outcome !== "proceed") {
			throw new Error("Expected user-approved guarded file read to proceed");
		}
		expect(approvalService.requestApproval).toHaveBeenCalledTimes(1);
		expect(approvalService.requestApproval).toHaveBeenCalledWith(
			expect.objectContaining({
				args: { path: "~/.ssh/config" },
				reason: expect.stringContaining("Guarded file access"),
			}),
			undefined,
			expect.objectContaining({
				now: expect.any(Function),
			}),
		);
		expect(result.verdict.effectiveToolCall.arguments).toEqual({
			path: "~/.ssh/config",
		});
	});

	it("honors PermissionRequest hook denials for guarded files", async () => {
		clearHookConfigCache();
		clearRegisteredHooks();

		registerHook("PermissionRequest", {
			type: "callback",
			callback: async () => ({
				reason: "Guarded path denied by policy hook",
				hookSpecificOutput: {
					hookEventName: "PermissionRequest",
					decision: {
						behavior: "deny",
					},
				},
			}),
		});

		const readTool = createReadTool();
		const approvalService = {
			requiresUserInteraction: () => true,
			requestApproval: vi.fn(async (_request: ActionApprovalRequest) => ({
				approved: true,
				resolvedBy: "user" as const,
			})),
		};

		const { result } = await collectSafetyResult(
			createBaseSafetyContext({
				tool: readTool,
				path: "~/.ssh/config",
				approvalService,
				hookService: createToolHookService({
					cwd: "/tmp/test",
					resolveTool: (toolName) =>
						toolName === "read" ? readTool : undefined,
				}),
			}),
		);

		expect(result.verdict.outcome).toBe("blocked");
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
						text: "Guarded path denied by policy hook",
					},
				],
			},
		});
	});

	it("requires guarded approval even when the firewall returns allow", async () => {
		const readTool = createReadTool();
		const approvalService = {
			requiresUserInteraction: () => true,
			requestApproval: vi.fn(async (_request: ActionApprovalRequest) => ({
				approved: true,
				resolvedBy: "user" as const,
			})),
		};

		const { result } = await collectSafetyResult(
			createBaseSafetyContext({
				tool: readTool,
				path: "~/.ssh/config",
				approvalService,
				firewall: {
					evaluate: vi.fn(async () => ({ action: "allow" as const })),
				} as unknown as ActionFirewall,
			}),
		);

		expect(result.verdict.outcome).toBe("proceed");
		expect(approvalService.requestApproval).toHaveBeenCalledTimes(1);
		expect(approvalService.requestApproval).toHaveBeenCalledWith(
			expect.objectContaining({
				args: { path: "~/.ssh/config" },
				reason: expect.stringContaining("Guarded file access"),
			}),
			undefined,
			expect.objectContaining({
				now: expect.any(Function),
			}),
		);
	});

	it("blocks guardedFiles block rules even when the firewall returns allow", async () => {
		const readTool = createReadTool();
		const approvalService = {
			requiresUserInteraction: () => true,
			requestApproval: vi.fn(async (_request: ActionApprovalRequest) => ({
				approved: true,
				resolvedBy: "user" as const,
			})),
		};

		const { result } = await collectSafetyResult(
			createBaseSafetyContext({
				tool: readTool,
				path: "/workspace/project/.secrets/token.txt",
				approvalService,
				firewall: {
					evaluate: vi.fn(async () => ({ action: "allow" as const })),
				} as unknown as ActionFirewall,
				cfg: {
					guardedFiles: {
						organization: {
							rules: [
								{
									key: "org-secrets",
									description: "Organization secret fixtures",
									patterns: ["**/.secrets/**"],
									defaultBehavior: "block",
								},
							],
						},
					},
				},
			}),
		);

		expect(result.verdict.outcome).toBe("blocked");
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
						text: expect.stringContaining("Organization secret fixtures"),
					},
				],
			},
		});
	});

	it("re-checks guarded files after PermissionRequest hooks rewrite inputs", async () => {
		clearHookConfigCache();
		clearRegisteredHooks();

		registerHook("PermissionRequest", {
			type: "callback",
			callback: async () => ({
				reason: "Trusted rewrite policy",
				hookSpecificOutput: {
					hookEventName: "PermissionRequest",
					decision: {
						behavior: "allow",
						updatedInput: { path: "~/.ssh/config" },
					},
				},
			}),
		});

		const readTool = createReadTool();
		const approvalService = {
			requiresUserInteraction: () => true,
			requestApproval: vi.fn(async (_request: ActionApprovalRequest) => ({
				approved: true,
				resolvedBy: "user" as const,
			})),
		};

		const { result } = await collectSafetyResult(
			createBaseSafetyContext({
				tool: readTool,
				path: "/tmp/original.txt",
				approvalService,
				hookService: createToolHookService({
					cwd: "/tmp/test",
					resolveTool: (toolName) =>
						toolName === "read" ? readTool : undefined,
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
			}),
		);

		expect(result.verdict.outcome).toBe("proceed");
		if (result.verdict.outcome !== "proceed") {
			throw new Error("Expected user-approved guarded file rewrite to proceed");
		}
		expect(approvalService.requestApproval).toHaveBeenCalledTimes(1);
		expect(approvalService.requestApproval).toHaveBeenCalledWith(
			expect.objectContaining({
				args: { path: "~/.ssh/config" },
				reason: expect.stringContaining("Guarded file access"),
			}),
			undefined,
			expect.objectContaining({
				now: expect.any(Function),
			}),
		);
		expect(result.verdict.effectiveToolCall.arguments).toEqual({
			path: "~/.ssh/config",
		});
	});

	it("blocks guardedFiles block rules after PermissionRequest hooks rewrite inputs", async () => {
		clearHookConfigCache();
		clearRegisteredHooks();

		registerHook("PermissionRequest", {
			type: "callback",
			callback: async () => ({
				reason: "Policy rewrite",
				hookSpecificOutput: {
					hookEventName: "PermissionRequest",
					decision: {
						behavior: "allow",
						updatedInput: { path: "/workspace/project/.secrets/token.txt" },
					},
				},
			}),
		});

		const readTool = createReadTool();
		const approvalService = {
			requiresUserInteraction: () => true,
			requestApproval: vi.fn(async (_request: ActionApprovalRequest) => ({
				approved: true,
				resolvedBy: "user" as const,
			})),
		};

		const { result } = await collectSafetyResult(
			createBaseSafetyContext({
				tool: readTool,
				path: "/tmp/original.txt",
				approvalService,
				hookService: createToolHookService({
					cwd: "/tmp/test",
					resolveTool: (toolName) =>
						toolName === "read" ? readTool : undefined,
				}),
				firewall: new ActionFirewall([
					{
						name: "require-original-approval",
						description: "require approval for the original path",
						action: "require_approval",
						evaluate: async (ctx) => ({
							allowed:
								(ctx.args as { path?: string }).path !== "/tmp/original.txt",
							reason: "Approval required",
						}),
					},
					...defaultFirewallRules,
				]),
				cfg: {
					guardedFiles: {
						organization: {
							rules: [
								{
									key: "org-secrets",
									description: "Organization secret fixtures",
									patterns: ["**/.secrets/**"],
									defaultBehavior: "block",
								},
							],
						},
					},
				},
			}),
		);

		expect(result.verdict.outcome).toBe("blocked");
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
						text: expect.stringContaining("Organization secret fixtures"),
					},
				],
			},
		});
	});
});
