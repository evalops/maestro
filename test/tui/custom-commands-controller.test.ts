import { describe, expect, it, vi } from "vitest";
import { CustomCommandsController } from "../../src/cli-tui/tui-renderer/custom-commands-controller.js";

vi.mock("../../src/commands/catalog.js", () => ({
	loadPrompts: vi.fn(() => []),
	loadCommandCatalog: vi.fn(() => [
		{
			name: "shipit",
			description: "Ship it",
			prompt: "Ship {{target}}",
			args: [{ name: "target", required: true }],
			source: "~/.maestro/commands/shipit.json",
		},
	]),
	findPrompt: vi.fn(),
	formatPromptListItem: vi.fn(),
	getPromptUsageHint: vi.fn(),
	parsePromptArgs: vi.fn(),
	renderPrompt: vi.fn(),
	validatePromptArgs: vi.fn(),
	parseCommandArgs: vi.fn((args: string[]) => ({
		target: args[0]?.split("=")[1],
	})),
	validateCommandArgs: vi.fn(() => null),
	renderCommandPrompt: vi.fn(() => "Ship prod"),
}));

describe("CustomCommandsController", () => {
	it("uses maestro wording when inserting a command into the editor", () => {
		const setEditorText = vi.fn();
		const showToast = vi.fn();
		const controller = new CustomCommandsController({
			cwd: process.cwd(),
			callbacks: {
				addContent: vi.fn(),
				setEditorText,
				showToast,
				requestRender: vi.fn(),
			},
		});

		controller.handleCommandsCommand({
			command: { name: "commands", description: "commands" },
			rawInput: "/commands run shipit target=prod",
			argumentText: "run shipit target=prod",
			showInfo: vi.fn(),
			showError: vi.fn(),
			renderHelp: vi.fn(),
		});

		expect(setEditorText).toHaveBeenCalledWith("Ship prod");
		expect(showToast).toHaveBeenCalledWith(
			'Inserted command "shipit" into Maestro. Edit then submit.',
			"info",
		);
	});
});
