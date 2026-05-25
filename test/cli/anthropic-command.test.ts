import { describe, expect, it, vi } from "vitest";
import { handleAnthropicCommand } from "../../src/cli/commands/anthropic.js";

describe("anthropic CLI command", () => {
	it("reports that Anthropic OAuth login has been removed", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const exit = vi.spyOn(process, "exit").mockImplementation(() => {
			throw new Error("process.exit called");
		});

		await expect(handleAnthropicCommand("status")).rejects.toThrow(
			"process.exit called",
		);

		expect(exit).toHaveBeenCalledWith(1);
		expect(error).toHaveBeenCalledWith(
			expect.stringContaining("Anthropic OAuth login has been removed"),
		);

		error.mockRestore();
		exit.mockRestore();
	});
});
