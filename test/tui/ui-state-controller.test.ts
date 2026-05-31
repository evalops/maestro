import { describe, expect, it, vi } from "vitest";
import { UiStateController } from "../../src/cli-tui/tui-renderer/ui-state-controller.js";

describe("UiStateController", () => {
	it("uses maestro wording in footer help text", () => {
		const showInfo = vi.fn();
		const controller = new UiStateController({
			initialCleanMode: "off",
			initialFooterMode: "rich",
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
			'Footer mode is Rich. Use "/footer rich" for the full footer or "/footer solo" for the minimal style.',
		);
	});

	it("rejects the retired ensemble footer mode", () => {
		const showError = vi.fn();
		const onFooterModeChange = vi.fn();
		const controller = new UiStateController({
			initialCleanMode: "off",
			initialFooterMode: "rich",
			initialZenMode: false,
			initialHideThinkingBlocks: false,
			callbacks: {
				onZenModeChange: vi.fn(),
				onFooterModeChange,
				onHideThinkingBlocksChange: vi.fn(),
				requestRender: vi.fn(),
			},
		});

		controller.handleFooterCommand(
			{
				command: { name: "footer", description: "footer" },
				rawInput: "/footer ensemble",
				argumentText: "ensemble",
				showInfo: vi.fn(),
				showError,
				renderHelp: vi.fn(),
			},
			{
				getToastHistory: vi.fn(() => []),
				clearAlerts: vi.fn(),
			},
		);

		expect(onFooterModeChange).not.toHaveBeenCalled();
		expect(showError).toHaveBeenCalledWith(
			"Footer mode must be either 'rich' or 'solo'.",
		);
	});
});
