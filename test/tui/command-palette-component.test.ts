import type { SlashCommand } from "@evalops/tui";
import { describe, expect, it } from "vitest";
import { CommandPaletteComponent } from "../../src/tui/utils/commands/command-palette.js";
import { stripAnsiSequences } from "../../src/tui/utils/text-formatting.js";

const cmd = (name: string, tags: string[] = []): SlashCommand => ({
	name,
	description: `${name} desc`,
	tags,
});

const renderText = (component: { render(width: number): string[] }) =>
	component.render(120).join("\n");

describe("CommandPaletteComponent", () => {
	it("orders favorites first, then recents, then others", () => {
		const commands = [cmd("run"), cmd("cost"), cmd("undo")];
		const palette = new CommandPaletteComponent(
			commands,
			["cost"],
			new Set(["undo"]),
			() => {},
			() => {},
			() => {},
		);

		const output = renderText(palette);
		const undoIndex = output.indexOf("/undo");
		const costIndex = output.indexOf("/cost");
		const runIndex = output.indexOf("/run");

		expect(undoIndex).toBeGreaterThanOrEqual(0);
		expect(costIndex).toBeGreaterThan(undoIndex);
		expect(runIndex).toBeGreaterThan(costIndex);
	});

	it("adds a favorite marker when toggled with f", () => {
		const commands = [cmd("run")];
		const palette = new CommandPaletteComponent(
			commands,
			[],
			new Set(),
			() => {},
			() => {},
			() => {},
		);

		palette.handleInput("f"); // toggle favorite on selected item
		const output = stripAnsiSequences(renderText(palette));
		const normalized = output.replace(/\s+/g, " ");
		expect(normalized).toContain("★ /run");
	});
});
