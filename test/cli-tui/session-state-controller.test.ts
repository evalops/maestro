import { describe, expect, it, vi } from "vitest";
import { COMPACTION_RESUME_PROMPT } from "../../src/agent/compaction.js";
import type { AgentState } from "../../src/agent/types.js";
import type { CommandExecutionContext } from "../../src/cli-tui/commands/types.js";
import { SessionStateController } from "../../src/cli-tui/tui-renderer/session-state-controller.js";

function createController(
	systemPromptSourcePaths?: string[],
	systemPrompt = "base prompt",
) {
	const editor = { addToHistory: vi.fn() };
	const sessionManager = {
		startFreshSession: vi.fn(),
		getHeader: vi.fn(),
		loadThinkingLevel: vi.fn(),
		loadModel: vi.fn(),
	};
	const notificationView = { showToast: vi.fn() };
	const runSessionEndHooks = vi.fn().mockResolvedValue(undefined);
	const runSessionStartHooks = vi.fn().mockResolvedValue(undefined);
	const agent = {
		state: { messages: [], systemPrompt, systemPromptSourcePaths },
		clearMessages: vi.fn(),
		setSystemPrompt: vi.fn(),
		setSystemPromptSourcePaths: vi.fn(),
		setThinkingLevel: vi.fn(),
		setModel: vi.fn(),
	};
	const controller = new SessionStateController({
		deps: {
			agent: agent as never,
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
		agent,
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
			agent,
			sessionManager,
			notificationView,
			runSessionEndHooks,
			runSessionStartHooks,
		} = createController();
		const context = createCommandContext();

		await controller.handleNewChatCommand(context);

		expect(runSessionEndHooks).toHaveBeenCalledWith("clear");
		expect(sessionManager.startFreshSession).toHaveBeenCalledTimes(1);
		expect(agent.setSystemPrompt).toHaveBeenCalledWith("base prompt");
		expect(agent.setSystemPromptSourcePaths).toHaveBeenCalledWith(undefined);
		expect(runSessionStartHooks).toHaveBeenCalledWith("new_chat");
		expect(notificationView.showToast).toHaveBeenCalledWith(
			"Started a new chat session.",
			"success",
		);
		expect(context.showError).not.toHaveBeenCalled();
	});

	it("restores the baseline prompt source paths for a new chat", () => {
		const { controller, agent, sessionManager } = createController([
			"/workspace/APPEND_SYSTEM.md",
		]);

		controller.resetConversation([], undefined);

		expect(sessionManager.startFreshSession).toHaveBeenCalledTimes(1);
		expect(agent.setSystemPrompt).toHaveBeenCalledWith("base prompt");
		expect(agent.setSystemPromptSourcePaths).toHaveBeenCalledWith([
			"/workspace/APPEND_SYSTEM.md",
		]);
	});

	it("restores the baseline prompt for a new chat after loading a session", () => {
		const { controller, agent, sessionManager } = createController(
			["/workspace/APPEND_SYSTEM.md"],
			"base prompt",
		);
		sessionManager.getHeader.mockReturnValue({
			systemPrompt: "loaded prompt",
			systemPromptSourcePaths: ["/tmp/APPEND_SYSTEM.md"],
		});

		controller.applyLoadedSessionContext();
		controller.resetConversation([], undefined);

		expect(agent.setSystemPrompt).toHaveBeenCalledWith("loaded prompt");
		expect(agent.setSystemPrompt).toHaveBeenLastCalledWith("base prompt");
		expect(agent.setSystemPromptSourcePaths).toHaveBeenLastCalledWith([
			"/workspace/APPEND_SYSTEM.md",
		]);
	});

	it("restores persisted prompt source paths when loading a session", () => {
		const { controller, agent, sessionManager } = createController();
		sessionManager.getHeader.mockReturnValue({
			systemPrompt: "loaded prompt",
			systemPromptSourcePaths: ["/tmp/APPEND_SYSTEM.md"],
		});

		controller.applyLoadedSessionContext();

		expect(agent.setSystemPrompt).toHaveBeenCalledWith("loaded prompt");
		expect(agent.setSystemPromptSourcePaths).toHaveBeenCalledWith([
			"/tmp/APPEND_SYSTEM.md",
		]);
	});

	it("preserves current prompt source paths when the loaded session has none", () => {
		const { controller, agent, sessionManager } = createController([
			"/workspace/APPEND_SYSTEM.md",
		]);
		sessionManager.getHeader.mockReturnValue(null);

		controller.applyLoadedSessionContext();

		expect(agent.setSystemPromptSourcePaths).not.toHaveBeenCalled();
	});
});
