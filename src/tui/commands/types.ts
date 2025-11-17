import type {
	AutocompleteItem,
	CommandArgumentDefinition,
	SlashCommand,
} from "../../tui-lib/index.js";

export interface CommandExecutionContext<TArgs = Record<string, unknown>> {
	command: SlashCommand;
	rawInput: string;
	argumentText: string;
	parsedArgs?: TArgs;
	showInfo(message: string): void;
	showError(message: string): void;
	renderHelp(): void;
}

export type RunScriptCompletionProvider = (
	prefix: string,
) => AutocompleteItem[] | null;

export interface CommandHandlers {
	thinking(context: CommandExecutionContext): void;
	model(context: CommandExecutionContext): void;
	exportSession(context: CommandExecutionContext): void;
	tools(context: CommandExecutionContext): void;
	importConfig(context: CommandExecutionContext): Promise<void> | void;
	sessionInfo(context: CommandExecutionContext): void;
	sessions(context: CommandExecutionContext): void;
	reportBug(context: CommandExecutionContext): void;
	about(context: CommandExecutionContext): void;
	status(context: CommandExecutionContext): void;
	review(context: CommandExecutionContext): void;
	undoChanges(context: CommandExecutionContext): void;
	shareFeedback(context: CommandExecutionContext): void;
	mention(context: CommandExecutionContext): void;
	help(context: CommandExecutionContext): void;
	update(context: CommandExecutionContext): Promise<void> | void;
	config(context: CommandExecutionContext): Promise<void> | void;
	cost(context: CommandExecutionContext): Promise<void> | void;
	telemetry(context: CommandExecutionContext): void;
	stats(context: CommandExecutionContext): Promise<void> | void;
	plan(context: CommandExecutionContext): void;
	preview(context: CommandExecutionContext): Promise<void> | void;
	run(context: CommandExecutionContext): Promise<void> | void;
	ollama(context: CommandExecutionContext): Promise<void> | void;
	why(context: CommandExecutionContext): void;
	diagnostics(context: CommandExecutionContext): void;
	compact(context: CommandExecutionContext): Promise<void> | void;
	compactTools(context: CommandExecutionContext): void;
	queue(context: CommandExecutionContext): Promise<void> | void;
	quit(context: CommandExecutionContext): void;
}

export interface CommandEntry {
	command: SlashCommand;
	matches: (input: string) => boolean;
	execute: (input: string) => void | Promise<void>;
}

export interface CommandRegistryOptions {
	getRunScriptCompletions: RunScriptCompletionProvider;
	handlers: CommandHandlers;
	createContext: (input: {
		command: SlashCommand;
		rawInput: string;
		argumentText: string;
		parsedArgs?: Record<string, unknown>;
	}) => CommandExecutionContext;
}

export type { CommandArgumentDefinition };
