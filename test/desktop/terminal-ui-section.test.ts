import { describe, expect, it } from "vitest";
import { buildTerminalUiViewModel } from "../../packages/desktop/src/renderer/components/Settings/TerminalUiSection";

describe("buildTerminalUiViewModel", () => {
	it("disables controls and shows the session warning when no session exists", () => {
		const viewModel = buildTerminalUiViewModel(
			{
				zenMode: false,
				cleanMode: "soft",
				footerMode: "solo",
				compactTools: true,
				queueMode: "all",
			},
			false,
		);

		expect(viewModel.controlsDisabled).toBe(true);
		expect(viewModel.showSessionWarning).toBe(true);
		expect(viewModel.zenModeLabel).toBe("Off");
		expect(viewModel.cleanMode).toBe("soft");
		expect(viewModel.footerMode).toBe("solo");
		expect(viewModel.compactToolsLabel).toBe("On");
	});

	it("enables controls when a session is present", () => {
		const viewModel = buildTerminalUiViewModel(
			{
				zenMode: true,
				cleanMode: "aggressive",
				footerMode: "ensemble",
				compactTools: false,
				queueMode: "one",
			},
			true,
		);

		expect(viewModel.controlsDisabled).toBe(false);
		expect(viewModel.showSessionWarning).toBe(false);
		expect(viewModel.zenModeLabel).toBe("On");
		expect(viewModel.cleanMode).toBe("aggressive");
		expect(viewModel.footerMode).toBe("ensemble");
		expect(viewModel.compactToolsLabel).toBe("Off");
	});
});
