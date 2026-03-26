import { EventEmitter } from "node:events";
import { extname, resolve } from "node:path";
import { sleep } from "../utils/async.js";
import { createLogger } from "../utils/logger.js";
import type { LspClient } from "./client.js";
import { spawnLspClient } from "./spawn.js";
import type { LspServerConfig, RootResolver } from "./types.js";

const logger = createLogger("lsp:manager");

const DEFAULT_ROOT_RESOLVER_TIMEOUT_MS = 2000;

interface LspManagerOptions {
	rootResolverTimeoutMs?: number;
}

export class RootResolverTimeoutError extends Error {
	constructor(
		public readonly label: string,
		public readonly timeoutMs: number,
	) {
		super(`root resolver ${label} timed out after ${timeoutMs}ms`);
	}
}

interface BrokenServerEntry {
	time: number;
	attempts: number;
}

export class LspClientManager extends EventEmitter {
	private clients = new Map<string, LspClient>();
	private spawning = new Map<string, Promise<LspClient | undefined>>();
	private brokenServers = new Map<string, BrokenServerEntry>();
	private servers: LspServerConfig[] = [];
	private defaultRootResolver?: RootResolver;
	private readonly rootResolverTimeoutMs: number;

	constructor(options?: LspManagerOptions) {
		super();
		this.rootResolverTimeoutMs =
			this.normalizeTimeout(options?.rootResolverTimeoutMs) ??
			this.normalizeTimeout(process.env.MAESTRO_LSP_ROOT_TIMEOUT_MS) ??
			DEFAULT_ROOT_RESOLVER_TIMEOUT_MS;
	}

	async configureServers(configs: LspServerConfig[]): Promise<void> {
		this.servers = configs;
		await this.shutdownAll();
	}

	configureRootResolver(resolver: RootResolver): void {
		this.defaultRootResolver = resolver;
	}

	async getClientsForFile(file: string): Promise<LspClient[]> {
		const absolute = resolve(file);
		const ext = extname(absolute);
		const matchingServers = this.servers.filter((srv) =>
			srv.extensions.includes(ext),
		);

		const clients: LspClient[] = [];

		for (const server of matchingServers) {
			const resolvedRoot = await this.resolveRootSafe(
				server.rootResolver,
				absolute,
				`server:${server.id}`,
			);
			const defaultRoot = await this.resolveRootSafe(
				this.defaultRootResolver,
				absolute,
				"default",
			);
			const root = resolvedRoot ?? defaultRoot ?? process.cwd();

			const key = this.getKey(server.id, root);

			// Check if should retry broken server
			if (!this.shouldRetryBroken(key)) {
				continue;
			}

			// Check existing client
			const existing = this.clients.get(key);
			if (existing && !existing.isDead) {
				clients.push(existing);
				continue;
			}

			// Remove dead client
			if (existing?.isDead) {
				this.clients.delete(key);
			}

			// Check if spawn in progress
			const inflight = this.spawning.get(key);
			if (inflight) {
				const client = await inflight;
				if (client) clients.push(client);
				continue;
			}

			// Spawn new client
			const task = this.spawnAndTrack(server, root, key);
			this.spawning.set(key, task);
			const client = await task;
			if (client) clients.push(client);
		}

		return clients;
	}

	getAllClients(): LspClient[] {
		return Array.from(this.clients.values()).filter((c) => !c.isDead);
	}

	async shutdownAll(): Promise<void> {
		const clientsToShutdown = Array.from(this.clients.values());
		this.clients.clear();
		this.spawning.clear();
		this.brokenServers.clear();

		await Promise.allSettled(clientsToShutdown.map((c) => c.shutdown()));
	}

	private async spawnAndTrack(
		server: LspServerConfig,
		root: string,
		key: string,
	): Promise<LspClient | undefined> {
		try {
			const client = await spawnLspClient(server, root);

			if (!client) {
				this.markBroken(key);
				return undefined;
			}

			// Setup event handlers with cleanup
			const handlers = {
				close: () => {
					this.clients.delete(key);
					this.markBroken(key);
					client.off("close", handlers.close);
					client.off("error", handlers.error);
					client.off("diagnostics", handlers.diagnostics);
				},
				error: () => {
					this.clients.delete(key);
					this.markBroken(key);
					client.off("close", handlers.close);
					client.off("error", handlers.error);
					client.off("diagnostics", handlers.diagnostics);
				},
				diagnostics: (uri: string) => {
					this.emit("diagnostics", uri);
				},
			};

			client.on("close", handlers.close);
			client.on("error", handlers.error);
			client.on("diagnostics", handlers.diagnostics);

			// Store client
			this.clients.set(key, client);
			this.emit("updated", { id: server.id, root });

			// Clear broken status on success
			this.brokenServers.delete(key);

			return client;
		} catch (error) {
			logger.error(
				"Failed to spawn",
				error instanceof Error ? error : new Error(String(error)),
				{ id: server.id },
			);
			this.markBroken(key);
			return undefined;
		} finally {
			this.spawning.delete(key);
		}
	}

	private markBroken(key: string): void {
		const existing = this.brokenServers.get(key);
		this.brokenServers.set(key, {
			time: Date.now(),
			attempts: (existing?.attempts ?? 0) + 1,
		});
	}

	private shouldRetryBroken(key: string): boolean {
		const entry = this.brokenServers.get(key);
		if (!entry) return true;

		// Exponential backoff: 1s, 2s, 4s, 8s, 16s, max 30s
		const backoff = Math.min(1000 * 2 ** (entry.attempts - 1), 30000);
		return Date.now() - entry.time > backoff;
	}

	private getKey(serverId: string, root: string): string {
		return `${serverId}:${root}`;
	}

	private normalizeTimeout(value?: number | string): number | undefined {
		if (value === undefined) {
			return undefined;
		}
		const numeric =
			typeof value === "number" ? value : Number.parseInt(String(value), 10);
		return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined;
	}

	public async resolveRootSafe(
		resolver: RootResolver | undefined,
		file: string,
		label: string,
	): Promise<string | undefined> {
		if (!resolver) {
			return undefined;
		}

		const timeoutPromise = (async () => {
			await sleep(this.rootResolverTimeoutMs);
			throw new RootResolverTimeoutError(label, this.rootResolverTimeoutMs);
		})();

		const resolverPromise = Promise.resolve().then(() => resolver(file));

		try {
			const result = await Promise.race([resolverPromise, timeoutPromise]);
			return result ?? undefined;
		} catch (error) {
			if (error instanceof RootResolverTimeoutError) {
				logger.warn("Root resolver timed out", {
					label,
					timeoutMs: error.timeoutMs,
				});
			} else {
				logger.warn("Root resolver failed", {
					label,
					error: error instanceof Error ? error.message : String(error),
				});
			}
			return undefined;
		}
	}
}

// Singleton instance
export const lspManager = new LspClientManager();
