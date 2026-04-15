import { Type } from "@sinclair/typebox";
import type { AgentTool } from "../agent/types.js";

export const vscodeGetDiagnosticsTool: AgentTool = {
	name: "vscode_get_diagnostics",
	description:
		"Get diagnostic errors/warnings from the current VS Code workspace.",
	parameters: Type.Object({
		uri: Type.Optional(
			Type.String({
				description: "File path within workspace to filter diagnostics",
			}),
		),
	}),
	executionLocation: "client",
	execute: async () => {
		// This code is never executed because of executionLocation: "client"
		return { content: [], isError: false };
	},
};

export const vscodeGetDefinitionTool: AgentTool = {
	name: "vscode_get_definition",
	description: "Go to definition of a symbol at a specific position.",
	parameters: Type.Object({
		uri: Type.String({ description: "File path within workspace" }),
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

export const vscodeFindReferencesTool: AgentTool = {
	name: "vscode_find_references",
	description: "Find references of a symbol at a specific position.",
	parameters: Type.Object({
		uri: Type.String({ description: "File path within workspace" }),
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

export const vscodeReadFileRangeTool: AgentTool = {
	name: "vscode_read_file_range",
	description:
		"Read a specific range of lines from a file (more efficient for large files).",
	parameters: Type.Object({
		uri: Type.String({ description: "File path within workspace" }),
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
