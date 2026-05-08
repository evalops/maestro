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
	completeRun?: ReturnType<typeof vi.fn>;
	failRun?: ReturnType<typeof vi.fn>;
}) {
	const recordStep =
		overrides?.recordStep ?? vi.fn(async () => ({ run: { id: "run_1" } }));
	const waitRun =
		overrides?.waitRun ?? vi.fn(async () => ({ run: { id: "run_1" } }));
	const resumeRun =
		overrides?.resumeRun ?? vi.fn(async () => ({ run: { id: "run_1" } }));
	const completeRun =
		overrides?.completeRun ?? vi.fn(async () => ({ run: { id: "run_1" } }));
	const failRun =
		overrides?.failRun ?? vi.fn(async () => ({ run: { id: "run_1" } }));
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
		operations: { recordStep, waitRun, resumeRun, completeRun, failRun },
	});
	return { recorder, recordStep, waitRun, resumeRun, completeRun, failRun };
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
				startedAtMs: 1_000,
				timeoutMs: 60_000,
			},
		};
		const resolved: ServerRequestLifecycleEvent = {
			type: "resolved",
			request: registered.request,
			resolution: "approved",
			resolvedBy: "user",
			reason: "looks good",
			resolvedAtMs: 2_000,
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
					payload: expect.objectContaining({
						started_at_ms: 1_000,
					}),
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
					started_at_ms: 1_000,
					resolved_at_ms: 2_000,
				}),
			}),
		);
	});

	it("propagates approval lifecycle timing to hosted wait and resume payloads", async () => {
		const { recorder, waitRun, resumeRun } = createRecorder();
		const request = {
			id: "approval_timed",
			toolName: "shell",
			displayName: "Shell",
			summaryLabel: "git push",
			args: { command: "git push" },
			reason: "Confirm shell",
			startedAtMs: 1_000,
		};

		recorder.recordAgentEvent({
			type: "action_approval_required",
			request,
		} satisfies AgentEvent);
		recorder.recordAgentEvent({
			type: "action_approval_resolved",
			request,
			decision: {
				approved: true,
				resolvedBy: "user",
				reason: "ship it",
				resolvedAtMs: 2_250,
			},
		} satisfies AgentEvent);
		await recorder.flush();

		expect(waitRun).toHaveBeenCalledWith(
			expect.objectContaining({
				wait: expect.objectContaining({
					id: "maestro:session_1:wait:approval_timed",
					payload: expect.objectContaining({
						request_id: "approval_timed",
						request_type: "approval",
						started_at_ms: 1_000,
					}),
				}),
			}),
		);
		expect(resumeRun).toHaveBeenCalledWith(
			expect.objectContaining({
				waitId: "maestro:session_1:wait:approval_timed",
				payload: expect.objectContaining({
					request_id: "approval_timed",
					request_type: "approval",
					resolution: "approved",
					resolved_by: "user",
					started_at_ms: 1_000,
					resolved_at_ms: 2_250,
				}),
			}),
		);
	});

	it("no-ops when hosted Platform lease handles are absent", async () => {
		const { recorder, recordStep, waitRun, resumeRun, completeRun, failRun } =
			createRecorder({
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
		await recorder.completeRun({ reason: "process_shutdown" });
		await recorder.failRun({ errorMessage: "should stay local" });
		await recorder.flush();

		expect(recordStep).not.toHaveBeenCalled();
		expect(waitRun).not.toHaveBeenCalled();
		expect(resumeRun).not.toHaveBeenCalled();
		expect(completeRun).not.toHaveBeenCalled();
		expect(failRun).not.toHaveBeenCalled();
	});

	it("completes the Platform run after prior progress writes during hosted drain", async () => {
		const { recorder, recordStep, completeRun } = createRecorder();

		recorder.recordAgentEvent({ type: "turn_start" });
		await recorder.completeRun({
			reason: "process_shutdown",
			requestedBy: "maestro_web_server",
			flushStatus: "completed",
			manifestPath: "/workspace/.maestro/runner-snapshots/mrs.json",
		});
		await recorder.completeRun({ reason: "duplicate" });

		expect(recordStep).toHaveBeenCalledTimes(1);
		expect(completeRun).toHaveBeenCalledTimes(1);
		expect(completeRun).toHaveBeenCalledWith(
			expect.objectContaining({
				runId: "run_1",
				leaseToken: "lease-token-1",
				result: expect.objectContaining({
					event_type: "hosted_runner_drained",
					status: "drained",
					flush_status: "completed",
					reason: "process_shutdown",
					requested_by: "maestro_web_server",
					manifest_path: "/workspace/.maestro/runner-snapshots/mrs.json",
				}),
			}),
		);
	});

	it("fails the Platform run once when hosted drain is interrupted", async () => {
		const { recorder, recordStep, failRun } = createRecorder();

		await recorder.failRun({
			errorMessage: "Hosted runner drain failed: flush timed out",
			reason: "kubernetes_prestop",
			requestedBy: "kubernetes_prestop",
		});
		await recorder.failRun({ errorMessage: "duplicate failure" });

		expect(recordStep).toHaveBeenCalledWith(
			expect.objectContaining({
				step: expect.objectContaining({
					id: "maestro:session_1:terminal:failed",
					stepKind: PlatformAgentRunStepKindValue.Error,
					state: PlatformAgentRunStepStateValue.Failed,
					errorMessage: "Hosted runner drain failed: flush timed out",
					output: expect.objectContaining({
						event_type: "hosted_runner_drain_failed",
						reason: "kubernetes_prestop",
						requested_by: "kubernetes_prestop",
					}),
				}),
			}),
		);
		expect(failRun).toHaveBeenCalledTimes(1);
		expect(failRun).toHaveBeenCalledWith(
			expect.objectContaining({
				runId: "run_1",
				leaseToken: "lease-token-1",
				errorMessage: "Hosted runner drain failed: flush timed out",
				retryable: false,
			}),
		);
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
