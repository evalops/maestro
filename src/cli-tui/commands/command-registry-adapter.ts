import type { SlashCommand } from "@evalops/tui";
import { parseCommandArguments, shouldShowHelp } from "./argument-parser.js";
import {
	type CommandCatalogEntry,
	CommandCompletionKind,
	CommandMatchKind,
} from "./command-catalog.js";
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

export type CommandCatalogBuildContext = {
	getRunScriptCompletions: RunScriptCompletionProvider;
	handlers: CommandHandlers;
	createContext: CommandRegistryOptions["createContext"];
};

export function buildCommandCatalogEntries(
	definitions: readonly CommandCatalogEntry[],
	context: CommandCatalogBuildContext,
): CommandEntry[] {
	return definitions.map((definition) =>
		buildCommandCatalogEntry(definition, context),
	);
}

export function buildCommandEntry(
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

export const matchCommandWithArgs =
	(name: string, aliases: readonly string[] = []) =>
	(input: string) =>
		input === `/${name}` ||
		input.startsWith(`/${name} `) ||
		aliases.some((alias) => {
			const commandAlias = `/${alias}`;
			return input === commandAlias || input.startsWith(`${commandAlias} `);
		});

const matchCommandExactly =
	(name: string, aliases: readonly string[] = []) =>
	(input: string) =>
		input === `/${name}` || aliases.some((alias) => input === `/${alias}`);

const matchDiagnostics = (input: string) =>
	input === "/diag" ||
	input.startsWith("/diag ") ||
	input === "/diagnostics" ||
	input === "/d" ||
	input.startsWith("/d ");

const matchQuit = (input: string) =>
	input === "/quit" || input === "/exit" || input === "/q";

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
	return buildCommandEntry(
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
	const command = commandFromCatalog(definition);
	const getArgumentCompletions = resolveCatalogCompletions(
		definition,
		getRunScriptCompletions,
	);
	return getArgumentCompletions
		? { ...command, getArgumentCompletions }
		: command;
}

function commandFromCatalog(definition: CommandCatalogEntry): SlashCommand {
	return {
		name: definition.name,
		description: definition.description,
		usage: definition.usage,
		examples: definition.examples,
		tags: definition.tags,
		aliases: definition.aliases,
		arguments: definition.arguments,
	};
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
	const aliases = definition.matchAliases ?? definition.aliases;
	switch (definition.matchKind) {
		case CommandMatchKind.Exact:
			return matchCommandExactly(definition.name, aliases);
		case CommandMatchKind.WithArgs:
			return matchCommandWithArgs(definition.name, aliases);
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
		new RegExp(`^/${escapeRegExp(definition.name)}(?=\\s|$)`),
		`/${definition.rewriteTo}`,
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

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
