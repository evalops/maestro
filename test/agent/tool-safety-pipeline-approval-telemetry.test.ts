import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	ActionApprovalDecision,
	ActionApprovalRequest,
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
});
