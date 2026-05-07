import { describe, expect, it, vi } from "vitest";

import type { AgentEvent } from "../../src/agent/types.js";
import {
	PlatformAgentRunStepKindValue,
	PlatformAgentRunStepStateValue,
	PlatformAgentRunWaitTypeValue,
} from "../../src/platform/agent-runtime-client.js";
import { HostedAgentRuntimeProgressRecorder } from "../../src/server/hosted-agent-runtime-progress.js";
import type { ServerRequestLifecycleEvent } from "../../src/server/server-request-manager.js";

function createRecorder(overrides?: {
	agentRunId?: string;
	agentRuntimeLeaseToken?: string;
	recordStep?: ReturnType<typeof vi.fn>;
	waitRun?: ReturnType<typeof vi.fn>;
	resumeRun?: ReturnType<typeof vi.fn>;
}) {
	const recordStep =
		overrides?.recordStep ?? vi.fn(async () => ({ run: { id: "run_1" } }));
	const waitRun =
		overrides?.waitRun ?? vi.fn(async () => ({ run: { id: "run_1" } }));
	const resumeRun =
		overrides?.resumeRun ?? vi.fn(async () => ({ run: { id: "run_1" } }));
	const recorder = new HostedAgentRuntimeProgressRecorder({
		sessionId: "session_1",
		workspaceRoot: "/workspace",
		hostedRunner: {
			enabled: true,
			agentRunId: overrides?.agentRunId ?? "run_1",
			agentRuntimeLeaseToken:
				overrides?.agentRuntimeLeaseToken ?? "lease-token-1",
			workspaceId: "ws_1",
			runnerSessionId: "mrs_1",
			ownerInstanceId: "pod-a",
			agentRuntimeWorkerQueue: "agent-runtime.production",
		},
		operations: { recordStep, waitRun, resumeRun },
	});
	return { recorder, recordStep, waitRun, resumeRun };
}

describe("hosted AgentRuntime progress recorder", () => {
	it("records turn and tool progress as leased AgentRuntime steps", async () => {
		const { recorder, recordStep } = createRecorder();

		recorder.recordAgentEvent({ type: "turn_start" });
		recorder.recordAgentEvent({
			type: "tool_execution_start",
			toolCallId: "call_1",
			toolName: "shell",
			displayName: "Shell",
			args: { command: "npm test", secret: "not copied" },
		});
		recorder.recordAgentEvent({
			type: "tool_execution_end",
			toolCallId: "call_1",
			toolName: "shell",
			displayName: "Shell",
			result: { type: "text", text: "ok" },
			isError: false,
		} as AgentEvent);
		recorder.recordAgentEvent({
			type: "turn_end",
			message: { role: "assistant", content: [] },
			toolResults: [],
		} as AgentEvent);

		await recorder.flush();

		expect(recordStep).toHaveBeenCalledTimes(4);
		expect(recordStep).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				runId: "run_1",
				leaseToken: "lease-token-1",
				step: expect.objectContaining({
					id: "maestro:session_1:turn:1",
					stepKind: PlatformAgentRunStepKindValue.ModelCall,
					state: PlatformAgentRunStepStateValue.Running,
				}),
			}),
		);
		expect(recordStep).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				step: expect.objectContaining({
					id: "maestro:session_1:tool:call_1",
					name: "Shell",
					stepKind: PlatformAgentRunStepKindValue.ToolCallIntent,
					state: PlatformAgentRunStepStateValue.Running,
					input: expect.objectContaining({
						arg_keys: ["command", "secret"],
						maestro_session_id: "session_1",
					}),
				}),
			}),
		);
		expect(recordStep).toHaveBeenNthCalledWith(
			3,
			expect.objectContaining({
				step: expect.objectContaining({
					id: "maestro:session_1:tool:call_1",
					stepKind: PlatformAgentRunStepKindValue.ToolResult,
					state: PlatformAgentRunStepStateValue.Succeeded,
				}),
			}),
		);
	});

	it("records pending server requests as waits and resumes them on resolution", async () => {
		const { recorder, waitRun, resumeRun } = createRecorder();
		const registered: ServerRequestLifecycleEvent = {
			type: "registered",
			request: {
				id: "approval_1",
				kind: "approval",
				sessionId: "session_1",
				callId: "call_1",
				toolName: "shell",
				args: { command: "git status" },
				reason: "Confirm shell",
				timestamp: Date.now(),
				timeoutMs: 60_000,
			},
		};
		const resolved: ServerRequestLifecycleEvent = {
			type: "resolved",
			request: registered.request,
			resolution: "approved",
			resolvedBy: "user",
			reason: "looks good",
		};

		recorder.recordServerRequestEvent(registered);
		recorder.recordServerRequestEvent(resolved);
		await recorder.flush();

		expect(waitRun).toHaveBeenCalledWith(
			expect.objectContaining({
				runId: "run_1",
				leaseToken: "lease-token-1",
				wait: expect.objectContaining({
					id: "maestro:session_1:wait:approval_1",
					stepId: "maestro:session_1:tool:call_1",
					type: PlatformAgentRunWaitTypeValue.Approval,
					externalRef: "approval_1",
				}),
				checkpoint: expect.objectContaining({
					id: "maestro:session_1:checkpoint:approval_1",
					resumeToken: "maestro:session_1:wait:approval_1",
				}),
			}),
		);
		expect(resumeRun).toHaveBeenCalledWith(
			expect.objectContaining({
				runId: "run_1",
				waitId: "maestro:session_1:wait:approval_1",
				resumeEventId: "maestro:session_1:resume:approval_1",
				payload: expect.objectContaining({
					resolution: "approved",
					resolved_by: "user",
				}),
			}),
		);
	});

	it("no-ops when hosted Platform lease handles are absent", async () => {
		const { recorder, recordStep, waitRun, resumeRun } = createRecorder({
			agentRuntimeLeaseToken: "",
		});

		recorder.recordAgentEvent({ type: "turn_start" });
		recorder.recordServerRequestEvent({
			type: "registered",
			request: {
				id: "request_1",
				kind: "user_input",
				sessionId: "session_1",
				callId: "request_1",
				toolName: "ask_user",
				args: {},
				reason: "Need input",
				timestamp: Date.now(),
				timeoutMs: 60_000,
			},
		});
		recorder.recordServerRequestEvent({
			type: "resolved",
			request: {
				id: "request_1",
				kind: "user_input",
				sessionId: "session_1",
				callId: "request_1",
				toolName: "ask_user",
				args: {},
				reason: "Need input",
				timestamp: Date.now(),
				timeoutMs: 60_000,
			},
			resolution: "answered",
			resolvedBy: "client",
		});
		await recorder.flush();

		expect(recordStep).not.toHaveBeenCalled();
		expect(waitRun).not.toHaveBeenCalled();
		expect(resumeRun).not.toHaveBeenCalled();
	});

	it("keeps later progress flowing after a Platform write failure", async () => {
		const recordStep = vi
			.fn()
			.mockRejectedValueOnce(new Error("Platform unavailable"))
			.mockResolvedValue({ run: { id: "run_1" } });
		const { recorder } = createRecorder({ recordStep });

		recorder.recordAgentEvent({ type: "turn_start" });
		recorder.recordAgentEvent({ type: "agent_start" });
		await recorder.flush();

		expect(recordStep).toHaveBeenCalledTimes(2);
		expect(recordStep).toHaveBeenLastCalledWith(
			expect.objectContaining({
				step: expect.objectContaining({
					id: "maestro:session_1:agent:start-2",
				}),
			}),
		);
	});
});
