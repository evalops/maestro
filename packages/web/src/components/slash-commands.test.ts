import { describe, expect, it } from "vitest";
import {
	buildWebSlashCommands,
	isWebSlashCommandSupported,
	renderCustomWebSlashCommand,
} from "./slash-commands.js";

describe("slash command catalog", () => {
	it("merges custom commands with generated web metadata", () => {
		const commands = buildWebSlashCommands([
			{
				name: "triage",
				description: "Triage an issue",
				prompt: "Triage issue {{issue}}",
				args: [{ name: "issue", required: true }],
			},
		]);

		const custom = commands.find((command) => command.name === "triage");
		const history = commands.find((command) => command.name === "history");

		expect(custom).toMatchObject({
			name: "triage",
			source: "custom",
			usage: "/triage issue=<value>",
			tags: ["custom", "args"],
		});
		expect(history?.supported).toBe(false);
		expect(isWebSlashCommandSupported(history!)).toBe(false);
	});

	it("renders custom prompt templates and validates required args", () => {
		const command = {
			name: "triage",
			usage: "/triage issue=<value>",
			prompt: "Triage issue {{issue}}",
			args: [{ name: "issue", required: true }],
		};

		expect(renderCustomWebSlashCommand(command, "issue=42")).toEqual({
			ok: true,
			prompt: "Triage issue 42",
		});
		expect(renderCustomWebSlashCommand(command, "")).toEqual({
			ok: false,
			error: "Missing required arg: issue\nUsage: /triage issue=<value>",
		});
	});
});
