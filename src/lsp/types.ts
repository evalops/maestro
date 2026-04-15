import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { MessageConnection } from "vscode-jsonrpc/node.js";

export interface LspRange {
	start: { line: number; character: number };
	end: { line: number; character: number };
}

export interface LspLocation {
	uri: string;
	range: LspRange;
}

export interface LspDiagnostic {
	severity?: 1 | 2 | 3 | 4;
	message: string;
	source?: string;
	range: LspRange;
}

export interface LspSymbol {
	name: string;
	kind: number;
	location: LspLocation;
}

export interface LspTextEdit {
	range: LspRange;
	newText: string;
}

export interface LspFormattingOptions {
	tabSize: number;
	insertSpaces: boolean;
	[key: string]: boolean | number | string;
}

export interface LspCompletionItem {
	label: string;
	kind?: number;
	detail?: string;
	documentation?: string | { kind: string; value: string };
	sortText?: string;
	filterText?: string;
	insertText?: string;
	textEdit?: LspTextEdit;
}

export interface LspCompletionList {
	isIncomplete: boolean;
	items: LspCompletionItem[];
}

export interface LspDocumentSymbol {
	name: string;
	detail?: string;
	kind: number;
	range: LspRange;
	selectionRange: LspRange;
	children?: LspDocumentSymbol[];
}

export interface LspClientHandle {
	id: string;
	root: string;
	process: ChildProcessWithoutNullStreams;
	connection: MessageConnection;
	diagnostics: Map<string, LspDiagnostic[]>;
	initialized: boolean;
	openFiles: Map<string, number>; // path -> version
}

export interface LspServerConfig {
	id: string;
	name?: string;
	extensions: string[];
	command: string;
	args?: string[];
	env?: Record<string, string>;
	rootResolver?: RootResolver;
	initializationOptions?: Record<string, unknown>;
}

export type RootResolver = (
	file: string,
) => string | undefined | Promise<string | undefined>;

export enum SymbolKind {
	File = 1,
	Module = 2,
	Namespace = 3,
	Package = 4,
	Class = 5,
	Method = 6,
	Property = 7,
	Field = 8,
	Constructor = 9,
	Enum = 10,
	Interface = 11,
	Function = 12,
	Variable = 13,
	Constant = 14,
	String = 15,
	Number = 16,
	Boolean = 17,
	Array = 18,
	Object = 19,
	Key = 20,
	Null = 21,
	EnumMember = 22,
	Struct = 23,
	Event = 24,
	Operator = 25,
	TypeParameter = 26,
}
