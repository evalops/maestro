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
	PlatformRuntimeEventTypeValue,
} from "../../src/platform/agent-runtime-client.js";
import { HostedAgentRuntimeProgressRecorder } from "../../src/server/hosted-agent-runtime-progress.js";
import type { ServerRequestLifecycleEvent } from "../../src/server/server-request-manager.js";

function createRecorder(overrides?: {
	agentRunId?: string;
	agentRuntimeLeaseToken?: string;
	agentId?: string;
	recordStep?: ReturnType<typeof vi.fn>;
	recordEvent?: ReturnType<typeof vi.fn>;
	recordCost?: ReturnType<typeof vi.fn>;
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
	const recordEvent =
		overrides?.recordEvent ?? vi.fn(async () => ({ run: { id: "run_1" } }));
	const recordCost =
		overrides?.recordCost ?? vi.fn(async () => ({ run: { id: "run_1" } }));
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
			recordEvent,
			recordCost,
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
		recordEvent,
		recordCost,
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

	it("records assistant usage as AgentRuntime model response evidence", async () => {
		const { recorder, recordEvent, recordCost } = createRecorder();

		recorder.recordAgentEvent({ type: "turn_start" });
		recorder.recordAgentEvent({
			type: "turn_end",
			message: {
				role: "assistant",
				content: [],
				api: "responses",
				provider: "openai",
				model: "gpt-5.3-codex",
				usage: {
					input: 10,
					output: 5,
					cacheRead: 2,
					cacheWrite: 1,
					cost: {
						input: 0.0001,
						output: 0.0002,
						cacheRead: 0.00001,
						cacheWrite: 0.00002,
						total: 0.00033,
					},
				},
				stopReason: "stop",
				timestamp: 1,
			},
			toolResults: [],
		} as AgentEvent);

		await recorder.flush();

		expect(recordEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				runId: "run_1",
				type: PlatformRuntimeEventTypeValue.ModelResponseRecorded,
				message: "Maestro model response usage recorded",
				stepId: "maestro:session_1:turn:1",
				costId: "maestro:session_1:cost:1",
				attributes: expect.objectContaining({
					event_type: "model_response_recorded",
					session_kind: "codex",
					session_provider: "maestro",
					model_call_id: "maestro:session_1:model:1",
					cost_id: "maestro:session_1:cost:1",
					provider: "openai",
					model: "gpt-5.3-codex",
					input_tokens: 10,
					output_tokens: 5,
					cache_read_tokens: 2,
					cache_write_tokens: 1,
					total_tokens: 18,
					estimated_cost_micros: 330,
					currency: "USD",
					maestro_session_id: "session_1",
				}),
			}),
		);
		expect(recordCost).toHaveBeenCalledWith(
			expect.objectContaining({
				runId: "run_1",
				leaseToken: "lease-token-1",
				cost: expect.objectContaining({
					id: "maestro:session_1:cost:1",
					stepId: "maestro:session_1:turn:1",
					meterRef: "meter://maestro/model-usage/maestro:session_1:cost:1",
					provider: "openai",
					model: "gpt-5.3-codex",
					inputTokens: 10,
					outputTokens: 5,
					totalTokens: 18,
					currency: "USD",
					estimatedCostMicros: 330,
				}),
			}),
		);
	});

	it("does not record model response evidence for empty usage", async () => {
		const { recorder, recordEvent, recordCost } = createRecorder();

		recorder.recordAgentEvent({ type: "turn_start" });
		recorder.recordAgentEvent({
			type: "turn_end",
			message: {
				role: "assistant",
				content: [],
				api: "responses",
				provider: "openai",
				model: "gpt-5.3-codex",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					cost: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						total: 0,
					},
				},
				stopReason: "stop",
				timestamp: 1,
			},
			toolResults: [],
		} as AgentEvent);

		await recorder.flush();

		expect(recordEvent).not.toHaveBeenCalled();
		expect(recordCost).not.toHaveBeenCalled();
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
			toolExecutionId: "collab-call-1",
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
			toolExecutionId: "texec-collab-call-1",
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
		const startStepInput = recordStep.mock.calls[0]?.[0]?.step?.input;
		expect(startStepInput).not.toHaveProperty("tool_execution_id");
		const endStepOutput = recordStep.mock.calls[1]?.[0]?.step?.output;
		expect(endStepOutput).toHaveProperty(
			"tool_execution_id",
			"texec-collab-call-1",
		);
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
		const recordedWorkItem = recordWorkItem.mock.calls[0]?.[0]?.workItem;
		expect(recordedWorkItem).not.toHaveProperty("toolExecutionId");
		expect(updateWorkItem).toHaveBeenCalledWith({
			runId: "run_1",
			workItemId: "maestro:session_1:work:collab-call-1",
			state: PlatformAgentWorkItemStateValue.Succeeded,
			toolExecutionId: "texec-collab-call-1",
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
				a2aSkillId: "maestro.subagent.code-review",
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
					a2a_skill_id: "maestro.subagent.code-review",
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

	it("records queryable tool, diagnostic, artifact, and final-status events", async () => {
		const { recorder, recordEvent } = createRecorder();

		recorder.recordAgentEvent({
			type: "tool_execution_update",
			toolCallId: "call_stream",
			toolExecutionId: "texec_stream",
			toolName: "read",
			displayName: "Read file",
			summaryLabel: "read src/index.ts",
			args: { file_path: "/workspace/src/index.ts" },
			partialResult: {
				content: [{ type: "text", text: "partial output" }],
				details: { bytes: 14 },
				toolExecutionId: "texec_stream",
			},
		});
		recorder.recordAgentEvent({
			type: "diagnostic_delta",
			toolCallId: "call_stream",
			toolName: "read",
			file: "/workspace/src/index.ts",
			displayPath: "src/index.ts",
			usedDelta: true,
			introducedCount: 1,
			repairedCount: 2,
			remainingCount: 0,
			fingerprint: "diag_abc",
			repairAttempt: 1,
			maxRepairAttempts: 2,
			willAutoFollowUp: false,
			reason: "no diagnostics remain",
		});
		recorder.recordAgentEvent({
			type: "tool_batch_summary",
			summary: "read src/index.ts, Ran pwd",
			summaryLabels: ["read src/index.ts", "Ran pwd"],
			toolCallIds: ["call_stream", "call_stream_again", "call_shell"],
			toolNames: ["read", "read", "shell"],
			callsSucceeded: 1,
			callsFailed: 0,
		});
		recorder.recordAgentEvent({
			type: "tool_execution_end",
			toolCallId: "call_stream",
			toolExecutionId: "texec_stream",
			toolName: "read",
			displayName: "Read file",
			result: {
				role: "toolResult",
				toolCallId: "call_stream",
				toolName: "read",
				content: [{ type: "text", text: "done" }],
				isError: false,
				timestamp: 1,
			},
			isError: false,
			skillMetadata: {
				name: "read-skill",
				hash: "sha256:abc",
				source: "project",
				artifactId: "artifact_1",
				version: "1.0.0",
			},
		} satisfies AgentEvent);
		recorder.recordAgentEvent({
			type: "agent_end",
			messages: [],
			aborted: false,
			stopReason: "stop",
		});
		await recorder.flush();

		expect(recordEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				type: PlatformRuntimeEventTypeValue.AgentProgressRecorded,
				message: "Maestro tool execution update recorded",
				stepId: "maestro:session_1:tool:call_stream",
				attributes: expect.objectContaining({
					event_type: "tool_execution_update",
					tool_call_id: "call_stream",
					tool_execution_id: "texec_stream",
					tool_name: "read",
					arg_keys: ["file_path"],
					content_block_count: 1,
					text_block_count: 1,
					text_total_chars: 14,
					details_keys: ["bytes"],
				}),
			}),
		);
		expect(recordEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Maestro diagnostic delta recorded",
				stepId: "maestro:session_1:tool:call_stream",
				attributes: expect.objectContaining({
					event_type: "diagnostic_delta",
					display_path: "src/index.ts",
					introduced_count: 1,
					repaired_count: 2,
					remaining_count: 0,
					fingerprint: "diag_abc",
				}),
			}),
		);
		expect(recordEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Maestro tool batch summary recorded",
				attributes: expect.objectContaining({
					event_type: "tool_batch_summary",
					summary: "[redacted]",
					summary_labels: ["read src/index.ts", "[redacted]"],
					calls_succeeded: 1,
					calls_failed: 0,
					tool_call_ids: ["call_stream", "call_stream_again", "call_shell"],
					tool_names: ["read", "read", "shell"],
				}),
			}),
		);
		expect(recordEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Maestro tool artifact evidence recorded",
				stepId: "maestro:session_1:tool:call_stream",
				artifactId: "artifact_1",
				attributes: expect.objectContaining({
					event_type: "tool_artifact_recorded",
					skill_name: "read-skill",
					skill_hash: "sha256:abc",
					skill_source: "project",
					skill_artifact_id: "artifact_1",
				}),
			}),
		);
		expect(recordEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Maestro agent final status recorded",
				stepId: "maestro:session_1:agent:end-0",
				attributes: expect.objectContaining({
					event_type: "agent_final_status",
					final_status: "succeeded",
					stop_reason: "stop",
				}),
			}),
		);
	});

	it("projects tool retry prompts as hosted waits and queryable retry events", async () => {
		const { recorder, waitRun, resumeRun, recordEvent } = createRecorder();
		const request = {
			id: "retry_1",
			toolCallId: "call_retry",
			toolName: "shell",
			args: { command: "npm test" },
			errorMessage: "exit code 1",
			attempt: 1,
			maxAttempts: 3,
			summary: "shell failed",
		};

		recorder.recordAgentEvent({
			type: "tool_retry_required",
			request,
		} satisfies AgentEvent);
		recorder.recordAgentEvent({
			type: "tool_retry_resolved",
			request,
			decision: {
				action: "retry",
				reason: "transient",
				resolvedBy: "user",
			},
		} satisfies AgentEvent);
		await recorder.flush();

		expect(waitRun).toHaveBeenCalledWith(
			expect.objectContaining({
				wait: expect.objectContaining({
					id: "maestro:session_1:wait:retry_1",
					stepId: "maestro:session_1:tool:call_retry",
					type: PlatformAgentRunWaitTypeValue.Approval,
					externalRef: "retry_1",
					payload: expect.objectContaining({
						request_type: "tool_retry",
						tool_name: "shell",
					}),
				}),
			}),
		);
		expect(resumeRun).toHaveBeenCalledWith(
			expect.objectContaining({
				waitId: "maestro:session_1:wait:retry_1",
				resumeEventId: "maestro:session_1:resume:retry_1",
				payload: expect.objectContaining({
					request_type: "tool_retry",
					resolution: "retry",
					resolved_by: "user",
				}),
			}),
		);
		expect(recordEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Maestro tool retry required",
				waitId: "maestro:session_1:wait:retry_1",
				attributes: expect.objectContaining({
					event_type: "tool_retry_required",
					error_message: "exit code 1",
					attempt: 1,
					max_attempts: 3,
					arg_keys: ["command"],
				}),
			}),
		);
		expect(recordEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Maestro tool retry resolved",
				waitId: "maestro:session_1:wait:retry_1",
				attributes: expect.objectContaining({
					event_type: "tool_retry_resolved",
					resolution: "retry",
					resolved_by: "user",
					reason: "transient",
				}),
			}),
		);
	});

	it("redacts retry progress event fields before Platform egress", async () => {
		const { recorder, recordEvent } = createRecorder();
		const request = {
			id: "retry_secret",
			toolCallId: "call_retry_secret",
			toolName: "shell",
			args: { command: "npm test" },
			errorMessage: "failed with sk_live_RETRY_EVENT_12345678",
			attempt: 1,
			maxAttempts: 3,
			summary:
				"Command failed: bunx vitest --run test/server/hosted-agent-runtime-progress.test.ts",
		};

		recorder.recordAgentEvent({
			type: "tool_retry_required",
			request,
		} satisfies AgentEvent);
		recorder.recordAgentEvent({
			type: "tool_retry_resolved",
			request,
			decision: {
				action: "retry",
				reason: "Command failed: npm test",
				resolvedBy: "user",
			},
		} satisfies AgentEvent);
		await recorder.flush();

		expect(recordEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Maestro tool retry required",
				attributes: expect.objectContaining({
					event_type: "tool_retry_required",
					error_message: "[redacted]",
					summary: "[redacted]",
				}),
			}),
		);
		expect(recordEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Maestro tool retry resolved",
				attributes: expect.objectContaining({
					event_type: "tool_retry_resolved",
					error_message: "[redacted]",
					summary: "[redacted]",
					reason: "[redacted]",
				}),
			}),
		);
	});

	it("coalesces tool retry AgentEvents with server-request lifecycle waits", async () => {
		const { recorder, waitRun, resumeRun, recordEvent } = createRecorder();
		const retryRequest = {
			id: "retry_dupe",
			toolCallId: "call_dupe",
			toolName: "shell",
			args: { command: "npm test" },
			errorMessage: "exit code 1",
			attempt: 2,
			maxAttempts: 3,
			summary: "shell failed again",
		};
		const registered: ServerRequestLifecycleEvent = {
			type: "registered",
			request: {
				id: retryRequest.id,
				kind: "tool_retry",
				sessionId: "session_1",
				callId: retryRequest.toolCallId,
				toolName: retryRequest.toolName,
				args: {
					tool_call_id: retryRequest.toolCallId,
					args: retryRequest.args,
					error_message: retryRequest.errorMessage,
					attempt: retryRequest.attempt,
					max_attempts: retryRequest.maxAttempts,
					summary: retryRequest.summary,
				},
				reason: retryRequest.summary,
				timestamp: Date.now(),
				startedAtMs: 4_000,
				timeoutMs: 60_000,
			},
		};
		const resolved: ServerRequestLifecycleEvent = {
			type: "resolved",
			request: registered.request,
			resolution: "retried",
			resolvedBy: "user",
			reason: "transient",
			resolvedAtMs: 5_000,
		};

		recorder.recordServerRequestEvent(registered);
		recorder.recordAgentEvent({
			type: "tool_retry_required",
			request: retryRequest,
		} satisfies AgentEvent);
		recorder.recordServerRequestEvent(resolved);
		recorder.recordAgentEvent({
			type: "tool_retry_resolved",
			request: retryRequest,
			decision: {
				action: "retry",
				reason: "transient",
				resolvedBy: "user",
			},
		} satisfies AgentEvent);
		await recorder.flush();

		expect(waitRun).toHaveBeenCalledTimes(1);
		expect(waitRun).toHaveBeenCalledWith(
			expect.objectContaining({
				wait: expect.objectContaining({
					id: "maestro:session_1:wait:retry_dupe",
					stepId: "maestro:session_1:tool:call_dupe",
					type: PlatformAgentRunWaitTypeValue.Approval,
					payload: expect.objectContaining({
						request_type: "tool_retry",
						started_at_ms: 4_000,
					}),
				}),
			}),
		);
		expect(resumeRun).toHaveBeenCalledTimes(1);
		expect(resumeRun).toHaveBeenCalledWith(
			expect.objectContaining({
				waitId: "maestro:session_1:wait:retry_dupe",
				payload: expect.objectContaining({
					request_type: "tool_retry",
					resolution: "retried",
					resolved_by: "user",
					resolved_at_ms: 5_000,
				}),
			}),
		);
		expect(recordEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Maestro tool retry required",
				waitId: "maestro:session_1:wait:retry_dupe",
				attributes: expect.objectContaining({
					event_type: "tool_retry_required",
					attempt: 2,
					max_attempts: 3,
				}),
			}),
		);
		expect(recordEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Maestro tool retry resolved",
				waitId: "maestro:session_1:wait:retry_dupe",
				attributes: expect.objectContaining({
					event_type: "tool_retry_resolved",
					resolution: "retry",
					reason: "transient",
				}),
			}),
		);
	});

	it("records recovery breadcrumbs for status, compaction, and auto retry", async () => {
		const { recorder, recordEvent, recordStep } = createRecorder();

		recorder.recordAgentEvent({
			type: "status",
			status: "restoring checkpoint",
			details: { checkpointId: "cp_1", replica: "pod-b" },
		});
		recorder.recordAgentEvent({
			type: "status",
			status: "Running npm test",
			details: { toolCallId: "call_status_command" },
		});
		recorder.recordAgentEvent({
			type: "status",
			status: "Running npm install lodash",
			details: { toolCallId: "call_status_plain_operand" },
		});
		recorder.recordAgentEvent({
			type: "status",
			status: "Running git checkout main",
			details: { toolCallId: "call_status_git_plain_operand" },
		});
		recorder.recordAgentEvent({
			type: "status",
			status: "Running cargo install ripgrep",
			details: { toolCallId: "call_status_cargo_plain_operand" },
		});
		recorder.recordAgentEvent({
			type: "status",
			status: "Running go run server",
			details: { toolCallId: "call_status_go_plain_operand" },
		});
		recorder.recordAgentEvent({
			type: "status",
			status: "Running pwd",
			details: { toolCallId: "call_status_pwd" },
		});
		recorder.recordAgentEvent({
			type: "status",
			status: "Running date",
			details: { toolCallId: "call_status_date" },
		});
		recorder.recordAgentEvent({
			type: "status",
			status: "Running uname -a",
			details: { toolCallId: "call_status_uname" },
		});
		recorder.recordAgentEvent({
			type: "status",
			status: "Running which node",
			details: { toolCallId: "call_status_which" },
		});
		recorder.recordAgentEvent({
			type: "status",
			status: "Running terraform apply tfplan",
			details: { toolCallId: "call_status_terraform_plain_operand" },
		});
		recorder.recordAgentEvent({
			type: "status",
			status: "Running echo $TOKEN",
			details: { toolCallId: "call_status_echo_token" },
		});
		recorder.recordAgentEvent({
			type: "status",
			status: "Running printf hello",
			details: { toolCallId: "call_status_printf_plain_operand" },
		});
		recorder.recordAgentEvent({
			type: "status",
			status: "Running cd /private/workspace",
			details: {
				kind: "tool_execution_summary",
				toolCallId: "call_status_cd",
				toolName: "exec_command",
			},
		});
		recorder.recordAgentEvent({
			type: "status",
			status: "Running release notes",
			details: {
				kind: "tool_execution_summary",
				toolCallId: "call_status_benign_running",
				toolName: "todo",
			},
		});
		recorder.recordAgentEvent({
			type: "compaction",
			summary: "Older context summarized",
			firstKeptEntryIndex: 12,
			tokensBefore: 42_000,
			auto: true,
			timestamp: "2026-05-23T01:00:00.000Z",
		});
		recorder.recordAgentEvent({
			type: "auto_retry_start",
			attempt: 2,
			maxAttempts: 5,
			delayMs: 1_500,
			errorMessage: "rate limited",
		});
		recorder.recordAgentEvent({
			type: "auto_retry_end",
			success: true,
			attempt: 2,
		});
		await recorder.flush();

		const recordedStatuses = recordEvent.mock.calls
			.map(([input]) => input.attributes)
			.filter((attributes) => attributes.event_type === "status")
			.map((attributes) => attributes.status);
		expect(recordedStatuses).toEqual([
			"restoring checkpoint",
			"[redacted]",
			"[redacted]",
			"[redacted]",
			"[redacted]",
			"[redacted]",
			"[redacted]",
			"[redacted]",
			"[redacted]",
			"[redacted]",
			"[redacted]",
			"[redacted]",
			"[redacted]",
			"[redacted]",
			"Running release notes",
		]);
		expect(recordEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Maestro context compaction recorded",
				attributes: expect.objectContaining({
					event_type: "compaction",
					first_kept_entry_index: 12,
					tokens_before: 42_000,
					auto: true,
					summary_chars: 24,
				}),
			}),
		);
		expect(recordStep).toHaveBeenCalledWith(
			expect.objectContaining({
				step: expect.objectContaining({
					id: "maestro:session_1:retry:auto-1-attempt-2",
					stepKind: PlatformAgentRunStepKindValue.System,
					state: PlatformAgentRunStepStateValue.Waiting,
					input: expect.objectContaining({
						event_type: "auto_retry_start",
						delay_ms: 1_500,
					}),
				}),
			}),
		);
		expect(recordStep).toHaveBeenCalledWith(
			expect.objectContaining({
				step: expect.objectContaining({
					id: "maestro:session_1:retry:auto-1-attempt-2",
					state: PlatformAgentRunStepStateValue.Succeeded,
					output: expect.objectContaining({
						event_type: "auto_retry_end",
						success: true,
					}),
				}),
			}),
		);
	});

	it("records unique auto-retry step IDs for separate retry sequences", async () => {
		const { recorder, recordStep } = createRecorder();

		recorder.recordAgentEvent({
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 100,
			errorMessage: "rate limited once",
		});
		recorder.recordAgentEvent({
			type: "auto_retry_end",
			success: true,
			attempt: 1,
		});
		recorder.recordAgentEvent({
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 200,
			errorMessage: "rate limited again",
		});
		recorder.recordAgentEvent({
			type: "auto_retry_end",
			success: true,
			attempt: 1,
		});
		await recorder.flush();

		const retryStepIds = recordStep.mock.calls
			.map(([input]) => input.step.id)
			.filter((id) => id.includes(":retry:"));

		expect(retryStepIds).toEqual([
			"maestro:session_1:retry:auto-1-attempt-1",
			"maestro:session_1:retry:auto-1-attempt-1",
			"maestro:session_1:retry:auto-2-attempt-1",
			"maestro:session_1:retry:auto-2-attempt-1",
		]);
		expect(new Set(retryStepIds).size).toBe(2);
	});

	it("redacts auto-retry error text before Platform egress", async () => {
		const { recorder, recordStep } = createRecorder();

		recorder.recordAgentEvent({
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 100,
			errorMessage: "Command failed: npm test -- --runInBand",
		});
		recorder.recordAgentEvent({
			type: "auto_retry_end",
			success: false,
			attempt: 1,
			finalError: "failed with sk_live_AUTO_RETRY_12345678",
		});
		await recorder.flush();

		expect(recordStep).toHaveBeenCalledWith(
			expect.objectContaining({
				step: expect.objectContaining({
					id: "maestro:session_1:retry:auto-1-attempt-1",
					input: expect.objectContaining({
						error_message: "[redacted]",
					}),
				}),
			}),
		);
		expect(recordStep).toHaveBeenCalledWith(
			expect.objectContaining({
				step: expect.objectContaining({
					id: "maestro:session_1:retry:auto-1-attempt-1",
					errorMessage: "[redacted]",
					output: expect.objectContaining({
						final_error: "[redacted]",
					}),
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

	it("records hosted drain manifest evidence before terminal completion", async () => {
		const { recorder, recordEvent, completeRun } = createRecorder();

		await recorder.recordHostedRunnerDrain({
			status: "drained",
			reason: "process_shutdown",
			requestedBy: "maestro_web_server",
			flushStatus: "completed",
			manifestPath: "/workspace/.maestro/runner-snapshots/mrs.json",
			platformEvidence: {
				protocol_version: "evalops.remote-runner.platform-evidence.v1",
				work_continuity: {
					codex_subagent_edge_count: 1,
				},
			},
		});

		expect(recordEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				runId: "run_1",
				type: PlatformRuntimeEventTypeValue.AgentProgressRecorded,
				message: "hosted runner drain manifest recorded",
				attributes: expect.objectContaining({
					event_type: "hosted_runner_drain_manifest_recorded",
					status: "drained",
					flush_status: "completed",
					manifest_path: "/workspace/.maestro/runner-snapshots/mrs.json",
					platform_evidence: expect.objectContaining({
						protocol_version: "evalops.remote-runner.platform-evidence.v1",
					}),
				}),
			}),
		);
		expect(completeRun).toHaveBeenCalledWith(
			expect.objectContaining({
				runId: "run_1",
				result: expect.objectContaining({
					event_type: "hosted_runner_drained",
					manifest_path: "/workspace/.maestro/runner-snapshots/mrs.json",
				}),
			}),
		);
		expect(recordEvent.mock.invocationCallOrder[0]).toBeLessThan(
			completeRun.mock.invocationCallOrder[0],
		);
	});

	it("sanitizes nested hosted drain reason evidence before Platform egress", async () => {
		const { recorder, recordEvent, completeRun } = createRecorder();

		await recorder.recordHostedRunnerDrain({
			status: "drained",
			reason: "cleanup sk_live_DRAIN_12345678",
			requestedBy: "maestro_web_server",
			flushStatus: "completed",
			manifestPath: "/workspace/.maestro/runner-snapshots/mrs.json",
			platformEvidence: {
				reason: "cleanup sk_live_DRAIN_12345678",
			},
		});

		expect(recordEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "hosted runner drain manifest recorded",
				attributes: expect.objectContaining({
					reason: "[redacted]",
					platform_evidence: expect.objectContaining({
						reason: "[redacted]",
					}),
				}),
			}),
		);
		expect(completeRun).toHaveBeenCalledWith(
			expect.objectContaining({
				result: expect.objectContaining({
					reason: "[redacted]",
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
			flushStatus: "failed",
			manifestPath: "/workspace/.maestro/runner-snapshots/mrs.json",
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
						flush_status: "failed",
						manifest_path: "/workspace/.maestro/runner-snapshots/mrs.json",
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

	it("sanitizes interrupted hosted drain failure text before Platform egress", async () => {
		const { recorder, recordEvent, recordStep, failRun } = createRecorder();

		await recorder.recordHostedRunnerDrain({
			status: "interrupted",
			reason: "cleanup sk_live_DRAIN_12345678",
			requestedBy: "kubernetes_prestop",
			flushStatus: "failed",
			manifestPath: "/workspace/.maestro/runner-snapshots/mrs.json",
			errorMessage: "drain failed with sk_live_DRAIN_12345678",
		});

		expect(recordEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "hosted runner interrupted drain manifest recorded",
				attributes: expect.objectContaining({
					event_type: "hosted_runner_drain_manifest_recorded",
					reason: "[redacted]",
					error: "[redacted]",
				}),
			}),
		);
		expect(recordStep).toHaveBeenCalledWith(
			expect.objectContaining({
				step: expect.objectContaining({
					errorMessage: "[redacted]",
					output: expect.objectContaining({
						event_type: "hosted_runner_drain_failed",
						reason: "[redacted]",
					}),
				}),
			}),
		);
		expect(failRun).toHaveBeenCalledWith(
			expect.objectContaining({
				errorMessage: "[redacted]",
			}),
		);
	});

	it("projects todo tool results into deterministic AgentRuntime task work items", async () => {
		const { recorder, recordWorkItem, recordStep, recordEvent } =
			createRecorder();

		recorder.recordAgentEvent({
			type: "tool_execution_start",
			toolCallId: "todo-call-1",
			toolName: "todo",
			displayName: "todo",
			args: {
				goal: "Ship Codex Mesh task projection",
				items: [
					{
						id: "task-1",
						content: "Plan the bridge",
						status: "completed",
						priority: "high",
					},
					{
						id: "task-2",
						content: "Wire hosted progress",
						status: "in_progress",
						priority: "high",
						blockedBy: ["platform lease"],
					},
				],
			},
		});
		recorder.recordAgentEvent({
			type: "tool_execution_end",
			toolCallId: "todo-call-1",
			toolExecutionId: "texec-todo-1",
			toolName: "todo",
			displayName: "todo",
			result: {
				role: "toolResult",
				toolCallId: "todo-call-1",
				toolName: "todo",
				content: [{ type: "text", text: "updated" }],
				details: {
					items: [
						{
							id: "task-1",
							content: "Plan the bridge",
							status: "completed",
							priority: "high",
						},
						{
							id: "task-2",
							content: "Wire hosted progress",
							status: "in_progress",
							priority: "high",
							blockedBy: ["platform lease"],
						},
					],
				},
				isError: false,
				timestamp: 10,
			},
			isError: false,
		} satisfies AgentEvent);

		await recorder.flush();
		const task1WorkItem = recordWorkItem.mock.calls.find(
			(call) => call[0]?.workItem?.payload?.todo_id === "task-1",
		)?.[0]?.workItem;
		const task2WorkItem = recordWorkItem.mock.calls.find(
			(call) => call[0]?.workItem?.payload?.todo_id === "task-2",
		)?.[0]?.workItem;

		expect(task1WorkItem?.id).toEqual(
			expect.stringMatching(
				/^maestro:session_1:todo:goal-[a-f0-9]{12}:task-1$/,
			),
		);
		expect(task2WorkItem?.id).toEqual(
			expect.stringMatching(
				/^maestro:session_1:todo:goal-[a-f0-9]{12}:task-2$/,
			),
		);

		expect(recordWorkItem).toHaveBeenCalledWith({
			runId: "run_1",
			workItem: expect.objectContaining({
				id: task1WorkItem?.id,
				kind: PlatformAgentWorkItemKindValue.Followup,
				state: PlatformAgentWorkItemStateValue.Succeeded,
				title: "Plan the bridge",
				goal: "Ship Codex Mesh task projection",
				toolExecutionId: "texec-todo-1",
				evidenceRefs: [
					`maestro-task:todo:${String(task1WorkItem?.id).split(":todo:")[1]}`,
					"tool-call:todo-call-1",
					"tool-execution:texec-todo-1",
				],
				payload: expect.objectContaining({
					event_type: "maestro_task_progress",
					task_source: "todo",
					task_id: "task-1",
					task_status: "succeeded",
					todo_goal_hash: expect.stringMatching(/^[a-f0-9]{12}$/),
					todo_scope: "goal",
					todo_status: "completed",
					maestro_session_id: "session_1",
				}),
			}),
		});
		expect(recordWorkItem).toHaveBeenCalledWith({
			runId: "run_1",
			workItem: expect.objectContaining({
				id: task2WorkItem?.id,
				state: PlatformAgentWorkItemStateValue.Running,
				blocker: "platform lease",
				payload: expect.objectContaining({
					task_status: "running",
					blocked_by: ["platform lease"],
				}),
			}),
		});
		expect(recordStep).toHaveBeenCalledWith(
			expect.objectContaining({
				step: expect.objectContaining({
					id: task2WorkItem?.id,
					stepKind: PlatformAgentRunStepKindValue.System,
					state: PlatformAgentRunStepStateValue.Running,
					input: expect.objectContaining({
						task_source: "todo",
						task_id: "task-2",
					}),
				}),
			}),
		);
		expect(recordEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				type: PlatformRuntimeEventTypeValue.AgentProgressRecorded,
				message: "Maestro todo task running",
				stepId: task2WorkItem?.id,
			}),
		);
	});

	it("keeps todo work items distinct when goals reuse task ids", async () => {
		const { recorder, recordWorkItem } = createRecorder();
		for (const [toolCallId, goal] of [
			["todo-call-a", "Ship hosted swarm progress"],
			["todo-call-b", "Prepare deploy rollout"],
		]) {
			recorder.recordAgentEvent({
				type: "tool_execution_start",
				toolCallId,
				toolName: "todo",
				args: {
					goal,
				},
			});
			recorder.recordAgentEvent({
				type: "tool_execution_end",
				toolCallId,
				toolExecutionId: `${toolCallId}-exec`,
				toolName: "todo",
				result: {
					role: "toolResult",
					toolCallId,
					toolName: "todo",
					content: [{ type: "text", text: "updated" }],
					details: {
						items: [
							{
								id: "task-1",
								content: `Shared task id for ${goal}`,
								status: "pending",
							},
						],
					},
					isError: false,
					timestamp: 10,
				},
				isError: false,
			} satisfies AgentEvent);
		}

		await recorder.flush();

		const ids = recordWorkItem.mock.calls
			.map((call) => call[0]?.workItem?.id)
			.filter((id): id is string => typeof id === "string");
		expect(ids).toHaveLength(2);
		expect(new Set(ids).size).toBe(2);
		expect(ids).toEqual([
			expect.stringMatching(
				/^maestro:session_1:todo:goal-[a-f0-9]{12}:task-1$/,
			),
			expect.stringMatching(
				/^maestro:session_1:todo:goal-[a-f0-9]{12}:task-1$/,
			),
		]);
	});

	it("hashes full todo goals before truncating projected goal text", async () => {
		const { recorder, recordWorkItem } = createRecorder();
		const sharedPrefix = "same long hosted goal prefix ".repeat(30);
		const goals = [
			`${sharedPrefix}finish the Maestro projection alpha`,
			`${sharedPrefix}finish the Deploy rollout beta`,
		];
		expect(goals[0]?.slice(0, 512)).toBe(goals[1]?.slice(0, 512));

		for (const [index, goal] of goals.entries()) {
			const toolCallId = `todo-long-goal-${index}`;
			recorder.recordAgentEvent({
				type: "tool_execution_start",
				toolCallId,
				toolName: "todo",
				args: { goal },
			});
			recorder.recordAgentEvent({
				type: "tool_execution_end",
				toolCallId,
				toolExecutionId: `${toolCallId}-exec`,
				toolName: "todo",
				result: {
					role: "toolResult",
					toolCallId,
					toolName: "todo",
					content: [{ type: "text", text: "updated" }],
					details: {
						items: [
							{
								id: "task-1",
								content: "Shared todo id under a long goal",
								status: "pending",
							},
						],
					},
					isError: false,
					timestamp: 10,
				},
				isError: false,
			} satisfies AgentEvent);
		}

		await recorder.flush();

		const workItems = recordWorkItem.mock.calls
			.map((call) => call[0]?.workItem)
			.filter((item): item is NonNullable<typeof item> => Boolean(item));
		const ids = workItems.map((item) => item.id);
		const goalHashes = workItems.map((item) => item.payload?.todo_goal_hash);
		expect(workItems).toHaveLength(2);
		expect(new Set(ids).size).toBe(2);
		expect(new Set(goalHashes).size).toBe(2);
		expect(workItems[0]?.goal).toBe(workItems[1]?.goal);
		expect(ids).toEqual([
			expect.stringMatching(
				/^maestro:session_1:todo:goal-[a-f0-9]{12}:task-1$/,
			),
			expect.stringMatching(
				/^maestro:session_1:todo:goal-[a-f0-9]{12}:task-1$/,
			),
		]);
	});

	it("projects background task details without copying env or log paths", async () => {
		const { recorder, recordWorkItem, recordStep } = createRecorder();

		recorder.recordAgentEvent({
			type: "tool_execution_start",
			toolCallId: "bash-bg-1",
			toolName: "bash",
			args: {
				command: "npm run dev",
				env: { SECRET_TOKEN: "do-not-copy" },
				runInBackground: true,
			},
		});
		recorder.recordAgentEvent({
			type: "tool_execution_end",
			toolCallId: "bash-bg-1",
			toolExecutionId: "texec-bg-1",
			toolName: "bash",
			result: {
				role: "toolResult",
				toolCallId: "bash-bg-1",
				toolName: "bash",
				content: [{ type: "text", text: "started" }],
				details: {
					taskId: "bg_1",
					status: "running",
					command: "npm run dev",
					cwd: "/workspace/app",
					logPath: "/workspace/.maestro/logs/bg_1.log",
				},
				isError: false,
				timestamp: 11,
			},
			isError: false,
		} satisfies AgentEvent);

		await recorder.flush();

		expect(recordWorkItem).toHaveBeenCalledWith({
			runId: "run_1",
			workItem: expect.objectContaining({
				id: "maestro:session_1:background:bg_1",
				kind: PlatformAgentWorkItemKindValue.ToolCall,
				state: PlatformAgentWorkItemStateValue.Running,
				title: "Background task: [redacted]",
				toolExecutionId: "texec-bg-1",
				payload: expect.objectContaining({
					task_source: "background",
					background_task_id: "bg_1",
					title: "Background task: [redacted]",
					command_summary: "[redacted]",
					cwd: "/workspace/app",
				}),
			}),
		});
		const payload = recordWorkItem.mock.calls.find(
			(call) => call[0]?.workItem?.id === "maestro:session_1:background:bg_1",
		)?.[0]?.workItem?.payload;
		expect(payload).not.toHaveProperty("env");
		expect(payload).not.toHaveProperty("logPath");
		expect(payload).not.toHaveProperty("log_path");
		expect(recordStep).toHaveBeenCalledWith(
			expect.objectContaining({
				step: expect.objectContaining({
					id: "maestro:session_1:background:bg_1",
					stepKind: PlatformAgentRunStepKindValue.ToolCallIntent,
					state: PlatformAgentRunStepStateValue.Running,
				}),
			}),
		);
	});

	it("redacts background task commands from command source context", async () => {
		const { recorder, recordWorkItem } = createRecorder();

		for (const [index, command] of [
			"pwd",
			"date",
			"npm install lodash",
		].entries()) {
			recorder.recordAgentEvent({
				type: "tool_execution_end",
				toolCallId: `bash-bg-command-${index}`,
				toolExecutionId: `texec-bg-command-${index}`,
				toolName: "background_tasks",
				result: {
					role: "toolResult",
					toolCallId: `bash-bg-command-${index}`,
					toolName: "background_tasks",
					content: [{ type: "text", text: "running" }],
					details: {
						taskId: `bg_command_${index}`,
						status: "running",
						command,
					},
					isError: false,
					timestamp: 11 + index,
				},
				isError: false,
			} satisfies AgentEvent);
		}

		await recorder.flush();

		for (const index of [0, 1, 2]) {
			expect(recordWorkItem).toHaveBeenCalledWith({
				runId: "run_1",
				workItem: expect.objectContaining({
					id: `maestro:session_1:background:bg_command_${index}`,
					title: "Background task: [redacted]",
					payload: expect.objectContaining({
						title: "Background task: [redacted]",
						command_summary: "[redacted]",
					}),
				}),
			});
		}
	});

	it("records swarm events as parent and child AgentRuntime work items", async () => {
		const { recorder, recordWorkItem, updateWorkItem, recordStep } =
			createRecorder();

		recorder.recordSwarmEvent({
			type: "swarm_start",
			swarmId: "swarm_1",
			config: {
				teammateCount: 2,
				planFile: "/workspace/plan.md",
				tasks: [
					{
						id: "task-a",
						prompt: "Implement remote runner profile support",
						dependsOn: ["task-prep"],
						subagentType: "coder",
						priority: 10,
					},
				],
				cwd: "/workspace",
				model: "gpt-5.3-codex",
			},
		});
		recorder.recordSwarmEvent({
			type: "task_start",
			swarmId: "swarm_1",
			teammateId: "mate_1",
			task: {
				id: "task-a",
				prompt: "Implement remote runner profile support",
				dependsOn: ["task-prep"],
				subagentType: "coder",
				priority: 10,
			},
		});
		recorder.recordSwarmEvent({
			type: "task_complete",
			swarmId: "swarm_1",
			teammateId: "mate_1",
			taskId: "task-a",
			output: "done but do not copy this raw teammate output",
		});

		await recorder.flush();

		expect(recordWorkItem).toHaveBeenCalledWith({
			runId: "run_1",
			workItem: expect.objectContaining({
				id: "maestro:session_1:swarm:swarm_1",
				kind: PlatformAgentWorkItemKindValue.Root,
				state: PlatformAgentWorkItemStateValue.Running,
				payload: expect.objectContaining({
					swarm_id: "swarm_1",
					teammate_count: 2,
					task_count: 1,
				}),
			}),
		});
		expect(recordWorkItem).toHaveBeenCalledWith({
			runId: "run_1",
			workItem: expect.objectContaining({
				id: "maestro:session_1:swarm:swarm_1:task:task-a",
				parentWorkItemId: "maestro:session_1:swarm:swarm_1",
				ownerChildRunId: "swarm:swarm_1:teammate:mate_1",
				kind: PlatformAgentWorkItemKindValue.ChildRun,
				state: PlatformAgentWorkItemStateValue.Running,
			}),
		});
		expect(updateWorkItem).toHaveBeenCalledWith(
			expect.objectContaining({
				runId: "run_1",
				workItemId: "maestro:session_1:swarm:swarm_1:task:task-a",
				state: PlatformAgentWorkItemStateValue.Succeeded,
				payload: expect.objectContaining({
					output_bytes: 45,
				}),
			}),
		);
		const completePayload = updateWorkItem.mock.calls.find(
			(call) =>
				call[0]?.workItemId === "maestro:session_1:swarm:swarm_1:task:task-a" &&
				call[0]?.state === PlatformAgentWorkItemStateValue.Succeeded,
		)?.[0]?.payload;
		expect(JSON.stringify(completePayload)).not.toContain(
			"do not copy this raw teammate output",
		);
		expect(recordStep).toHaveBeenCalledWith(
			expect.objectContaining({
				step: expect.objectContaining({
					id: "maestro:session_1:swarm:swarm_1:task:task-a",
					state: PlatformAgentRunStepStateValue.Succeeded,
				}),
			}),
		);
	});

	it("preserves failed swarm state when swarm_complete follows a failure", async () => {
		const { recorder, updateWorkItem } = createRecorder();

		recorder.recordSwarmEvent({
			type: "swarm_start",
			swarmId: "swarm_failed",
			config: {
				teammateCount: 1,
				planFile: "/workspace/plan.md",
				tasks: [{ id: "task-a", prompt: "Fail this task" }],
				cwd: "/workspace",
			},
		});
		recorder.recordSwarmEvent({
			type: "swarm_complete",
			swarmId: "swarm_failed",
			state: {
				id: "swarm_failed",
				status: "failed",
				config: {
					teammateCount: 1,
					planFile: "/workspace/plan.md",
					tasks: [{ id: "task-a", prompt: "Fail this task" }],
					cwd: "/workspace",
				},
				teammates: [],
				pendingTasks: [],
				activeTasks: new Map(),
				completedTasks: new Set(),
				failedTasks: new Set(["task-a"]),
				startedAt: 1,
				completedAt: 2,
				error: "task-a failed",
			},
		});

		await recorder.flush();

		expect(updateWorkItem).toHaveBeenCalledWith(
			expect.objectContaining({
				workItemId: "maestro:session_1:swarm:swarm_failed",
				state: PlatformAgentWorkItemStateValue.Failed,
				payload: expect.objectContaining({
					swarm_status: "failed",
					failed_task_count: 1,
					error: "task-a failed",
				}),
			}),
		);
	});

	it("bounds projected task strings to their configured limits", async () => {
		const { recorder, recordWorkItem } = createRecorder();
		const longTitle = "title ".repeat(80);
		const longGoal = "goal ".repeat(140);

		recorder.recordTaskProgressEvent({
			source: "checkpoint",
			id: "long_projection",
			status: "running",
			title: longTitle,
			goal: longGoal,
		});
		await recorder.flush();

		const workItem = recordWorkItem.mock.calls[0]?.[0]?.workItem;
		expect(workItem?.title).toHaveLength(256);
		expect(workItem?.title).toMatch(/…$/);
		expect(workItem?.goal).toHaveLength(512);
		expect(workItem?.goal).toMatch(/…$/);
		expect(workItem?.payload?.title).toHaveLength(256);
		expect(workItem?.payload?.goal).toHaveLength(512);
	});

	it("retries task work item creation after an initial Platform write failure", async () => {
		const recordWorkItem = vi
			.fn()
			.mockRejectedValueOnce(new Error("Platform unavailable"))
			.mockResolvedValue({ run: { id: "run_1" } });
		const updateWorkItem = vi.fn(async () => ({ run: { id: "run_1" } }));
		const { recorder } = createRecorder({ recordWorkItem, updateWorkItem });

		recorder.recordTaskProgressEvent({
			source: "todo",
			id: "task-retry",
			status: "running",
			title: "Retry task",
		});
		await recorder.flush();

		recorder.recordTaskProgressEvent({
			source: "todo",
			id: "task-retry",
			status: "succeeded",
			title: "Retry task",
		});
		await recorder.flush();

		recorder.recordTaskProgressEvent({
			source: "todo",
			id: "task-retry",
			status: "running",
			title: "Retry task",
			nextAction: "verify follow-up update",
		});
		await recorder.flush();

		expect(recordWorkItem).toHaveBeenCalledTimes(2);
		expect(recordWorkItem).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				workItem: expect.objectContaining({
					id: "maestro:session_1:todo:task-retry",
					state: PlatformAgentWorkItemStateValue.Succeeded,
				}),
			}),
		);
		expect(updateWorkItem).toHaveBeenCalledTimes(1);
		expect(updateWorkItem).toHaveBeenCalledWith(
			expect.objectContaining({
				workItemId: "maestro:session_1:todo:task-retry",
				state: PlatformAgentWorkItemStateValue.Running,
				nextAction: "verify follow-up update",
			}),
		);
	});

	it("falls back to update when task work item already exists in Platform", async () => {
		const recordWorkItem = vi
			.fn()
			.mockRejectedValueOnce(
				new Error(
					"agent runtime service returned 409: work item already exists",
				),
			)
			.mockResolvedValue({ run: { id: "run_1" } });
		const updateWorkItem = vi.fn(async () => ({ run: { id: "run_1" } }));
		const { recorder } = createRecorder({ recordWorkItem, updateWorkItem });

		recorder.recordTaskProgressEvent({
			source: "swarm",
			id: "task-after-restart",
			status: "succeeded",
			title: "Restarted task",
			nextAction: "terminal state from restored runner",
			toolExecutionId: "tool_exec_1",
		});
		await recorder.flush();

		expect(recordWorkItem).toHaveBeenCalledTimes(1);
		expect(updateWorkItem).toHaveBeenCalledWith(
			expect.objectContaining({
				runId: "run_1",
				workItemId: "maestro:session_1:swarm:task-after-restart",
				state: PlatformAgentWorkItemStateValue.Succeeded,
				nextAction: "terminal state from restored runner",
				toolExecutionId: "tool_exec_1",
				payload: expect.objectContaining({
					task_status: "succeeded",
				}),
			}),
		);

		recorder.recordTaskProgressEvent({
			source: "swarm",
			id: "task-after-restart",
			status: "running",
			title: "Restarted task",
			nextAction: "follow-up progress",
		});
		await recorder.flush();

		expect(recordWorkItem).toHaveBeenCalledTimes(1);
		expect(updateWorkItem).toHaveBeenCalledTimes(2);
		expect(updateWorkItem).toHaveBeenLastCalledWith(
			expect.objectContaining({
				workItemId: "maestro:session_1:swarm:task-after-restart",
				state: PlatformAgentWorkItemStateValue.Running,
				nextAction: "follow-up progress",
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

	it("keeps benign task prose while redacting command-looking task text", async () => {
		const { recorder, recordWorkItem, recordEvent } = createRecorder();
		const bareChecksum = "a".repeat(64);

		recorder.recordTaskProgressEvent({
			source: "todo",
			id: "benign-prose",
			status: "running",
			title: "fix login; update docs",
			goal: "Go over docs and review the bash docs",
			payload: {
				note: "Keep $10 pricing and OAuth wording",
				summary: "update auth | docs notes",
			},
		});
		recorder.recordTaskProgressEvent({
			source: "todo",
			id: "benign-executable-words",
			status: "running",
			title: "npm package migration",
			goal: "python version support and kubectl docs",
			payload: {
				blocker: "terraform module design",
				biome: "biome check notes",
				buf: "buf lint config",
				docker: "docker documentation follow-up",
				dockerBuild: "docker build failure",
				git: "git authentication issue",
				gitCommit: "git commit message",
				gitStatus: "git status notes",
				gh: "gh actions migration",
				ghPr: "gh pr migration notes",
				ghWorkflow: "gh workflow ownership",
				kubectl: "kubectl version support",
				node: "node version support",
				npx: "npx package migration",
				pip: "pip install notes",
				pipShow: "pip show follow-up",
				sudo: "sudo access request",
				terraform: "terraform plan notes",
				uv: "uv run notes",
				uvx: "uvx ruff follow-up",
				vite: "vite build failure",
				vitest: "vitest run follow-up",
			},
		});
		recorder.recordTaskProgressEvent({
			source: "todo",
			id: "benign-security-prose",
			status: "running",
			title: "Document password rotation",
			goal: "Review bearer authentication flow",
			payload: {
				note: "Keep authorization guidance readable",
			},
		});
		recorder.recordTaskProgressEvent({
			source: "todo",
			id: "benign-credential-shape-prose",
			status: "running",
			title: "sketchbook notes",
			goal: "Authorization: Bearer token handling",
			payload: {
				digest: bareChecksum,
				note: "Document Authorization: Basic flow",
			},
		});
		recorder.recordTaskProgressEvent({
			source: "todo",
			id: "benign-github-token-prefix-prose",
			status: "running",
			title: "ghostwriter notes",
			goal: "ghostwritten docs follow-up",
			payload: {
				note: "ghoul migration planning",
			},
		});
		recorder.recordTaskProgressEvent({
			source: "todo",
			id: "benign-find-prose",
			status: "running",
			title: "find root cause for login",
			goal: "find auth regression owner",
			payload: {
				note: "find the related ticket",
			},
		});
		recorder.recordTaskProgressEvent({
			source: "todo",
			id: "benign-command-label-prose",
			status: "running",
			title: "Command: document release process",
			goal: "Detected command: document release process",
			payload: {
				note: "Command: document release process",
			},
		});
		recorder.recordTaskProgressEvent({
			source: "todo",
			id: "benign-dev-server-url",
			status: "running",
			title: "Inspect http://localhost:5173/@vite/client",
			goal: "Review Vite client URL http://localhost:5173/@vite/client",
			payload: {
				url: "http://localhost:5173/@vite/client",
			},
		});
		recorder.recordTaskProgressEvent({
			source: "todo",
			id: "benign-ssh-prose",
			status: "running",
			title: "ssh authentication issue",
			goal: "ssh access follow-up",
			payload: {
				note: "ssh terminology in docs",
			},
		});
		recorder.recordTaskProgressEvent({
			source: "todo",
			id: "benign-grep-prose",
			status: "running",
			title: "grep results incorrect",
			goal: "grep auth issue",
			payload: {
				note: "grep output needs review",
			},
		});
		recorder.recordTaskProgressEvent({
			source: "todo",
			id: "benign-go-yarn-cargo-prose",
			status: "running",
			title: "go version support",
			goal: "cargo build failure notes",
			payload: {
				note: "yarn test ownership",
			},
		});
		recorder.recordTaskProgressEvent({
			source: "todo",
			id: "benign-curl-wget-prose",
			status: "running",
			title: "curl docs update",
			goal: "wget migration notes",
			payload: {
				note: "curl examples backlog",
			},
		});
		recorder.recordTaskProgressEvent({
			source: "todo",
			id: "benign-package-manager-prose",
			status: "running",
			title: "npm version support",
			goal: "pnpm install notes",
			payload: {
				note: "npm audit follow-up",
				bun: "bun build failure notes",
			},
		});
		recorder.recordTaskProgressEvent({
			source: "todo",
			id: "benign-make-prose",
			status: "running",
			title: "make improvements",
			goal: "make accessible",
			payload: {
				note: "make docs readable",
			},
		});
		recorder.recordTaskProgressEvent({
			source: "background",
			id: "command-prose",
			status: "running",
			title: "Command: npm test",
			goal: "Detected command: npm test",
			payload: {
				command_summary: "bash -lc npm test",
				docker: "Command: docker run ubuntu",
				git: "Command: git checkout main",
				cargo: "Command: cargo run server",
				echo: "Command: echo $TOKEN",
				go: "Detected command: go run server",
				npm: "Command: npm install lodash",
				pip: "Detected command: pip install requests",
				printf: "Command: printf hello",
				terraform: "Command: terraform apply tfplan",
				yarn: "Detected command: yarn add lodash",
			},
		});
		recorder.recordTaskProgressEvent({
			source: "background",
			id: "executable-command-text",
			status: "running",
			title: "git push origin main",
			goal: "node --version",
			payload: {
				docker: "docker build .",
				gh: "gh pr view 2389",
				ghWorkflow: "gh workflow run release.yml",
				kubectl: "kubectl get pods",
				npm: "npm test",
				npx: "npx @scope/tool --help",
				pip: "pip install --upgrade requests",
				pipFreeze: "pip freeze",
				pipShow: "pip show ./packages/example",
				python: "python -m pytest",
				sudo: "sudo npm test",
				terraform: "terraform plan",
				uv: "uv run --python 3.12 pytest",
				uvx: "uvx ruff@latest check",
				kubectlVersion: "kubectl version --client",
				biome: "biome check ./src",
				buf: "buf lint --path proto",
				terraformPlan: "terraform plan -out=tfplan",
				vite: "vite build --mode production",
				vitest: "vitest run test/server/hosted-agent-runtime-progress.test.ts",
			},
		});
		recorder.recordTaskProgressEvent({
			source: "background",
			id: "credential-url",
			status: "running",
			title: "Fetch https://user:pass@example.com/private",
			goal: "Check credential URL",
			payload: {
				url: "https://user:pass@example.com/private",
			},
		});
		recorder.recordTaskProgressEvent({
			source: "background",
			id: "credential-token-shape",
			status: "running",
			title: "sk_live_SECRET_12345678",
			goal: "Authorization: Bearer abcdefghijklmn12",
			payload: {
				auth: "Authorization: Basic dXNlcjpwYXNzMTIzNA==",
				github: "gho_abcdefghijklmno",
			},
		});
		recorder.recordTaskProgressEvent({
			source: "background",
			id: "remote-command-text",
			status: "running",
			title: "ssh prod.example",
			goal: "ssh -v prod.example",
			payload: {
				scp: "scp .env host:/tmp",
				rsync: "rsync -av secrets/ host:/tmp",
			},
		});
		recorder.recordTaskProgressEvent({
			source: "background",
			id: "grep-command-text",
			status: "running",
			title: "grep -R auth src",
			goal: "grep 'auth' src/index.ts",
			payload: {
				path: "grep auth ./src",
			},
		});
		recorder.recordTaskProgressEvent({
			source: "background",
			id: "go-yarn-cargo-command-text",
			status: "running",
			title: "go version",
			goal: "cargo build --release",
			payload: {
				yarn: "yarn test --watch",
			},
		});
		recorder.recordTaskProgressEvent({
			source: "background",
			id: "curl-wget-command-text",
			status: "running",
			title: "curl https://example.com/api",
			goal: "wget -O out https://example.com/file",
			payload: {
				curl: "curl example.com/path",
			},
		});
		recorder.recordTaskProgressEvent({
			source: "background",
			id: "package-manager-command-text",
			status: "running",
			title: "npm test",
			goal: "pnpm install --frozen-lockfile",
			payload: {
				script: "npm run build",
				path: "pnpm test ./packages/web",
				bun: "bun install --frozen-lockfile",
				bunScript: "bun run dev",
			},
		});
		recorder.recordTaskProgressEvent({
			source: "background",
			id: "make-command-text",
			status: "running",
			title: "make build",
			goal: "make web-local",
			payload: {
				chdir: "make -C packages/web build",
			},
		});
		await recorder.flush();

		expect(recordWorkItem).toHaveBeenCalledWith({
			runId: "run_1",
			workItem: expect.objectContaining({
				id: "maestro:session_1:todo:benign-prose",
				title: "fix login; update docs",
				goal: "Go over docs and review the bash docs",
				payload: expect.objectContaining({
					title: "fix login; update docs",
					goal: "Go over docs and review the bash docs",
					note: "Keep $10 pricing and OAuth wording",
					summary: "update auth | docs notes",
				}),
			}),
		});
		expect(recordWorkItem).toHaveBeenCalledWith({
			runId: "run_1",
			workItem: expect.objectContaining({
				id: "maestro:session_1:todo:benign-security-prose",
				title: "Document password rotation",
				goal: "Review bearer authentication flow",
				payload: expect.objectContaining({
					title: "Document password rotation",
					goal: "Review bearer authentication flow",
					note: "Keep authorization guidance readable",
				}),
			}),
		});
		expect(recordWorkItem).toHaveBeenCalledWith({
			runId: "run_1",
			workItem: expect.objectContaining({
				id: "maestro:session_1:todo:benign-executable-words",
				title: "npm package migration",
				goal: "python version support and kubectl docs",
				payload: expect.objectContaining({
					title: "npm package migration",
					goal: "python version support and kubectl docs",
					blocker: "terraform module design",
					biome: "biome check notes",
					buf: "buf lint config",
					docker: "docker documentation follow-up",
					dockerBuild: "docker build failure",
					git: "git authentication issue",
					gitCommit: "git commit message",
					gitStatus: "git status notes",
					gh: "gh actions migration",
					ghPr: "gh pr migration notes",
					ghWorkflow: "gh workflow ownership",
					kubectl: "kubectl version support",
					node: "node version support",
					npx: "npx package migration",
					pip: "pip install notes",
					pipShow: "pip show follow-up",
					sudo: "sudo access request",
					terraform: "terraform plan notes",
					uv: "uv run notes",
					uvx: "uvx ruff follow-up",
					vite: "vite build failure",
					vitest: "vitest run follow-up",
				}),
			}),
		});
		expect(recordWorkItem).toHaveBeenCalledWith({
			runId: "run_1",
			workItem: expect.objectContaining({
				id: "maestro:session_1:todo:benign-find-prose",
				title: "find root cause for login",
				goal: "find auth regression owner",
				payload: expect.objectContaining({
					title: "find root cause for login",
					goal: "find auth regression owner",
					note: "find the related ticket",
				}),
			}),
		});
		expect(recordWorkItem).toHaveBeenCalledWith({
			runId: "run_1",
			workItem: expect.objectContaining({
				id: "maestro:session_1:todo:benign-credential-shape-prose",
				title: "sketchbook notes",
				goal: "Authorization: Bearer token handling",
				payload: expect.objectContaining({
					title: "sketchbook notes",
					goal: "Authorization: Bearer token handling",
					digest: bareChecksum,
					note: "Document Authorization: Basic flow",
				}),
			}),
		});
		expect(recordWorkItem).toHaveBeenCalledWith({
			runId: "run_1",
			workItem: expect.objectContaining({
				id: "maestro:session_1:todo:benign-github-token-prefix-prose",
				title: "ghostwriter notes",
				goal: "ghostwritten docs follow-up",
				payload: expect.objectContaining({
					title: "ghostwriter notes",
					goal: "ghostwritten docs follow-up",
					note: "ghoul migration planning",
				}),
			}),
		});
		expect(recordWorkItem).toHaveBeenCalledWith({
			runId: "run_1",
			workItem: expect.objectContaining({
				id: "maestro:session_1:todo:benign-command-label-prose",
				title: "Command: document release process",
				goal: "Detected command: document release process",
				payload: expect.objectContaining({
					title: "Command: document release process",
					goal: "Detected command: document release process",
					note: "Command: document release process",
				}),
			}),
		});
		expect(recordWorkItem).toHaveBeenCalledWith({
			runId: "run_1",
			workItem: expect.objectContaining({
				id: "maestro:session_1:todo:benign-dev-server-url",
				title: "Inspect http://localhost:5173/@vite/client",
				goal: "Review Vite client URL http://localhost:5173/@vite/client",
				payload: expect.objectContaining({
					title: "Inspect http://localhost:5173/@vite/client",
					goal: "Review Vite client URL http://localhost:5173/@vite/client",
					url: "http://localhost:5173/@vite/client",
				}),
			}),
		});
		expect(recordWorkItem).toHaveBeenCalledWith({
			runId: "run_1",
			workItem: expect.objectContaining({
				id: "maestro:session_1:todo:benign-ssh-prose",
				title: "ssh authentication issue",
				goal: "ssh access follow-up",
				payload: expect.objectContaining({
					title: "ssh authentication issue",
					goal: "ssh access follow-up",
					note: "ssh terminology in docs",
				}),
			}),
		});
		expect(recordWorkItem).toHaveBeenCalledWith({
			runId: "run_1",
			workItem: expect.objectContaining({
				id: "maestro:session_1:todo:benign-grep-prose",
				title: "grep results incorrect",
				goal: "grep auth issue",
				payload: expect.objectContaining({
					title: "grep results incorrect",
					goal: "grep auth issue",
					note: "grep output needs review",
				}),
			}),
		});
		expect(recordWorkItem).toHaveBeenCalledWith({
			runId: "run_1",
			workItem: expect.objectContaining({
				id: "maestro:session_1:todo:benign-go-yarn-cargo-prose",
				title: "go version support",
				goal: "cargo build failure notes",
				payload: expect.objectContaining({
					title: "go version support",
					goal: "cargo build failure notes",
					note: "yarn test ownership",
				}),
			}),
		});
		expect(recordWorkItem).toHaveBeenCalledWith({
			runId: "run_1",
			workItem: expect.objectContaining({
				id: "maestro:session_1:todo:benign-curl-wget-prose",
				title: "curl docs update",
				goal: "wget migration notes",
				payload: expect.objectContaining({
					title: "curl docs update",
					goal: "wget migration notes",
					note: "curl examples backlog",
				}),
			}),
		});
		expect(recordWorkItem).toHaveBeenCalledWith({
			runId: "run_1",
			workItem: expect.objectContaining({
				id: "maestro:session_1:todo:benign-package-manager-prose",
				title: "npm version support",
				goal: "pnpm install notes",
				payload: expect.objectContaining({
					title: "npm version support",
					goal: "pnpm install notes",
					note: "npm audit follow-up",
					bun: "bun build failure notes",
				}),
			}),
		});
		expect(recordWorkItem).toHaveBeenCalledWith({
			runId: "run_1",
			workItem: expect.objectContaining({
				id: "maestro:session_1:todo:benign-make-prose",
				title: "make improvements",
				goal: "make accessible",
				payload: expect.objectContaining({
					title: "make improvements",
					goal: "make accessible",
					note: "make docs readable",
				}),
			}),
		});
		expect(recordWorkItem).toHaveBeenCalledWith({
			runId: "run_1",
			workItem: expect.objectContaining({
				id: "maestro:session_1:background:command-prose",
				title: "[redacted]",
				goal: "[redacted]",
				payload: expect.objectContaining({
					title: "[redacted]",
					goal: "[redacted]",
					command_summary: "[redacted]",
					docker: "[redacted]",
					git: "[redacted]",
					cargo: "[redacted]",
					echo: "[redacted]",
					go: "[redacted]",
					npm: "[redacted]",
					pip: "[redacted]",
					printf: "[redacted]",
					terraform: "[redacted]",
					yarn: "[redacted]",
				}),
			}),
		});
		expect(recordWorkItem).toHaveBeenCalledWith({
			runId: "run_1",
			workItem: expect.objectContaining({
				id: "maestro:session_1:background:credential-url",
				title: "[redacted]",
				goal: "Check credential URL",
				payload: expect.objectContaining({
					title: "[redacted]",
					goal: "Check credential URL",
					url: "[redacted]",
				}),
			}),
		});
		expect(recordWorkItem).toHaveBeenCalledWith({
			runId: "run_1",
			workItem: expect.objectContaining({
				id: "maestro:session_1:background:credential-token-shape",
				title: "[redacted]",
				goal: "[redacted]",
				payload: expect.objectContaining({
					title: "[redacted]",
					goal: "[redacted]",
					auth: "[redacted]",
					github: "[redacted]",
				}),
			}),
		});
		expect(recordWorkItem).toHaveBeenCalledWith({
			runId: "run_1",
			workItem: expect.objectContaining({
				id: "maestro:session_1:background:executable-command-text",
				title: "[redacted]",
				goal: "[redacted]",
				payload: expect.objectContaining({
					title: "[redacted]",
					goal: "[redacted]",
					biome: "[redacted]",
					buf: "[redacted]",
					docker: "[redacted]",
					gh: "[redacted]",
					ghWorkflow: "[redacted]",
					kubectl: "[redacted]",
					npm: "[redacted]",
					npx: "[redacted]",
					pip: "[redacted]",
					pipFreeze: "[redacted]",
					pipShow: "[redacted]",
					python: "[redacted]",
					sudo: "[redacted]",
					terraform: "[redacted]",
					uv: "[redacted]",
					uvx: "[redacted]",
					kubectlVersion: "[redacted]",
					vite: "[redacted]",
					vitest: "[redacted]",
					terraformPlan: "[redacted]",
				}),
			}),
		});
		expect(recordWorkItem).toHaveBeenCalledWith({
			runId: "run_1",
			workItem: expect.objectContaining({
				id: "maestro:session_1:background:remote-command-text",
				title: "[redacted]",
				goal: "[redacted]",
				payload: expect.objectContaining({
					title: "[redacted]",
					goal: "[redacted]",
					scp: "[redacted]",
					rsync: "[redacted]",
				}),
			}),
		});
		expect(recordWorkItem).toHaveBeenCalledWith({
			runId: "run_1",
			workItem: expect.objectContaining({
				id: "maestro:session_1:background:grep-command-text",
				title: "[redacted]",
				goal: "[redacted]",
				payload: expect.objectContaining({
					title: "[redacted]",
					goal: "[redacted]",
					path: "[redacted]",
				}),
			}),
		});
		expect(recordWorkItem).toHaveBeenCalledWith({
			runId: "run_1",
			workItem: expect.objectContaining({
				id: "maestro:session_1:background:go-yarn-cargo-command-text",
				title: "[redacted]",
				goal: "[redacted]",
				payload: expect.objectContaining({
					title: "[redacted]",
					goal: "[redacted]",
					yarn: "[redacted]",
				}),
			}),
		});
		expect(recordWorkItem).toHaveBeenCalledWith({
			runId: "run_1",
			workItem: expect.objectContaining({
				id: "maestro:session_1:background:curl-wget-command-text",
				title: "[redacted]",
				goal: "[redacted]",
				payload: expect.objectContaining({
					title: "[redacted]",
					goal: "[redacted]",
					curl: "[redacted]",
				}),
			}),
		});
		expect(recordWorkItem).toHaveBeenCalledWith({
			runId: "run_1",
			workItem: expect.objectContaining({
				id: "maestro:session_1:background:package-manager-command-text",
				title: "[redacted]",
				goal: "[redacted]",
				payload: expect.objectContaining({
					title: "[redacted]",
					goal: "[redacted]",
					script: "[redacted]",
					path: "[redacted]",
					bun: "[redacted]",
					bunScript: "[redacted]",
				}),
			}),
		});
		expect(recordWorkItem).toHaveBeenCalledWith({
			runId: "run_1",
			workItem: expect.objectContaining({
				id: "maestro:session_1:background:make-command-text",
				title: "[redacted]",
				goal: "[redacted]",
				payload: expect.objectContaining({
					title: "[redacted]",
					goal: "[redacted]",
					chdir: "[redacted]",
				}),
			}),
		});
		expect(recordEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Maestro todo task running",
				attributes: expect.objectContaining({
					title: "fix login; update docs",
					goal: "Go over docs and review the bash docs",
					note: "Keep $10 pricing and OAuth wording",
					summary: "update auth | docs notes",
				}),
			}),
		);
		expect(recordEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Maestro todo task running",
				attributes: expect.objectContaining({
					title: "npm package migration",
					goal: "python version support and kubectl docs",
					blocker: "terraform module design",
					biome: "biome check notes",
					buf: "buf lint config",
					docker: "docker documentation follow-up",
					dockerBuild: "docker build failure",
					git: "git authentication issue",
					gitCommit: "git commit message",
					gitStatus: "git status notes",
					gh: "gh actions migration",
					kubectl: "kubectl version support",
					node: "node version support",
					npx: "npx package migration",
					pip: "pip install notes",
					pipShow: "pip show follow-up",
					sudo: "sudo access request",
					terraform: "terraform plan notes",
					uv: "uv run notes",
					uvx: "uvx ruff follow-up",
					vite: "vite build failure",
					vitest: "vitest run follow-up",
				}),
			}),
		);
		expect(recordEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Maestro todo task running",
				attributes: expect.objectContaining({
					title: "Document password rotation",
					goal: "Review bearer authentication flow",
					note: "Keep authorization guidance readable",
				}),
			}),
		);
		expect(recordEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Maestro todo task running",
				attributes: expect.objectContaining({
					title: "sketchbook notes",
					goal: "Authorization: Bearer token handling",
					digest: bareChecksum,
					note: "Document Authorization: Basic flow",
				}),
			}),
		);
		expect(recordEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Maestro todo task running",
				attributes: expect.objectContaining({
					title: "ghostwriter notes",
					goal: "ghostwritten docs follow-up",
					note: "ghoul migration planning",
				}),
			}),
		);
		expect(recordEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Maestro todo task running",
				attributes: expect.objectContaining({
					title: "find root cause for login",
					goal: "find auth regression owner",
					note: "find the related ticket",
				}),
			}),
		);
		expect(recordEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Maestro todo task running",
				attributes: expect.objectContaining({
					title: "Command: document release process",
					goal: "Detected command: document release process",
					note: "Command: document release process",
				}),
			}),
		);
		expect(recordEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Maestro todo task running",
				attributes: expect.objectContaining({
					title: "Inspect http://localhost:5173/@vite/client",
					goal: "Review Vite client URL http://localhost:5173/@vite/client",
					url: "http://localhost:5173/@vite/client",
				}),
			}),
		);
		expect(recordEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Maestro todo task running",
				attributes: expect.objectContaining({
					title: "ssh authentication issue",
					goal: "ssh access follow-up",
					note: "ssh terminology in docs",
				}),
			}),
		);
		expect(recordEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Maestro todo task running",
				attributes: expect.objectContaining({
					title: "grep results incorrect",
					goal: "grep auth issue",
					note: "grep output needs review",
				}),
			}),
		);
		expect(recordEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Maestro todo task running",
				attributes: expect.objectContaining({
					title: "go version support",
					goal: "cargo build failure notes",
					note: "yarn test ownership",
				}),
			}),
		);
		expect(recordEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Maestro todo task running",
				attributes: expect.objectContaining({
					title: "curl docs update",
					goal: "wget migration notes",
					note: "curl examples backlog",
				}),
			}),
		);
		expect(recordEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Maestro todo task running",
				attributes: expect.objectContaining({
					title: "npm version support",
					goal: "pnpm install notes",
					note: "npm audit follow-up",
					bun: "bun build failure notes",
				}),
			}),
		);
		expect(recordEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Maestro background task running",
				attributes: expect.objectContaining({
					title: "[redacted]",
					goal: "[redacted]",
					auth: "[redacted]",
					github: "[redacted]",
				}),
			}),
		);
		expect(recordEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Maestro background task running",
				attributes: expect.objectContaining({
					title: "[redacted]",
					goal: "[redacted]",
					command_summary: "[redacted]",
					docker: "[redacted]",
					git: "[redacted]",
					npm: "[redacted]",
					pip: "[redacted]",
					yarn: "[redacted]",
				}),
			}),
		);
		expect(recordEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Maestro background task running",
				attributes: expect.objectContaining({
					title: "[redacted]",
					goal: "[redacted]",
					biome: "[redacted]",
					buf: "[redacted]",
					docker: "[redacted]",
					gh: "[redacted]",
					kubectl: "[redacted]",
					npm: "[redacted]",
					npx: "[redacted]",
					pip: "[redacted]",
					pipFreeze: "[redacted]",
					pipShow: "[redacted]",
					python: "[redacted]",
					sudo: "[redacted]",
					terraform: "[redacted]",
					uv: "[redacted]",
					uvx: "[redacted]",
					kubectlVersion: "[redacted]",
					vite: "[redacted]",
					vitest: "[redacted]",
					terraformPlan: "[redacted]",
				}),
			}),
		);
		expect(recordEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Maestro background task running",
				attributes: expect.objectContaining({
					title: "[redacted]",
					goal: "Check credential URL",
					url: "[redacted]",
				}),
			}),
		);
		expect(recordEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Maestro background task running",
				attributes: expect.objectContaining({
					title: "[redacted]",
					goal: "[redacted]",
					scp: "[redacted]",
					rsync: "[redacted]",
				}),
			}),
		);
		expect(recordEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Maestro background task running",
				attributes: expect.objectContaining({
					title: "[redacted]",
					goal: "[redacted]",
					path: "[redacted]",
				}),
			}),
		);
		expect(recordEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Maestro background task running",
				attributes: expect.objectContaining({
					title: "[redacted]",
					goal: "[redacted]",
					yarn: "[redacted]",
				}),
			}),
		);
		expect(recordEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Maestro background task running",
				attributes: expect.objectContaining({
					title: "[redacted]",
					goal: "[redacted]",
					curl: "[redacted]",
				}),
			}),
		);
		expect(recordEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Maestro background task running",
				attributes: expect.objectContaining({
					title: "[redacted]",
					goal: "[redacted]",
					script: "[redacted]",
					path: "[redacted]",
					bun: "[redacted]",
					bunScript: "[redacted]",
				}),
			}),
		);
	});

	it("redacts command-like and secret-like outbound progress fields", async () => {
		const {
			recorder,
			recordStep,
			recordEvent,
			recordWorkItem,
			updateWorkItem,
			waitRun,
			resumeRun,
			delegateAgent,
		} = createRecorder();
		const fakeGoogleApiKey = `AIza${"A".repeat(35)}`;
		recorder.recordAgentEvent({
			type: "tool_execution_start",
			toolCallId: "call_secret",
			toolName: "shell",
			displayName: "bash -lc 'echo $TOKEN'",
			summaryLabel: "Ran rm -rf /tmp/sk_live_SECRET_12345678",
			args: { command: "rm -rf /tmp/sk_live_SECRET_12345678" },
		});
		recorder.recordAgentEvent({
			type: "tool_execution_update",
			toolCallId: "call_secret",
			toolName: "shell",
			displayName: "bash -lc 'echo $TOKEN'",
			summaryLabel: "Streaming sk_live_SECRET_12345678",
			args: { command: "rm -rf /tmp/sk_live_SECRET_12345678" },
			partialResult: {
				content: [{ type: "text", text: "partial output" }],
				toolExecutionId: "texec_secret",
			},
		});
		recorder.recordAgentEvent({
			type: "tool_execution_end",
			toolCallId: "call_secret",
			toolExecutionId: "texec_secret",
			toolName: "shell",
			displayName: "sh -c 'echo artifact'",
			summaryLabel: "Artifact for sk_live_SECRET_12345678",
			result: {
				role: "toolResult",
				toolCallId: "call_secret",
				toolName: "shell",
				content: [{ type: "text", text: "done" }],
				isError: false,
				timestamp: 1,
			},
			isError: false,
			skillMetadata: {
				name: "shell-skill",
				hash: "sha256:secret-test",
				source: "project",
				artifactId: "artifact_secret",
			},
		} satisfies AgentEvent);
		recorder.recordAgentEvent({
			type: "tool_execution_start",
			toolCallId: "call_fine_grained_pat",
			toolName: "shell",
			displayName: "GitHub token github_pat_11AA22BB33CC44DD55",
			summaryLabel: "Using fine-grained token",
			args: {},
		});
		recorder.recordAgentEvent({
			type: "tool_execution_start",
			toolCallId: "call_google_api_key",
			toolName: "shell",
			displayName: `Google API key ${fakeGoogleApiKey}`,
			summaryLabel: "Using Gemini provider key",
			args: {},
		});
		for (const [toolCallId, displayName] of [
			[
				"call_bearer_token",
				"Provider error Authorization: Bearer bearer-token-value-1234567890",
			],
			[
				"call_basic_auth_token",
				"Provider error Basic dXNlcjpwYXNzd29yZC1wcm94eQ==",
			],
			["call_keyword_token", "Provider error token=keyword-token-value"],
			[
				"call_jwt_token",
				`Provider error token eyJ${"a".repeat(12)}.${"b".repeat(12)}.${"c".repeat(12)}`,
			],
			["call_long_hex_secret", `Provider error secret ${"a".repeat(64)}`],
		] as const) {
			recorder.recordAgentEvent({
				type: "tool_execution_start",
				toolCallId,
				toolName: "shell",
				displayName,
				summaryLabel: "Using provider credential",
				args: {},
			});
		}
		for (const [toolCallId, token] of [
			["call_github_oauth_token", "gho_11AA22BB33CC44DD55"],
			["call_github_user_token", "ghu_11AA22BB33CC44DD55"],
			["call_github_server_token", "ghs_11AA22BB33CC44DD55"],
			["call_github_refresh_token", "ghr_11AA22BB33CC44DD55"],
		] as const) {
			recorder.recordAgentEvent({
				type: "tool_execution_start",
				toolCallId,
				toolName: "shell",
				displayName: `GitHub token ${token}`,
				summaryLabel: "Using GitHub token prefix",
				args: {},
			});
		}
		recorder.recordAgentEvent({
			type: "tool_execution_start",
			toolCallId: "call_plain_command",
			toolName: "shell",
			displayName: "git push",
			summaryLabel: "rm -rf /tmp/plain",
			args: {},
		});
		recorder.recordAgentEvent({
			type: "tool_execution_start",
			toolCallId: "call_prefixed_command_summary",
			toolName: "shell",
			summaryLabel: "Ran npm test -- --runInBand",
			args: {},
		});
		for (const [toolCallId, summaryLabel] of [
			["call_prefixed_npx_summary", "Ran npx nx run maestro:test"],
			["call_prefixed_make_summary", "Ran make web-local"],
			["call_prefixed_yarn_summary", "Ran yarn test"],
			["call_prefixed_go_summary", "Ran go test ./..."],
		] as const) {
			recorder.recordAgentEvent({
				type: "tool_execution_start",
				toolCallId,
				toolName: "shell",
				summaryLabel,
				args: {},
			});
		}
		recorder.recordAgentEvent({
			type: "tool_execution_start",
			toolCallId: "call_raw_common_command",
			toolName: "shell",
			displayName: "bunx biome check .",
			summaryLabel: "yarn test",
			args: {},
		});
		recorder.recordAgentEvent({
			type: "tool_execution_start",
			toolCallId: "call_simple_shell_utility_label",
			toolName: "shell",
			displayName: "Ran ls -la",
			summaryLabel: "Ran cat package.json",
			args: {},
		});
		recorder.recordAgentEvent({
			type: "tool_execution_start",
			toolCallId: "call_search_shell_utility_label",
			toolName: "shell",
			displayName: 'Ran rg "TODO" src',
			summaryLabel: "Ran sed -n '1,80p' file",
			args: {},
		});
		recorder.recordAgentEvent({
			type: "tool_execution_start",
			toolCallId: "call_fd_shell_utility_label",
			toolName: "shell",
			displayName: "Ran fd package.json",
			summaryLabel: "Ran fd package.json packages",
			args: {},
		});
		recorder.recordAgentEvent({
			type: "tool_execution_start",
			toolCallId: "call_file_shell_utility_label",
			toolName: "shell",
			displayName: "Ran cp .env /tmp/backup",
			summaryLabel: "Ran mv secret.txt out/",
			args: {},
		});
		recorder.recordAgentEvent({
			type: "tool_execution_start",
			toolCallId: "call_fs_shell_utility_label",
			toolName: "shell",
			displayName: "Ran mkdir -p dist",
			summaryLabel: "Ran touch .env",
			args: {},
		});
		recorder.recordAgentEvent({
			type: "tool_execution_start",
			toolCallId: "call_archive_shell_utility_label",
			toolName: "shell",
			displayName: "Ran chmod 600 key.pem",
			summaryLabel: "Ran tar -czf logs.tgz logs",
			args: {},
		});
		recorder.recordAgentEvent({
			type: "tool_execution_start",
			toolCallId: "call_find_shell_utility_label",
			toolName: "shell",
			displayName: "Ran find . -name '*.env' -print",
			summaryLabel: "Ran find src -type f -name '*.ts'",
			args: {},
		});
		recorder.recordAgentEvent({
			type: "tool_execution_start",
			toolCallId: "call_remote_shell_utility_label",
			toolName: "shell",
			displayName: "Ran ssh prod.example",
			summaryLabel: "Ran scp .env host:/tmp",
			args: {},
		});
		recorder.recordAgentEvent({
			type: "tool_execution_start",
			toolCallId: "call_rsync_shell_utility_label",
			toolName: "shell",
			displayName: "Ran rsync -av secrets/ host:/tmp",
			summaryLabel: "Ran rsync logs/ host:/tmp",
			args: {},
		});
		recorder.recordAgentEvent({
			type: "tool_execution_start",
			toolCallId: "call_generated_shell_label",
			toolName: "shell",
			displayName: "Ran pwd",
			summaryLabel: "Ran date",
			args: {},
		});
		recorder.recordAgentEvent({
			type: "tool_execution_start",
			toolCallId: "call_generated_bash_label",
			toolName: "bash",
			displayName: "Ran uname -a",
			summaryLabel: "Ran which node",
			args: {},
		});
		recorder.recordAgentEvent({
			type: "tool_execution_update",
			toolCallId: "call_plain_command",
			toolName: "shell",
			displayName: "git push",
			summaryLabel: "rm -rf /tmp/plain",
			args: {},
			partialResult: {
				content: [{ type: "text", text: "partial output" }],
				toolExecutionId: "texec_plain_command",
			},
		});
		recorder.recordAgentEvent({
			type: "tool_execution_start",
			toolCallId: "subagent_secret",
			toolName: "codex.subagent.spawnAgent",
			displayName: "bash -lc 'echo $SUBAGENT_TOKEN'",
			summaryLabel: "Spawn with sk_live_SUBAGENT_12345678",
			args: {
				codexTool: "spawnAgent",
				receiverThreadIds: ["child-thread-secret"],
				childRunIds: ["agent-run-secret"],
				prompt:
					"Review github_pat_11AA22BB33CC44DD55 before running bash -lc 'echo $TOKEN'",
			},
		});
		recorder.recordAgentEvent({
			type: "tool_execution_end",
			toolCallId: "subagent_secret",
			toolName: "codex.subagent.spawnAgent",
			displayName: "sh -c 'echo done'",
			summaryLabel: "Completed with sk_live_SUBAGENT_12345678",
			result: {
				role: "toolResult",
				toolCallId: "subagent_secret",
				toolName: "codex.subagent.spawnAgent",
				content: [{ type: "text", text: "spawn completed" }],
				details: {
					codexTool: "spawnAgent",
					receiverThreadIds: ["child-thread-secret"],
					childRunIds: ["agent-run-secret"],
				},
				isError: false,
				timestamp: 2,
			},
			isError: false,
		} satisfies AgentEvent);
		recorder.recordPromptFailure("failed with sk_live_SECRET_12345678");
		recorder.recordServerRequestEvent({
			type: "registered",
			request: {
				id: "approval_2",
				kind: "approval",
				sessionId: "session_1",
				callId: "call_secret",
				toolName: "shell",
				args: {},
				reason: "Detected command: rm -rf /tmp/sk_live_SECRET_12345678",
				timestamp: Date.now(),
				timeoutMs: 60_000,
				displayName: "sh -c whoami",
				summaryLabel: "Ran sh -c whoami",
			},
		});
		recorder.recordServerRequestEvent({
			type: "registered",
			request: {
				id: "approval_generated_shell_label",
				kind: "approval",
				sessionId: "session_1",
				callId: "call_plain_command",
				toolName: "shell",
				args: {},
				reason: "Approval required",
				timestamp: Date.now(),
				timeoutMs: 60_000,
				summaryLabel: "Ran pwd",
			},
		});
		recorder.recordServerRequestEvent({
			type: "resolved",
			request: {
				id: "approval_2",
				kind: "approval",
				sessionId: "session_1",
				callId: "call_secret",
				toolName: "shell",
				args: {},
				reason: "reason",
				timestamp: Date.now(),
				timeoutMs: 60_000,
			},
			resolution: "denied",
			resolvedBy: "user",
			reason: "Contains sk_live_SECRET_12345678",
		});
		recorder.recordServerRequestEvent({
			type: "registered",
			request: {
				id: "approval_embedded_command",
				kind: "approval",
				sessionId: "session_1",
				callId: "call_plain_command",
				toolName: "shell",
				args: {},
				reason: "Detected command: rm -rf /tmp/plain",
				timestamp: Date.now(),
				timeoutMs: 60_000,
			},
		});
		recorder.recordServerRequestEvent({
			type: "resolved",
			request: {
				id: "approval_embedded_command",
				kind: "approval",
				sessionId: "session_1",
				callId: "call_plain_command",
				toolName: "shell",
				args: {},
				reason: "reason",
				timestamp: Date.now(),
				timeoutMs: 60_000,
			},
			resolution: "denied",
			resolvedBy: "user",
			reason: "Command failed: npm test",
		});
		recorder.recordServerRequestEvent({
			type: "registered",
			request: {
				id: "approval_path_command",
				kind: "approval",
				sessionId: "session_1",
				callId: "call_plain_command",
				toolName: "shell",
				args: {},
				reason: "Detected command: ./scripts/deploy.sh prod",
				timestamp: Date.now(),
				timeoutMs: 60_000,
			},
		});
		recorder.recordServerRequestEvent({
			type: "resolved",
			request: {
				id: "approval_path_command",
				kind: "approval",
				sessionId: "session_1",
				callId: "call_plain_command",
				toolName: "shell",
				args: {},
				reason: "reason",
				timestamp: Date.now(),
				timeoutMs: 60_000,
			},
			resolution: "denied",
			resolvedBy: "user",
			reason: "Command: ../bin/tool --flag",
		});
		recorder.recordServerRequestEvent({
			type: "registered",
			request: {
				id: "approval_make_command",
				kind: "approval",
				sessionId: "session_1",
				callId: "call_plain_command",
				toolName: "shell",
				args: {},
				reason: "Command failed: make -C packages/web build",
				timestamp: Date.now(),
				timeoutMs: 60_000,
			},
		});
		recorder.recordServerRequestEvent({
			type: "resolved",
			request: {
				id: "approval_make_command",
				kind: "approval",
				sessionId: "session_1",
				callId: "call_plain_command",
				toolName: "shell",
				args: {},
				reason: "reason",
				timestamp: Date.now(),
				timeoutMs: 60_000,
			},
			resolution: "denied",
			resolvedBy: "user",
			reason: "Command failed: make web-local FOO=bar",
		});
		recorder.recordServerRequestEvent({
			type: "registered",
			request: {
				id: "approval_pytest_command",
				kind: "approval",
				sessionId: "session_1",
				callId: "call_plain_command",
				toolName: "shell",
				args: {},
				reason: "Command failed: pytest tests",
				timestamp: Date.now(),
				timeoutMs: 60_000,
			},
		});
		recorder.recordServerRequestEvent({
			type: "registered",
			request: {
				id: "approval_wrapped_command",
				kind: "approval",
				sessionId: "session_1",
				callId: "call_plain_command",
				toolName: "shell",
				args: {},
				reason: "Command failed: `npm test`",
				timestamp: Date.now(),
				timeoutMs: 60_000,
			},
		});
		recorder.recordServerRequestEvent({
			type: "registered",
			request: {
				id: "approval_bare_make_command",
				kind: "approval",
				sessionId: "session_1",
				callId: "call_plain_command",
				toolName: "shell",
				args: {},
				reason: "Command failed: make",
				timestamp: Date.now(),
				timeoutMs: 60_000,
			},
		});
		recorder.recordServerRequestEvent({
			type: "registered",
			request: {
				id: "approval_make_multi_target_command",
				kind: "approval",
				sessionId: "session_1",
				callId: "call_plain_command",
				toolName: "shell",
				args: {},
				reason: "Command failed: make test build",
				timestamp: Date.now(),
				timeoutMs: 60_000,
			},
		});
		recorder.recordServerRequestEvent({
			type: "registered",
			request: {
				id: "approval_make_project_targets_command",
				kind: "approval",
				sessionId: "session_1",
				callId: "call_plain_command",
				toolName: "shell",
				args: {},
				reason: "Command failed: make deploy prod",
				timestamp: Date.now(),
				timeoutMs: 60_000,
			},
		});
		recorder.recordServerRequestEvent({
			type: "registered",
			request: {
				id: "approval_chained_builtin_command",
				kind: "approval",
				sessionId: "session_1",
				callId: "call_plain_command",
				toolName: "shell",
				args: {},
				reason: "Command failed: cd packages/web && npm test",
				timestamp: Date.now(),
				timeoutMs: 60_000,
			},
		});
		recorder.recordServerRequestEvent({
			type: "registered",
			request: {
				id: "approval_multiline_prefixed_command",
				kind: "approval",
				sessionId: "session_1",
				callId: "call_plain_command",
				toolName: "shell",
				args: {},
				reason: "Command failed: npm test\nstderr: failed tests",
				timestamp: Date.now(),
				timeoutMs: 60_000,
			},
		});
		recorder.recordServerRequestEvent({
			type: "registered",
			request: {
				id: "approval_uv_command",
				kind: "approval",
				sessionId: "session_1",
				callId: "call_plain_command",
				toolName: "shell",
				args: {},
				reason: "Command failed: uv run pytest",
				timestamp: Date.now(),
				timeoutMs: 60_000,
			},
		});
		recorder.recordServerRequestEvent({
			type: "registered",
			request: {
				id: "approval_explicit_unknown_cli_command",
				kind: "approval",
				sessionId: "session_1",
				callId: "call_plain_command",
				toolName: "shell",
				args: {},
				reason: "Command failed: ruff check .",
				timestamp: Date.now(),
				timeoutMs: 60_000,
			},
		});
		recorder.recordServerRequestEvent({
			type: "registered",
			request: {
				id: "approval_env_prefixed_command",
				kind: "approval",
				sessionId: "session_1",
				callId: "call_plain_command",
				toolName: "shell",
				args: {},
				reason: "Command failed: CI=1 npm test",
				timestamp: Date.now(),
				timeoutMs: 60_000,
			},
		});
		recorder.recordServerRequestEvent({
			type: "registered",
			request: {
				id: "approval_env_wrapped_command",
				kind: "approval",
				sessionId: "session_1",
				callId: "call_plain_command",
				toolName: "shell",
				args: {},
				reason: "Command failed: env CI=1 npm test",
				timestamp: Date.now(),
				timeoutMs: 60_000,
			},
		});
		recorder.recordServerRequestEvent({
			type: "registered",
			request: {
				id: "approval_detected_dangerous_command",
				kind: "approval",
				sessionId: "session_1",
				callId: "call_plain_command",
				toolName: "shell",
				args: {},
				reason: "Detected dangerous rm command: rm -rf /tmp/plain",
				timestamp: Date.now(),
				timeoutMs: 60_000,
			},
		});
		await recorder.flush();
		expect(recordStep).toHaveBeenCalledWith(
			expect.objectContaining({
				step: expect.objectContaining({
					name: "[redacted]",
					input: expect.objectContaining({
						display_name: "[redacted]",
						summary_label: "[redacted]",
					}),
				}),
			}),
		);
		expect(recordStep).toHaveBeenCalledWith(
			expect.objectContaining({
				step: expect.objectContaining({
					id: "maestro:session_1:tool:call_fine_grained_pat",
					name: "[redacted]",
				}),
			}),
		);
		expect(recordStep).toHaveBeenCalledWith(
			expect.objectContaining({
				step: expect.objectContaining({
					id: "maestro:session_1:tool:call_google_api_key",
					name: "[redacted]",
				}),
			}),
		);
		for (const toolCallId of [
			"call_github_oauth_token",
			"call_github_user_token",
			"call_github_server_token",
			"call_github_refresh_token",
			"call_google_api_key",
			"call_bearer_token",
			"call_basic_auth_token",
			"call_keyword_token",
			"call_jwt_token",
			"call_long_hex_secret",
		]) {
			expect(recordStep).toHaveBeenCalledWith(
				expect.objectContaining({
					step: expect.objectContaining({
						id: `maestro:session_1:tool:${toolCallId}`,
						name: "[redacted]",
					}),
				}),
			);
		}
		expect(recordStep).toHaveBeenCalledWith(
			expect.objectContaining({
				step: expect.objectContaining({
					id: "maestro:session_1:tool:call_plain_command",
					input: expect.objectContaining({
						display_name: "[redacted]",
						summary_label: "[redacted]",
					}),
					name: "[redacted]",
				}),
			}),
		);
		expect(recordStep).toHaveBeenCalledWith(
			expect.objectContaining({
				step: expect.objectContaining({
					id: "maestro:session_1:tool:call_prefixed_command_summary",
					input: expect.objectContaining({
						summary_label: "[redacted]",
					}),
					name: "[redacted]",
				}),
			}),
		);
		for (const toolCallId of [
			"call_prefixed_npx_summary",
			"call_prefixed_make_summary",
			"call_prefixed_yarn_summary",
			"call_prefixed_go_summary",
		]) {
			expect(recordStep).toHaveBeenCalledWith(
				expect.objectContaining({
					step: expect.objectContaining({
						id: `maestro:session_1:tool:${toolCallId}`,
						input: expect.objectContaining({
							summary_label: "[redacted]",
						}),
						name: "[redacted]",
					}),
				}),
			);
		}
		expect(recordStep).toHaveBeenCalledWith(
			expect.objectContaining({
				step: expect.objectContaining({
					id: "maestro:session_1:tool:call_raw_common_command",
					input: expect.objectContaining({
						display_name: "[redacted]",
						summary_label: "[redacted]",
					}),
					name: "[redacted]",
				}),
			}),
		);
		expect(recordStep).toHaveBeenCalledWith(
			expect.objectContaining({
				step: expect.objectContaining({
					id: "maestro:session_1:tool:call_simple_shell_utility_label",
					input: expect.objectContaining({
						display_name: "[redacted]",
						summary_label: "[redacted]",
					}),
					name: "[redacted]",
				}),
			}),
		);
		for (const toolCallId of [
			"call_search_shell_utility_label",
			"call_fd_shell_utility_label",
			"call_file_shell_utility_label",
			"call_fs_shell_utility_label",
			"call_archive_shell_utility_label",
			"call_find_shell_utility_label",
			"call_remote_shell_utility_label",
			"call_rsync_shell_utility_label",
			"call_generated_shell_label",
			"call_generated_bash_label",
		]) {
			expect(recordStep).toHaveBeenCalledWith(
				expect.objectContaining({
					step: expect.objectContaining({
						id: `maestro:session_1:tool:${toolCallId}`,
						input: expect.objectContaining({
							display_name: "[redacted]",
							summary_label: "[redacted]",
						}),
						name: "[redacted]",
					}),
				}),
			);
		}
		expect(recordStep).toHaveBeenCalledWith(
			expect.objectContaining({
				step: expect.objectContaining({
					name: "Prompt failed",
					errorMessage: "[redacted]",
				}),
			}),
		);
		expect(recordEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				attributes: expect.objectContaining({
					error_message: "[redacted]",
				}),
			}),
		);
		expect(recordEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Maestro tool execution update recorded",
				attributes: expect.objectContaining({
					display_name: "[redacted]",
					summary_label: "[redacted]",
					tool_call_id: "call_plain_command",
				}),
			}),
		);
		expect(recordEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Maestro tool artifact evidence recorded",
				artifactId: "artifact_secret",
				attributes: expect.objectContaining({
					display_name: "[redacted]",
					summary_label: "[redacted]",
				}),
			}),
		);
		expect(recordWorkItem).toHaveBeenCalledWith(
			expect.objectContaining({
				workItem: expect.objectContaining({
					title: "[redacted]",
					goal: "[redacted]",
					payload: expect.objectContaining({
						display_name: "[redacted]",
						summary_label: "[redacted]",
					}),
				}),
			}),
		);
		expect(updateWorkItem).toHaveBeenCalledWith(
			expect.objectContaining({
				workItemId: "maestro:session_1:work:subagent_secret",
				payload: expect.objectContaining({
					display_name: "[redacted]",
					summary_label: "[redacted]",
				}),
			}),
		);
		expect(delegateAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				contextPayload: expect.objectContaining({
					display_name: "[redacted]",
					prompt: "[redacted]",
					summary_label: "[redacted]",
				}),
				reason: "Codex subagent spawn requested by Maestro: [redacted]",
			}),
		);
		expect(waitRun).toHaveBeenCalledWith(
			expect.objectContaining({
				wait: expect.objectContaining({
					reason: "[redacted]",
					payload: expect.objectContaining({
						display_name: "[redacted]",
						summary_label: "[redacted]",
					}),
				}),
			}),
		);
		expect(waitRun).toHaveBeenCalledWith(
			expect.objectContaining({
				wait: expect.objectContaining({
					externalRef: "approval_generated_shell_label",
					reason: "Approval required",
					payload: expect.objectContaining({
						summary_label: "[redacted]",
					}),
				}),
			}),
		);
		expect(resumeRun).toHaveBeenCalledWith(
			expect.objectContaining({
				payload: expect.objectContaining({
					reason: "[redacted]",
				}),
			}),
		);
		expect(waitRun).toHaveBeenCalledWith(
			expect.objectContaining({
				wait: expect.objectContaining({
					externalRef: "approval_embedded_command",
					reason: "[redacted]",
				}),
			}),
		);
		expect(resumeRun).toHaveBeenCalledWith(
			expect.objectContaining({
				resumeEventId: "maestro:session_1:resume:approval_embedded_command",
				payload: expect.objectContaining({
					reason: "[redacted]",
				}),
			}),
		);
		expect(waitRun).toHaveBeenCalledWith(
			expect.objectContaining({
				wait: expect.objectContaining({
					externalRef: "approval_path_command",
					reason: "[redacted]",
				}),
			}),
		);
		expect(resumeRun).toHaveBeenCalledWith(
			expect.objectContaining({
				resumeEventId: "maestro:session_1:resume:approval_path_command",
				payload: expect.objectContaining({
					reason: "[redacted]",
				}),
			}),
		);
		expect(waitRun).toHaveBeenCalledWith(
			expect.objectContaining({
				wait: expect.objectContaining({
					externalRef: "approval_make_command",
					reason: "[redacted]",
				}),
			}),
		);
		expect(resumeRun).toHaveBeenCalledWith(
			expect.objectContaining({
				resumeEventId: "maestro:session_1:resume:approval_make_command",
				payload: expect.objectContaining({
					reason: "[redacted]",
				}),
			}),
		);
		expect(waitRun).toHaveBeenCalledWith(
			expect.objectContaining({
				wait: expect.objectContaining({
					externalRef: "approval_pytest_command",
					reason: "[redacted]",
				}),
			}),
		);
		expect(waitRun).toHaveBeenCalledWith(
			expect.objectContaining({
				wait: expect.objectContaining({
					externalRef: "approval_bare_make_command",
					reason: "[redacted]",
				}),
			}),
		);
		expect(waitRun).toHaveBeenCalledWith(
			expect.objectContaining({
				wait: expect.objectContaining({
					externalRef: "approval_wrapped_command",
					reason: "[redacted]",
				}),
			}),
		);
		expect(waitRun).toHaveBeenCalledWith(
			expect.objectContaining({
				wait: expect.objectContaining({
					externalRef: "approval_make_multi_target_command",
					reason: "[redacted]",
				}),
			}),
		);
		expect(waitRun).toHaveBeenCalledWith(
			expect.objectContaining({
				wait: expect.objectContaining({
					externalRef: "approval_make_project_targets_command",
					reason: "[redacted]",
				}),
			}),
		);
		expect(waitRun).toHaveBeenCalledWith(
			expect.objectContaining({
				wait: expect.objectContaining({
					externalRef: "approval_chained_builtin_command",
					reason: "[redacted]",
				}),
			}),
		);
		expect(waitRun).toHaveBeenCalledWith(
			expect.objectContaining({
				wait: expect.objectContaining({
					externalRef: "approval_multiline_prefixed_command",
					reason: "[redacted]",
				}),
			}),
		);
		expect(waitRun).toHaveBeenCalledWith(
			expect.objectContaining({
				wait: expect.objectContaining({
					externalRef: "approval_uv_command",
					reason: "[redacted]",
				}),
			}),
		);
		expect(waitRun).toHaveBeenCalledWith(
			expect.objectContaining({
				wait: expect.objectContaining({
					externalRef: "approval_explicit_unknown_cli_command",
					reason: "[redacted]",
				}),
			}),
		);
		expect(waitRun).toHaveBeenCalledWith(
			expect.objectContaining({
				wait: expect.objectContaining({
					externalRef: "approval_env_prefixed_command",
					reason: "[redacted]",
				}),
			}),
		);
		expect(waitRun).toHaveBeenCalledWith(
			expect.objectContaining({
				wait: expect.objectContaining({
					externalRef: "approval_env_wrapped_command",
					reason: "[redacted]",
				}),
			}),
		);
		expect(waitRun).toHaveBeenCalledWith(
			expect.objectContaining({
				wait: expect.objectContaining({
					externalRef: "approval_detected_dangerous_command",
					reason: "[redacted]",
				}),
			}),
		);
	});

	it("preserves benign prose with punctuation in outbound progress fields", async () => {
		const { recorder, recordStep } = createRecorder();

		recorder.recordAgentEvent({
			type: "tool_execution_start",
			toolCallId: "call_benign_prose",
			toolName: "task",
			displayName: "make login faster",
			summaryLabel: "Go over docs",
			args: {},
		});
		await recorder.flush();

		expect(recordStep).toHaveBeenCalledWith(
			expect.objectContaining({
				step: expect.objectContaining({
					id: "maestro:session_1:tool:call_benign_prose",
					name: "make login faster",
					input: expect.objectContaining({
						display_name: "make login faster",
						summary_label: "Go over docs",
					}),
				}),
			}),
		);
	});

	it("redacts embedded command prompts from Codex subagent goals", async () => {
		const { recorder, recordWorkItem, delegateAgent } = createRecorder();

		recorder.recordAgentEvent({
			type: "tool_execution_start",
			toolCallId: "subagent_command_prompt",
			toolName: "codex.subagent.spawnAgent",
			displayName: "Spawn test runner",
			summaryLabel: "Run tests",
			args: {
				codexTool: "spawnAgent",
				receiverThreadIds: ["child-thread-command"],
				childRunIds: ["agent-run-command"],
				prompt: "Please run `npm test -- --runInBand`",
			},
		});
		await recorder.flush();

		expect(recordWorkItem).toHaveBeenCalledWith(
			expect.objectContaining({
				workItem: expect.objectContaining({
					goal: "[redacted]",
				}),
			}),
		);
		expect(delegateAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				contextPayload: expect.objectContaining({
					prompt: "[redacted]",
				}),
				reason: "Codex subagent spawn requested by Maestro: [redacted]",
			}),
		);

		recorder.recordAgentEvent({
			type: "tool_execution_start",
			toolCallId: "subagent_gh_command_prompt",
			toolName: "codex.subagent.spawnAgent",
			displayName: "Spawn GitHub reviewer",
			summaryLabel: "Run GitHub CLI",
			args: {
				codexTool: "spawnAgent",
				receiverThreadIds: ["child-thread-gh"],
				childRunIds: ["agent-run-gh"],
				prompt: "Please run gh pr list --repo evalops/maestro-internal",
			},
		});
		await recorder.flush();

		expect(recordWorkItem).toHaveBeenCalledWith(
			expect.objectContaining({
				workItem: expect.objectContaining({
					id: "maestro:session_1:work:subagent_gh_command_prompt",
					goal: "[redacted]",
				}),
			}),
		);
		expect(delegateAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				contextPayload: expect.objectContaining({
					tool_call_id: "subagent_gh_command_prompt",
					prompt: "[redacted]",
				}),
				reason: "Codex subagent spawn requested by Maestro: [redacted]",
			}),
		);

		recorder.recordAgentEvent({
			type: "tool_execution_start",
			toolCallId: "subagent_pytest_prompt",
			toolName: "codex.subagent.spawnAgent",
			displayName: "Spawn Python tester",
			summaryLabel: "Run pytest",
			args: {
				codexTool: "spawnAgent",
				receiverThreadIds: ["child-thread-pytest"],
				childRunIds: ["agent-run-pytest"],
				prompt: "Please run pytest -k auth",
			},
		});
		await recorder.flush();

		expect(recordWorkItem).toHaveBeenCalledWith(
			expect.objectContaining({
				workItem: expect.objectContaining({
					id: "maestro:session_1:work:subagent_pytest_prompt",
					goal: "[redacted]",
				}),
			}),
		);
		expect(delegateAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				contextPayload: expect.objectContaining({
					tool_call_id: "subagent_pytest_prompt",
					prompt: "[redacted]",
				}),
				reason: "Codex subagent spawn requested by Maestro: [redacted]",
			}),
		);

		recorder.recordAgentEvent({
			type: "tool_execution_start",
			toolCallId: "subagent_chained_builtin_prompt",
			toolName: "codex.subagent.spawnAgent",
			displayName: "Spawn web tester",
			summaryLabel: "Run web tests",
			args: {
				codexTool: "spawnAgent",
				receiverThreadIds: ["child-thread-web"],
				childRunIds: ["agent-run-web"],
				prompt: "Please run cd packages/web && npm test",
			},
		});
		await recorder.flush();

		expect(recordWorkItem).toHaveBeenCalledWith(
			expect.objectContaining({
				workItem: expect.objectContaining({
					id: "maestro:session_1:work:subagent_chained_builtin_prompt",
					goal: "[redacted]",
				}),
			}),
		);
		expect(delegateAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				contextPayload: expect.objectContaining({
					tool_call_id: "subagent_chained_builtin_prompt",
					prompt: "[redacted]",
				}),
				reason: "Codex subagent spawn requested by Maestro: [redacted]",
			}),
		);

		recorder.recordAgentEvent({
			type: "tool_execution_start",
			toolCallId: "subagent_wrapped_trailing_prompt",
			toolName: "codex.subagent.spawnAgent",
			displayName: "Spawn test reporter",
			summaryLabel: "Run test report",
			args: {
				codexTool: "spawnAgent",
				receiverThreadIds: ["child-thread-report"],
				childRunIds: ["agent-run-report"],
				prompt: "Please run `npm test` and report failures",
			},
		});
		await recorder.flush();

		expect(recordWorkItem).toHaveBeenCalledWith(
			expect.objectContaining({
				workItem: expect.objectContaining({
					id: "maestro:session_1:work:subagent_wrapped_trailing_prompt",
					goal: "[redacted]",
				}),
			}),
		);
		expect(delegateAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				contextPayload: expect.objectContaining({
					tool_call_id: "subagent_wrapped_trailing_prompt",
					prompt: "[redacted]",
				}),
				reason: "Codex subagent spawn requested by Maestro: [redacted]",
			}),
		);

		recorder.recordAgentEvent({
			type: "tool_execution_start",
			toolCallId: "subagent_uvx_prompt",
			toolName: "codex.subagent.spawnAgent",
			displayName: "Spawn Python linter",
			summaryLabel: "Run ruff",
			args: {
				codexTool: "spawnAgent",
				receiverThreadIds: ["child-thread-uvx"],
				childRunIds: ["agent-run-uvx"],
				prompt: "Please run uvx ruff check",
			},
		});
		await recorder.flush();

		expect(recordWorkItem).toHaveBeenCalledWith(
			expect.objectContaining({
				workItem: expect.objectContaining({
					id: "maestro:session_1:work:subagent_uvx_prompt",
					goal: "[redacted]",
				}),
			}),
		);
		expect(delegateAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				contextPayload: expect.objectContaining({
					tool_call_id: "subagent_uvx_prompt",
					prompt: "[redacted]",
				}),
				reason: "Codex subagent spawn requested by Maestro: [redacted]",
			}),
		);

		recorder.recordAgentEvent({
			type: "tool_execution_start",
			toolCallId: "subagent_env_prefixed_prompt",
			toolName: "codex.subagent.spawnAgent",
			displayName: "Spawn test runner",
			summaryLabel: "Run tests",
			args: {
				codexTool: "spawnAgent",
				receiverThreadIds: ["child-thread-env"],
				childRunIds: ["agent-run-env"],
				prompt: "Please run NODE_ENV=test bun test",
			},
		});
		await recorder.flush();

		expect(recordWorkItem).toHaveBeenCalledWith(
			expect.objectContaining({
				workItem: expect.objectContaining({
					id: "maestro:session_1:work:subagent_env_prefixed_prompt",
					goal: "[redacted]",
				}),
			}),
		);
		expect(delegateAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				contextPayload: expect.objectContaining({
					tool_call_id: "subagent_env_prefixed_prompt",
					prompt: "[redacted]",
				}),
				reason: "Codex subagent spawn requested by Maestro: [redacted]",
			}),
		);

		recorder.recordAgentEvent({
			type: "tool_execution_start",
			toolCallId: "subagent_env_wrapped_prompt",
			toolName: "codex.subagent.spawnAgent",
			displayName: "Spawn package test runner",
			summaryLabel: "Run package tests",
			args: {
				codexTool: "spawnAgent",
				receiverThreadIds: ["child-thread-env-wrapper"],
				childRunIds: ["agent-run-env-wrapper"],
				prompt: "Please run env -C packages/web npm test",
			},
		});
		await recorder.flush();

		expect(recordWorkItem).toHaveBeenCalledWith(
			expect.objectContaining({
				workItem: expect.objectContaining({
					id: "maestro:session_1:work:subagent_env_wrapped_prompt",
					goal: "[redacted]",
				}),
			}),
		);
		expect(delegateAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				contextPayload: expect.objectContaining({
					tool_call_id: "subagent_env_wrapped_prompt",
					prompt: "[redacted]",
				}),
				reason: "Codex subagent spawn requested by Maestro: [redacted]",
			}),
		);
	});

	it("preserves benign delegation prompts beyond telemetry label length", async () => {
		const { recorder, recordWorkItem, delegateAgent } = createRecorder();
		const longPrompt =
			"Review the hosted progress redaction behavior and summarize the routing context for the release steward. ".repeat(
				6,
			);
		const expectedDelegationPrompt = longPrompt.slice(0, 512);

		recorder.recordAgentEvent({
			type: "tool_execution_start",
			toolCallId: "subagent_long_benign_prompt",
			toolName: "codex.subagent.spawnAgent",
			displayName: "Spawn release reviewer",
			summaryLabel: "Coordinate release review",
			args: {
				codexTool: "spawnAgent",
				receiverThreadIds: ["child-thread-long"],
				childRunIds: ["agent-run-long"],
				prompt: longPrompt,
			},
		});
		await recorder.flush();

		expect(recordWorkItem).toHaveBeenCalledWith(
			expect.objectContaining({
				workItem: expect.objectContaining({
					goal: `${longPrompt.slice(0, 159)}…`,
				}),
			}),
		);
		expect(delegateAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				contextPayload: expect.objectContaining({
					prompt: expectedDelegationPrompt,
				}),
				reason:
					`Codex subagent spawn requested by Maestro: ${expectedDelegationPrompt}`.slice(
						0,
						512,
					),
			}),
		);
	});
});
