import { describe, expect, it, vi } from "vitest";
import { COMPACTION_RESUME_PROMPT } from "../../src/agent/compaction.js";
import type { AgentState } from "../../src/agent/types.js";
import type { CommandExecutionContext } from "../../src/cli-tui/commands/types.js";
import { SessionStateController } from "../../src/cli-tui/tui-renderer/session-state-controller.js";

function createController() {
	const editor = { addToHistory: vi.fn() };
	const sessionManager = { startFreshSession: vi.fn() };
	const notificationView = { showToast: vi.fn() };
	const runSessionEndHooks = vi.fn().mockResolvedValue(undefined);
	const runSessionStartHooks = vi.fn().mockResolvedValue(undefined);
	const controller = new SessionStateController({
		deps: {
			agent: { state: { messages: [] }, clearMessages: vi.fn() } as never,
			sessionManager: sessionManager as never,
			sessionContext: { resetArtifacts: vi.fn() } as never,
			sessionRecoveryManager: {} as never,
			editor: editor as never,
			messageView: { renderInitialMessages: vi.fn() } as never,
			toolOutputView: { clearTrackedComponents: vi.fn() } as never,
			chatContainer: { clear: vi.fn() } as never,
			scrollContainer: { clearHistory: vi.fn() } as never,
			startupContainer: { clear: vi.fn() } as never,
			planView: { syncHintWithStore: vi.fn() } as never,
			footer: { updateState: vi.fn() } as never,
			notificationView: notificationView as never,
			runSessionEndHooks,
			runSessionStartHooks,
		},
		callbacks: {
			refreshFooterHint: vi.fn(),
			requestRender: vi.fn(),
			clearEditor: vi.fn(),
			setPlanHint: vi.fn(),
			isAgentRunning: vi.fn().mockReturnValue(false),
		},
	});
	return {
		controller,
		editor,
		sessionManager,
		notificationView,
		runSessionEndHooks,
		runSessionStartHooks,
	};
}

function createCommandContext(): CommandExecutionContext {
	return {
		command: { name: "new", description: "new" },
		rawInput: "/new",
		argumentText: "",
		showInfo: vi.fn(),
		showError: vi.fn(),
		renderHelp: vi.fn(),
	};
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

	it("runs session lifecycle hooks when starting a new chat", async () => {
		const {
			controller,
			sessionManager,
			notificationView,
			runSessionEndHooks,
			runSessionStartHooks,
		} = createController();
		const context = createCommandContext();

		await controller.handleNewChatCommand(context);

		expect(runSessionEndHooks).toHaveBeenCalledWith("clear");
		expect(sessionManager.startFreshSession).toHaveBeenCalledTimes(1);
		expect(runSessionStartHooks).toHaveBeenCalledWith("new_chat");
		expect(notificationView.showToast).toHaveBeenCalledWith(
			"Started a new chat session.",
			"success",
		);
		expect(context.showError).not.toHaveBeenCalled();
	});
});
