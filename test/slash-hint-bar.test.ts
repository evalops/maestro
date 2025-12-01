import type { SlashCommand } from "@evalops/tui";
import { describe, expect, it } from "vitest";
import { SlashHintBar } from "../src/tui/utils/commands/slash-hint-bar.js";

const makeCmd = (
	name: string,
	tags: string[] = [],
	usage?: string,
): SlashCommand => ({
	name,
	description: `${name} description`,
	usage,
	tags,
});

describe("SlashHintBar", () => {
	it("shows the best exact/startsWith match and usage", () => {
		const bar = new SlashHintBar();
		const commands = [
			makeCmd("quota", ["usage"], "/quota [detailed]"),
			makeCmd("quit", ["system"]),
		];

		bar.update("/quo", commands, new Set(), new Set());
		const output = bar.render(120).join("\n");

		expect(output).toContain("/quota");
		expect(output).toContain("/quota [detailed]");
		expect(output).not.toContain("/quit");
	});

	it("prefers favorites when no query is provided", () => {
		const bar = new SlashHintBar();
		const commands = [
			makeCmd("cost", ["usage"]),
			makeCmd("stats", ["diagnostics"]),
		];

		bar.update("/", commands, new Set(), new Set(["stats"]));
		const output = bar.render(120).join("\n");

		const firstLine = output.split("\n")[0] ?? "";
		expect(firstLine).toContain("/stats");
	});

	it("renders tag badges", () => {
		const bar = new SlashHintBar();
		const commands = [makeCmd("undo", ["git", "safety"])];

		bar.update("/undo", commands, new Set(), new Set());
		const output = bar.render(120).join("\n");

		expect(output).toMatch(/\[git\]/);
		expect(output).toMatch(/\[safety\]/);
	});
});
