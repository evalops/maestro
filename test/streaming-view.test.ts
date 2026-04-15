import type { Component } from "@evalops/tui";
import { describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "../src/agent/types.js";
import { StreamingView } from "../src/cli-tui/streaming-view.js";

// Mock the assistant message component so we can inspect the renderable content
// that StreamingView passes into the UI.
const updateContentMock = vi.hoisted(() => vi.fn());
const toolExecutionMock = vi.hoisted(() => {
	const instances: Array<{
		name: string;
		args: Record<string, unknown>;
		updateArgs: ReturnType<typeof vi.fn>;
		updatePartialArgs: ReturnType<typeof vi.fn>;
		updatePresentation: ReturnType<typeof vi.fn>;
		updateResult: ReturnType<typeof vi.fn>;
		updatePartialResult: ReturnType<typeof vi.fn>;
	}> = [];

	class ToolExecutionComponent {
		public updateArgs = vi.fn();
		public updatePartialArgs = vi.fn();
		public updatePresentation = vi.fn();
		public updateResult = vi.fn();
		public updatePartialResult = vi.fn();

		constructor(
			public name: string,
			public args: Record<string, unknown>,
		) {
			instances.push(this);
		}
	}

	return { ToolExecutionComponent, instances };
});

vi.mock("../src/cli-tui/assistant-message.js", () => {
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

vi.mock("../src/cli-tui/tool-execution.js", () => ({
	__esModule: true,
	ToolExecutionComponent: toolExecutionMock.ToolExecutionComponent,
}));

const baseMessage: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "" }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "test",
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

describe("StreamingView clean mode handling", () => {
	it("applies clean mode on final render (dedupes streaming duplicates)", () => {
		const chatContainer = new MockContainer();
		const view = new StreamingView({
			chatContainer,
			toolOutputView: noopToolOutputView,
			pendingTools: new Map(),
			lowBandwidth: { enabled: false, batchIntervalMs: 0, scrollbackLimit: 10 },
			getCleanMode: () => "soft",
		});

		const dupMessage: AssistantMessage = {
			...baseMessage,
			content: [{ type: "text", text: "Line A\nLine A\nLine B" }],
		};

		updateContentMock.mockClear();
		view.beginAssistantMessage(dupMessage);
		view.finishAssistantMessage(dupMessage);

		const finalRenderable = updateContentMock.mock.calls.at(-1)?.[0] as {
			textBlocks: string[];
		};
		expect(finalRenderable.textBlocks[0]).toBe("Line A\nLine B");
	});

	it("respects clean mode off on final render (no dedupe)", () => {
		const chatContainer = new MockContainer();
		const view = new StreamingView({
			chatContainer,
			toolOutputView: noopToolOutputView,
			pendingTools: new Map(),
			lowBandwidth: { enabled: false, batchIntervalMs: 0, scrollbackLimit: 10 },
			getCleanMode: () => "off",
		});

		const dupMessage: AssistantMessage = {
			...baseMessage,
			content: [{ type: "text", text: "Alpha\nAlpha\nBeta" }],
		};

		updateContentMock.mockClear();
		view.beginAssistantMessage(dupMessage);
		view.finishAssistantMessage(dupMessage);

		const finalRenderable = updateContentMock.mock.calls.at(-1)?.[0] as {
			textBlocks: string[];
		};
		expect(finalRenderable.textBlocks[0]).toBe("Alpha\nAlpha\nBeta");
	});

	it("streams toolcall args into tool components", () => {
		const chatContainer = new MockContainer();
		const pendingTools = new Map();
		const view = new StreamingView({
			chatContainer,
			toolOutputView: noopToolOutputView,
			pendingTools,
			lowBandwidth: { enabled: false, batchIntervalMs: 0, scrollbackLimit: 10 },
			getCleanMode: () => "off",
		});

		const firstMessage: AssistantMessage = {
			...baseMessage,
			content: [
				{
					type: "toolCall",
					id: "call_1",
					name: "read_file",
					arguments: { path: "/tmp/one.txt" },
				},
			],
		};

		const secondMessage: AssistantMessage = {
			...baseMessage,
			content: [
				{
					type: "toolCall",
					id: "call_1",
					name: "read_file",
					arguments: { path: "/tmp/two.txt" },
				},
			],
		};

		toolExecutionMock.instances.length = 0;
		view.beginAssistantMessage(firstMessage);
		view.updateAssistantMessage(firstMessage);

		expect(toolExecutionMock.instances).toHaveLength(1);
		const component = toolExecutionMock.instances[0];
		expect(component.updatePartialArgs).toHaveBeenCalledWith({
			path: "/tmp/one.txt",
		});

		view.updateAssistantMessage(secondMessage);
		expect(component.updateArgs).toHaveBeenCalledWith({ path: "/tmp/two.txt" });
		expect(component.updatePartialArgs).toHaveBeenCalledWith({
			path: "/tmp/two.txt",
		});
	});
});
