import { Type } from "@sinclair/typebox";
import type { AgentTool } from "../agent/types.js";

/**
 * JetBrains IDE-specific tools.
 * These tools are executed on the client (JetBrains plugin) side.
 * The backend defines the schema; the plugin implements the execution.
 */

export const jetbrainsGetDiagnosticsTool: AgentTool = {
	name: "jetbrains_get_diagnostics",
	description:
		"Get diagnostic errors/warnings from the current JetBrains IDE workspace. Returns issues from the code analysis daemon.",
	parameters: Type.Object({
		uri: Type.Optional(
			Type.String({
				description:
					"File path within project to filter diagnostics. If omitted, returns diagnostics from all open files.",
			}),
		),
	}),
	executionLocation: "client",
	execute: async () => {
		// This code is never executed because of executionLocation: "client"
		// The JetBrains plugin handles execution via ClientToolExecutor
		return { content: [], isError: false };
	},
};

export const jetbrainsGetDefinitionTool: AgentTool = {
	name: "jetbrains_get_definition",
	description:
		"Go to definition of a symbol at a specific position. Uses PSI (Program Structure Interface) to resolve references.",
	parameters: Type.Object({
		uri: Type.String({ description: "File path within project" }),
		line: Type.Number({ minimum: 0, description: "Line number (0-based)" }),
		character: Type.Number({
			minimum: 0,
			description: "Character number (0-based)",
		}),
	}),
	executionLocation: "client",
	execute: async () => {
		return { content: [], isError: false };
	},
};

export const jetbrainsFindReferencesTool: AgentTool = {
	name: "jetbrains_find_references",
	description:
		"Find all references to a symbol at a specific position. Searches the entire project for usages.",
	parameters: Type.Object({
		uri: Type.String({ description: "File path within project" }),
		line: Type.Number({ minimum: 0, description: "Line number (0-based)" }),
		character: Type.Number({
			minimum: 0,
			description: "Character number (0-based)",
		}),
	}),
	executionLocation: "client",
	execute: async () => {
		return { content: [], isError: false };
	},
};

export const jetbrainsReadFileRangeTool: AgentTool = {
	name: "jetbrains_read_file_range",
	description:
		"Read a specific range of lines from a file (more efficient for large files). Uses IDE's document model.",
	parameters: Type.Object({
		uri: Type.String({ description: "File path within project" }),
		startLine: Type.Number({
			minimum: 0,
			maximum: 10000,
			description: "Start line number (0-based, inclusive)",
		}),
		endLine: Type.Number({
			minimum: 0,
			maximum: 10000,
			description: "End line number (0-based, inclusive, max 10000)",
		}),
	}),
	executionLocation: "client",
	execute: async () => {
		return { content: [], isError: false };
	},
};

/**
 * All JetBrains-specific tools.
 */
export const jetbrainsTools: AgentTool[] = [
	jetbrainsGetDiagnosticsTool,
	jetbrainsGetDefinitionTool,
	jetbrainsFindReferencesTool,
	jetbrainsReadFileRangeTool,
];
