export interface ComposerTrigger {
	/** Glob pattern for file paths that activate this composer */
	files?: string[];
	/** Directory patterns that activate this composer */
	directories?: string[];
	/** Keywords in the prompt that activate this composer */
	keywords?: string[];
}

export interface ComposerConfig {
	name: string;
	description: string;
	/** System prompt to prepend/append to the base prompt */
	systemPrompt?: string;
	/** How to combine systemPrompt with base: prepend, append, or replace */
	promptMode?: "prepend" | "append" | "replace";
	/** Whitelist of tool names to allow (if omitted, all tools allowed) */
	tools?: string[];
	/** Model to use when this composer is active */
	model?: string;
	/** Triggers for auto-activation */
	triggers?: ComposerTrigger;
	/** Whether this composer is enabled */
	enabled?: boolean;
}

export interface LoadedComposer extends ComposerConfig {
	source: "project" | "personal";
	filePath: string;
}

export interface ComposerState {
	/** Currently active composer, or null if none */
	active: LoadedComposer | null;
	/** Available composers */
	available: LoadedComposer[];
}
