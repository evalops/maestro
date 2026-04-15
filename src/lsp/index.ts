/**
 * LSP Client - Refactored Architecture
 *
 * This module provides a clean interface for managing LSP (Language Server Protocol)
 * clients. The implementation is now properly architected with:
 *
 * - LspClient: Encapsulates individual client lifecycle
 * - LspClientManager: Manages multiple clients with retry logic
 * - Proper separation of concerns across multiple files
 * - No global mutable state (except singleton manager)
 */

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { MessageConnection } from "vscode-jsonrpc";
import { lspManager } from "./manager.js";
import { SymbolKind } from "./types.js";
import type {
	LspCompletionItem,
	LspCompletionList,
	LspDiagnostic,
	LspDocumentSymbol,
	LspFormattingOptions,
	LspLocation,
	LspRange,
	LspServerConfig,
	LspSymbol,
	LspTextEdit,
	RootResolver,
} from "./types.js";
import { pathToUri, uriToPath } from "./utils.js";

// Re-export types
export type {
	LspClientHandle,
	LspCompletionItem,
	LspCompletionList,
	LspDiagnostic,
	LspDocumentSymbol,
	LspFormattingOptions,
	LspLocation,
	LspRange,
	LspServerConfig,
	LspSymbol,
	LspTextEdit,
	RootResolver,
} from "./types.js";
export { SymbolKind } from "./types.js";

// Re-export manager events
export const lspEvents = lspManager;

/**
 * Configure LSP servers
 */
export async function configureServers(
	config: LspServerConfig[],
): Promise<void> {
	await lspManager.configureServers(config);
}

/**
 * Configure default root resolver
 */
export function configureRootResolver(resolver: RootResolver): void {
	lspManager.configureRootResolver(resolver);
}

/**
 * Open a file in all matching LSP servers
 */
export async function touchFile(file: string): Promise<void> {
	const clients = await lspManager.getClientsForFile(file);
	await Promise.all(clients.map((client) => client.openFile(file)));
}

/**
 * Update file content in all matching LSP servers
 */
export async function changeFile(file: string, content: string): Promise<void> {
	const clients = await lspManager.getClientsForFile(file);
	await Promise.all(clients.map((client) => client.changeFile(file, content)));
}

/**
 * Close a file in all LSP servers that have it open
 */
export async function closeFile(file: string): Promise<void> {
	const clients = lspManager.getAllClients().filter((c) => c.hasFile(file));
	await Promise.all(clients.map((client) => client.closeFile(file)));
}

/**
 * Collect diagnostics from all active clients
 */
export async function collectDiagnostics(): Promise<
	Record<string, LspDiagnostic[]>
> {
	const result: Record<string, LspDiagnostic[]> = {};
	const clients = lspManager.getAllClients();

	for (const client of clients) {
		const diagnostics = client.getAllDiagnostics();
		for (const [uri, entries] of diagnostics.entries()) {
			const file = uriToPath(uri);
			result[file] ??= [];
			result[file].push(...entries);
		}
	}

	return result;
}

/**
 * Get diagnostics for a specific file
 */
export async function getDiagnostics(file: string): Promise<LspDiagnostic[]> {
	const clients = await lspManager.getClientsForFile(file);
	const uri = pathToUri(file);
	const results: LspDiagnostic[] = [];

	for (const client of clients) {
		results.push(...client.getDiagnostics(uri));
	}

	return results;
}

/**
 * Get hover information at a position
 */
export async function hover(
	file: string,
	line: number,
	character: number,
): Promise<unknown[]> {
	const clients = await lspManager.getClientsForFile(file);
	const uri = pathToUri(file);

	return Promise.all(
		clients.map((client) =>
			client.connection.sendRequest("textDocument/hover", {
				textDocument: { uri },
				position: { line, character },
			}),
		),
	);
}

// Important symbol kinds for filtering
const IMPORTANT_KINDS = [
	SymbolKind.Class,
	SymbolKind.Function,
	SymbolKind.Method,
	SymbolKind.Interface,
	SymbolKind.Variable,
	SymbolKind.Constant,
	SymbolKind.Struct,
	SymbolKind.Enum,
];

/**
 * Helper to normalize LSP location results which can be Location, Location[], or LocationLink[]
 */
function normalizeLocationResult(result: unknown): LspLocation[] {
	if (!result) return [];

	const items = Array.isArray(result) ? result : [result];
	const locations: LspLocation[] = [];

	for (const item of items) {
		if (!item || typeof item !== "object") continue;

		// Handle LocationLink (has targetUri and targetRange)
		if ("targetUri" in item && "targetRange" in item) {
			const link = item as { targetUri: string; targetRange: LspRange };
			locations.push({ uri: link.targetUri, range: link.targetRange });
		}
		// Handle Location (has uri and range)
		else if ("uri" in item && "range" in item) {
			locations.push(item as LspLocation);
		}
	}

	return locations;
}

/**
 * Helper to execute an LSP request across all applicable clients
 */
async function executeLspRequest<T>(
	file: string,
	method: string,
	params: Record<string, unknown>,
	resultMapper: (result: unknown) => T[],
): Promise<T[]> {
	const clients = await lspManager.getClientsForFile(file);
	const uri = pathToUri(file);

	const results = await Promise.all(
		clients.map((client) =>
			client.connection
				.sendRequest(method, {
					textDocument: { uri },
					...params,
				})
				.then(resultMapper)
				.catch(() => []),
		),
	);

	return results.flat().filter(Boolean) as T[];
}

/**
 * Search for workspace symbols
 */
export async function workspaceSymbol(query: string): Promise<LspSymbol[]> {
	const clients = lspManager.getAllClients();

	const results = await Promise.all(
		clients.map((client) =>
			client.connection
				.sendRequest("workspace/symbol", { query })
				.then((symbols: unknown) => {
					if (!Array.isArray(symbols)) return [];
					return symbols.filter(
						(symbol): symbol is LspSymbol =>
							typeof symbol === "object" &&
							symbol !== null &&
							"kind" in symbol &&
							IMPORTANT_KINDS.includes((symbol as LspSymbol).kind),
					);
				})
				.catch(() => []),
		),
	);

	return results.flat().slice(0, 50);
}

/**
 * Get document symbols for a file
 */
export async function documentSymbol(
	file: string,
): Promise<(LspSymbol | LspDocumentSymbol)[]> {
	const clients = await lspManager.getClientsForFile(file);
	const uri = pathToUri(file);

	const results = await Promise.all(
		clients.map((client) =>
			client.connection
				.sendRequest("textDocument/documentSymbol", {
					textDocument: { uri },
				})
				.then((symbols: unknown) => (Array.isArray(symbols) ? symbols : []))
				.catch(() => []),
		),
	);

	return results.flat().filter(Boolean);
}

/**
 * Get definition location(s) for a symbol at a position
 */
export async function definition(
	file: string,
	line: number,
	character: number,
): Promise<LspLocation[]> {
	return executeLspRequest(
		file,
		"textDocument/definition",
		{ position: { line, character } },
		normalizeLocationResult,
	);
}

/**
 * Get references for a symbol at a position
 */
export async function references(
	file: string,
	line: number,
	character: number,
	includeDeclaration = true,
): Promise<LspLocation[]> {
	return executeLspRequest(
		file,
		"textDocument/references",
		{ position: { line, character }, context: { includeDeclaration } },
		(result) => (Array.isArray(result) ? result : []),
	);
}

/**
 * Get type definition location(s) for a symbol at a position
 */
export async function typeDefinition(
	file: string,
	line: number,
	character: number,
): Promise<LspLocation[]> {
	return executeLspRequest(
		file,
		"textDocument/typeDefinition",
		{ position: { line, character } },
		normalizeLocationResult,
	);
}

/**
 * Get implementation location(s) for a symbol at a position
 */
export async function implementation(
	file: string,
	line: number,
	character: number,
): Promise<LspLocation[]> {
	return executeLspRequest(
		file,
		"textDocument/implementation",
		{ position: { line, character } },
		normalizeLocationResult,
	);
}

/**
 * Format a file
 */
export async function formatting(
	file: string,
	options?: LspFormattingOptions,
): Promise<LspTextEdit[]> {
	return executeLspRequest(
		file,
		"textDocument/formatting",
		{
			options: options ?? {
				tabSize: 2, // Default
				insertSpaces: true,
			},
		},
		(result) => (Array.isArray(result) ? result : []),
	);
}

/**
 * Get completion items at a position
 */
export async function completion(
	file: string,
	line: number,
	character: number,
): Promise<LspCompletionItem[]> {
	return executeLspRequest(
		file,
		"textDocument/completion",
		{ position: { line, character } },
		(result) => {
			if (!result) return [];
			if (Array.isArray(result)) return result;
			if (typeof result === "object" && result !== null && "items" in result) {
				return (result as LspCompletionList).items;
			}
			return [];
		},
	);
}

/**
 * Get all active clients (for testing/debugging)
 */
export async function getClients(): Promise<
	Array<{
		id: string;
		root: string;
		initialized: boolean;
		process: ChildProcessWithoutNullStreams;
		connection: MessageConnection;
		diagnostics: Map<string, LspDiagnostic[]>;
		openFiles: Map<string, number>;
	}>
> {
	return lspManager.getAllClients().map((client) => {
		const diagnostics = client.getAllDiagnostics();
		return {
			id: client.id,
			root: client.root,
			initialized: client.initialized,
			process: client.process,
			connection: client.connection,
			diagnostics,
			openFiles: new Map(client.openFiles),
		};
	});
}
