import type { SlashCommand } from "@evalops/tui";
import { loadPrompts } from "../../commands/catalog.js";
import type {
	CommandEntry,
	CommandExecutionContext,
} from "../commands/types.js";
import { buildCommandRegistry } from "../utils/commands/command-registry-builder.js";
import { buildPromptTemplateSlashCommands } from "./prompt-template-slash-commands.js";

type CommandRegistryOptions = Parameters<typeof buildCommandRegistry>[0];

export type CommandRegistryResult = {
	entries: CommandEntry[];
	commands: SlashCommand[];
};

export function buildTuiCommandRegistry({
	cwd,
	registryOptions,
	executePromptTemplate,
	logDebug,
}: {
	cwd: string;
	registryOptions: CommandRegistryOptions;
	executePromptTemplate: (
		promptName: string,
		userArgumentText: string,
		context: CommandExecutionContext,
	) => void;
	logDebug?: (message: string, meta?: Record<string, unknown>) => void;
}): CommandRegistryResult {
	const registry = buildCommandRegistry(registryOptions);
	const promptTemplates = loadPrompts(cwd);
	const promptTemplateCommands = buildPromptTemplateSlashCommands({
		prompts: promptTemplates,
		existingCommands: registry.commands,
		createContext: registryOptions.createContext,
		executePromptTemplate,
	});
	if (promptTemplateCommands.commands.length > 0) {
		registry.entries.push(...promptTemplateCommands.entries);
		registry.commands.push(...promptTemplateCommands.commands);
		logDebug?.("Registered prompt templates as slash commands", {
			added: promptTemplateCommands.commands.length,
			skipped: promptTemplateCommands.skipped,
		});
	}
	return registry;
}
