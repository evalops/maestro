/**
 * @fileoverview PostgreSQL Database Client
 *
 * This module provides the database connection layer for Composer's enterprise
 * features. It uses PostgreSQL via the `postgres.js` driver with Drizzle ORM
 * for type-safe queries.
 *
 * ## Features
 *
 * - **Connection Pooling**: Configurable pool size via `MAESTRO_DB_MAX_CONNECTIONS`
 * - **Graceful Shutdown**: Signal handlers ensure clean connection closure
 * - **Lazy Initialization**: Database connects on first use
 * - **Health Checks**: `testConnection()` for readiness probes
 *
 * ## Configuration
 *
 * | Environment Variable | Description | Default |
 * |---------------------|-------------|---------|
 * | `MAESTRO_DATABASE_URL` | PostgreSQL connection string | (required) |
 * | `DATABASE_URL` | Fallback connection string | - |
 * | `MAESTRO_DB_MAX_CONNECTIONS` | Connection pool size | 10 |
 * | `MAESTRO_DB_IDLE_TIMEOUT` | Idle connection timeout (seconds) | 20 |
 * | `MAESTRO_DB_CONNECT_TIMEOUT` | Connection timeout (seconds) | 10 |
 *
 * ## Usage
 *
 * ```typescript
 * import { getDb, isDbAvailable, testConnection } from "./db/client.js";
 *
 * // Check if database is configured
 * if (isDatabaseConfigured()) {
 *   // Get the database client (connects lazily)
 *   const db = getDb();
 *
 *   // Execute type-safe queries
 *   const sessions = await db.select().from(schema.sessions);
 * }
 * ```
 *
 * ## Enterprise Use Cases
 *
 * The database stores:
 * - Shared session tokens and access tracking
 * - Webhook configurations
 * - Enterprise audit logs
 * - API token management
 *
 * For single-user deployments without enterprise features, the database
 * is optional and Composer falls back to file-based storage.
 *
 * @module db/client
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createLogger } from "../utils/logger.js";
import * as schema from "./schema.js";

const logger = createLogger("db");

export type DbClient = ReturnType<typeof drizzle<typeof schema>>;

let dbInstance: DbClient | null = null;
let pgClient: ReturnType<typeof postgres> | null = null;

export interface DatabaseConfig {
	url: string;
	maxConnections?: number;
	idleTimeout?: number;
	connectTimeout?: number;
}

function getDatabaseConfig(): DatabaseConfig {
	const url = process.env.MAESTRO_DATABASE_URL || process.env.DATABASE_URL;

	if (!url) {
		throw new Error(
			"MAESTRO_DATABASE_URL or DATABASE_URL environment variable must be set for enterprise features",
		);
	}

	return {
		url,
		maxConnections: Number.parseInt(
			process.env.MAESTRO_DB_MAX_CONNECTIONS || "10",
			10,
		),
		idleTimeout: Number.parseInt(
			process.env.MAESTRO_DB_IDLE_TIMEOUT || "20",
			10,
		),
		connectTimeout: Number.parseInt(
			process.env.MAESTRO_DB_CONNECT_TIMEOUT || "10",
			10,
		),
	};
}

export function getDb(): DbClient {
	if (dbInstance) {
		return dbInstance;
	}

	const config = getDatabaseConfig();

	logger.info("Connecting to PostgreSQL database");

	pgClient = postgres(config.url, {
		max: config.maxConnections,
		idle_timeout: config.idleTimeout,
		connect_timeout: config.connectTimeout,
	});

	dbInstance = drizzle(pgClient, { schema });

	return dbInstance;
}

export async function closeDb(): Promise<void> {
	if (pgClient) {
		logger.info("Closing database connection");
		await pgClient.end();
		pgClient = null;
		dbInstance = null;
	}
}

/**
 * Check if database is configured and available
 */
export function isDatabaseConfigured(): boolean {
	return !!(process.env.MAESTRO_DATABASE_URL || process.env.DATABASE_URL);
}

/**
 * Check if database connection is currently available.
 * Returns true if configured and connected, false otherwise.
 */
export function isDbAvailable(): boolean {
	return isDatabaseConfigured() && dbInstance !== null;
}

/**
 * Test database connection
 */
export async function testConnection(): Promise<boolean> {
	try {
		const db = getDb();
		// Simple query to test connection
		await db.execute("SELECT 1");
		return true;
	} catch (error) {
		logger.error(
			"Database connection test failed",
			error instanceof Error ? error : undefined,
		);
		return false;
	}
}

// Graceful shutdown
let shuttingDown = false;
async function handleShutdown(signal: NodeJS.Signals): Promise<void> {
	if (shuttingDown) {
		return;
	}
	shuttingDown = true;
	logger.info(`Received ${signal}, shutting down database connections`);
	try {
		await closeDb();
	} catch (error) {
		logger.error(
			"Error while closing database connection",
			error instanceof Error ? error : undefined,
		);
	} finally {
		// Don't exit in test mode - let vitest handle process lifecycle
		if (process.env.VITEST !== "true" && process.env.NODE_ENV !== "test") {
			process.exit(0);
		}
	}
}

// Only register signal handlers outside of test mode
// In test mode, vitest manages the process lifecycle
if (process.env.VITEST !== "true" && process.env.NODE_ENV !== "test") {
	process.once("SIGINT", () => {
		handleShutdown("SIGINT").catch((error) => {
			logger.error(
				"Error during SIGINT shutdown",
				error instanceof Error ? error : undefined,
			);
			process.exit(1);
		});
	});

	process.once("SIGTERM", () => {
		handleShutdown("SIGTERM").catch((error) => {
			logger.error(
				"Error during SIGTERM shutdown",
				error instanceof Error ? error : undefined,
			);
			process.exit(1);
		});
	});
}
