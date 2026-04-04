import type { Component } from "@evalops/tui";
import { describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "../../src/agent/types.js";
import { AgentEventRouter } from "../../src/cli-tui/agent-event-router.js";
import { StreamingView } from "../../src/cli-tui/streaming-view.js";

const updateContentMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/cli-tui/assistant-message.js", () => {
	class AssistantMessageComponent {
		public lastContent: unknown;
		updateContent(content: unknown): void {
			this.lastContent = content;
			updateContentMock(content);
		}
	}
	return {
		__esModule: true,
		AssistantMessageComponent,
		updateContentMock,
	};
});

class MockContainer {
	children: Component[] = [];
	addChild(child: Component): void {
		this.children.push(child);
	}
	removeChild(child: Component): void {
		this.children = this.children.filter((c) => c !== child);
	}
	clear(): void {
		this.children = [];
	}
	render(_width: number): string[] {
		return [];
	}
	invalidate(): void {
		// No-op for mock
	}
}

type ToolOutputViewType = ConstructorParameters<
	typeof StreamingView
>[0]["toolOutputView"];

const noopToolOutputView = {
	registerToolComponent: () => {},
	clearTrackedComponents: () => {},
	getTrackedComponents: () => new Set(),
	handleCompactToolsCommand: () => {},
	setCompactMode: () => {},
	toggleCompactMode: () => false,
	isCompact: () => false,
} as unknown as ToolOutputViewType;

describe("AgentEventRouter reasoning summary streaming", () => {
	it("propagates thinking summaries to the streaming view", () => {
		const chatContainer = new MockContainer();
		const streamingView = new StreamingView({
			chatContainer,
			toolOutputView: noopToolOutputView,
			pendingTools: new Map(),
			lowBandwidth: { enabled: false, batchIntervalMs: 0, scrollbackLimit: 10 },
			getCleanMode: () => "off",
		});

		const router = new AgentEventRouter({
			messageView: { addMessage: vi.fn() } as unknown as {
				addMessage: (message: unknown) => void;
			},
			streamingView,
			loaderView: {
				beginTurn: vi.fn(),
				completeTurn: vi.fn(),
				setStreamingActive: vi.fn(),
				maybeTransitionToResponding: vi.fn(),
				registerToolStage: vi.fn(),
				markToolComplete: vi.fn(),
				showToolBatchSummary: vi.fn(),
			} as unknown,
			runController: {
				handleAgentStart: vi.fn(),
				handleAgentEnd: (cb: () => void) => cb(),
			} as unknown,
			sessionContext: {
				beginTurn: vi.fn(),
				completeTurn: vi.fn(),
				setLastUserMessage: vi.fn(),
				setLastAssistantMessage: vi.fn(),
				recordToolUsage: vi.fn(),
			} as unknown,
			extractText: () => "",
			clearEditor: vi.fn(),
			requestRender: vi.fn(),
			clearPendingTools: vi.fn(),
			refreshPlanHint: vi.fn(),
		});

		const baseAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "thinking", thinking: "" }],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		const updatedAssistant: AssistantMessage = {
			...baseAssistant,
			content: [{ type: "thinking", thinking: "Reasoning summary" }],
		};

		updateContentMock.mockClear();
		router.handle({ type: "message_start", message: baseAssistant });
		router.handle({
			type: "message_update",
			message: updatedAssistant,
			assistantMessageEvent: {
				type: "thinking_delta",
				contentIndex: 0,
				delta: "Reasoning summary",
			},
		});

		const lastRenderable = updateContentMock.mock.calls.at(-1)?.[0] as {
			thinkingBlocks?: string[];
		};
		expect(lastRenderable?.thinkingBlocks?.[0]).toBe("Reasoning summary");
	});

	it("shows transient tool batch summaries through the loader view", () => {
		const showToolBatchSummary = vi.fn();
		const requestRender = vi.fn();
		const chatContainer = new MockContainer();
		const streamingView = new StreamingView({
			chatContainer,
			toolOutputView: noopToolOutputView,
			pendingTools: new Map(),
			lowBandwidth: { enabled: false, batchIntervalMs: 0, scrollbackLimit: 10 },
			getCleanMode: () => "off",
		});

		const router = new AgentEventRouter({
			messageView: { addMessage: vi.fn() } as unknown as {
				addMessage: (message: unknown) => void;
			},
			streamingView,
			loaderView: {
				beginTurn: vi.fn(),
				completeTurn: vi.fn(),
				setStreamingActive: vi.fn(),
				maybeTransitionToResponding: vi.fn(),
				registerToolStage: vi.fn(),
				markToolComplete: vi.fn(),
				showToolBatchSummary,
			} as unknown,
			runController: {
				handleAgentStart: vi.fn(),
				handleAgentEnd: (cb: () => void) => cb(),
			} as unknown,
			sessionContext: {
				beginTurn: vi.fn(),
				completeTurn: vi.fn(),
				setLastUserMessage: vi.fn(),
				setLastAssistantMessage: vi.fn(),
				recordToolUsage: vi.fn(),
			} as unknown,
			extractText: () => "",
			clearEditor: vi.fn(),
			requestRender,
			clearPendingTools: vi.fn(),
			refreshPlanHint: vi.fn(),
		});

		router.handle({
			type: "tool_batch_summary",
			summary: "Read README.md +1 more",
			summaryLabels: ["Read README.md", "Wrote notes.txt"],
			toolCallIds: ["tool_0", "tool_1"],
			toolNames: ["read", "write"],
			callsSucceeded: 2,
			callsFailed: 0,
		});

		expect(showToolBatchSummary).toHaveBeenCalledWith("Read README.md +1 more");
		expect(requestRender).toHaveBeenCalled();
	});
});
