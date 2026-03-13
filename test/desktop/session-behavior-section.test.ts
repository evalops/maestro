import { describe, expect, it } from "vitest";
import { buildSessionBehaviorViewModel } from "../../packages/desktop/src/renderer/components/Settings/SessionBehaviorSection";

describe("buildSessionBehaviorViewModel", () => {
	it("disables queue controls until a session exists", () => {
		const viewModel = buildSessionBehaviorViewModel(false, "all");

		expect(viewModel.queueMode).toBe("all");
		expect(viewModel.queueModeDisabled).toBe(true);
		expect(viewModel.showSessionWarning).toBe(true);
	});

	it("enables queue controls for active sessions", () => {
		const viewModel = buildSessionBehaviorViewModel(true, "one");

		expect(viewModel.queueMode).toBe("one");
		expect(viewModel.queueModeDisabled).toBe(false);
		expect(viewModel.showSessionWarning).toBe(false);
	});
});
