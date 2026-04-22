import type { SlashCommand } from "@evalops/tui";
import {
	POST_SUITE_COMMAND_CATALOG,
	PRIMARY_COMMAND_CATALOG,
} from "./command-catalog.js";
import {
	type CommandCatalogBuildContext,
	buildCommandCatalogEntries,
	buildCommandEntry,
	matchCommandWithArgs,
} from "./command-registry-adapter.js";
import {
	COMMAND_SUITE_DEFINITIONS,
	type CommandSuiteDefinition,
} from "./command-suite-catalog.js";
import { createSubcommandCompletions } from "./subcommands/index.js";
import type {
	CommandEntry,
	CommandExecutionContext,
	CommandRegistryOptions,
} from "./types.js";

export function createCommandRegistry({
	getRunScriptCompletions,
	handlers,
	getCommandSuiteHandlers,
	createContext,
}: CommandRegistryOptions): CommandEntry[] {
	const catalogContext: CommandCatalogBuildContext = {
		getRunScriptCompletions,
		handlers,
		createContext,
	};

	return [
		...buildCommandCatalogEntries(PRIMARY_COMMAND_CATALOG, catalogContext),
		...buildCommandSuiteEntries(getCommandSuiteHandlers, createContext),
		...buildCommandCatalogEntries(POST_SUITE_COMMAND_CATALOG, catalogContext),
	];
}

function buildCommandSuiteEntries(
	getCommandSuiteHandlers: CommandRegistryOptions["getCommandSuiteHandlers"],
	createContext: CommandRegistryOptions["createContext"],
): CommandEntry[] {
	return COMMAND_SUITE_DEFINITIONS.map((definition) =>
		buildCommandSuiteEntry(definition, getCommandSuiteHandlers, createContext),
	);
}

function buildCommandSuiteEntry(
	definition: CommandSuiteDefinition,
	getCommandSuiteHandlers: CommandRegistryOptions["getCommandSuiteHandlers"],
	createContext: CommandRegistryOptions["createContext"],
): CommandEntry {
	const handler = (context: CommandExecutionContext) =>
		getCommandSuiteHandlers()[definition.key](context);
	return buildCommandEntry(
		commandFromSuite(definition),
		matchCommandWithArgs(definition.name, definition.aliases),
		handler,
		createContext,
	);
}

function commandFromSuite(definition: CommandSuiteDefinition): SlashCommand {
	return {
		name: definition.name,
		description: definition.description,
		usage: definition.usage,
		examples: definition.examples,
		tags: definition.tags,
		aliases: definition.aliases,
		arguments: definition.arguments,
		getArgumentCompletions: createSubcommandCompletions(definition.subcommands),
	};
}
