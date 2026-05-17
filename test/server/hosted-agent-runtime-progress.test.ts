import { describe, expect, it, vi } from "vitest";

import type { AgentEvent } from "../../src/agent/types.js";
import {
	type PlatformAgentRegistryDelegateInput,
	type PlatformAgentRegistryResolveDelegationInput,
	PlatformDelegationStatusValue,
} from "../../src/platform/agent-registry-client.js";
import {
	PlatformAgentRunStepKindValue,
	PlatformAgentRunStepStateValue,
	PlatformAgentRunWaitTypeValue,
	PlatformAgentWorkItemKindValue,
	PlatformAgentWorkItemStateValue,
} from "../../src/platform/agent-runtime-client.js";
import { HostedAgentRuntimeProgressRecorder } from "../../src/server/hosted-agent-runtime-progress.js";
import type { ServerRequestLifecycleEvent } from "../../src/server/server-request-manager.js";

function createRecorder(overrides?: {
	agentRunId?: string;
	agentRuntimeLeaseToken?: string;
	agentId?: string;
	recordStep?: ReturnType<typeof vi.fn>;
	recordWorkItem?: ReturnType<typeof vi.fn>;
	updateWorkItem?: ReturnType<typeof vi.fn>;
	waitRun?: ReturnType<typeof vi.fn>;
	resumeRun?: ReturnType<typeof vi.fn>;
	completeRun?: ReturnType<typeof vi.fn>;
	failRun?: ReturnType<typeof vi.fn>;
	delegateAgent?: ReturnType<typeof vi.fn>;
	resolveDelegation?: ReturnType<typeof vi.fn>;
}) {
	const recordStep =
		overrides?.recordStep ?? vi.fn(async () => ({ run: { id: "run_1" } }));
	const recordWorkItem =
		overrides?.recordWorkItem ?? vi.fn(async () => ({ run: { id: "run_1" } }));
	const updateWorkItem =
		overrides?.updateWorkItem ?? vi.fn(async () => ({ run: { id: "run_1" } }));
	const waitRun =
		overrides?.waitRun ?? vi.fn(async () => ({ run: { id: "run_1" } }));
	const resumeRun =
		overrides?.resumeRun ?? vi.fn(async () => ({ run: { id: "run_1" } }));
	const completeRun =
		overrides?.completeRun ?? vi.fn(async () => ({ run: { id: "run_1" } }));
	const failRun =
		overrides?.failRun ?? vi.fn(async () => ({ run: { id: "run_1" } }));
	const delegateAgent = overrides?.delegateAgent ?? vi.fn(async () => null);
	const resolveDelegation =
		overrides?.resolveDelegation ?? vi.fn(async () => null);
	const recorder = new HostedAgentRuntimeProgressRecorder({
		sessionId: "session_1",
		workspaceRoot: "/workspace",
		hostedRunner: {
			enabled: true,
			agentRunId: overrides?.agentRunId ?? "run_1",
			agentRuntimeLeaseToken:
				overrides?.agentRuntimeLeaseToken ?? "lease-token-1",
			workspaceId: "ws_1",
			agentId: overrides?.agentId ?? "agent_parent",
			runnerSessionId: "mrs_1",
			ownerInstanceId: "pod-a",
			agentRuntimeWorkerQueue: "agent-runtime.production",
		},
		operations: {
			recordStep,
			recordWorkItem,
			updateWorkItem,
			waitRun,
			resumeRun,
			completeRun,
			failRun,
			delegateAgent,
			resolveDelegation,
		},
	});
	return {
		recorder,
		recordStep,
		recordWorkItem,
		updateWorkItem,
		waitRun,
		resumeRun,
		completeRun,
		failRun,
		delegateAgent,
		resolveDelegation,
	};
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

	it("records Codex subagent collaboration as durable Platform work items", async () => {
		const { recorder, recordWorkItem, updateWorkItem, recordStep } =
			createRecorder();

		recorder.recordAgentEvent({
			type: "tool_execution_start",
			toolCallId: "collab-call-1",
			toolName: "codex.subagent.spawnAgent",
			displayName: "Codex subagent: spawn agent",
			summaryLabel: "spawn agent 1 agent",
			args: {
				codexTool: "spawnAgent",
				senderThreadId: "parent-thread",
				receiverThreadIds: ["child-thread-1"],
				codexWorkGraph: {
					schemaVersion: "evalops.maestro.codex.subagent-workgraph.v1",
					toolCallId: "collab-call-1",
					tool: "spawnAgent",
					status: "inProgress",
					parent: {
						threadId: "parent-thread",
						turnId: "turn-1",
						senderThreadId: "parent-thread",
					},
					childRuns: [
						{
							threadId: "child-thread-1",
							childRunId: "codex-thread:child-thread-1",
							operation: "spawnAgent",
						},
					],
				},
				prompt: "Inspect platform remote runner wiring",
				model: "gpt-5.3-codex",
				reasoningEffort: "high",
			},
		});
		recorder.recordAgentEvent({
			type: "tool_execution_end",
			toolCallId: "collab-call-1",
			toolName: "codex.subagent.spawnAgent",
			displayName: "Codex subagent: spawn agent",
			summaryLabel: "spawn agent 1 agent",
			result: {
				role: "toolResult",
				toolCallId: "collab-call-1",
				toolName: "codex.subagent.spawnAgent",
				content: [{ type: "text", text: "Codex subagent completed." }],
				details: {
					codexTool: "spawnAgent",
				},
				isError: false,
				timestamp: 2,
			},
			isError: false,
		} satisfies AgentEvent);

		await recorder.flush();

		expect(recordStep).toHaveBeenCalledTimes(2);
		expect(recordWorkItem).toHaveBeenCalledWith({
			runId: "run_1",
			workItem: expect.objectContaining({
				id: "maestro:session_1:work:collab-call-1",
				runId: "run_1",
				ownerChildRunId: "codex-thread:child-thread-1",
				kind: PlatformAgentWorkItemKindValue.ChildRun,
				state: PlatformAgentWorkItemStateValue.Running,
				title: "Codex subagent: spawn agent",
				goal: "Inspect platform remote runner wiring",
				nextAction: "wait for child agent initialization or completion",
				evidenceRefs: [
					"codex-tool-call:collab-call-1",
					"codex-thread:child-thread-1",
					"codex-child-run:codex-thread:child-thread-1",
				],
				completionGate: "codex_collab_tool_completed",
				payload: expect.objectContaining({
					event_type: "tool_execution_start",
					codex_tool: "spawnAgent",
					sender_thread_id: "parent-thread",
					receiver_thread_ids: ["child-thread-1"],
					receiver_thread_count: 1,
					child_run_ids: ["codex-thread:child-thread-1"],
					codex_work_graph: expect.objectContaining({
						schemaVersion: "evalops.maestro.codex.subagent-workgraph.v1",
						toolCallId: "collab-call-1",
						childRuns: [
							expect.objectContaining({
								threadId: "child-thread-1",
								childRunId: "codex-thread:child-thread-1",
							}),
						],
					}),
					linked_work_item_ids: [],
					model: "gpt-5.3-codex",
					reasoning_effort: "high",
					maestro_session_id: "session_1",
					runner_session_id: "mrs_1",
				}),
			}),
		});
		expect(updateWorkItem).toHaveBeenCalledWith({
			runId: "run_1",
			workItemId: "maestro:session_1:work:collab-call-1",
			state: PlatformAgentWorkItemStateValue.Succeeded,
			evidenceRefs: [
				"codex-tool-call:collab-call-1",
				"codex-thread:child-thread-1",
				"codex-child-run:codex-thread:child-thread-1",
			],
			completionGate: "codex_collab_tool_completed",
			payload: expect.objectContaining({
				event_type: "tool_execution_end",
				codex_tool: "spawnAgent",
				result_error: false,
				receiver_thread_ids: ["child-thread-1"],
				child_run_ids: ["codex-thread:child-thread-1"],
				codex_work_graph: expect.objectContaining({
					toolCallId: "collab-call-1",
					childRuns: [
						expect.objectContaining({
							childRunId: "codex-thread:child-thread-1",
						}),
					],
				}),
				linked_work_item_ids: ["maestro:session_1:work:collab-call-1"],
			}),
		});
	});

	it("records Codex spawn handoffs as Platform agent-registry delegations", async () => {
		const delegateAgent = vi.fn(
			async (_input: PlatformAgentRegistryDelegateInput) => ({
				delegation: {
					id: "delegation_1",
					status: PlatformDelegationStatusValue.Pending,
				},
			}),
		);
		const resolveDelegation = vi.fn(
			async (_input: PlatformAgentRegistryResolveDelegationInput) => ({
				delegation: {
					id: "delegation_1",
					status: PlatformDelegationStatusValue.Completed,
				},
			}),
		);
		const { recorder, updateWorkItem } = createRecorder({
			agentId: "maestro-codex-parent",
			delegateAgent,
			resolveDelegation,
		});

		recorder.recordAgentEvent({
			type: "tool_execution_start",
			toolCallId: "spawn-delegation-call",
			toolName: "codex.subagent.spawnAgent",
			displayName: "Codex subagent: spawn agent",
			args: {
				codexTool: "spawnAgent",
				senderThreadId: "parent-thread",
				receiverThreadIds: ["child-thread-1"],
				childRunIds: ["agent-run-child-1"],
				codexWorkGraph: {
					schemaVersion: "evalops.maestro.codex.subagent-workgraph.v1",
					toolCallId: "spawn-delegation-call",
					tool: "spawnAgent",
					status: "inProgress",
					parent: {
						threadId: "parent-thread",
						turnId: "turn-1",
						senderThreadId: "parent-thread",
					},
					childRuns: [
						{
							threadId: "child-thread-1",
							childRunId: "agent-run-child-1",
							operation: "spawnAgent",
						},
					],
				},
				prompt: "Audit remote runner drain behavior",
				requiredCapability: "code:review",
			},
		});
		recorder.recordAgentEvent({
			type: "tool_execution_end",
			toolCallId: "spawn-delegation-call",
			toolName: "codex.subagent.spawnAgent",
			displayName: "Codex subagent: spawn agent",
			result: {
				role: "toolResult",
				toolCallId: "spawn-delegation-call",
				toolName: "codex.subagent.spawnAgent",
				content: [{ type: "text", text: "spawn completed" }],
				details: {
					codexTool: "spawnAgent",
					receiverThreadIds: ["child-thread-1"],
					childRunIds: ["agent-run-child-1"],
					codexWorkGraph: {
						schemaVersion: "evalops.maestro.codex.subagent-workgraph.v1",
						toolCallId: "spawn-delegation-call",
						tool: "spawnAgent",
						status: "completed",
						parent: {
							threadId: "parent-thread",
							turnId: "turn-1",
							senderThreadId: "parent-thread",
						},
						childRuns: [
							{
								threadId: "child-thread-1",
								childRunId: "agent-run-child-1",
								operation: "spawnAgent",
							},
						],
					},
				},
				isError: false,
				timestamp: 3,
			},
			isError: false,
		} satisfies AgentEvent);

		await recorder.flush();

		expect(delegateAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				fromAgentId: "maestro-codex-parent",
				requiredCapability: "code:review",
				reason:
					"Codex subagent spawn requested by Maestro: Audit remote runner drain behavior",
				contextPayload: expect.objectContaining({
					event_type: "codex_subagent_delegation_requested",
					agent_id: "maestro-codex-parent",
					agent_run_id: "run_1",
					work_item_id: "maestro:session_1:work:spawn-delegation-call",
					owner_child_run_id: "agent-run-child-1",
					receiver_thread_ids: ["child-thread-1"],
					child_run_ids: ["agent-run-child-1"],
					codex_work_graph: expect.objectContaining({
						toolCallId: "spawn-delegation-call",
						childRuns: [
							expect.objectContaining({
								childRunId: "agent-run-child-1",
							}),
						],
					}),
					required_capability: "code:review",
				}),
			}),
		);
		expect(updateWorkItem).toHaveBeenCalledWith(
			expect.objectContaining({
				workItemId: "maestro:session_1:work:spawn-delegation-call",
				evidenceRefs: expect.arrayContaining([
					"agent-registry-delegation:delegation_1",
				]),
				payload: expect.objectContaining({
					delegation_id: "delegation_1",
					delegation_resolution: "deferred_until_child_terminal_edge",
				}),
			}),
		);
		expect(resolveDelegation).not.toHaveBeenCalled();

		recorder.recordAgentEvent({
			type: "tool_execution_start",
			toolCallId: "wait-delegation-call",
			toolName: "codex.subagent.wait",
			displayName: "Codex subagent: wait",
			args: {
				codexTool: "wait",
				receiverThreadIds: ["child-thread-1"],
				childRunIds: ["agent-run-child-1"],
			},
		});
		recorder.recordAgentEvent({
			type: "tool_execution_end",
			toolCallId: "wait-delegation-call",
			toolName: "codex.subagent.wait",
			displayName: "Codex subagent: wait",
			result: {
				role: "toolResult",
				toolCallId: "wait-delegation-call",
				toolName: "codex.subagent.wait",
				content: [{ type: "text", text: "wait completed" }],
				details: {
					codexTool: "wait",
					receiverThreadIds: ["child-thread-1"],
					childRunIds: ["agent-run-child-1"],
					agentsStates: {
						"child-thread-1": {
							status: "completed",
						},
					},
				},
				isError: false,
				timestamp: 4,
			},
			isError: false,
		} satisfies AgentEvent);

		await recorder.flush();

		expect(updateWorkItem).toHaveBeenCalledWith(
			expect.objectContaining({
				workItemId: "maestro:session_1:work:wait-delegation-call",
				payload: expect.objectContaining({
					delegation_id: "delegation_1",
					delegation_resolution: "resolved_from_child_terminal_edge",
				}),
			}),
		);
		expect(resolveDelegation).toHaveBeenCalledWith({
			delegationId: "delegation_1",
			status: PlatformDelegationStatusValue.Completed,
			resultPayload: expect.objectContaining({
				event_type: "codex_subagent_delegation_resolved",
				codex_tool: "wait",
				codex_subagent_operation: "wait_agent",
				codex_subagent_edge_status: "completed",
				agent_id: "maestro-codex-parent",
				agent_run_id: "run_1",
				work_item_id: "maestro:session_1:work:wait-delegation-call",
				resolution_tool_call_id: "wait-delegation-call",
				child_run_ids: ["agent-run-child-1"],
			}),
			errorMessage: undefined,
		});
	});

	it("resolves every Codex delegation targeted by a multi-child wait", async () => {
		let delegationIndex = 0;
		const delegateAgent = vi.fn(
			async (_input: PlatformAgentRegistryDelegateInput) => {
				delegationIndex += 1;
				return {
					delegation: {
						id: `delegation_${delegationIndex}`,
						status: PlatformDelegationStatusValue.Pending,
					},
				};
			},
		);
		const resolveDelegation = vi.fn(
			async (_input: PlatformAgentRegistryResolveDelegationInput) => ({
				delegation: {
					id: _input.delegationId,
					status: PlatformDelegationStatusValue.Completed,
				},
			}),
		);
		const { recorder, updateWorkItem } = createRecorder({
			delegateAgent,
			resolveDelegation,
		});

		for (const child of [
			{
				callId: "spawn-child-1",
				threadId: "child-thread-1",
				runId: "child-run-1",
			},
			{
				callId: "spawn-child-2",
				threadId: "child-thread-2",
				runId: "child-run-2",
			},
		]) {
			recorder.recordAgentEvent({
				type: "tool_execution_start",
				toolCallId: child.callId,
				toolName: "codex.subagent.spawnAgent",
				displayName: "Codex subagent: spawn agent",
				args: {
					codexTool: "spawnAgent",
					receiverThreadIds: [child.threadId],
					childRunIds: [child.runId],
					prompt: `Spawn ${child.runId}`,
				},
			});
		}
		await recorder.flush();

		recorder.recordAgentEvent({
			type: "tool_execution_start",
			toolCallId: "wait-all-children",
			toolName: "codex.subagent.wait",
			displayName: "Codex subagent: wait",
			args: {
				codexTool: "wait",
				receiverThreadIds: ["child-thread-1", "child-thread-2"],
				childRunIds: ["child-run-1", "child-run-2"],
			},
		});
		recorder.recordAgentEvent({
			type: "tool_execution_end",
			toolCallId: "wait-all-children",
			toolName: "codex.subagent.wait",
			displayName: "Codex subagent: wait",
			result: {
				role: "toolResult",
				toolCallId: "wait-all-children",
				toolName: "codex.subagent.wait",
				content: [{ type: "text", text: "both children completed" }],
				details: {
					codexTool: "wait",
					receiverThreadIds: ["child-thread-1", "child-thread-2"],
					childRunIds: ["child-run-1", "child-run-2"],
				},
				isError: false,
				timestamp: 5,
			},
			isError: false,
		} satisfies AgentEvent);

		await recorder.flush();

		expect(updateWorkItem).toHaveBeenCalledWith(
			expect.objectContaining({
				workItemId: "maestro:session_1:work:wait-all-children",
				evidenceRefs: expect.arrayContaining([
					"agent-registry-delegation:delegation_1",
					"agent-registry-delegation:delegation_2",
				]),
				payload: expect.objectContaining({
					delegation_id: "delegation_1",
					delegation_ids: ["delegation_1", "delegation_2"],
					delegation_resolution: "resolved_from_child_terminal_edge",
				}),
			}),
		);
		expect(resolveDelegation).toHaveBeenCalledTimes(2);
		expect(resolveDelegation).toHaveBeenCalledWith(
			expect.objectContaining({
				delegationId: "delegation_1",
				status: PlatformDelegationStatusValue.Completed,
				resultPayload: expect.objectContaining({
					delegation_ids: ["delegation_1", "delegation_2"],
					child_run_ids: ["child-run-1", "child-run-2"],
				}),
			}),
		);
		expect(resolveDelegation).toHaveBeenCalledWith(
			expect.objectContaining({
				delegationId: "delegation_2",
				status: PlatformDelegationStatusValue.Completed,
				resultPayload: expect.objectContaining({
					delegation_ids: ["delegation_1", "delegation_2"],
					child_run_ids: ["child-run-1", "child-run-2"],
				}),
			}),
		);
	});

	it("uses terminal-edge-specific failure messages when resolving Codex delegations", async () => {
		const delegateAgent = vi.fn(
			async (_input: PlatformAgentRegistryDelegateInput) => ({
				delegation: {
					id: "delegation_1",
					status: PlatformDelegationStatusValue.Pending,
				},
			}),
		);
		const resolveDelegation = vi.fn(
			async (_input: PlatformAgentRegistryResolveDelegationInput) => ({
				delegation: {
					id: "delegation_1",
					status: PlatformDelegationStatusValue.Failed,
				},
			}),
		);
		const { recorder } = createRecorder({
			delegateAgent,
			resolveDelegation,
		});

		recorder.recordAgentEvent({
			type: "tool_execution_start",
			toolCallId: "spawn-before-wait-failure",
			toolName: "codex.subagent.spawnAgent",
			displayName: "Codex subagent: spawn agent",
			args: {
				codexTool: "spawnAgent",
				receiverThreadIds: ["child-thread-1"],
				childRunIds: ["child-run-1"],
				prompt: "Spawn then fail wait",
			},
		});
		await recorder.flush();

		recorder.recordAgentEvent({
			type: "tool_execution_end",
			toolCallId: "wait-failed",
			toolName: "codex.subagent.wait",
			displayName: "Codex subagent: wait",
			result: {
				role: "toolResult",
				toolCallId: "wait-failed",
				toolName: "codex.subagent.wait",
				content: [{ type: "text", text: "wait failed" }],
				details: {
					codexTool: "wait",
					receiverThreadIds: ["child-thread-1"],
					childRunIds: ["child-run-1"],
				},
				isError: true,
				timestamp: 6,
			},
			isError: true,
		} satisfies AgentEvent);

		await recorder.flush();

		expect(resolveDelegation).toHaveBeenCalledWith(
			expect.objectContaining({
				delegationId: "delegation_1",
				status: PlatformDelegationStatusValue.Failed,
				errorMessage: "Codex subagent wait failed",
			}),
		);
	});

	it("clears Codex delegation ids when delegation resolution fails", async () => {
		const delegateAgent = vi.fn(
			async (_input: PlatformAgentRegistryDelegateInput) => ({
				delegation: {
					id: "delegation_1",
					status: PlatformDelegationStatusValue.Pending,
				},
			}),
		);
		const resolveDelegation = vi.fn(
			async (_input: PlatformAgentRegistryResolveDelegationInput) => {
				throw new Error("platform unavailable");
			},
		);
		const { recorder } = createRecorder({
			delegateAgent,
			resolveDelegation,
		});
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		const delegationIds = (
			recorder as unknown as {
				codexSubagentDelegationIds: Map<string, string>;
			}
		).codexSubagentDelegationIds;

		try {
			recorder.recordAgentEvent({
				type: "tool_execution_start",
				toolCallId: "spawn-delegation-call",
				toolName: "codex.subagent.spawnAgent",
				displayName: "Codex subagent: spawn agent",
				args: {
					codexTool: "spawnAgent",
					receiverThreadIds: ["child-thread-1"],
					childRunIds: ["agent-run-child-1"],
					prompt: "Audit remote runner drain behavior",
				},
			});
			await recorder.flush();

			expect(delegationIds.get("spawn-delegation-call")).toBe("delegation_1");

			recorder.recordAgentEvent({
				type: "tool_execution_end",
				toolCallId: "spawn-delegation-call",
				toolName: "codex.subagent.spawnAgent",
				displayName: "Codex subagent: spawn agent",
				result: {
					role: "toolResult",
					toolCallId: "spawn-delegation-call",
					toolName: "codex.subagent.spawnAgent",
					content: [{ type: "text", text: "spawn completed" }],
					details: {
						codexTool: "spawnAgent",
						receiverThreadIds: ["child-thread-1"],
						childRunIds: ["agent-run-child-1"],
					},
					isError: false,
					timestamp: 3,
				},
				isError: false,
			} satisfies AgentEvent);
			await recorder.flush();

			expect(resolveDelegation).not.toHaveBeenCalled();
			expect(delegationIds.get("spawn-delegation-call")).toBe("delegation_1");

			recorder.recordAgentEvent({
				type: "tool_execution_start",
				toolCallId: "wait-delegation-call",
				toolName: "codex.subagent.wait",
				displayName: "Codex subagent: wait",
				args: {
					codexTool: "wait",
					receiverThreadIds: ["child-thread-1"],
					childRunIds: ["agent-run-child-1"],
				},
			});
			recorder.recordAgentEvent({
				type: "tool_execution_end",
				toolCallId: "wait-delegation-call",
				toolName: "codex.subagent.wait",
				displayName: "Codex subagent: wait",
				result: {
					role: "toolResult",
					toolCallId: "wait-delegation-call",
					toolName: "codex.subagent.wait",
					content: [{ type: "text", text: "wait completed" }],
					details: {
						codexTool: "wait",
						receiverThreadIds: ["child-thread-1"],
						childRunIds: ["agent-run-child-1"],
					},
					isError: false,
					timestamp: 4,
				},
				isError: false,
			} satisfies AgentEvent);
			await recorder.flush();

			expect(resolveDelegation).toHaveBeenCalledTimes(1);
			expect(delegationIds.has("spawn-delegation-call")).toBe(false);
			expect(
				consoleError.mock.calls.some((call) =>
					call
						.join(" ")
						.includes("Failed to resolve Codex subagent delegation"),
				),
			).toBe(true);
		} finally {
			consoleError.mockRestore();
		}
	});

	it("preserves work item update errors when delegation resolution also fails", async () => {
		const updateWorkItem = vi.fn(async () => {
			throw new Error("update unavailable");
		});
		const delegateAgent = vi.fn(
			async (_input: PlatformAgentRegistryDelegateInput) => ({
				delegation: {
					id: "delegation_1",
					status: PlatformDelegationStatusValue.Pending,
				},
			}),
		);
		const resolveDelegation = vi.fn(
			async (_input: PlatformAgentRegistryResolveDelegationInput) => {
				throw new Error("resolve unavailable");
			},
		);
		const { recorder } = createRecorder({
			updateWorkItem,
			delegateAgent,
			resolveDelegation,
		});
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		const delegationIds = (
			recorder as unknown as {
				codexSubagentDelegationIds: Map<string, string>;
			}
		).codexSubagentDelegationIds;

		try {
			recorder.recordAgentEvent({
				type: "tool_execution_start",
				toolCallId: "spawn-delegation-call",
				toolName: "codex.subagent.spawnAgent",
				displayName: "Codex subagent: spawn agent",
				args: {
					codexTool: "spawnAgent",
					receiverThreadIds: ["child-thread-1"],
					childRunIds: ["agent-run-child-1"],
					prompt: "Audit remote runner drain behavior",
				},
			});
			await recorder.flush();

			recorder.recordAgentEvent({
				type: "tool_execution_end",
				toolCallId: "spawn-delegation-call",
				toolName: "codex.subagent.spawnAgent",
				displayName: "Codex subagent: spawn agent",
				result: {
					role: "toolResult",
					toolCallId: "spawn-delegation-call",
					toolName: "codex.subagent.spawnAgent",
					content: [{ type: "text", text: "spawn completed" }],
					details: {
						codexTool: "spawnAgent",
						receiverThreadIds: ["child-thread-1"],
						childRunIds: ["agent-run-child-1"],
					},
					isError: false,
					timestamp: 3,
				},
				isError: false,
			} satisfies AgentEvent);
			await recorder.flush();

			recorder.recordAgentEvent({
				type: "tool_execution_start",
				toolCallId: "wait-delegation-call",
				toolName: "codex.subagent.wait",
				displayName: "Codex subagent: wait",
				args: {
					codexTool: "wait",
					receiverThreadIds: ["child-thread-1"],
					childRunIds: ["agent-run-child-1"],
				},
			});
			recorder.recordAgentEvent({
				type: "tool_execution_end",
				toolCallId: "wait-delegation-call",
				toolName: "codex.subagent.wait",
				displayName: "Codex subagent: wait",
				result: {
					role: "toolResult",
					toolCallId: "wait-delegation-call",
					toolName: "codex.subagent.wait",
					content: [{ type: "text", text: "wait completed" }],
					details: {
						codexTool: "wait",
						receiverThreadIds: ["child-thread-1"],
						childRunIds: ["agent-run-child-1"],
					},
					isError: false,
					timestamp: 4,
				},
				isError: false,
			} satisfies AgentEvent);
			await recorder.flush();

			const logged = consoleError.mock.calls.map((call) => call.join(" "));
			expect(logged.some((line) => line.includes("resolve unavailable"))).toBe(
				true,
			);
			expect(
				logged.some(
					(line) =>
						line.includes("Failed to record hosted AgentRuntime progress") &&
						line.includes("update unavailable"),
				),
			).toBe(true);
			expect(delegationIds.has("spawn-delegation-call")).toBe(false);
		} finally {
			consoleError.mockRestore();
		}
	});

	it("derives Codex child work items from work graph evidence when legacy arrays are absent", async () => {
		const { recorder, recordWorkItem } = createRecorder();

		recorder.recordAgentEvent({
			type: "tool_execution_start",
			toolCallId: "graph-only-spawn",
			toolName: "codex.subagent.spawnAgent",
			displayName: "Codex subagent: spawn agent",
			args: {
				codexTool: "spawnAgent",
				codexWorkGraph: {
					schemaVersion: "evalops.maestro.codex.subagent-workgraph.v1",
					toolCallId: "graph-only-spawn",
					tool: "spawnAgent",
					status: "inProgress",
					parent: {
						threadId: "parent-thread",
						turnId: "turn-graph",
						senderThreadId: "parent-thread",
					},
					childRuns: [
						{
							threadId: "graph-child-thread",
							childRunId: "agent-run-child-graph",
							operation: "spawnAgent",
						},
					],
				},
				prompt: "Replay child graph evidence",
			},
		});

		await recorder.flush();

		expect(recordWorkItem).toHaveBeenCalledWith({
			runId: "run_1",
			workItem: expect.objectContaining({
				id: "maestro:session_1:work:graph-only-spawn",
				ownerChildRunId: "agent-run-child-graph",
				evidenceRefs: [
					"codex-tool-call:graph-only-spawn",
					"codex-thread:graph-child-thread",
					"codex-child-run:agent-run-child-graph",
				],
				payload: expect.objectContaining({
					receiver_thread_ids: ["graph-child-thread"],
					child_run_ids: ["agent-run-child-graph"],
					codex_work_graph: expect.objectContaining({
						toolCallId: "graph-only-spawn",
					}),
				}),
			}),
		});
	});

	it("links follow-up Codex subagent tools to the spawned child work item", async () => {
		const { recorder, recordWorkItem, updateWorkItem } = createRecorder();

		recorder.recordAgentEvent({
			type: "tool_execution_start",
			toolCallId: "spawn-call",
			toolName: "codex.subagent.spawnAgent",
			displayName: "Codex subagent: spawn agent",
			args: {
				codexTool: "spawnAgent",
				receiverThreadIds: ["child-thread-1"],
				childRunIds: ["agent-run-child-1"],
				prompt: "Review the remote-runner deployment",
			},
		});
		recorder.recordAgentEvent({
			type: "tool_execution_start",
			toolCallId: "send-call",
			toolName: "codex.subagent.sendInput",
			displayName: "Codex subagent: send input",
			args: {
				codexTool: "sendInput",
				receiverThreadIds: ["child-thread-1"],
				childRunIds: ["agent-run-child-1"],
				prompt: "Focus on drain/restore risks",
			},
		});
		recorder.recordAgentEvent({
			type: "tool_execution_start",
			toolCallId: "wait-call",
			toolName: "codex.subagent.wait",
			displayName: "Codex subagent: wait",
			args: {
				codexTool: "wait",
				receiverThreadIds: ["child-thread-1"],
				childRunIds: ["agent-run-child-1"],
			},
		});
		recorder.recordAgentEvent({
			type: "tool_execution_end",
			toolCallId: "wait-call",
			toolName: "codex.subagent.wait",
			displayName: "Codex subagent: wait",
			result: {
				role: "toolResult",
				toolCallId: "wait-call",
				toolName: "codex.subagent.wait",
				content: [{ type: "text", text: "wait completed" }],
				details: {
					codexTool: "wait",
					receiverThreadIds: ["child-thread-1"],
					childRunIds: ["agent-run-child-1"],
				},
				isError: false,
				timestamp: 3,
			},
			isError: false,
		} satisfies AgentEvent);

		await recorder.flush();

		expect(recordWorkItem).toHaveBeenNthCalledWith(1, {
			runId: "run_1",
			workItem: expect.objectContaining({
				id: "maestro:session_1:work:spawn-call",
				ownerChildRunId: "agent-run-child-1",
				payload: expect.objectContaining({
					child_run_ids: ["agent-run-child-1"],
					linked_work_item_ids: [],
				}),
			}),
		});
		expect(recordWorkItem).toHaveBeenNthCalledWith(2, {
			runId: "run_1",
			workItem: expect.objectContaining({
				id: "maestro:session_1:work:send-call",
				parentWorkItemId: "maestro:session_1:work:spawn-call",
				ownerChildRunId: "agent-run-child-1",
				nextAction: "wait for child agent response",
				payload: expect.objectContaining({
					child_run_ids: ["agent-run-child-1"],
					linked_work_item_ids: ["maestro:session_1:work:spawn-call"],
				}),
			}),
		});
		expect(recordWorkItem).toHaveBeenNthCalledWith(3, {
			runId: "run_1",
			workItem: expect.objectContaining({
				id: "maestro:session_1:work:wait-call",
				parentWorkItemId: "maestro:session_1:work:spawn-call",
				ownerChildRunId: "agent-run-child-1",
				kind: PlatformAgentWorkItemKindValue.Wait,
				state: PlatformAgentWorkItemStateValue.Waiting,
				nextAction: "wait for selected child agents",
				payload: expect.objectContaining({
					child_run_ids: ["agent-run-child-1"],
					linked_work_item_ids: ["maestro:session_1:work:spawn-call"],
				}),
			}),
		});
		expect(updateWorkItem).toHaveBeenCalledWith(
			expect.objectContaining({
				runId: "run_1",
				workItemId: "maestro:session_1:work:wait-call",
				state: PlatformAgentWorkItemStateValue.Succeeded,
				evidenceRefs: expect.arrayContaining([
					"codex-child-run:agent-run-child-1",
				]),
				payload: expect.objectContaining({
					child_run_ids: ["agent-run-child-1"],
					linked_work_item_ids: ["maestro:session_1:work:spawn-call"],
				}),
			}),
		);
	});

	it("normalizes Codex subagent operation aliases before recording hosted work items", async () => {
		const { recorder, recordWorkItem, updateWorkItem } = createRecorder();

		recorder.recordAgentEvent({
			type: "tool_execution_start",
			toolCallId: "spawn-snake",
			toolName: "codex.subagent.spawn_agent",
			displayName: "Codex subagent: spawn agent",
			args: {
				codexTool: "spawn_agent",
				receiverThreadIds: ["child-thread-1"],
				childRunIds: ["agent-run-child-1"],
				prompt: "Review the remote runner",
			},
		});
		recorder.recordAgentEvent({
			type: "tool_execution_start",
			toolCallId: "wait-snake",
			toolName: "codex.subagent.wait_agent",
			displayName: "Codex subagent: wait",
			args: {
				codexTool: "wait_agent",
				receiverThreadIds: ["child-thread-1"],
				childRunIds: ["agent-run-child-1"],
			},
		});
		recorder.recordAgentEvent({
			type: "tool_execution_start",
			toolCallId: "close-snake",
			toolName: "codex.subagent.close_agent",
			displayName: "Codex subagent: close agent",
			args: {
				codexTool: "close_agent",
				receiverThreadIds: ["child-thread-1"],
				childRunIds: ["agent-run-child-1"],
			},
		});
		recorder.recordAgentEvent({
			type: "tool_execution_end",
			toolCallId: "close-snake",
			toolName: "codex.subagent.close_agent",
			displayName: "Codex subagent: close agent",
			result: {
				role: "toolResult",
				toolCallId: "close-snake",
				toolName: "codex.subagent.close_agent",
				content: [{ type: "text", text: "closed" }],
				details: {
					codexTool: "close_agent",
					receiverThreadIds: ["child-thread-1"],
					childRunIds: ["agent-run-child-1"],
				},
				isError: false,
				timestamp: 4,
			},
			isError: false,
		} satisfies AgentEvent);
		recorder.recordAgentEvent({
			type: "tool_execution_start",
			toolCallId: "send-after-close",
			toolName: "codex.subagent.send_input",
			displayName: "Codex subagent: send input",
			args: {
				codexTool: "send_input",
				receiverThreadIds: ["child-thread-1"],
				childRunIds: ["agent-run-child-1"],
			},
		});

		await recorder.flush();

		expect(recordWorkItem).toHaveBeenNthCalledWith(1, {
			runId: "run_1",
			workItem: expect.objectContaining({
				id: "maestro:session_1:work:spawn-snake",
				ownerChildRunId: "agent-run-child-1",
				payload: expect.objectContaining({
					codex_tool: "spawnAgent",
				}),
			}),
		});
		expect(recordWorkItem).toHaveBeenNthCalledWith(2, {
			runId: "run_1",
			workItem: expect.objectContaining({
				id: "maestro:session_1:work:wait-snake",
				parentWorkItemId: "maestro:session_1:work:spawn-snake",
				kind: PlatformAgentWorkItemKindValue.Wait,
				state: PlatformAgentWorkItemStateValue.Waiting,
				nextAction: "wait for selected child agents",
				payload: expect.objectContaining({
					codex_tool: "wait",
				}),
			}),
		});
		expect(recordWorkItem).toHaveBeenNthCalledWith(3, {
			runId: "run_1",
			workItem: expect.objectContaining({
				id: "maestro:session_1:work:close-snake",
				parentWorkItemId: "maestro:session_1:work:spawn-snake",
				nextAction: "confirm child agent shutdown",
				payload: expect.objectContaining({
					codex_tool: "closeAgent",
				}),
			}),
		});
		const sendAfterClose = recordWorkItem.mock.calls[3]?.[0]?.workItem;
		expect(sendAfterClose).toEqual(
			expect.objectContaining({
				id: "maestro:session_1:work:send-after-close",
				nextAction: "wait for child agent response",
				payload: expect.objectContaining({
					codex_tool: "sendInput",
					linked_work_item_ids: [],
				}),
			}),
		);
		expect(sendAfterClose?.parentWorkItemId).toBeUndefined();
		expect(updateWorkItem).toHaveBeenCalledWith(
			expect.objectContaining({
				workItemId: "maestro:session_1:work:close-snake",
				state: PlatformAgentWorkItemStateValue.Succeeded,
				payload: expect.objectContaining({
					codex_tool: "closeAgent",
				}),
			}),
		);
	});

	it("preserves future Codex subagent operation names as generic hosted work items", async () => {
		const { recorder, recordWorkItem } = createRecorder();

		recorder.recordAgentEvent({
			type: "tool_execution_start",
			toolCallId: "broadcast-plan",
			toolName: "codex.subagent.broadcastPlan",
			displayName: "Codex subagent: broadcast plan",
			args: {
				codexTool: "broadcastPlan",
				receiverThreadIds: ["child-thread-2"],
				childRunIds: ["agent-run-child-2"],
			},
		});

		await recorder.flush();

		expect(recordWorkItem).toHaveBeenCalledWith({
			runId: "run_1",
			workItem: expect.objectContaining({
				id: "maestro:session_1:work:broadcast-plan",
				ownerChildRunId: "agent-run-child-2",
				kind: PlatformAgentWorkItemKindValue.ChildRun,
				state: PlatformAgentWorkItemStateValue.Running,
				nextAction: "track Codex subagent collaboration",
				payload: expect.objectContaining({
					codex_tool: "broadcastPlan",
					tool_name: "codex.subagent.broadcastPlan",
					receiver_thread_ids: ["child-thread-2"],
					child_run_ids: ["agent-run-child-2"],
				}),
			}),
		});
	});

	it("records prototype-chain subagent suffixes as safe string fallbacks", async () => {
		const { recorder, recordWorkItem } = createRecorder();

		recorder.recordAgentEvent({
			type: "tool_execution_start",
			toolCallId: "proto-suffix",
			toolName: "codex.subagent.__proto__",
			displayName: "Codex subagent: unknown",
			args: {
				receiverThreadIds: ["child-thread-3"],
				childRunIds: ["agent-run-child-3"],
			},
		});

		await recorder.flush();

		expect(recordWorkItem).toHaveBeenCalledWith({
			runId: "run_1",
			workItem: expect.objectContaining({
				id: "maestro:session_1:work:proto-suffix",
				nextAction: "track Codex subagent collaboration",
				payload: expect.objectContaining({
					codex_tool: "__proto__",
					tool_name: "codex.subagent.__proto__",
				}),
			}),
		});
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
