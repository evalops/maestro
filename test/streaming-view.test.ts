import type { Component } from "@evalops/tui";
import { describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "../src/agent/types.js";
import { StreamingView } from "../src/tui/streaming-view.js";

// Mock the assistant message component so we can inspect the renderable content
// that StreamingView passes into the UI.
const updateContentMock = vi.hoisted(() => vi.fn());

vi.mock("../src/tui/assistant-message.js", () => {
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
}

type ToolOutputViewType = Parameters<typeof StreamingView>[0]["toolOutputView"];

const noopToolOutputView: ToolOutputViewType = {
	registerToolComponent: () => {},
	clearTrackedComponents: () => {},
	getTrackedComponents: () => new Set(),
	handleCompactToolsCommand: () => {},
	setCompactMode: () => {},
	toggleCompactMode: () => false,
	isCompact: () => false,
};

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
});
