/**
 * SDK Tool Types Export
 *
 * This file exports TypeBox schemas and TypeScript types for all built-in tools,
 * enabling type-safe tool integration for SDK consumers.
 *
 * @example
 * ```typescript
 * import type { ReadInput, EditInput, BashInput } from '@evalops/composer/sdk-tools';
 *
 * const readParams: ReadInput = {
 *   path: '/path/to/file',
 *   offset: 1,
 *   limit: 100
 * };
 * ```
 */

import { type Static, type TSchema, Type } from "@sinclair/typebox";

// ============================================================================
// Read Tool
// ============================================================================

export const ReadInputSchema = Type.Object({
	path: Type.String({
		description: "Path to the file to read (relative or absolute)",
		minLength: 1,
	}),
	offset: Type.Optional(
		Type.Integer({
			description: "Line number to start reading from (1-indexed)",
			minimum: 1,
		}),
	),
	limit: Type.Optional(
		Type.Integer({
			description: "Maximum number of lines to read",
			minimum: 1,
		}),
	),
	mode: Type.Optional(
		Type.Union(
			[Type.Literal("normal"), Type.Literal("head"), Type.Literal("tail")],
			{
				description: 'Reading mode: "normal", "head", or "tail"',
				default: "normal",
			},
		),
	),
	encoding: Type.Optional(
		Type.Union(
			[
				Type.Literal("utf-8"),
				Type.Literal("utf-16le"),
				Type.Literal("latin1"),
				Type.Literal("ascii"),
			],
			{
				description: "Text encoding for the file",
				default: "utf-8",
			},
		),
	),
});

export type ReadInput = Static<typeof ReadInputSchema>;

// ============================================================================
// Edit Tool
// ============================================================================

export const EditOperationSchema = Type.Object({
	oldText: Type.String({
		description: "Exact text to find and replace",
		minLength: 1,
	}),
	newText: Type.Optional(
		Type.String({
			description: "Replacement text (omit or empty string to delete)",
			default: "",
		}),
	),
});

export const EditInputSchema = Type.Object({
	path: Type.String({
		description: "Path to the file to edit",
		minLength: 1,
	}),
	oldText: Type.Optional(
		Type.String({
			description: "Exact text to find and replace",
			minLength: 1,
		}),
	),
	newText: Type.Optional(
		Type.String({
			description: "New text to replace the old text with",
			default: "",
		}),
	),
	edits: Type.Optional(
		Type.Array(EditOperationSchema, {
			description: "Multiple edits to apply sequentially",
			minItems: 1,
			maxItems: 50,
		}),
	),
	replaceAll: Type.Optional(
		Type.Boolean({
			description: "Replace all occurrences",
			default: false,
		}),
	),
	occurrence: Type.Optional(
		Type.Integer({
			description: "Which occurrence to replace (1-based)",
			minimum: 1,
			default: 1,
		}),
	),
	dryRun: Type.Optional(
		Type.Boolean({
			description: "Preview without writing changes",
			default: false,
		}),
	),
});

export type EditInput = Static<typeof EditInputSchema>;

// ============================================================================
// Write Tool
// ============================================================================

export const WriteInputSchema = Type.Object({
	path: Type.String({
		description: "Path to the file to write",
		minLength: 1,
	}),
	content: Type.String({
		description: "Content to write to the file",
	}),
});

export type WriteInput = Static<typeof WriteInputSchema>;

// ============================================================================
// Bash Tool
// ============================================================================

export const BashInputSchema = Type.Object({
	command: Type.String({
		description: "The command to execute",
		minLength: 1,
	}),
	timeout: Type.Optional(
		Type.Integer({
			description: "Timeout in milliseconds (max 600000)",
			minimum: 1,
			maximum: 600000,
		}),
	),
	description: Type.Optional(
		Type.String({
			description: "Clear description of what this command does (5-10 words)",
		}),
	),
	runInBackground: Type.Optional(
		Type.Boolean({
			description: "Run command in background",
			default: false,
		}),
	),
});

export type BashInput = Static<typeof BashInputSchema>;

// ============================================================================
// Search (Grep) Tool
// ============================================================================

export const SearchInputSchema = Type.Object({
	pattern: Type.String({
		description: "Regular expression pattern to search for",
		minLength: 1,
	}),
	path: Type.Optional(
		Type.String({
			description: "File or directory to search in",
		}),
	),
	glob: Type.Optional(
		Type.String({
			description: 'Glob pattern to filter files (e.g., "*.js", "*.{ts,tsx}")',
		}),
	),
	outputMode: Type.Optional(
		Type.Union(
			[
				Type.Literal("content"),
				Type.Literal("files_with_matches"),
				Type.Literal("count"),
			],
			{
				description: "Output mode",
				default: "files_with_matches",
			},
		),
	),
	contextBefore: Type.Optional(
		Type.Integer({
			description: "Lines of context before each match",
			minimum: 0,
		}),
	),
	contextAfter: Type.Optional(
		Type.Integer({
			description: "Lines of context after each match",
			minimum: 0,
		}),
	),
	caseInsensitive: Type.Optional(
		Type.Boolean({
			description: "Case insensitive search",
			default: false,
		}),
	),
	headLimit: Type.Optional(
		Type.Integer({
			description: "Limit output to first N entries",
			minimum: 1,
		}),
	),
	multiline: Type.Optional(
		Type.Boolean({
			description: "Enable multiline mode",
			default: false,
		}),
	),
});

export type SearchInput = Static<typeof SearchInputSchema>;

// ============================================================================
// List (Glob) Tool
// ============================================================================

export const ListInputSchema = Type.Object({
	pattern: Type.String({
		description: 'Glob pattern to match files (e.g., "**/*.ts")',
		minLength: 1,
	}),
	path: Type.Optional(
		Type.String({
			description: "Directory to search in",
		}),
	),
});

export type ListInput = Static<typeof ListInputSchema>;

// ============================================================================
// Notebook Edit Tool
// ============================================================================

export const NotebookEditInputSchema = Type.Object({
	path: Type.String({
		description: "Path to the Jupyter notebook file (.ipynb)",
		minLength: 1,
	}),
	cellId: Type.Optional(
		Type.String({
			description: "Cell ID to edit",
		}),
	),
	cellIndex: Type.Optional(
		Type.Integer({
			description: "Cell index (0-based) to edit",
			minimum: 0,
		}),
	),
	newSource: Type.String({
		description: "New source content for the cell",
	}),
	cellType: Type.Optional(
		Type.Union([Type.Literal("code"), Type.Literal("markdown")], {
			description: "Cell type",
		}),
	),
	editMode: Type.Optional(
		Type.Union(
			[Type.Literal("replace"), Type.Literal("insert"), Type.Literal("delete")],
			{
				description: "Edit mode",
				default: "replace",
			},
		),
	),
});

export type NotebookEditInput = Static<typeof NotebookEditInputSchema>;

// ============================================================================
// Todo Tool
// ============================================================================

export const TodoItemSchema = Type.Object({
	content: Type.String({
		description: "The task description",
		minLength: 1,
	}),
	status: Type.Union(
		[
			Type.Literal("pending"),
			Type.Literal("in_progress"),
			Type.Literal("completed"),
		],
		{
			description: "Task status",
		},
	),
	activeForm: Type.String({
		description:
			'Present continuous form shown during execution (e.g., "Running tests")',
		minLength: 1,
	}),
});

export const TodoInputSchema = Type.Object({
	todos: Type.Array(TodoItemSchema, {
		description: "The updated todo list",
	}),
});

export type TodoItem = Static<typeof TodoItemSchema>;
export type TodoInput = Static<typeof TodoInputSchema>;

// ============================================================================
// Ask User Tool
// ============================================================================

export const QuestionOptionSchema = Type.Object({
	label: Type.String({
		description: "Display text for this option (1-5 words)",
		minLength: 1,
		maxLength: 50,
	}),
	description: Type.String({
		description: "Explanation of what this option means",
		minLength: 1,
		maxLength: 200,
	}),
});

export const QuestionSchema = Type.Object({
	question: Type.String({
		description: "The complete question to ask",
		minLength: 5,
		maxLength: 500,
	}),
	header: Type.String({
		description: "Short label (max 12 chars)",
		minLength: 1,
		maxLength: 12,
	}),
	options: Type.Array(QuestionOptionSchema, {
		description: "Available choices (2-4 options)",
		minItems: 2,
		maxItems: 4,
	}),
	multiSelect: Type.Optional(
		Type.Boolean({
			description: "Allow selecting multiple options",
			default: false,
		}),
	),
});

export const AskUserInputSchema = Type.Object({
	questions: Type.Array(QuestionSchema, {
		description: "Questions to ask (1-4)",
		minItems: 1,
		maxItems: 4,
	}),
});

export type AskUserQuestionOption = Static<typeof QuestionOptionSchema>;
export type AskUserQuestion = Static<typeof QuestionSchema>;
export type AskUserInput = Static<typeof AskUserInputSchema>;

// ============================================================================
// Web Search Tool
// ============================================================================

export const WebSearchInputSchema = Type.Object({
	query: Type.String({
		description: "The search query",
		minLength: 2,
	}),
	allowedDomains: Type.Optional(
		Type.Array(Type.String(), {
			description: "Only include results from these domains",
		}),
	),
	blockedDomains: Type.Optional(
		Type.Array(Type.String(), {
			description: "Exclude results from these domains",
		}),
	),
});

export type WebSearchInput = Static<typeof WebSearchInputSchema>;

// ============================================================================
// Web Fetch Tool
// ============================================================================

export const WebFetchInputSchema = Type.Object({
	url: Type.String({
		description: "The URL to fetch content from",
		format: "uri",
	}),
	prompt: Type.String({
		description: "Prompt to run on the fetched content",
	}),
});

export type WebFetchInput = Static<typeof WebFetchInputSchema>;

// ============================================================================
// Agent/Task Tool
// ============================================================================

export const AgentInputSchema = Type.Object({
	description: Type.String({
		description: "Short (3-5 word) description of the task",
		minLength: 1,
	}),
	prompt: Type.String({
		description: "The task for the agent to perform",
		minLength: 1,
	}),
	subagentType: Type.String({
		description:
			"The type of specialized agent to use (e.g., 'explore', 'plan', 'review')",
	}),
	model: Type.Optional(
		Type.Union(
			[Type.Literal("sonnet"), Type.Literal("opus"), Type.Literal("haiku")],
			{
				description:
					"Model to use for this agent. Prefer 'haiku' for quick, straightforward tasks.",
			},
		),
	),
	resume: Type.Optional(
		Type.String({
			description:
				"Agent transcript ID to resume from. If provided, the agent will continue from the previous execution, building on prior context and analysis.",
		}),
	),
});

export type AgentInput = Static<typeof AgentInputSchema>;

// ============================================================================
// All Tool Input Types Union
// ============================================================================

export type ToolInputSchemas =
	| ReadInput
	| EditInput
	| WriteInput
	| BashInput
	| SearchInput
	| ListInput
	| NotebookEditInput
	| TodoInput
	| AskUserInput
	| WebSearchInput
	| WebFetchInput
	| AgentInput;

// ============================================================================
// Schema Registry
// ============================================================================

export const toolSchemas: Record<string, TSchema> = {
	read: ReadInputSchema,
	edit: EditInputSchema,
	write: WriteInputSchema,
	bash: BashInputSchema,
	search: SearchInputSchema,
	list: ListInputSchema,
	notebook_edit: NotebookEditInputSchema,
	todo: TodoInputSchema,
	ask_user: AskUserInputSchema,
	websearch: WebSearchInputSchema,
	webfetch: WebFetchInputSchema,
	agent: AgentInputSchema,
};

/**
 * Get the TypeBox schema for a tool by name.
 */
export function getToolSchema(toolName: string): TSchema | undefined {
	return toolSchemas[toolName];
}
