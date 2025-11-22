import chalk from "chalk";
import { beforeAll, describe, expect, it } from "vitest";
import { buildConfigShowSections } from "../src/cli/commands/config.js";
import type { ConfigInspection } from "../src/models/registry.js";

const ANSI_REGEX = new RegExp(`${String.fromCharCode(27)}\[[0-9;]*m`, "g");
const stripAnsi = (value: string): string => value.replace(ANSI_REGEX, "");

beforeAll(() => {
	chalk.level = 0;
});

const sampleInspection: ConfigInspection = {
	sources: [
		{ path: "/Users/test/.composer/config.json", exists: true, loaded: true },
		{ path: "/etc/composer/config.json", exists: false, loaded: false },
	],
	providers: [
		{
			id: "anthropic",
			name: "Anthropic",
			baseUrl: "https://api.anthropic.com",
			enabled: true,
			apiKeySource: "env:ANTHROPIC_API_KEY",
			isLocal: false,
			options: { region: "us" },
			modelCount: 2,
			models: [
				{ id: "claude-3", name: "Claude 3", reasoning: true },
				{ id: "claude-3-haiku", name: "Claude Haiku", input: ["text"] },
			],
		},
	],
	fileReferences: [
		{ path: "/Users/test/project/prompts/system.md", exists: true, size: 2048 },
	],
	envVars: [{ name: "ANTHROPIC_API_KEY", set: false }],
};

describe("buildConfigShowSections", () => {
	it("produces snapshot for populated inspection", () => {
		const result = buildConfigShowSections(sampleInspection, {
			hierarchy: ["/Users/test/.composer/config.json"],
			homeDir: "/Users/test",
			disableColors: true,
		});
		expect(stripAnsi(result.join("\n")).trim()).toMatchSnapshot();
	});

	it("handles empty collections", () => {
		const emptyInspection: ConfigInspection = {
			sources: [],
			providers: [],
			fileReferences: [],
			envVars: [],
		};
		const result = buildConfigShowSections(emptyInspection, {
			hierarchy: [],
			homeDir: "/home/user",
			disableColors: true,
		});
		expect(stripAnsi(result.join("\n")).trim()).toMatchSnapshot();
	});
});
