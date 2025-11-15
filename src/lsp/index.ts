import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { extname, resolve } from "node:path";
import {
	type MessageConnection,
	createMessageConnection,
} from "vscode-jsonrpc/node";

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

export interface LspClientHandle {
	id: string;
	root: string;
	process: ChildProcessWithoutNullStreams;
	connection: MessageConnection;
	diagnostics: Map<string, LspDiagnostic[]>;
	initialized: boolean;
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

async function ensureClientsForFile(file: string) {
	const absolute = resolve(file);
	const ext = extname(absolute);
	const matches = servers.filter((srv) => srv.extensions.includes(ext));
	const handles: LspClientHandle[] = [];
	for (const server of matches) {
		const root = (await server.rootResolver?.(absolute)) ?? process.cwd();
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
		const connection = createMessageConnection(proc.stdin, proc.stdout);
		const handle: LspClientHandle = {
			id: server.id,
			root,
			process: proc,
			connection,
			diagnostics: new Map(),
			initialized: false,
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
		connection.listen();
		await connection.sendRequest("initialize", {
			processId: process.pid,
			rootUri: pathToUri(root),
			capabilities: {},
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

function languageIdFromFile(file: string) {
	switch (extname(file)) {
		case ".ts":
		case ".tsx":
			return "typescript";
		case ".js":
		case ".jsx":
			return "javascript";
		case ".py":
			return "python";
		default:
			return "plaintext";
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
