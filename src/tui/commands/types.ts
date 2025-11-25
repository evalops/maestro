import type {
	AutocompleteItem,
	CommandArgumentDefinition,
	SlashCommand,
} from "@evalops/tui";

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
	exportSession(context: CommandExecutionContext): Promise<void> | void;
	shareSession(context: CommandExecutionContext): Promise<void> | void;
	tools(context: CommandExecutionContext): void;
	importConfig(context: CommandExecutionContext): Promise<void> | void;
	session(context: CommandExecutionContext): void;
	sessions(context: CommandExecutionContext): void;
	report(context: CommandExecutionContext): void;
	about(context: CommandExecutionContext): void;
	clear(context: CommandExecutionContext): Promise<void> | void;
	status(context: CommandExecutionContext): void;
	review(context: CommandExecutionContext): void;
	undoChanges(context: CommandExecutionContext): void;
	mention(context: CommandExecutionContext): void;
	help(context: CommandExecutionContext): void;
	update(context: CommandExecutionContext): Promise<void> | void;
	changelog(context: CommandExecutionContext): void;
	config(context: CommandExecutionContext): Promise<void> | void;
	cost(context: CommandExecutionContext): Promise<void> | void;
	quota(context: CommandExecutionContext): Promise<void> | void;
	telemetry(context: CommandExecutionContext): void;
	training(context: CommandExecutionContext): void;
	stats(context: CommandExecutionContext): Promise<void> | void;
	plan(context: CommandExecutionContext): void;
	preview(context: CommandExecutionContext): Promise<void> | void;
	run(context: CommandExecutionContext): Promise<void> | void;
	ollama(context: CommandExecutionContext): Promise<void> | void;
	diagnostics(context: CommandExecutionContext): void;
	background(context: CommandExecutionContext): void;
	compact(context: CommandExecutionContext): Promise<void> | void;
	footer(context: CommandExecutionContext): void;
	compactTools(context: CommandExecutionContext): void;
	queue(context: CommandExecutionContext): Promise<void> | void;
	branch(context: CommandExecutionContext): void;
	quit(context: CommandExecutionContext): void;
	approvals(context: CommandExecutionContext): void;
	planMode(context: CommandExecutionContext): void;
	commands(context: CommandExecutionContext): void | Promise<void>;
	newChat(context: CommandExecutionContext): void;
	initAgents(context: CommandExecutionContext): void;
	mcp(context: CommandExecutionContext): void;
	composer(context: CommandExecutionContext): void;
	login(context: CommandExecutionContext): void | Promise<void>;
	logout(context: CommandExecutionContext): void | Promise<void>;
	zen(context: CommandExecutionContext): void;
	context(context: CommandExecutionContext): void;
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
