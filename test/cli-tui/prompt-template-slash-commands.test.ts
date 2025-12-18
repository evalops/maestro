import type { SlashCommand } from "@evalops/tui";
import { describe, expect, it, vi } from "vitest";
import { buildPromptTemplateSlashCommands } from "../../src/cli-tui/tui-renderer/prompt-template-slash-commands.js";
import type { PromptDefinition } from "../../src/commands/catalog.js";

function prompt(name: string, aliases: string[] = []): PromptDefinition {
	return {
		name,
		description: `desc ${name}`,
		aliases: aliases.length > 0 ? aliases : undefined,
		argumentHint: "FILE=src/main.ts",
		body: "Body",
		sourcePath: `/tmp/${name}.md`,
		sourceType: "project",
		namedPlaceholders: [],
		hasPositionalPlaceholders: false,
	};
}

describe("prompt-template slash commands", () => {
	it("registers prompts as slash commands and skips collisions", () => {
		const prompts = [prompt("pr-review", ["prr"]), prompt("model")];
		const existingCommands: SlashCommand[] = [{ name: "model" }];

		const createContext = vi.fn((input) => ({
			command: input.command,
			rawInput: input.rawInput,
			argumentText: input.argumentText,
			showInfo: vi.fn(),
			showError: vi.fn(),
			renderHelp: vi.fn(),
		}));

		const executePromptTemplate = vi.fn();

		const result = buildPromptTemplateSlashCommands({
			prompts,
			existingCommands,
			createContext,
			executePromptTemplate,
		});

		expect(result.commands.map((c) => c.name)).toEqual(["pr-review"]);
		expect(result.commands[0].aliases).toEqual(["prr"]);
		expect(result.skipped).toBe(1);

		const entry = result.entries[0];
		expect(entry.matches("/pr-review")).toBe(true);
		expect(entry.matches("/pr-review FILE=src/main.ts")).toBe(true);
		expect(entry.matches("/prr FILE=src/main.ts")).toBe(true);
		expect(entry.matches("/pr-reviewer")).toBe(false);

		// Help short-circuits execution
		entry.execute("/pr-review --help");
		const helpCtx = createContext.mock.results[0]?.value;
		expect(helpCtx?.renderHelp).toHaveBeenCalledTimes(1);
		expect(executePromptTemplate).not.toHaveBeenCalled();

		// Normal invocation delegates
		entry.execute("/pr-review FILE=src/main.ts");
		expect(executePromptTemplate).toHaveBeenCalledWith(
			"pr-review",
			"FILE=src/main.ts",
			expect.any(Object),
		);
	});
});
