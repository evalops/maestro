import { describe, expect, it } from "vitest";
import type { Agent } from "../../src/agent/agent.js";
import type { AgentEvent, AssistantMessage } from "../../src/agent/types.js";
import { TurnTracker } from "../../src/telemetry/turn-tracker.js";

describe("TurnTracker", () => {
	it("does not start LLM timing on user message boundaries", () => {
		let listener: ((event: AgentEvent) => void) | undefined;
		const agent = {
			state: {
				messages: [],
				error: undefined,
				model: {
					id: "test-model",
					provider: "anthropic",
				},
				thinkingLevel: "off",
			},
			subscribe: (fn: (event: AgentEvent) => void) => {
				listener = fn;
				return () => {
					listener = undefined;
				};
			},
		} as unknown as Agent;

		let completed: { llmDurationMs: number } | undefined;
		const tracker = new TurnTracker(agent, {
			sessionId: "session-1",
			onTurnComplete: (event) => {
				completed = event;
			},
		});

		const userMessage = {
			role: "user",
			content: [{ type: "text", text: "hi" }],
			timestamp: Date.now(),
		};

		listener?.({ type: "agent_start" });
		listener?.({ type: "message_start", message: userMessage });
		listener?.({ type: "message_end", message: userMessage });
		listener?.({ type: "agent_end", messages: [] });

		tracker.dispose();

		expect(completed).toBeTruthy();
		expect(completed?.llmDurationMs).toBe(0);
	});

	it("does not classify a max-output stop as context overflow", () => {
		let listener: ((event: AgentEvent) => void) | undefined;
		const agent = {
			state: {
				messages: [],
				error: undefined,
				model: {
					id: "test-model",
					provider: "anthropic",
				},
				thinkingLevel: "off",
			},
			subscribe: (fn: (event: AgentEvent) => void) => {
				listener = fn;
				return () => {
					listener = undefined;
				};
			},
		} as unknown as Agent;

		let completed:
			| {
					status: string;
					abortReason?: string;
			  }
			| undefined;
		const tracker = new TurnTracker(agent, {
			sessionId: "session-2",
			onTurnComplete: (event) => {
				completed = event;
			},
		});

		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "partial" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-20250514",
			usage: {
				input: 10,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "length",
			timestamp: Date.now(),
		};

		listener?.({ type: "agent_start" });
		listener?.({ type: "message_start", message: assistantMessage });
		listener?.({ type: "message_end", message: assistantMessage });
		listener?.({
			type: "agent_end",
			messages: [assistantMessage],
			stopReason: "length",
		});

		tracker.dispose();

		expect(completed?.status).toBe("success");
		expect(completed?.abortReason).toBeUndefined();
	});

	it("keeps automatic continuations on the same logical turn number", () => {
		let listener: ((event: AgentEvent) => void) | undefined;
		const agent = {
			state: {
				messages: [],
				error: undefined,
				model: {
					id: "test-model",
					provider: "anthropic",
				},
				thinkingLevel: "off",
			},
			subscribe: (fn: (event: AgentEvent) => void) => {
				listener = fn;
				return () => {
					listener = undefined;
				};
			},
		} as unknown as Agent;

		const completed: Array<{ turnNumber: number; status: string }> = [];
		const tracker = new TurnTracker(agent, {
			sessionId: "session-3",
			onTurnComplete: (event) => {
				completed.push({
					turnNumber: event.turnNumber,
					status: event.status,
				});
			},
		});

		const partialMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "partial" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-20250514",
			usage: {
				input: 10,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "length",
			timestamp: Date.now(),
		};
		const finalMessage: AssistantMessage = {
			...partialMessage,
			content: [{ type: "text", text: "complete" }],
			stopReason: "stop",
			timestamp: Date.now() + 1,
		};

		listener?.({ type: "agent_start" });
		listener?.({ type: "message_start", message: partialMessage });
		listener?.({ type: "message_end", message: partialMessage });
		listener?.({
			type: "agent_end",
			messages: [partialMessage],
			stopReason: "length",
		});

		listener?.({ type: "agent_start", continuation: true });
		listener?.({ type: "message_start", message: finalMessage });
		listener?.({ type: "message_end", message: finalMessage });
		listener?.({
			type: "agent_end",
			messages: [partialMessage, finalMessage],
			stopReason: "stop",
		});

		tracker.dispose();

		expect(completed).toHaveLength(2);
		expect(completed.map((event) => event.turnNumber)).toEqual([1, 1]);
		expect(tracker.getTurnNumber()).toBe(1);
	});

	it("preserves accumulated usage across continuation turns", () => {
		let listener: ((event: AgentEvent) => void) | undefined;
		const agent = {
			state: {
				messages: [],
				error: undefined,
				model: {
					id: "test-model",
					provider: "anthropic",
				},
				thinkingLevel: "off",
			},
			subscribe: (fn: (event: AgentEvent) => void) => {
				listener = fn;
				return () => {
					listener = undefined;
				};
			},
		} as unknown as Agent;

		const completed: Array<{
			turnNumber: number;
			tokens: { input: number; output: number };
			costUsd: number;
		}> = [];
		const tracker = new TurnTracker(agent, {
			sessionId: "session-4",
			onTurnComplete: (event) => {
				completed.push({
					turnNumber: event.turnNumber,
					tokens: {
						input: event.tokens.input,
						output: event.tokens.output,
					},
					costUsd: event.costUsd,
				});
			},
		});

		const partialMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "partial" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-20250514",
			usage: {
				input: 10,
				output: 20,
				cacheRead: 1,
				cacheWrite: 2,
				cost: {
					input: 0.1,
					output: 0.2,
					cacheRead: 0.01,
					cacheWrite: 0.02,
					total: 0.33,
				},
			},
			stopReason: "length",
			timestamp: Date.now(),
		};
		const finalMessage: AssistantMessage = {
			...partialMessage,
			content: [{ type: "text", text: "complete" }],
			usage: {
				input: 30,
				output: 40,
				cacheRead: 3,
				cacheWrite: 4,
				cost: {
					input: 0.3,
					output: 0.4,
					cacheRead: 0.03,
					cacheWrite: 0.04,
					total: 0.77,
				},
			},
			stopReason: "stop",
			timestamp: Date.now() + 1,
		};

		listener?.({ type: "agent_start" });
		listener?.({ type: "message_start", message: partialMessage });
		listener?.({ type: "message_end", message: partialMessage });
		listener?.({
			type: "agent_end",
			messages: [partialMessage],
			stopReason: "length",
		});

		listener?.({ type: "agent_start", continuation: true });
		listener?.({ type: "message_start", message: finalMessage });
		listener?.({ type: "message_end", message: finalMessage });
		listener?.({
			type: "agent_end",
			messages: [partialMessage, finalMessage],
			stopReason: "stop",
		});

		tracker.dispose();

		expect(completed).toHaveLength(2);
		expect(completed[1]).toMatchObject({
			turnNumber: 1,
			tokens: {
				input: 40,
				output: 60,
			},
			costUsd: 1.1,
		});
	});

	it("records governed tool failure codes on completed turns", () => {
		let listener: ((event: AgentEvent) => void) | undefined;
		const agent = {
			state: {
				messages: [],
				error: undefined,
				model: {
					id: "test-model",
					provider: "anthropic",
				},
				thinkingLevel: "off",
			},
			subscribe: (fn: (event: AgentEvent) => void) => {
				listener = fn;
				return () => {
					listener = undefined;
				};
			},
		} as unknown as Agent;

		let completed:
			| {
					tools: Array<{
						name: string;
						callId: string;
						success: boolean;
						errorCode?: string;
					}>;
					toolFailureCount: number;
			  }
			| undefined;
		const tracker = new TurnTracker(agent, {
			sessionId: "session-governed-tool",
			onTurnComplete: (event) => {
				completed = {
					tools: event.tools,
					toolFailureCount: event.toolFailureCount,
				};
			},
		});

		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-20250514",
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		listener?.({ type: "agent_start" });
		listener?.({
			type: "tool_execution_start",
			toolCallId: "call-governed",
			toolName: "bash",
			args: { command: "rm -rf /tmp/demo" },
		});
		listener?.({
			type: "tool_execution_end",
			toolCallId: "call-governed",
			toolName: "bash",
			result: {
				role: "toolResult",
				toolCallId: "call-governed",
				toolName: "bash",
				content: [{ type: "text", text: "Denied by policy" }],
				isError: true,
				timestamp: Date.now(),
			},
			isError: true,
			errorCode: "governance_denied",
			governedOutcome: "denied",
			approvalRequestId: "approval-123",
		});
		listener?.({ type: "message_start", message: assistantMessage });
		listener?.({ type: "message_end", message: assistantMessage });
		listener?.({
			type: "agent_end",
			messages: [assistantMessage],
			stopReason: "stop",
		});

		tracker.dispose();

		expect(completed?.tools).toEqual([
			expect.objectContaining({
				name: "bash",
				callId: "call-governed",
				success: false,
				errorCode: "governance_denied",
			}),
		]);
		expect(completed?.toolFailureCount).toBe(1);
	});

	it("attaches prompt artifact identity to completed turns", () => {
		let listener: ((event: AgentEvent) => void) | undefined;
		const agent = {
			state: {
				messages: [],
				error: undefined,
				promptMetadata: {
					name: "maestro-system",
					label: "production",
					surface: "maestro",
					version: 9,
					versionId: "ver_9",
					hash: "hash_123",
					source: "service",
				},
				model: {
					id: "test-model",
					provider: "anthropic",
				},
				thinkingLevel: "off",
			},
			subscribe: (fn: (event: AgentEvent) => void) => {
				listener = fn;
				return () => {
					listener = undefined;
				};
			},
		} as unknown as Agent;

		let completed:
			| {
					promptMetadata?: {
						name: string;
						versionId?: string;
						source: string;
					};
			  }
			| undefined;
		const tracker = new TurnTracker(agent, {
			sessionId: "session-prompt-metadata",
			onTurnComplete: (event) => {
				completed = {
					promptMetadata: event.promptMetadata,
				};
			},
		});

		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-20250514",
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		listener?.({ type: "agent_start" });
		listener?.({ type: "message_start", message: assistantMessage });
		listener?.({ type: "message_end", message: assistantMessage });
		listener?.({
			type: "agent_end",
			messages: [assistantMessage],
			stopReason: "stop",
		});

		tracker.dispose();

		expect(completed?.promptMetadata).toMatchObject({
			name: "maestro-system",
			versionId: "ver_9",
			source: "service",
		});
	});

	it("attaches skill artifact identity to completed turns", () => {
		let listener: ((event: AgentEvent) => void) | undefined;
		const agent = {
			state: {
				messages: [],
				error: undefined,
				model: {
					id: "test-model",
					provider: "anthropic",
				},
				thinkingLevel: "off",
			},
			subscribe: (fn: (event: AgentEvent) => void) => {
				listener = fn;
				return () => {
					listener = undefined;
				};
			},
		} as unknown as Agent;

		let completed:
			| {
					skillMetadata?: Array<{
						name: string;
						artifactId?: string;
						source: string;
					}>;
			  }
			| undefined;
		const tracker = new TurnTracker(agent, {
			sessionId: "session-skill-metadata",
			onTurnComplete: (event) => {
				completed = {
					skillMetadata: event.skillMetadata,
				};
			},
		});

		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-20250514",
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		listener?.({ type: "agent_start" });
		listener?.({
			type: "tool_execution_start",
			toolCallId: "call-skill",
			toolName: "Skill",
			args: { skill: "incident-review" },
		});
		listener?.({
			type: "tool_execution_end",
			toolCallId: "call-skill",
			toolName: "Skill",
			skillMetadata: {
				name: "incident-review",
				artifactId: "skill_remote_1",
				hash: "hash_skill_123",
				source: "service",
			},
			result: {
				role: "toolResult",
				toolCallId: "call-skill",
				toolName: "Skill",
				content: [{ type: "text", text: "# Skill: incident-review" }],
				isError: false,
				timestamp: Date.now(),
			},
			isError: false,
		});
		listener?.({ type: "message_start", message: assistantMessage });
		listener?.({ type: "message_end", message: assistantMessage });
		listener?.({
			type: "agent_end",
			messages: [assistantMessage],
			stopReason: "stop",
		});

		tracker.dispose();

		expect(completed?.skillMetadata).toEqual([
			expect.objectContaining({
				name: "incident-review",
				artifactId: "skill_remote_1",
				source: "service",
			}),
		]);
	});
});
