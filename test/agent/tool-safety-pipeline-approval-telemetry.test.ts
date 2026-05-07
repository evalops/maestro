import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type ActionApprovalDecision,
	type ActionApprovalRequest,
	ActionApprovalService,
} from "../../src/agent/action-approval.js";
import { evaluateToolSafety } from "../../src/agent/transport/tool-safety-pipeline.js";
import type {
	AgentRunConfig,
	AgentTool,
	Message,
} from "../../src/agent/types.js";
import { PlatformBackedActionApprovalService } from "../../src/approvals/platform-action-approval.js";
import { resetApprovalsDownstreamForTests } from "../../src/approvals/service-client.js";
import { ActionFirewall } from "../../src/safety/action-firewall.js";
import { AdaptiveThresholds } from "../../src/safety/adaptive-thresholds.js";
import { SafetyMiddleware } from "../../src/safety/safety-middleware.js";
import { WorkflowStateTracker } from "../../src/safety/workflow-state.js";

const telemetryMocks = vi.hoisted(() => ({
	recordMaestroApprovalHit: vi.fn(),
	recordMaestroFirewallBlock: vi.fn(),
}));

vi.mock("../../src/telemetry/maestro-event-bus.js", () => telemetryMocks);

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

function createGuardedReadSafetyContext(options: {
	approvalService: ActionApprovalService;
}) {
	const readTool = createReadTool();
	return {
		toolCall: {
			type: "toolCall" as const,
			id: "call-guarded-read",
			name: "read",
			arguments: { path: "~/.ssh/config" },
		},
		tools: [readTool],
		userMessage: {
			role: "user" as const,
			content: "Read the ssh config",
			timestamp: Date.now(),
		} satisfies Message,
		cfg: {
			tools: [readTool],
			session: { id: "session-guarded", startedAt: new Date() },
			user: { id: "user-1", orgId: "workspace-1" },
		} as AgentRunConfig,
		clock: { now: () => Date.now() },
		safetyMiddleware: new SafetyMiddleware({
			enableContextFirewall: false,
			enableLoopDetection: false,
			enableSequenceAnalysis: false,
		}),
		workflowState: new WorkflowStateTracker(),
		adaptiveThresholds: new AdaptiveThresholds(),
		approvalService: options.approvalService,
		firewall: new ActionFirewall(),
		rateLimitState: {
			recentToolTimestamps: new Map(),
			toolCallsThisMinute: 0,
			minuteWindowStart: 0,
			rateWindowMs: 10_000,
			rateLimit: 10,
		},
		emitToolResult: () => [],
	};
}

describe("evaluateToolSafety approval telemetry", () => {
	afterEach(() => {
		resetApprovalsDownstreamForTests();
		telemetryMocks.recordMaestroApprovalHit.mockReset();
		telemetryMocks.recordMaestroFirewallBlock.mockReset();
		vi.unstubAllGlobals();
	});

	it("records the remote approvals-service request id before waiting for user approval", async () => {
		const fetchMock = vi.fn(async (url: string | URL | Request) => {
			const href = String(url);
			if (href.endsWith("/approvals.v1.ApprovalService/RequestApproval")) {
				return new Response(
					JSON.stringify({
						approvalRequest: { id: "remote-approval-telemetry-1" },
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (href.endsWith("/approvals.v1.ApprovalService/ResolveApproval")) {
				return new Response(JSON.stringify({}), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response("not found", { status: 404 });
		});
		vi.stubGlobal("fetch", fetchMock);

		const bashTool: AgentTool = {
			name: "bash",
			description: "Run a shell command",
			parameters: Type.Object({
				command: Type.String(),
			}),
			execute: async () => ({
				content: [{ type: "text", text: "ok" }],
			}),
		};
		const approvalService = new PlatformBackedActionApprovalService("prompt", {
			sessionIdProvider: "session-1",
			approvalsServiceConfig: {
				baseUrl: "https://platform.test",
				maxAttempts: 1,
				timeoutMs: 500,
				workspaceId: "workspace-1",
			},
		});

		const iterator = evaluateToolSafety({
			toolCall: {
				type: "toolCall",
				id: "call-1",
				name: "bash",
				arguments: { command: "git push origin main" },
			},
			tools: [bashTool],
			userMessage: {
				role: "user",
				content: "Push the branch",
				timestamp: Date.now(),
			} satisfies Message,
			cfg: {
				tools: [bashTool],
				session: { id: "session-1", startedAt: new Date() },
				user: { id: "user-1", orgId: "workspace-1" },
			} as AgentRunConfig,
			clock: { now: () => Date.now() },
			safetyMiddleware: new SafetyMiddleware({
				enableContextFirewall: false,
				enableLoopDetection: false,
				enableSequenceAnalysis: false,
			}),
			workflowState: new WorkflowStateTracker(),
			adaptiveThresholds: new AdaptiveThresholds(),
			approvalService,
			firewall: new ActionFirewall([
				{
					name: "require-approval",
					description: "Require approval",
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
			emitToolResult: () => [],
		});

		const first = await iterator.next();
		expect(first.done).toBe(false);
		if (first.done) {
			throw new Error("Expected tool-start event");
		}
		expect(first.value).toMatchObject({
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "bash",
		});

		const second = await iterator.next();
		expect(second.done).toBe(false);
		if (second.done) {
			throw new Error("Expected approval-required event");
		}
		expect(second.value).toMatchObject({
			type: "action_approval_required",
			request: {
				id: "call-1",
				toolName: "bash",
			},
		});
		expect(telemetryMocks.recordMaestroApprovalHit).toHaveBeenCalledWith(
			expect.objectContaining({
				approval_request_id: "remote-approval-telemetry-1",
				action: "Running git push origin main",
				decision_mode: "MAESTRO_DECISION_MODE_REQUIRE_APPROVAL",
				reason: "Approval required",
				correlation: {
					session_id: "session-1",
					agent_run_step_id: "call-1",
				},
			}),
		);
		expect(approvalService.getPendingApprovalRegistration("call-1")).toEqual({
			remoteApprovalRequestId: "remote-approval-telemetry-1",
		});

		expect(approvalService.approve("call-1", "Looks good")).toBe(true);

		const third = await iterator.next();
		expect(third.done).toBe(false);
		if (third.done) {
			throw new Error("Expected approval-resolved event");
		}
		expect(third.value).toMatchObject({
			type: "action_approval_resolved",
			decision: {
				approved: true,
				reason: "Looks good",
				resolvedBy: "user",
			},
		});

		const final = await iterator.next();
		expect(final.done).toBe(true);
		if (!final.done) {
			throw new Error("Expected final safety verdict");
		}
		expect(final.value.verdict).toMatchObject({
			outcome: "proceed",
		});
		expect(
			approvalService.getPendingApprovalRegistration("call-1"),
		).toBeUndefined();
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("does not orphan a rejection when approval registration wins the race", async () => {
		const unhandledRejections: unknown[] = [];
		const onUnhandledRejection = (reason: unknown) => {
			unhandledRejections.push(reason);
		};
		process.on("unhandledRejection", onUnhandledRejection);

		let rejectDecision!: (reason?: unknown) => void;
		const decisionPromise = new Promise<ActionApprovalDecision>(
			(_resolve, reject) => {
				rejectDecision = reject;
			},
		);
		const approvalService: ActionApprovalService & {
			waitForPendingApprovalRegistration: (
				requestId: string,
			) => Promise<{ remoteApprovalRequestId: string } | null>;
		} = {
			requiresUserInteraction: () => true,
			requestApproval: vi.fn(
				(_request: ActionApprovalRequest) => decisionPromise,
			),
			waitForPendingApprovalRegistration: vi.fn(async () => ({
				remoteApprovalRequestId: "remote-approval-after-race",
			})),
			cancelAll: vi.fn(),
		};
		const bashTool: AgentTool = {
			name: "bash",
			description: "Run a shell command",
			parameters: Type.Object({
				command: Type.String(),
			}),
			execute: async () => ({
				content: [{ type: "text", text: "ok" }],
			}),
		};

		try {
			const iterator = evaluateToolSafety({
				toolCall: {
					type: "toolCall",
					id: "call-race",
					name: "bash",
					arguments: { command: "git push origin main" },
				},
				tools: [bashTool],
				userMessage: {
					role: "user",
					content: "Push the branch",
					timestamp: Date.now(),
				} satisfies Message,
				cfg: {
					tools: [bashTool],
					session: { id: "session-1", startedAt: new Date() },
					user: { id: "user-1", orgId: "workspace-1" },
				} as AgentRunConfig,
				clock: { now: () => Date.now() },
				safetyMiddleware: new SafetyMiddleware({
					enableContextFirewall: false,
					enableLoopDetection: false,
					enableSequenceAnalysis: false,
				}),
				workflowState: new WorkflowStateTracker(),
				adaptiveThresholds: new AdaptiveThresholds(),
				approvalService,
				firewall: new ActionFirewall([
					{
						name: "require-approval",
						description: "Require approval",
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
				emitToolResult: () => [],
			});

			expect((await iterator.next()).done).toBe(false);
			expect((await iterator.next()).done).toBe(false);

			const approvalError = new Error("approval aborted");
			rejectDecision(approvalError);
			await expect(iterator.next()).rejects.toThrow("approval aborted");
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(unhandledRejections).toEqual([]);
			expect(telemetryMocks.recordMaestroApprovalHit).toHaveBeenCalledWith(
				expect.objectContaining({
					approval_request_id: "remote-approval-after-race",
				}),
			);
		} finally {
			process.off("unhandledRejection", onUnhandledRejection);
		}
	});

	it("marks guarded-file approval hits with structured audit context", async () => {
		const approvalService = new ActionApprovalService("prompt");
		const iterator = evaluateToolSafety(
			createGuardedReadSafetyContext({ approvalService }),
		);

		expect((await iterator.next()).done).toBe(false);

		const approvalRequired = await iterator.next();
		expect(approvalRequired.done).toBe(false);
		if (approvalRequired.done) {
			throw new Error("Expected approval-required event");
		}
		expect(approvalRequired.value).toMatchObject({
			type: "action_approval_required",
			request: {
				id: "call-guarded-read",
				toolName: "read",
				args: { path: "~/.ssh/config" },
			},
		});
		expect(telemetryMocks.recordMaestroApprovalHit).toHaveBeenCalledWith(
			expect.objectContaining({
				approval_request_id: "call-guarded-read",
				policy_id: "guardedFiles_block",
				risk_level: "guarded_file",
				decision_mode: "MAESTRO_DECISION_MODE_REQUIRE_APPROVAL",
				reason: expect.stringContaining("Guarded file access"),
				context: expect.objectContaining({
					tool_name: "read",
					args: { path: "~/.ssh/config" },
					guarded_file: expect.objectContaining({
						rule_id: "default-guarded-file",
						category: "SSH and GPG keys",
						path: "~/.ssh/config",
						action: "read",
					}),
				}),
				correlation: {
					session_id: "session-guarded",
					agent_run_step_id: "call-guarded-read",
				},
			}),
		);

		expect(approvalService.approve("call-guarded-read", "Confirmed")).toBe(
			true,
		);
		expect((await iterator.next()).done).toBe(false);
		const final = await iterator.next();
		expect(final.done).toBe(true);
		if (!final.done) {
			throw new Error("Expected final safety verdict");
		}
		expect(final.value.verdict).toMatchObject({
			outcome: "proceed",
		});
	});

	it("records guarded-file audit context when non-interactive approval blocks", async () => {
		const approvalService = new ActionApprovalService("auto");
		const requestApproval = vi.spyOn(approvalService, "requestApproval");
		const iterator = evaluateToolSafety(
			createGuardedReadSafetyContext({ approvalService }),
		);

		expect((await iterator.next()).done).toBe(false);
		const final = await iterator.next();

		expect(final.done).toBe(true);
		if (!final.done) {
			throw new Error("Expected final safety verdict");
		}
		expect(final.value.verdict).toMatchObject({
			outcome: "blocked",
		});
		expect(requestApproval).not.toHaveBeenCalled();
		expect(telemetryMocks.recordMaestroApprovalHit).toHaveBeenCalledWith(
			expect.objectContaining({
				approval_request_id: "call-guarded-read",
				policy_id: "guardedFiles_block",
				risk_level: "guarded_file",
				reason: expect.stringContaining(
					"Approval mode must be prompt for guarded file access",
				),
				context: expect.objectContaining({
					tool_name: "read",
					args: { path: "~/.ssh/config" },
					guarded_file: expect.objectContaining({
						rule_id: "default-guarded-file",
						category: "SSH and GPG keys",
						action: "read",
					}),
				}),
			}),
		);
	});
});
