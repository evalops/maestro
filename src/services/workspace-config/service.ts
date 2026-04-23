import { eq, sql } from "drizzle-orm";
import { type DbClient, getDb, isDatabaseConfigured } from "../../db/client.js";
import { workspaceConfig } from "../../db/schema.js";
import { createLogger } from "../../utils/logger.js";
import {
	normalizeModelPreferences,
	normalizeRateLimits,
	normalizeSafetyRules,
	normalizeWorkspaceConfigId,
	normalizeWorkspaceConfigInput,
	normalizeWorkspaceConfigPatchInput,
} from "./normalize.js";
import type {
	WorkspaceConfig,
	WorkspaceConfigInput,
	WorkspaceConfigListQuery,
	WorkspaceConfigListResult,
	WorkspaceConfigPatchInput,
	WorkspaceConfigSummary,
} from "./types.js";

const logger = createLogger("workspace-config");

type WorkspaceConfigRow = typeof workspaceConfig.$inferSelect;

export class WorkspaceConfigUnavailableError extends Error {
	constructor() {
		super("Workspace config database is not configured.");
		this.name = "WorkspaceConfigUnavailableError";
	}
}

function toDateIso(value: Date | string): string {
	return value instanceof Date
		? value.toISOString()
		: new Date(value).toISOString();
}

function configFromRow(row: WorkspaceConfigRow): WorkspaceConfig {
	return {
		workspaceId: row.workspaceId,
		modelPreferences: normalizeModelPreferences(row.modelPreferences),
		safetyRules: normalizeSafetyRules(row.safetyRules),
		rateLimits: normalizeRateLimits(row.rateLimits),
		createdAt: toDateIso(row.createdAt),
		updatedAt: toDateIso(row.updatedAt),
	};
}

function summaryFromConfig(config: WorkspaceConfig): WorkspaceConfigSummary {
	return {
		workspaceId: config.workspaceId,
		modelPreferences: config.modelPreferences,
		safetyRules: config.safetyRules,
		rateLimits: config.rateLimits,
		createdAt: config.createdAt,
		updatedAt: config.updatedAt,
	};
}

export class WorkspaceConfigService {
	constructor(
		private readonly getDatabase: () => DbClient = getDb,
		private readonly databaseConfigured: () => boolean = isDatabaseConfigured,
	) {}

	isConfigured(): boolean {
		return this.databaseConfigured();
	}

	private requireDatabase(): DbClient {
		if (!this.databaseConfigured()) {
			throw new WorkspaceConfigUnavailableError();
		}
		return this.getDatabase();
	}

	async upsertConfig(input: WorkspaceConfigInput): Promise<WorkspaceConfig> {
		const config = normalizeWorkspaceConfigInput(input);
		const db = this.requireDatabase();
		const now = new Date(config.updatedAt);

		try {
			const [row] = await db
				.insert(workspaceConfig)
				.values({
					workspaceId: config.workspaceId,
					modelPreferences: config.modelPreferences,
					safetyRules: config.safetyRules,
					rateLimits: config.rateLimits,
					createdAt: now,
					updatedAt: now,
				})
				.onConflictDoUpdate({
					target: workspaceConfig.workspaceId,
					set: {
						modelPreferences: config.modelPreferences,
						safetyRules: config.safetyRules,
						rateLimits: config.rateLimits,
						updatedAt: now,
					},
				})
				.returning();

			return row ? configFromRow(row) : config;
		} catch (error) {
			logger.warn("Failed to upsert workspace config", {
				error: error instanceof Error ? error.message : String(error),
				workspaceId: config.workspaceId,
			});
			throw error;
		}
	}

	async patchConfig(
		workspaceId: string,
		input: WorkspaceConfigPatchInput,
	): Promise<WorkspaceConfig> {
		const existing = await this.getConfig(workspaceId);
		const config = normalizeWorkspaceConfigPatchInput(
			workspaceId,
			input,
			existing,
		);
		const db = this.requireDatabase();
		const now = new Date(config.updatedAt);

		const [row] = await db
			.insert(workspaceConfig)
			.values({
				workspaceId: config.workspaceId,
				modelPreferences: config.modelPreferences,
				safetyRules: config.safetyRules,
				rateLimits: config.rateLimits,
				createdAt: new Date(config.createdAt),
				updatedAt: now,
			})
			.onConflictDoUpdate({
				target: workspaceConfig.workspaceId,
				set: {
					modelPreferences: config.modelPreferences,
					safetyRules: config.safetyRules,
					rateLimits: config.rateLimits,
					updatedAt: now,
				},
			})
			.returning();

		return row ? configFromRow(row) : config;
	}

	async getConfig(workspaceId: string): Promise<WorkspaceConfig | null> {
		const normalizedWorkspaceId = normalizeWorkspaceConfigId(workspaceId);
		const db = this.requireDatabase();
		const [row] = await db
			.select()
			.from(workspaceConfig)
			.where(eq(workspaceConfig.workspaceId, normalizedWorkspaceId))
			.limit(1);
		return row ? configFromRow(row) : null;
	}

	async listConfigs(
		query: WorkspaceConfigListQuery,
	): Promise<WorkspaceConfigListResult> {
		const db = this.requireDatabase();
		const rows = await db
			.select()
			.from(workspaceConfig)
			.orderBy(sql`${workspaceConfig.updatedAt} DESC`)
			.limit(query.limit + 1)
			.offset(query.offset);
		const hasMore = rows.length > query.limit;
		const visibleRows = hasMore ? rows.slice(0, query.limit) : rows;
		return {
			configs: visibleRows.map((row) => summaryFromConfig(configFromRow(row))),
			pagination: {
				limit: query.limit,
				offset: query.offset,
				hasMore,
				...(hasMore ? { nextOffset: query.offset + query.limit } : {}),
			},
		};
	}

	async deleteConfig(workspaceId: string): Promise<boolean> {
		const normalizedWorkspaceId = normalizeWorkspaceConfigId(workspaceId);
		const db = this.requireDatabase();
		const deleted = await db
			.delete(workspaceConfig)
			.where(eq(workspaceConfig.workspaceId, normalizedWorkspaceId))
			.returning({ workspaceId: workspaceConfig.workspaceId });
		return deleted.length > 0;
	}
}

let defaultWorkspaceConfigService: WorkspaceConfigService | null = null;

export function getWorkspaceConfigService(): WorkspaceConfigService {
	defaultWorkspaceConfigService ??= new WorkspaceConfigService();
	return defaultWorkspaceConfigService;
}

export function setWorkspaceConfigServiceForTest(
	service: WorkspaceConfigService | null,
): void {
	defaultWorkspaceConfigService = service;
}
