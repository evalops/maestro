import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import type { MessageConnection } from "vscode-jsonrpc/node.js";
import { sleep } from "../utils/async.js";
import { createLogger } from "../utils/logger.js";
import { languageIdFromFile } from "./language.js";
import type { LspDiagnostic, LspServerConfig } from "./types.js";
import { isConnectionDead, pathToUri } from "./utils.js";

const logger = createLogger("lsp:client");

export class LspClient extends EventEmitter {
	public readonly id: string;
	public readonly root: string;
	public readonly process: ChildProcessWithoutNullStreams;
	public readonly connection: MessageConnection;
	public readonly openFiles = new Map<string, number>();

	private readonly diagnostics = new Map<string, LspDiagnostic[]>();
	private _initialized = false;
	private _dead = false;
	private processClosed = false;
	private connectionDisposed = false;

	constructor(
		config: LspServerConfig,
		root: string,
		process: ChildProcessWithoutNullStreams,
		connection: MessageConnection,
	) {
		super();
		this.id = config.id;
		this.root = root;
		this.process = process;
		this.connection = connection;

		this.process.once("exit", () => {
			this.processClosed = true;
			this.disposeConnection();
			if (!this._dead) {
				this._dead = true;
				this.emit("close");
			}
		});

		this.setupEventHandlers();
	}

	private setupEventHandlers(): void {
		this.connection.onNotification(
			"textDocument/publishDiagnostics",
			(params: any) => {
				const uri = params.uri;
				if (!uri) return;
				this.diagnostics.set(uri, params.diagnostics ?? []);
				this.emit("diagnostics", uri);
			},
		);

		this.connection.onClose(() => {
			this.disposeConnection();
			if (this.processClosed || this._dead) {
				return;
			}
			this._dead = true;
			this.emit("close");
		});

		this.connection.onError((error) => {
			logger.error(
				"Connection error",
				error instanceof Error ? error : new Error(String(error)),
				{ id: this.id },
			);
			this.disposeConnection();
			this._dead = true;
			this.emit("error", error);
		});
	}

	get initialized(): boolean {
		return this._initialized;
	}

	get isDead(): boolean {
		return this._dead || this.processClosed;
	}

	private disposeConnection(): void {
		if (this.connectionDisposed) {
			return;
		}
		this.connectionDisposed = true;
		this.connection.dispose();
	}

	async initialize(initOptions?: Record<string, unknown>): Promise<void> {
		await this.connection.sendRequest("initialize", {
			processId: process.pid,
			rootUri: pathToUri(this.root),
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
					completion: {
						completionItem: {
							snippetSupport: true,
						},
					},
					hover: {
						contentFormat: ["plaintext", "markdown"],
					},
					signatureHelp: {
						dynamicRegistration: true,
					},
					definition: {
						dynamicRegistration: true,
					},
					references: {
						dynamicRegistration: true,
					},
					documentHighlight: {
						dynamicRegistration: true,
					},
					documentSymbol: {
						hierarchicalDocumentSymbolSupport: true,
					},
					codeAction: {
						dynamicRegistration: true,
					},
					formatting: {
						dynamicRegistration: true,
					},
					rangeFormatting: {
						dynamicRegistration: true,
					},
					rename: {
						dynamicRegistration: true,
					},
					typeDefinition: {
						dynamicRegistration: true,
					},
					implementation: {
						dynamicRegistration: true,
					},
				},
			},
			initializationOptions: initOptions ?? {},
		});

		await this.connection.sendNotification("initialized", {});
		this._initialized = true;
	}

	async openFile(file: string): Promise<void> {
		if (this.openFiles.has(file)) return;

		const uri = pathToUri(file);
		const version = 0;

		await this.sendSafe(async () => {
			const text = await readFile(file, "utf-8").catch(() => "");
			await this.connection.sendNotification("textDocument/didOpen", {
				textDocument: {
					uri,
					languageId: languageIdFromFile(file),
					version,
					text,
				},
			});
			this.openFiles.set(file, version);
		});
	}

	async changeFile(file: string, content: string): Promise<void> {
		const uri = pathToUri(file);
		const currentVersion = this.openFiles.get(file);

		await this.sendSafe(async () => {
			if (currentVersion === undefined) {
				// File not open, open it first
				await this.connection.sendNotification("textDocument/didOpen", {
					textDocument: {
						uri,
						languageId: languageIdFromFile(file),
						version: 0,
						text: content,
					},
				});
				this.openFiles.set(file, 0);
			} else {
				// File open, send change
				const newVersion = currentVersion + 1;
				await this.connection.sendNotification("textDocument/didChange", {
					textDocument: { uri, version: newVersion },
					contentChanges: [{ text: content }],
				});
				this.openFiles.set(file, newVersion);
			}
		});
	}

	async closeFile(file: string): Promise<void> {
		if (!this.openFiles.has(file)) return;

		const uri = pathToUri(file);
		this.openFiles.delete(file);

		await this.sendSafe(async () => {
			await this.connection.sendNotification("textDocument/didClose", {
				textDocument: { uri },
			});
		});
	}

	hasFile(file: string): boolean {
		return this.openFiles.has(file);
	}

	getDiagnostics(uri: string): LspDiagnostic[] {
		return this.diagnostics.get(uri) ?? [];
	}

	getAllDiagnostics(): Map<string, LspDiagnostic[]> {
		return new Map(this.diagnostics);
	}

	async shutdown(): Promise<void> {
		if (this.isDead) return;

		this._dead = true;

		// Try graceful shutdown with timeout
		const shutdownPromise = (async () => {
			try {
				if (!this.connectionDisposed && !this.processClosed) {
					await this.connection.sendRequest("shutdown", null, 500);
					await this.connection.sendNotification("exit", {});
				}
			} catch {
				// Server didn't respond or connection already closed
			}
		})();

		await Promise.race([shutdownPromise, sleep(600)]);

		// Force kill if still alive
		try {
			if (!this.processClosed && this.process && !this.process.killed) {
				this.process.kill("SIGKILL");
			}
		} catch {
			// Already dead
		}

		// Dispose connection to prevent any further writes
		this.disposeConnection();
	}

	private async sendSafe(fn: () => Promise<void>): Promise<void> {
		if (this.isDead) return;

		try {
			await fn();
		} catch (error) {
			if (isConnectionDead(error)) {
				this._dead = true;
				this.emit("close");
				return;
			}
			throw error;
		}
	}
}
