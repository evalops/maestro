import { Type } from "@sinclair/typebox";
import { describe, expect, it, vi } from "vitest";

import {
	type ActionApprovalRequest,
	ActionApprovalService,
} from "../../src/agent/action-approval.js";
import type { PlatformToolExecutionBridge } from "../../src/agent/transport/tool-execution-bridge.js";
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
import { CONTEXT_INTERPOLATED_MARKER } from "../../src/tools/tool-dsl.js";

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

function createBashTool(): AgentTool {
	return {
		name: "bash",
		description: "Run a shell command",
		parameters: Type.Object({
			command: Type.String(),
			env: Type.Optional(Type.Record(Type.String(), Type.String())),
		}),
		execute: async () => ({
			content: [{ type: "text", text: "ok" }],
		}),
	};
}

function createBaseSafetyContext(options: {
	tool: AgentTool;
	path?: string;
	args?: Record<string, unknown>;
	approvalService?: Parameters<typeof evaluateToolSafety>[0]["approvalService"];
	hookService?: Parameters<typeof evaluateToolSafety>[0]["hookService"];
	toolExecutionBridge?: Parameters<
		typeof evaluateToolSafety
	>[0]["toolExecutionBridge"];
	firewall?: ActionFirewall;
	safetyMiddleware?: SafetyMiddleware;
	cfg?: Partial<AgentRunConfig>;
}): Parameters<typeof evaluateToolSafety>[0] {
	return {
		toolCall: {
			type: "toolCall",
			id: "call-1",
			name: options.tool.name,
			arguments: options.args ?? { path: options.path },
		},
		tools: [options.tool],
		userMessage: {
			role: "user",
			content: "Read the file",
			timestamp: Date.now(),
		} satisfies Message,
		cfg: { tools: [options.tool], ...options.cfg } as AgentRunConfig,
		clock: { now: () => Date.now() },
		safetyMiddleware:
			options.safetyMiddleware ??
			new SafetyMiddleware({
				enableContextFirewall: false,
				enableLoopDetection: false,
				enableSequenceAnalysis: false,
			}),
		workflowState: new WorkflowStateTracker(),
		adaptiveThresholds: new AdaptiveThresholds(),
		approvalService: options.approvalService,
		hookService: options.hookService,
		toolExecutionBridge: options.toolExecutionBridge,
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
	it("evaluates bash firewall approval against interpolated commands", async () => {
		const previousValue = process.env.MAESTRO_TEST_DANGEROUS_COMMAND;
		process.env.MAESTRO_TEST_DANGEROUS_COMMAND = "rm -rf /tmp/nope";
		try {
			const bashTool = createBashTool();
			const approvalService = {
				requiresUserInteraction: () => true,
				requestApproval: vi.fn(async (_request: ActionApprovalRequest) => ({
					approved: true,
					resolvedBy: "user" as const,
				})),
			};

			const { result } = await collectSafetyResult(
				createBaseSafetyContext({
					tool: bashTool,
					args: { command: "${env.MAESTRO_TEST_DANGEROUS_COMMAND}" },
					approvalService,
				}),
			);

			expect(result.verdict.outcome).toBe("proceed");
			expect(approvalService.requestApproval).toHaveBeenCalledTimes(1);
			expect(approvalService.requestApproval).toHaveBeenCalledWith(
				expect.objectContaining({
					args: { command: "rm -rf /tmp/nope" },
					reason: expect.stringContaining("rm -rf /tmp/nope"),
				}),
				undefined,
				expect.objectContaining({
					now: expect.any(Function),
				}),
			);
			if (result.verdict.outcome !== "proceed") {
				throw new Error("Expected approved interpolated command to proceed");
			}
			expect(result.verdict.effectiveToolCall.arguments).toEqual({
				command: "rm -rf /tmp/nope",
				[CONTEXT_INTERPOLATED_MARKER]: true,
			});
		} finally {
			if (previousValue === undefined) {
				delete process.env.MAESTRO_TEST_DANGEROUS_COMMAND;
			} else {
				process.env.MAESTRO_TEST_DANGEROUS_COMMAND = previousValue;
			}
		}
	});

	it("uses bash env overrides when interpolating approval commands", async () => {
		const previousValue = process.env.MAESTRO_TEST_OVERRIDE_COMMAND;
		process.env.MAESTRO_TEST_OVERRIDE_COMMAND = "echo safe";
		try {
			const bashTool = createBashTool();
			const approvalService = {
				requiresUserInteraction: () => true,
				requestApproval: vi.fn(async (_request: ActionApprovalRequest) => ({
					approved: true,
					resolvedBy: "user" as const,
				})),
			};

			const { result } = await collectSafetyResult(
				createBaseSafetyContext({
					tool: bashTool,
					args: {
						command: "${env.MAESTRO_TEST_OVERRIDE_COMMAND}",
						env: {
							MAESTRO_TEST_OVERRIDE_COMMAND: "rm -rf /tmp/override",
						},
					},
					approvalService,
				}),
			);

			expect(result.verdict.outcome).toBe("proceed");
			expect(approvalService.requestApproval).toHaveBeenCalledWith(
				expect.objectContaining({
					args: {
						command: "rm -rf /tmp/override",
						env: {
							MAESTRO_TEST_OVERRIDE_COMMAND: "rm -rf /tmp/override",
						},
					},
					reason: expect.stringContaining("rm -rf /tmp/override"),
				}),
				undefined,
				expect.objectContaining({
					now: expect.any(Function),
				}),
			);
			if (result.verdict.outcome !== "proceed") {
				throw new Error("Expected approved override command to proceed");
			}
			expect(result.verdict.effectiveToolCall.arguments).toEqual({
				command: "rm -rf /tmp/override",
				env: {
					MAESTRO_TEST_OVERRIDE_COMMAND: "rm -rf /tmp/override",
				},
				[CONTEXT_INTERPOLATED_MARKER]: true,
			});
		} finally {
			if (previousValue === undefined) {
				delete process.env.MAESTRO_TEST_OVERRIDE_COMMAND;
			} else {
				process.env.MAESTRO_TEST_OVERRIDE_COMMAND = previousValue;
			}
		}
	});

	it("passes interpolated bash args to the platform bridge", async () => {
		const previousValue = process.env.MAESTRO_TEST_BRIDGE_COMMAND;
		process.env.MAESTRO_TEST_BRIDGE_COMMAND = "pwd";
		try {
			const prepare = vi.fn(async () => ({ status: "skip" as const }));
			const toolExecutionBridge: PlatformToolExecutionBridge = {
				prepare,
				resolveApproval: vi.fn(async (_input, plan) => ({
					status: "allow" as const,
					plan,
				})),
				recordObservation: vi.fn(async () => ({ metadata: {} })),
				recordGovernedOutput: vi.fn(async () => ({ metadata: {} })),
			};

			const { result } = await collectSafetyResult(
				createBaseSafetyContext({
					tool: createBashTool(),
					args: { command: "${env.MAESTRO_TEST_BRIDGE_COMMAND}" },
					toolExecutionBridge,
				}),
			);

			expect(result.verdict.outcome).toBe("proceed");
			expect(prepare).toHaveBeenCalledWith(
				expect.objectContaining({
					toolCall: expect.objectContaining({
						arguments: {
							command: "pwd",
							[CONTEXT_INTERPOLATED_MARKER]: true,
						},
					}),
					sanitizedArgs: { command: "pwd" },
				}),
				undefined,
			);
		} finally {
			if (previousValue === undefined) {
				delete process.env.MAESTRO_TEST_BRIDGE_COMMAND;
			} else {
				process.env.MAESTRO_TEST_BRIDGE_COMMAND = previousValue;
			}
		}
	});

	it("shows exact bash execution args in approval prompts", async () => {
		const bashTool = createBashTool();
		const approvalService = {
			requiresUserInteraction: () => true,
			requestApproval: vi.fn(async (_request: ActionApprovalRequest) => ({
				approved: true,
				resolvedBy: "user" as const,
			})),
		};
		const safetyMiddleware = new SafetyMiddleware({
			enableContextFirewall: false,
			enableLoopDetection: false,
			enableSequenceAnalysis: false,
		});
		vi.spyOn(safetyMiddleware, "sanitizeForLogging").mockImplementation(
			(args) => ({
				...args,
				command: "[REDACTED]",
			}),
		);

		const { result } = await collectSafetyResult(
			createBaseSafetyContext({
				tool: bashTool,
				args: { command: "rm -rf /tmp/nope" },
				approvalService,
				safetyMiddleware,
			}),
		);

		expect(result.verdict.outcome).toBe("proceed");
		expect(approvalService.requestApproval).toHaveBeenCalledTimes(1);
		expect(approvalService.requestApproval).toHaveBeenCalledWith(
			expect.objectContaining({
				actionDescription: expect.stringContaining("rm -rf /tmp/nope"),
				args: { command: "rm -rf /tmp/nope" },
				summaryLabel: expect.stringContaining("rm -rf /tmp/nope"),
			}),
			undefined,
			expect.objectContaining({
				now: expect.any(Function),
			}),
		);
		if (result.verdict.outcome !== "proceed") {
			throw new Error("Expected approved raw command to proceed");
		}
		expect(result.verdict.effectiveToolCall.arguments).toEqual({
			command: "rm -rf /tmp/nope",
		});
	});

	it("rebinds reused platform approval requests to exact bash args", async () => {
		const bashTool = createBashTool();
		const approvalService = {
			requiresUserInteraction: () => true,
			requestApproval: vi.fn(async (_request: ActionApprovalRequest) => ({
				approved: true,
				resolvedBy: "user" as const,
			})),
		};
		const safetyMiddleware = new SafetyMiddleware({
			enableContextFirewall: false,
			enableLoopDetection: false,
			enableSequenceAnalysis: false,
		});
		vi.spyOn(safetyMiddleware, "sanitizeForLogging").mockImplementation(
			(args) => ({
				...args,
				command: "[REDACTED]",
			}),
		);
		const toolExecutionBridge: PlatformToolExecutionBridge = {
			prepare: vi.fn(async () => ({
				status: "wait_approval" as const,
				plan: {
					kind: "governed",
					metadata: {
						approvalRequestId: "platform-approval-1",
						toolExecutionId: "tool-exec-1",
					},
				} as never,
				request: {
					id: "platform-approval-1",
					toolName: "bash",
					summaryLabel: "Bash: [REDACTED]",
					actionDescription: "Running: [REDACTED]",
					args: { command: "[REDACTED]" },
					reason: "Platform approval required",
					startedAtMs: 100,
					platform: {
						source: "tool_execution",
						toolExecutionId: "tool-exec-1",
						approvalRequestId: "platform-approval-1",
					},
				},
			})),
			resolveApproval: vi.fn(async (_input, plan) => ({
				status: "allow" as const,
				plan,
			})),
			recordObservation: vi.fn(async () => ({ metadata: {} })),
			recordGovernedOutput: vi.fn(async () => ({ metadata: {} })),
		};

		const { result } = await collectSafetyResult(
			createBaseSafetyContext({
				tool: bashTool,
				args: { command: "rm -rf /tmp/nope" },
				approvalService,
				safetyMiddleware,
				toolExecutionBridge,
			}),
		);

		expect(result.verdict.outcome).toBe("proceed");
		expect(approvalService.requestApproval).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "platform-approval-1",
				args: { command: "rm -rf /tmp/nope" },
				summaryLabel: expect.stringContaining("rm -rf /tmp/nope"),
				actionDescription: expect.stringContaining("rm -rf /tmp/nope"),
				platform: {
					source: "tool_execution",
					toolExecutionId: "tool-exec-1",
					approvalRequestId: "platform-approval-1",
				},
			}),
			undefined,
			expect.objectContaining({
				now: expect.any(Function),
			}),
		);
		expect(toolExecutionBridge.resolveApproval).toHaveBeenCalled();
		if (result.verdict.outcome !== "proceed") {
			throw new Error("Expected platform-approved bash command to proceed");
		}
		expect(result.verdict.effectiveToolCall.arguments).toEqual({
			command: "rm -rf /tmp/nope",
		});
	});

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

	it("shows rewritten args for platform approval requests", async () => {
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
						updatedInput: { path: "/tmp/rewritten.txt" },
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
		const platformBridge: PlatformToolExecutionBridge = {
			prepare: vi.fn(async () => ({
				status: "wait_approval" as const,
				plan: {
					kind: "governed",
					metadata: {
						approvalRequestId: "platform-approval-1",
						toolExecutionId: "tool-exec-1",
					},
				} as never,
				request: {
					id: "platform-approval-1",
					toolName: "read",
					args: { path: "/tmp/original.txt" },
					reason: "Platform approval required",
					startedAtMs: 100,
					platform: {
						source: "tool_execution",
						toolExecutionId: "tool-exec-1",
						approvalRequestId: "platform-approval-1",
					},
				},
			})),
			resolveApproval: vi.fn(async (_input, plan) => ({
				status: "allow" as const,
				plan,
			})),
			recordObservation: vi.fn(async () => ({ metadata: {} })),
			recordGovernedOutput: vi.fn(async () => ({ metadata: {} })),
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
				toolExecutionBridge: platformBridge,
				firewall: new ActionFirewall([
					{
						name: "require-rewritten-approval",
						description: "require approval for rewritten path",
						action: "require_approval",
						evaluate: async (ctx) => ({
							allowed:
								(ctx.args as { path?: string }).path !== "/tmp/rewritten.txt",
							reason: "Rewritten path approval",
						}),
					},
				]),
			}),
		);

		expect(result.verdict.outcome).toBe("proceed");
		expect(approvalService.requestApproval).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "platform-approval-1",
				args: { path: "/tmp/rewritten.txt" },
				reason: "Rewritten path approval",
				startedAtMs: 100,
				platform: {
					source: "tool_execution",
					toolExecutionId: "tool-exec-1",
					approvalRequestId: "platform-approval-1",
				},
			}),
			undefined,
			expect.objectContaining({
				now: expect.any(Function),
			}),
		);
		expect(platformBridge.resolveApproval).toHaveBeenCalled();
		if (result.verdict.outcome !== "proceed") {
			throw new Error("Expected rewritten platform approval to proceed");
		}
		expect(result.verdict.effectiveToolCall.arguments).toEqual({
			path: "/tmp/rewritten.txt",
		});
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

	it("refreshes platform approval requests after PermissionRequest hooks rewrite inputs", async () => {
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
						updatedInput: { path: "/tmp/rewritten-secret.txt" },
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
		const toolExecutionBridge = {
			prepare: vi.fn(async () => ({
				status: "wait_approval" as const,
				plan: {
					kind: "governed" as const,
					mode: "governed" as const,
					classification: {} as never,
					config: {} as never,
					request: {} as never,
					metadata: {
						toolExecutionId: "platform-exec-1",
						approvalRequestId: "platform-approval-1",
					},
					resumeToken: "platform-resume-1",
				},
				request: {
					id: "platform-approval-1",
					toolName: "read",
					summaryLabel: "Read original.txt",
					actionDescription: "Reading original.txt",
					args: { path: "/tmp/original.txt" },
					reason: "Original platform approval reason",
					platform: {
						source: "tool_execution" as const,
						toolExecutionId: "platform-exec-1",
						approvalRequestId: "platform-approval-1",
					},
				},
			})),
			resolveApproval: vi.fn(async (_input, plan) => ({
				status: "allow" as const,
				plan,
			})),
			recordObservation: vi.fn(async () => ({
				metadata: {},
			})),
			recordGovernedOutput: vi.fn(async () => ({
				metadata: {},
			})),
		} satisfies NonNullable<
			Parameters<typeof evaluateToolSafety>[0]["toolExecutionBridge"]
		>;

		const { events, result } = await collectSafetyResult({
			...createBaseSafetyContext({
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
						name: "rewrite-requires-approval",
						description: "require approval after rewrite",
						action: "require_approval",
						evaluate: async (ctx) => ({
							allowed:
								(ctx.args as { path?: string }).path !==
								"/tmp/rewritten-secret.txt",
							reason: "Hook rewrite requires approval",
						}),
					},
				]),
			}),
			toolExecutionBridge,
		});

		expect(result.verdict.outcome).toBe("proceed");
		if (result.verdict.outcome !== "proceed") {
			throw new Error("Expected rewritten platform approval to proceed");
		}
		expect(result.verdict.effectiveToolCall.arguments).toEqual({
			path: "/tmp/rewritten-secret.txt",
		});
		expect(approvalService.requestApproval).toHaveBeenCalledTimes(1);
		expect(approvalService.requestApproval).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "platform-approval-1",
				args: { path: "/tmp/rewritten-secret.txt" },
				summaryLabel: "Read rewritten-secret.txt",
				actionDescription: "Reading rewritten-secret.txt",
				reason: "Hook rewrite requires approval",
				platform: {
					source: "tool_execution",
					toolExecutionId: "platform-exec-1",
					approvalRequestId: "platform-approval-1",
				},
			}),
			undefined,
			expect.objectContaining({
				now: expect.any(Function),
			}),
		);
		const approvalRequiredEvent = events.find(
			(event) => event.type === "action_approval_required",
		);
		expect(approvalRequiredEvent).toMatchObject({
			type: "action_approval_required",
			request: {
				id: "platform-approval-1",
				args: { path: "/tmp/rewritten-secret.txt" },
				summaryLabel: "Read rewritten-secret.txt",
				actionDescription: "Reading rewritten-secret.txt",
				reason: "Hook rewrite requires approval",
			},
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
