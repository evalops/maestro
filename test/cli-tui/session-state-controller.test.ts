import { describe, expect, it, vi } from "vitest";
import { COMPACTION_RESUME_PROMPT } from "../../src/agent/compaction.js";
import type { AgentState } from "../../src/agent/types.js";
import { SessionStateController } from "../../src/cli-tui/tui-renderer/session-state-controller.js";

function createController() {
	const editor = { addToHistory: vi.fn() };
	const controller = new SessionStateController({
		deps: {
			agent: { state: { messages: [] } } as never,
			sessionManager: {} as never,
			sessionContext: {} as never,
			sessionRecoveryManager: {} as never,
			editor: editor as never,
			messageView: { renderInitialMessages: vi.fn() } as never,
			toolOutputView: { clearTrackedComponents: vi.fn() } as never,
			chatContainer: { clear: vi.fn() } as never,
			scrollContainer: { clearHistory: vi.fn() } as never,
			startupContainer: { clear: vi.fn() } as never,
			planView: { syncHintWithStore: vi.fn() } as never,
			footer: { updateState: vi.fn() } as never,
			notificationView: { showToast: vi.fn() } as never,
		},
		callbacks: {
			refreshFooterHint: vi.fn(),
			requestRender: vi.fn(),
			clearEditor: vi.fn(),
			setPlanHint: vi.fn(),
			isAgentRunning: vi.fn().mockReturnValue(false),
		},
	});
	return { controller, editor };
}

describe("SessionStateController", () => {
	it("keeps internal compaction resume prompts out of editor history", () => {
		const { controller, editor } = createController();

		controller.renderInitialMessages({
			messages: [
				{ role: "user", content: "Ship the next change", timestamp: 1 },
				{ role: "user", content: COMPACTION_RESUME_PROMPT, timestamp: 2 },
				{ role: "user", content: "[Context compaction: legacy]", timestamp: 3 },
			],
		} as AgentState);

		expect(editor.addToHistory).toHaveBeenCalledTimes(1);
		expect(editor.addToHistory).toHaveBeenCalledWith("Ship the next change");
	});
});
