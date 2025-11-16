import type { AutocompleteItem, SlashCommand } from "../../tui-lib/index.js";

export type RunScriptCompletionProvider = (
	prefix: string,
) => AutocompleteItem[] | null;

export interface CommandHandlers {
	thinking(): void;
	model(): void;
	exportSession(text: string): void;
	tools(text: string): void;
	importConfig(text: string): Promise<void> | void;
	sessionInfo(): void;
	sessions(text: string): void;
	reportBug(): void;
	status(): void;
	review(): void;
	undoChanges(text: string): void;
	shareFeedback(): void;
	mention(text: string): void;
	help(): void;
	update(): Promise<void> | void;
	config(): Promise<void> | void;
	plan(text: string): void;
	preview(text: string): Promise<void> | void;
	run(text: string): Promise<void> | void;
	why(): void;
	diagnostics(text: string): void;
	compact(): Promise<void> | void;
	compactTools(text: string): void;
	quit(): void;
}

export interface CommandEntry {
	command: SlashCommand;
	matches: (input: string) => boolean;
	execute: (input: string) => void | Promise<void>;
}

export interface CommandRegistryOptions {
	getRunScriptCompletions: RunScriptCompletionProvider;
	handlers: CommandHandlers;
}
