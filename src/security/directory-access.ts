/**
 * Directory Access Control System
 * Implements allowlist/denylist with wildcard patterns
 */

import { normalize, resolve } from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { minimatch } from "minimatch";
import { getDb } from "../db/client.js";
import { directoryAccessRules } from "../db/schema.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("directory-access");

// ============================================================================
// TYPES
// ============================================================================

export interface DirectoryAccessContext {
	userId: string;
	orgId: string;
	roleId: string;
}

export interface AccessRule {
	pattern: string;
	isAllowed: boolean;
	priority: number;
	roleIds: string[] | null;
	description?: string;
}

export interface CreateDirectoryRuleInput {
	orgId: string;
	pattern: string;
	isAllowed: boolean;
	roleIds?: string[];
	description?: string;
	priority?: number;
}

// ============================================================================
// CACHE
// ============================================================================

const ruleCache = new Map<string, AccessRule[]>();
const ruleCacheTimers = new Map<string, ReturnType<typeof setTimeout>>();
const CACHE_TIMEOUT = 5 * 60 * 1000; // 5 minutes

// ============================================================================
// INTERNAL HELPERS
// ============================================================================

function matchesPattern(path: string, pattern: string): boolean {
	return minimatch(path, pattern, {
		dot: true,
		matchBase: false,
		nocomment: true,
	});
}

async function getRules(orgId: string): Promise<AccessRule[]> {
	const cacheKey = `rules:${orgId}`;
	const cached = ruleCache.get(cacheKey);

	if (cached) {
		return cached;
	}

	const db = getDb();
	const rules = await db.query.directoryAccessRules.findMany({
		where: eq(directoryAccessRules.orgId, orgId),
		orderBy: [desc(directoryAccessRules.priority)],
	});

	const mappedRules: AccessRule[] = rules.map((r) => ({
		pattern: r.pattern,
		isAllowed: r.isAllowed,
		priority: r.priority,
		roleIds: r.roleIds as string[] | null,
		description: r.description || undefined,
	}));

	ruleCache.set(cacheKey, mappedRules);

	// Clear any existing timer for this key
	const existingTimer = ruleCacheTimers.get(cacheKey);
	if (existingTimer) {
		clearTimeout(existingTimer);
	}

	// Store timer ID so it can be cleared if cache is manually cleared
	const timerId = setTimeout(() => {
		ruleCache.delete(cacheKey);
		ruleCacheTimers.delete(cacheKey);
	}, CACHE_TIMEOUT);
	ruleCacheTimers.set(cacheKey, timerId);

	return mappedRules;
}

// ============================================================================
// PUBLIC FUNCTIONS
// ============================================================================

/**
 * Check if a user has access to a file or directory path
 */
export async function checkDirectoryAccess(
	context: DirectoryAccessContext,
	filePath: string,
): Promise<{ allowed: boolean; reason?: string; matchedRule?: string }> {
	try {
		const normalizedPath = normalize(resolve(filePath));
		const rules = await getRules(context.orgId);

		// If no rules are defined, deny by default for security
		if (rules.length === 0) {
			return {
				allowed: false,
				reason: "No access rules configured (default deny)",
			};
		}

		// Check rules in priority order (highest first)
		for (const rule of rules) {
			if (rule.roleIds && !rule.roleIds.includes(context.roleId)) {
				continue;
			}

			if (matchesPattern(normalizedPath, rule.pattern)) {
				const allowed = rule.isAllowed;
				const reason = allowed
					? "Path allowed by access rule"
					: "Path denied by access rule";

				logger.debug("Directory access check", {
					path: normalizedPath,
					pattern: rule.pattern,
					allowed,
					userId: context.userId,
					orgId: context.orgId,
				});

				return {
					allowed,
					reason,
					matchedRule: rule.pattern,
				};
			}
		}

		// No matching rule - default deny (secure by default)
		logger.warn("No matching directory access rule, defaulting to deny", {
			path: normalizedPath,
			userId: context.userId,
			orgId: context.orgId,
		});

		return {
			allowed: false,
			reason: "No matching access rule (default deny)",
		};
	} catch (error) {
		logger.error(
			"Directory access check failed",
			error instanceof Error ? error : undefined,
			{
				path: filePath,
				context,
			},
		);
		return {
			allowed: false,
			reason: "Access check failed due to error",
		};
	}
}

/**
 * Check access and throw error if denied
 */
export async function requireDirectoryAccess(
	context: DirectoryAccessContext,
	filePath: string,
): Promise<void> {
	const result = await checkDirectoryAccess(context, filePath);
	if (!result.allowed) {
		throw new DirectoryAccessDeniedError(`Access denied to path: ${filePath}`, {
			path: filePath,
			reason: result.reason || "Unknown",
			matchedRule: result.matchedRule,
		});
	}
}

/**
 * Check multiple paths at once
 */
export async function checkMultiplePaths(
	context: DirectoryAccessContext,
	filePaths: string[],
): Promise<Map<string, boolean>> {
	const results = new Map<string, boolean>();

	for (const path of filePaths) {
		const result = await checkDirectoryAccess(context, path);
		results.set(path, result.allowed);
	}

	return results;
}

/**
 * Clear rule cache (useful after rule changes)
 */
export function clearDirectoryRulesCache(orgId?: string): void {
	if (orgId) {
		const cacheKey = `rules:${orgId}`;
		ruleCache.delete(cacheKey);
		const timer = ruleCacheTimers.get(cacheKey);
		if (timer) {
			clearTimeout(timer);
			ruleCacheTimers.delete(cacheKey);
		}
	} else {
		ruleCache.clear();
		for (const timer of ruleCacheTimers.values()) {
			clearTimeout(timer);
		}
		ruleCacheTimers.clear();
	}
}

/**
 * Get default safe directories (always allowed regardless of rules)
 */
export function getDefaultSafeDirectories(): string[] {
	return [
		"/tmp",
		"/var/tmp",
		process.env.HOME ? `${process.env.HOME}/.composer` : "~/.composer",
	];
}

/**
 * Get default restricted directories (always denied regardless of rules)
 */
export function getDefaultRestrictedDirectories(): string[] {
	return [
		"/etc",
		"/sys",
		"/proc",
		"/dev",
		"/boot",
		"/root",
		"**/node_modules/**",
		"**/.git/**",
	];
}

// ============================================================================
// RULE MANAGEMENT
// ============================================================================

/**
 * Create a new directory access rule
 */
export async function createDirectoryRule(
	input: CreateDirectoryRuleInput,
): Promise<void> {
	const db = getDb();

	await db.insert(directoryAccessRules).values({
		orgId: input.orgId,
		pattern: input.pattern,
		isAllowed: input.isAllowed,
		roleIds: input.roleIds || null,
		description: input.description,
		priority: input.priority || 0,
	});

	clearDirectoryRulesCache(input.orgId);

	logger.info("Created directory access rule", {
		orgId: input.orgId,
		pattern: input.pattern,
		isAllowed: input.isAllowed,
	});
}

/**
 * Delete a directory access rule
 */
export async function deleteDirectoryRule(
	ruleId: string,
	orgId: string,
): Promise<void> {
	const db = getDb();

	await db
		.delete(directoryAccessRules)
		.where(
			and(
				eq(directoryAccessRules.id, ruleId),
				eq(directoryAccessRules.orgId, orgId),
			),
		);

	clearDirectoryRulesCache(orgId);

	logger.info("Deleted directory access rule", { ruleId, orgId });
}

/**
 * Seed default rules for a new organization
 */
export async function seedDefaultDirectoryRules(orgId: string): Promise<void> {
	const homeDir = process.env.HOME || process.env.USERPROFILE;
	const defaultRules: Array<Omit<CreateDirectoryRuleInput, "orgId">> = [
		...(homeDir
			? [
					{
						pattern: `${homeDir}/**`,
						isAllowed: true,
						priority: 100,
						description: "Allow access to user home directory",
					},
				]
			: []),
		{
			pattern: "/tmp/**",
			isAllowed: true,
			priority: 90,
			description: "Allow access to temporary directory",
		},
		{
			pattern: "/etc/**",
			isAllowed: false,
			priority: 200,
			description: "Deny access to system configuration",
		},
		{
			pattern: "/sys/**",
			isAllowed: false,
			priority: 200,
			description: "Deny access to system files",
		},
		{
			pattern: "/proc/**",
			isAllowed: false,
			priority: 200,
			description: "Deny access to process information",
		},
		{
			pattern: "**/node_modules/**",
			isAllowed: false,
			priority: 50,
			description: "Deny access to node_modules directories",
		},
		{
			pattern: "**/.git/**",
			isAllowed: false,
			priority: 50,
			description: "Deny direct access to git internals",
		},
	];

	for (const rule of defaultRules) {
		await createDirectoryRule({ ...rule, orgId });
	}

	logger.info("Seeded default directory access rules", { orgId });
}

// ============================================================================
// ERROR CLASSES
// ============================================================================

export class DirectoryAccessDeniedError extends Error {
	constructor(
		message: string,
		public details: {
			path: string;
			reason: string;
			matchedRule?: string;
		},
	) {
		super(message);
		this.name = "DirectoryAccessDeniedError";
	}
}

// ============================================================================
// BACKWARD COMPATIBILITY
// ============================================================================

export const DirectoryAccessChecker = {
	checkAccess: checkDirectoryAccess,
	requireAccess: requireDirectoryAccess,
	checkMultiplePaths,
	clearCache: clearDirectoryRulesCache,
	getDefaultSafeDirectories,
	getDefaultRestrictedDirectories,
};

export const DirectoryRuleManager = {
	createRule: createDirectoryRule,
	deleteRule: deleteDirectoryRule,
	seedDefaultRules: seedDefaultDirectoryRules,
};
