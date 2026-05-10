import { describe, expect, it, vi } from "vitest";
import {
	createModeCommandHandler,
	getModeCompletions,
} from "../../../src/cli-tui/commands/handlers/mode-handler.js";
import type { CommandExecutionContext } from "../../../src/cli-tui/commands/types.js";

function createContext(argumentText: string): CommandExecutionContext {
	return {
		command: {
			name: "mode",
			description: "Switch mode",
			handler: vi.fn(),
		},
		rawInput: `/mode ${argumentText}`,
		argumentText,
		showInfo: vi.fn(),
		showError: vi.fn(),
		renderHelp: vi.fn(),
	};
}

describe("mode command handler", () => {
	it("accepts extra whitespace in hidden-mode list arguments", () => {
		const ctx = createContext(" list    --all ");

		createModeCommandHandler()(ctx);

		expect(ctx.showInfo).toHaveBeenCalledWith(
			expect.stringContaining("Frontier"),
		);
		expect(ctx.showError).not.toHaveBeenCalled();
	});

	it("keeps default list limited to visible modes", () => {
		const ctx = createContext("list");

		createModeCommandHandler()(ctx);

		const output = vi.mocked(ctx.showInfo).mock.calls[0]?.[0] ?? "";
		expect(output).toContain("Smart");
		expect(output).not.toContain("Frontier");
	});

	it("keeps hidden modes out of completions", () => {
		expect(getModeCompletions(" front")).toEqual([]);
		expect(getModeCompletions(" sm")).toContainEqual(
			expect.objectContaining({ label: "smart" }),
		);
	});
});
