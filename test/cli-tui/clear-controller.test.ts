import { describe, expect, it, vi } from "vitest";
import { ClearController } from "../../src/cli-tui/tui-renderer/clear-controller.js";

function createController() {
	const callbacks = {
		abortAndWait: vi.fn().mockResolvedValue(undefined),
		setAgentRunning: vi.fn(),
		cancelQueuedPrompts: vi.fn(),
		stopLoader: vi.fn(),
		clearStatusContainer: vi.fn(),
		resetAgent: vi.fn(),
		resetSession: vi.fn(),
		resetArtifacts: vi.fn(),
		clearActiveSkills: vi.fn(),
		clearToolTracking: vi.fn(),
		clearChatContainer: vi.fn(),
		clearScrollHistory: vi.fn(),
		clearStartupContainer: vi.fn(),
		syncPlanHint: vi.fn(),
		setPlanHint: vi.fn(),
		clearEditor: vi.fn(),
		clearPendingTools: vi.fn(),
		clearInterruptState: vi.fn(),
		renderInitialMessages: vi.fn(),
		getAgentState: vi.fn(() => ({ messages: [] })),
		updateFooterState: vi.fn(),
		refreshFooterHint: vi.fn(),
		runSessionEndHooks: vi.fn().mockResolvedValue(undefined),
		runSessionStartHooks: vi.fn().mockResolvedValue(undefined),
		showSuccess: vi.fn(),
		showError: vi.fn(),
		requestRender: vi.fn(),
	};

	return {
		controller: new ClearController({ callbacks }),
		callbacks,
	};
}

describe("ClearController", () => {
	it("runs session lifecycle hooks around /clear resets", async () => {
		const { controller, callbacks } = createController();

		await controller.handleClearCommand();

		expect(callbacks.runSessionEndHooks).toHaveBeenCalledWith("clear");
		expect(callbacks.resetSession).toHaveBeenCalledTimes(1);
		expect(callbacks.runSessionStartHooks).toHaveBeenCalledWith("clear");
		expect(callbacks.showSuccess).toHaveBeenCalledWith(
			"Context cleared - started fresh session",
		);
	});
});
