import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { extname, resolve } from "node:path";
import {
	type MessageConnection,
	createMessageConnection,
} from "vscode-jsonrpc/node";
import { languageIdFromFile } from "./language.js";

export interface LspRange {
	start: { line: number; character: number };
	end: { line: number; character: number };
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
	location: {
		uri: string;
		range: LspRange;
	};
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
	rootResolver?: (file: string) => Promise<string | undefined>;
	initializationOptions?: Record<string, unknown>;
}

let servers: LspServerConfig[] = [];
let defaultRootResolver: RootResolver | undefined;
const clients: LspClientHandle[] = [];
const spawning = new Map<string, Promise<LspClientHandle | undefined>>();
const brokenServers = new Set<string>();

export const lspEvents = new EventEmitter();

export function configureServers(config: LspServerConfig[]): void {
	servers = config;
}

export async function touchFile(file: string): Promise<void> {
	const handles = await ensureClientsForFile(file);
	await Promise.all(
		handles.map(async (handle) => {
			const uri = pathToUri(file);
			await handle.connection.sendNotification("textDocument/didOpen", {
				textDocument: {
					uri,
					languageId: languageIdFromFile(file),
					version: Date.now(),
					text: await readFileText(file).catch(() => ""),
				},
			});
		}),
	);
}

export async function collectDiagnostics(): Promise<
	Record<string, LspDiagnostic[]>
> {
	const result: Record<string, LspDiagnostic[]> = {};
	for (const client of clients) {
		for (const [uri, entries] of client.diagnostics.entries()) {
			const file = uriToPath(uri);
			result[file] ??= [];
			result[file].push(...entries);
		}
	}
	return result;
}

export async function hover(file: string, line: number, character: number) {
	const uri = pathToUri(file);
	const handles = await ensureClientsForFile(file);
	return Promise.all(
		handles.map((handle) =>
			handle.connection.sendRequest("textDocument/hover", {
				textDocument: { uri },
				position: { line, character },
			}),
		),
	);
}

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

export async function workspaceSymbol(query: string): Promise<LspSymbol[]> {
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

export async function documentSymbol(
	file: string,
): Promise<(LspSymbol | LspDocumentSymbol)[]> {
	const uri = pathToUri(file);
	const handles = await ensureClientsForFile(file);
	const results = await Promise.all(
		handles.map((handle) =>
			handle.connection
				.sendRequest("textDocument/documentSymbol", {
					textDocument: { uri },
				})
				.then((symbols: any) => (Array.isArray(symbols) ? symbols : []))
				.catch(() => []),
		),
	);
	return results.flat().filter(Boolean);
}

export async function changeFile(file: string, content: string): Promise<void> {
	const handles = await ensureClientsForFile(file);
	const uri = pathToUri(file);

	await Promise.all(
		handles.map(async (handle) => {
			const currentVersion = handle.openFiles.get(file);
			if (currentVersion === undefined) {
				// File not open yet, open it first
				handle.openFiles.set(file, 1);
				await handle.connection.sendNotification("textDocument/didOpen", {
					textDocument: {
						uri,
						languageId: languageIdFromFile(file),
						version: 1,
						text: content,
					},
				});
			} else {
				// File already open, send change
				const newVersion = currentVersion + 1;
				handle.openFiles.set(file, newVersion);
				await handle.connection.sendNotification("textDocument/didChange", {
					textDocument: {
						uri,
						version: newVersion,
					},
					contentChanges: [{ text: content }],
				});
			}
		}),
	);
}

export async function closeFile(file: string): Promise<void> {
	const uri = pathToUri(file);
	await Promise.all(
		clients
			.filter((client) => client.openFiles.has(file))
			.map(async (client) => {
				client.openFiles.delete(file);
				await client.connection.sendNotification("textDocument/didClose", {
					textDocument: { uri },
				});
			}),
	);
}

export async function getClients(): Promise<LspClientHandle[]> {
	return [...clients];
}

async function ensureClientsForFile(file: string) {
	const absolute = resolve(file);
	const ext = extname(absolute);
	const matches = servers.filter((srv) => srv.extensions.includes(ext));
	const handles: LspClientHandle[] = [];
	for (const server of matches) {
		const root =
			(await server.rootResolver?.(absolute)) ??
			defaultRootResolver?.(absolute) ??
			process.cwd();
		const key = `${server.id}:${root}`;
		if (brokenServers.has(key)) continue;
		const existing = clients.find((c) => c.id === server.id && c.root === root);
		if (existing) {
			handles.push(existing);
			continue;
		}
		const inflight = spawning.get(key);
		if (inflight) {
			const handle = await inflight;
			if (handle) handles.push(handle);
			continue;
		}
		const task = spawnClient(server, root, key);
		spawning.set(key, task);
		const handle = await task;
		if (handle) handles.push(handle);
	}
	return handles;
}

async function spawnClient(server: LspServerConfig, root: string, key: string) {
	try {
		const proc = spawn(server.command, server.args ?? [], {
			cwd: root,
			env: { ...process.env, ...server.env },
		});

		// Handle spawn errors
		proc.on("error", (err) => {
			brokenServers.add(key);
			console.error(`[lsp] Failed to spawn ${server.id}:`, err);
		});

		const connection = createMessageConnection(proc.stdin, proc.stdout);
		const handle: LspClientHandle = {
			id: server.id,
			root,
			process: proc,
			connection,
			diagnostics: new Map(),
			initialized: false,
			openFiles: new Map(),
		};
		connection.onNotification(
			"textDocument/publishDiagnostics",
			(params: any) => {
				const uri = params.textDocument?.uri;
				if (!uri) return;
				handle.diagnostics.set(uri, params.diagnostics ?? []);
				lspEvents.emit("diagnostics", uri);
			},
		);
		connection.onClose(() => {
			brokenServers.add(key);
			connection.dispose();
		});
		connection.onError(() => {
			// Suppress connection errors to avoid unhandled rejections
		});
		connection.listen();
		await connection.sendRequest("initialize", {
			processId: process.pid,
			rootUri: pathToUri(root),
			capabilities: {
				workspace: {
					workspaceFolders: true,
					symbol: {
						symbolKind: {
							valueSet: [
								1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
								19, 20, 21, 22, 23, 24, 25, 26,
							],
						},
					},
					configuration: true,
				},
				textDocument: {
					synchronization: {
						didOpen: true,
						didChange: true,
						didSave: true,
						didClose: true,
					},
					hover: {
						contentFormat: ["plaintext", "markdown"],
					},
					documentSymbol: {
						hierarchicalDocumentSymbolSupport: true,
					},
				},
			},
			initializationOptions: server.initializationOptions ?? {},
		});
		await connection.sendNotification("initialized", {});
		handle.initialized = true;
		clients.push(handle);
		lspEvents.emit("updated", { id: server.id, root });
		return handle;
	} catch (error) {
		brokenServers.add(key);
		console.error(`[lsp] Failed to start ${server.id}:`, error);
		return undefined;
	} finally {
		spawning.delete(key);
	}
}

async function readFileText(file: string): Promise<string> {
	const { readFile } = await import("node:fs/promises");
	return readFile(file, "utf-8");
}

function pathToUri(file: string) {
	const absolute = resolve(file);
	return `file://${absolute}`;
}

function uriToPath(uri: string) {
	return uri.replace(/^file:\/\//, "");
}

export type RootResolver = (file: string) => Promise<string | undefined>;

export function configureRootResolver(resolver: RootResolver) {
	defaultRootResolver = resolver;
}
