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

import { lspManager } from "./manager.js";
import { SymbolKind } from "./types.js";
import type {
	LspDiagnostic,
	LspDocumentSymbol,
	LspServerConfig,
	LspSymbol,
	RootResolver,
} from "./types.js";
import { pathToUri, uriToPath } from "./utils.js";

// Re-export types
export type {
	LspClientHandle,
	LspDiagnostic,
	LspDocumentSymbol,
	LspRange,
	LspServerConfig,
	LspSymbol,
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
 * Get hover information at a position
 */
export async function hover(
	file: string,
	line: number,
	character: number,
): Promise<any[]> {
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
 * Search for workspace symbols
 */
export async function workspaceSymbol(query: string): Promise<LspSymbol[]> {
	const clients = lspManager.getAllClients();

	const results = await Promise.all(
		clients.map((client) =>
			client.connection
				.sendRequest("workspace/symbol", { query })
				.then((symbols: any) =>
					Array.isArray(symbols)
						? symbols.filter((s: LspSymbol) => IMPORTANT_KINDS.includes(s.kind))
						: [],
				)
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
				.then((symbols: any) => (Array.isArray(symbols) ? symbols : []))
				.catch(() => []),
		),
	);

	return results.flat().filter(Boolean);
}

/**
 * Get all active clients (for testing/debugging)
 */
export async function getClients(): Promise<any[]> {
	return lspManager.getAllClients().map((client) => ({
		id: client.id,
		root: client.root,
		initialized: client.initialized,
		process: client.process,
		connection: client.connection,
		diagnostics: client.getAllDiagnostics(),
		openFiles: new Map(client.openFiles),
	}));
}
