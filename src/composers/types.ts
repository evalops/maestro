export interface ComposerTrigger {
	/** Glob pattern for file paths that activate this composer */
	files?: string[];
	/** Directory patterns that activate this composer */
	directories?: string[];
	/** Keywords in the prompt that activate this composer */
	keywords?: string[];
}

/** Permission level for tool access */
export type PermissionLevel = "allow" | "ask" | "deny";

/** Tool permission configuration */
export interface ToolPermissions {
	/** Default permission for unlisted tools */
	default?: PermissionLevel;
	/** Specific tool permissions (tool name -> permission) */
	tools?: Record<string, PermissionLevel>;
	/** Bash command patterns (pattern -> permission) */
	bash?: Record<string, PermissionLevel>;
}

/** Agent mode - when this agent can be used */
export type AgentMode = "primary" | "subagent" | "all";

export interface ComposerConfig {
	name: string;
	description: string;
	/** System prompt to prepend/append to the base prompt */
	systemPrompt?: string;
	/** How to combine systemPrompt with base: prepend, append, or replace */
	promptMode?: "prepend" | "append" | "replace";
	/** Whitelist of tool names to allow (if omitted, all tools allowed) */
	tools?: string[];
	/** Blocklist of tool names to deny */
	denyTools?: string[];
	/** Model to use when this composer is active */
	model?: string;
	/** Triggers for auto-activation */
	triggers?: ComposerTrigger;
	/** Whether this composer is enabled */
	enabled?: boolean;
	/** Permission configuration */
	permissions?: ToolPermissions;
	/** Agent mode - primary, subagent, or all */
	mode?: AgentMode;
	/** Temperature for LLM */
	temperature?: number;
	/** Top-p for LLM */
	topP?: number;
	/** Color for UI display */
	color?: string;
	/** Whether this is a built-in agent */
	builtIn?: boolean;
}

export interface LoadedComposer extends ComposerConfig {
	source: "project" | "personal" | "builtin";
	filePath: string;
}

export interface ComposerState {
	/** Currently active composer, or null if none */
	active: LoadedComposer | null;
	/** Available composers */
	available: LoadedComposer[];
}
