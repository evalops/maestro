import { EventEmitter } from "node:events";
import { extname, resolve } from "node:path";
import type { LspClient } from "./client.js";
import { spawnLspClient } from "./spawn.js";
import type { LspServerConfig, RootResolver } from "./types.js";
import { sleep } from "./utils.js";

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
			const root =
				(await server.rootResolver?.(absolute)) ??
				this.defaultRootResolver?.(absolute) ??
				process.cwd();

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

			// Setup event handlers
			client.on("close", () => {
				this.clients.delete(key);
				this.markBroken(key);
			});

			client.on("error", () => {
				this.clients.delete(key);
				this.markBroken(key);
			});

			client.on("diagnostics", (uri: string) => {
				this.emit("diagnostics", uri);
			});

			// Store client
			this.clients.set(key, client);
			this.emit("updated", { id: server.id, root });

			// Clear broken status on success
			this.brokenServers.delete(key);

			return client;
		} catch (error) {
			console.error(`[lsp] Failed to spawn ${server.id}:`, error);
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
}

// Singleton instance
export const lspManager = new LspClientManager();
