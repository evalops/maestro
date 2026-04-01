import { describe, expect, it, vi } from "vitest";
import { UiStateController } from "../../src/cli-tui/tui-renderer/ui-state-controller.js";

describe("UiStateController", () => {
	it("uses maestro wording in footer help text", () => {
		const showInfo = vi.fn();
		const controller = new UiStateController({
			initialCleanMode: "off",
			initialFooterMode: "ensemble",
			initialZenMode: false,
			initialHideThinkingBlocks: false,
			callbacks: {
				onZenModeChange: vi.fn(),
				onFooterModeChange: vi.fn(),
				onHideThinkingBlocksChange: vi.fn(),
				requestRender: vi.fn(),
			},
		});

		controller.handleFooterCommand(
			{
				command: { name: "footer", description: "footer" },
				rawInput: "/footer",
				argumentText: "",
				showInfo,
				showError: vi.fn(),
				renderHelp: vi.fn(),
			},
			{
				getToastHistory: vi.fn(() => []),
				clearAlerts: vi.fn(),
			},
		);

		expect(showInfo).toHaveBeenCalledWith(
			'Footer mode is Ensemble (rich). Use "/footer ensemble" for the full Maestro Ensemble or "/footer solo" for the minimal Solo style.',
		);
	});
});
