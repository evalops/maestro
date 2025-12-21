/**
 * Storage Abstraction - Pluggable backends for enterprise deployments
 *
 * Supports:
 * - File-based storage (simple self-hosting)
 * - Redis storage (enterprise, multi-instance)
 *
 * For sensitive data environments (e.g., financial services):
 * - Use Redis with TLS and encryption at rest
 * - Configure short TTLs
 * - Enable audit logging
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as logger from "./logger.js";
import { ensureDirSync } from "./utils/fs.js";

// ============================================================================
// Storage Interface
// ============================================================================

export interface StorageBackend {
	get<T>(key: string): Promise<T | null>;
	set<T>(key: string, value: T, ttlMs?: number): Promise<void>;
	/**
	 * Set if not exists (atomic) - returns true if key was set, false if it already existed
	 * Use this for distributed locking to prevent race conditions
	 */
	setNX<T>(key: string, value: T, ttlMs?: number): Promise<boolean>;
	delete(key: string): Promise<boolean>;
	exists(key: string): Promise<boolean>;
	keys(pattern: string): Promise<string[]>;
	/** Flush all data (for shutdown) */
	flush(): Promise<void>;
}

// ============================================================================
// File Storage Backend
// ============================================================================

export class FileStorageBackend implements StorageBackend {
	constructor(private baseDir: string) {
		ensureDirSync(baseDir);
	}

	private readMetadata(
		path: string,
	): { key?: string; expiresAt?: number } | null {
		try {
			const content = readFileSync(path, "utf-8");
			return JSON.parse(content) as { key?: string; expiresAt?: number };
		} catch {
			return null;
		}
	}

	private isExpired(expiresAt: unknown): boolean {
		return (
			typeof expiresAt === "number" &&
			Number.isFinite(expiresAt) &&
			Date.now() > expiresAt
		);
	}

	private getPath(key: string): string {
		// Safe filename - replace special chars
		const safeKey = key.replace(/[^a-zA-Z0-9-_]/g, "_");
		return join(this.baseDir, `${safeKey}.json`);
	}

	async get<T>(key: string): Promise<T | null> {
		const path = this.getPath(key);
		if (!existsSync(path)) return null;

		try {
			const content = readFileSync(path, "utf-8");
			const data = JSON.parse(content) as {
				key?: string; // Original key stored for reconstruction
				value: T;
				expiresAt?: number;
			};

			// Check TTL
			if (data.expiresAt && Date.now() > data.expiresAt) {
				await this.delete(key);
				return null;
			}

			return data.value;
		} catch (error) {
			// Log errors for debugging (JSON parse, permission issues, etc.)
			logger.logWarning(`Storage read error for key "${key}"`, String(error));
			return null;
		}
	}

	async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
		const path = this.getPath(key);
		const data = {
			key, // Store original key for unambiguous reconstruction
			value,
			expiresAt: ttlMs ? Date.now() + ttlMs : undefined,
		};
		writeFileSync(path, JSON.stringify(data, null, 2));
	}

	async setNX<T>(key: string, value: T, ttlMs?: number): Promise<boolean> {
		const path = this.getPath(key);
		const data = {
			key,
			value,
			expiresAt: ttlMs ? Date.now() + ttlMs : undefined,
		};
		try {
			// 'wx' flag: exclusive write - fails if file exists (atomic)
			writeFileSync(path, JSON.stringify(data, null, 2), { flag: "wx" });
			return true;
		} catch (error) {
			// EEXIST means file already exists - not an error for setNX
			if ((error as NodeJS.ErrnoException).code === "EEXIST") {
				const metadata = this.readMetadata(path);
				if (metadata && this.isExpired(metadata.expiresAt)) {
					try {
						unlinkSync(path);
					} catch {
						return false;
					}
					try {
						writeFileSync(path, JSON.stringify(data, null, 2), { flag: "wx" });
						return true;
					} catch {
						return false;
					}
				}
				return false;
			}
			throw error;
		}
	}

	async delete(key: string): Promise<boolean> {
		const path = this.getPath(key);
		if (existsSync(path)) {
			unlinkSync(path);
			return true;
		}
		return false;
	}

	async exists(key: string): Promise<boolean> {
		const path = this.getPath(key);
		if (!existsSync(path)) return false;
		const metadata = this.readMetadata(path);
		if (metadata && this.isExpired(metadata.expiresAt)) {
			try {
				unlinkSync(path);
			} catch {
				// Ignore cleanup failures; treat as still existing.
				return true;
			}
			return false;
		}
		return true;
	}

	async keys(pattern: string): Promise<string[]> {
		// Read stored keys from files for accurate reconstruction
		const { readdirSync } = await import("node:fs");
		const files = readdirSync(this.baseDir).filter((f) => f.endsWith(".json"));

		// Convert glob pattern to regex for matching original keys
		const regexPattern = pattern
			.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") // Escape regex special chars
			.replace(/\\\*/g, ".*") // Convert * to .*
			.replace(/\\\?/g, "."); // Convert ? to .
		const regex = new RegExp(`^${regexPattern}$`);

		const keys: string[] = [];
		for (const file of files) {
			const path = join(this.baseDir, file);
			try {
				const content = readFileSync(path, "utf-8");
				const data = JSON.parse(content) as {
					key?: string;
					expiresAt?: number;
				};
				if (this.isExpired(data.expiresAt)) {
					try {
						unlinkSync(path);
					} catch {
						// Best-effort cleanup; skip expired key either way.
					}
					continue;
				}
				// Use stored key if available, otherwise fallback to filename conversion
				const key = data.key ?? file.replace(/\.json$/, "").replace(/_/g, ":");
				if (regex.test(key)) {
					keys.push(key);
				}
			} catch {
				// Skip invalid files
			}
		}
		return keys;
	}

	async flush(): Promise<void> {
		// File storage is already persisted, nothing to flush
	}
}

// ============================================================================
// Redis Storage Backend
// ============================================================================

export interface RedisConfig {
	url?: string;
	host?: string;
	port?: number;
	password?: string;
	tls?: boolean;
	keyPrefix?: string;
	/** Default TTL for all keys (ms) */
	defaultTtlMs?: number;
}

/**
 * Redis storage backend for enterprise deployments
 *
 * Requires ioredis package:
 * ```
 * bun add ioredis
 * ```
 *
 * Usage:
 * ```typescript
 * const redis = await createRedisBackend({
 *   url: process.env.REDIS_URL,
 *   keyPrefix: 'slack-agent:',
 *   defaultTtlMs: 3600000, // 1 hour
 * });
 * ```
 */
export async function createRedisBackend(
	config: RedisConfig,
): Promise<StorageBackend> {
	// Dynamic import to avoid requiring ioredis for file-based deployments
	// Use type assertion since ioredis default export varies across versions
	type RedisConstructor = new (options: {
		host?: string;
		port?: number;
		password?: string;
		tls?: Record<string, unknown>;
		keyPrefix?: string;
		lazyConnect?: boolean;
	}) => {
		connect(): Promise<void>;
		get(key: string): Promise<string | null>;
		set(
			key: string,
			value: string,
			mode?: string,
			duration?: number,
			nx?: string,
		): Promise<string | null>;
		del(key: string): Promise<number>;
		exists(key: string): Promise<number>;
		keys(pattern: string): Promise<string[]>;
		quit(): Promise<string>;
	};

	let Redis: RedisConstructor;
	try {
		const ioredis = await import("ioredis");
		Redis = ioredis.default as unknown as RedisConstructor;
	} catch {
		throw new Error(
			"Redis storage requires ioredis package. Install with: bun add ioredis",
		);
	}

	// Support both URL string and individual options
	// ioredis accepts URL as first param: new Redis("redis://...")
	type RedisInstance = InstanceType<RedisConstructor>;
	let client: RedisInstance;

	if (config.url) {
		// Use URL-based connection (supports redis://, rediss://)
		const ioredis = await import("ioredis");
		const RedisWithUrl = ioredis.default as unknown as new (
			url: string,
			options?: { keyPrefix?: string; lazyConnect?: boolean },
		) => RedisInstance;
		client = new RedisWithUrl(config.url, {
			keyPrefix: config.keyPrefix ?? "slack-agent:",
			lazyConnect: true,
		});
	} else {
		client = new Redis({
			host: config.host ?? "localhost",
			port: config.port ?? 6379,
			password: config.password,
			tls: config.tls ? {} : undefined,
			keyPrefix: config.keyPrefix ?? "slack-agent:",
			lazyConnect: true,
		});
	}

	// Connect
	await client.connect();
	const connectedTo = config.url
		? config.url.replace(/\/\/[^:]+:[^@]+@/, "//***:***@")
		: `${config.host ?? "localhost"}:${config.port ?? 6379}`;
	logger.logInfo(`Redis connected: ${connectedTo}`);

	const backend: StorageBackend = {
		async get<T>(key: string): Promise<T | null> {
			const data = await client.get(key);
			if (!data) return null;
			try {
				return JSON.parse(data) as T;
			} catch {
				return null;
			}
		},

		async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
			const json = JSON.stringify(value);
			const ttl = ttlMs ?? config.defaultTtlMs;
			if (ttl) {
				await client.set(key, json, "PX", ttl);
			} else {
				await client.set(key, json);
			}
		},

		async setNX<T>(key: string, value: T, ttlMs?: number): Promise<boolean> {
			const json = JSON.stringify(value);
			const ttl = ttlMs ?? config.defaultTtlMs;
			// Use SET with NX (only set if not exists) - atomic operation
			const result = ttl
				? await client.set(key, json, "PX", ttl, "NX")
				: await client.set(key, json, "NX");
			return result === "OK";
		},

		async delete(key: string): Promise<boolean> {
			const result = await client.del(key);
			return result > 0;
		},

		async exists(key: string): Promise<boolean> {
			const result = await client.exists(key);
			return result > 0;
		},

		async keys(pattern: string): Promise<string[]> {
			return client.keys(pattern);
		},

		async flush(): Promise<void> {
			await client.quit();
			logger.logInfo("Redis disconnected");
		},
	};

	return backend;
}

// ============================================================================
// Factory Function
// ============================================================================

export type StorageType = "file" | "redis";

export interface StorageConfig {
	type: StorageType;
	/** Base directory for file storage */
	baseDir?: string;
	/** Redis configuration */
	redis?: RedisConfig;
}

/**
 * Create a storage backend based on configuration
 */
export async function createStorageBackend(
	config: StorageConfig,
): Promise<StorageBackend> {
	switch (config.type) {
		case "redis":
			if (!config.redis) {
				throw new Error("Redis config required for redis storage type");
			}
			return createRedisBackend(config.redis);

		default:
			if (!config.baseDir) {
				throw new Error("baseDir required for file storage type");
			}
			return new FileStorageBackend(config.baseDir);
	}
}
