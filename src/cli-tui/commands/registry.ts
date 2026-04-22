import type { SlashCommand } from "@evalops/tui";
import { parseCommandArguments, shouldShowHelp } from "./argument-parser.js";
import {
	type CommandCatalogEntry,
	CommandCompletionKind,
	CommandMatchKind,
	POST_SUITE_COMMAND_CATALOG,
	PRIMARY_COMMAND_CATALOG,
} from "./command-catalog.js";
import {
	COMMAND_SUITE_DEFINITIONS,
	type CommandSuiteDefinition,
} from "./command-suite-catalog.js";
import { HOTKEYS_SUBCOMMANDS } from "./hotkeys-command.js";
import { PACKAGE_SUBCOMMANDS } from "./package-handlers.js";
import {
	ACCESS_SUBCOMMANDS,
	createSubcommandCompletions,
} from "./subcommands/index.js";
import type {
	CommandEntry,
	CommandExecutionContext,
	CommandHandlers,
	CommandRegistryOptions,
	RunScriptCompletionProvider,
} from "./types.js";

const equals =
	(name: string, aliases: readonly string[] = []) =>
	(input: string) =>
		input === `/${name}` || aliases.some((a) => input === `/${a}`);

const withArgs =
	(name: string, aliases: readonly string[] = []) =>
	(input: string) =>
		input === `/${name}` ||
		input.startsWith(`/${name} `) ||
		aliases.some((a) => input === `/${a}` || input.startsWith(`/${a} `));

const matchDiagnostics = (input: string) =>
	input === "/diag" ||
	input.startsWith("/diag ") ||
	input === "/diagnostics" ||
	input === "/d" ||
	input.startsWith("/d ");

const matchQuit = (input: string) =>
	input === "/quit" || input === "/exit" || input === "/q";

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

type CommandCatalogBuildContext = {
	getRunScriptCompletions: RunScriptCompletionProvider;
	handlers: CommandHandlers;
	createContext: CommandRegistryOptions["createContext"];
};

function buildCommandCatalogEntries(
	definitions: readonly CommandCatalogEntry[],
	context: CommandCatalogBuildContext,
): CommandEntry[] {
	return definitions.map((definition) =>
		buildCommandCatalogEntry(definition, context),
	);
}

function buildCommandCatalogEntry(
	definition: CommandCatalogEntry,
	context: CommandCatalogBuildContext,
): CommandEntry {
	const command = withCatalogCompletions(
		definition,
		context.getRunScriptCompletions,
	);
	const handler = (executionContext: CommandExecutionContext) => {
		rewriteCatalogContext(definition, executionContext);
		return context.handlers[definition.handlerKey](executionContext);
	};
	return buildEntry(
		command,
		buildCatalogMatcher(definition),
		handler,
		context.createContext,
	);
}

function withCatalogCompletions(
	definition: CommandCatalogEntry,
	getRunScriptCompletions: RunScriptCompletionProvider,
): SlashCommand {
	const getArgumentCompletions = resolveCatalogCompletions(
		definition,
		getRunScriptCompletions,
	);
	return getArgumentCompletions
		? { ...definition.command, getArgumentCompletions }
		: definition.command;
}

function resolveCatalogCompletions(
	definition: CommandCatalogEntry,
	getRunScriptCompletions: RunScriptCompletionProvider,
): SlashCommand["getArgumentCompletions"] | undefined {
	switch (definition.completions) {
		case CommandCompletionKind.Access:
			return createSubcommandCompletions(ACCESS_SUBCOMMANDS);
		case CommandCompletionKind.Hotkeys:
			return createSubcommandCompletions(HOTKEYS_SUBCOMMANDS);
		case CommandCompletionKind.Package:
			return createSubcommandCompletions(PACKAGE_SUBCOMMANDS);
		case CommandCompletionKind.RunScripts:
			return getRunScriptCompletions;
		case undefined:
			return undefined;
	}
}

function buildCatalogMatcher(
	definition: CommandCatalogEntry,
): (input: string) => boolean {
	const aliases = definition.match.aliases ?? definition.command.aliases;
	switch (definition.match.kind) {
		case CommandMatchKind.Exact:
			return equals(definition.command.name, aliases);
		case CommandMatchKind.WithArgs:
			return withArgs(definition.command.name, aliases);
		case CommandMatchKind.Diagnostics:
			return matchDiagnostics;
		case CommandMatchKind.Quit:
			return matchQuit;
	}
}

function rewriteCatalogContext(
	definition: CommandCatalogEntry,
	context: CommandExecutionContext,
): void {
	if (!definition.rewriteTo) {
		return;
	}
	context.rawInput = context.rawInput.replace(
		new RegExp(`^/${escapeRegExp(definition.command.name)}(?=\\s|$)`),
		`/${definition.rewriteTo}`,
	);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildCommandSuiteEntries(
	getCommandSuiteHandlers: CommandRegistryOptions["getCommandSuiteHandlers"],
	createContext: CommandRegistryOptions["createContext"],
): CommandEntry[] {
	return COMMAND_SUITE_DEFINITIONS.map((definition) =>
		buildCommandSuiteEntry(definition, getCommandSuiteHandlers, createContext),
	);
}

function buildEntry(
	command: SlashCommand,
	matches: (input: string) => boolean,
	handler: (context: CommandExecutionContext) => void | Promise<void>,
	createContext: CommandRegistryOptions["createContext"],
): CommandEntry {
	return {
		command,
		matches,
		execute: (input: string) =>
			executeCommand(command, input, handler, createContext),
	};
}

function buildCommandSuiteEntry(
	definition: CommandSuiteDefinition,
	getCommandSuiteHandlers: CommandRegistryOptions["getCommandSuiteHandlers"],
	createContext: CommandRegistryOptions["createContext"],
): CommandEntry {
	const handler = (context: CommandExecutionContext) =>
		getCommandSuiteHandlers()[definition.key](context);
	return buildEntry(
		{
			...definition.command,
			getArgumentCompletions: createSubcommandCompletions(
				definition.subcommands,
			),
		},
		withArgs(definition.command.name, definition.command.aliases),
		handler,
		createContext,
	);
}

function executeCommand(
	command: SlashCommand,
	rawInput: string,
	handler: (context: CommandExecutionContext) => void | Promise<void>,
	createContext: CommandRegistryOptions["createContext"],
): void | Promise<void> {
	const argumentText = extractArgumentText(rawInput);
	if (shouldShowHelp(argumentText)) {
		const context = createContext({ command, rawInput, argumentText });
		context.renderHelp();
		return;
	}
	const parseResult = parseCommandArguments(argumentText, command.arguments);
	if (!parseResult.ok) {
		const context = createContext({ command, rawInput, argumentText });
		context.showError(
			"errors" in parseResult ? parseResult.errors.join(" ") : "Parse error",
		);
		context.renderHelp();
		return;
	}
	const context = createContext({
		command,
		rawInput,
		argumentText,
		parsedArgs: parseResult.args,
	});
	return handler(context);
}

function extractArgumentText(input: string): string {
	const spaceIndex = input.indexOf(" ");
	if (spaceIndex === -1) {
		return "";
	}
	return input.slice(spaceIndex + 1).trim();
}
