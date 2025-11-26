/**
 * RBAC Permission System
 * Defines resources, actions, and permission checking logic
 */

import { and, eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import {
	orgMemberships,
	permissions,
	rolePermissions,
	roles,
} from "../db/schema.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("rbac");

// ============================================================================
// PERMISSION DEFINITIONS
// ============================================================================

export const RESOURCES = {
	SESSIONS: "sessions",
	MODELS: "models",
	USERS: "users",
	ORGS: "orgs",
	AUDIT: "audit",
	CONFIG: "config",
	TOOLS: "tools",
	API_KEYS: "api_keys",
	ROLES: "roles",
	DIRECTORIES: "directories",
} as const;

export const ACTIONS = {
	READ: "read",
	WRITE: "write",
	DELETE: "delete",
	EXECUTE: "execute",
	ADMIN: "admin",
	WILDCARD: "*",
} as const;

export type Resource = (typeof RESOURCES)[keyof typeof RESOURCES];
export type Action = (typeof ACTIONS)[keyof typeof ACTIONS];

export interface Permission {
	resource: Resource;
	action: Action;
}

// ============================================================================
// BUILT-IN ROLE DEFINITIONS
// ============================================================================

export const SYSTEM_ROLES = {
	ORG_OWNER: {
		name: "org_owner",
		description: "Organization owner with full access",
		permissions: [{ resource: RESOURCES.ORGS, action: ACTIONS.WILDCARD }],
	},
	ORG_ADMIN: {
		name: "org_admin",
		description: "Organization administrator",
		permissions: [
			{ resource: RESOURCES.SESSIONS, action: ACTIONS.WILDCARD },
			{ resource: RESOURCES.MODELS, action: ACTIONS.WILDCARD },
			{ resource: RESOURCES.USERS, action: ACTIONS.READ },
			{ resource: RESOURCES.CONFIG, action: ACTIONS.WILDCARD },
			{ resource: RESOURCES.AUDIT, action: ACTIONS.READ },
			{ resource: RESOURCES.API_KEYS, action: ACTIONS.WILDCARD },
			{ resource: RESOURCES.TOOLS, action: ACTIONS.EXECUTE },
			{ resource: RESOURCES.DIRECTORIES, action: ACTIONS.READ },
		],
	},
	ORG_MEMBER: {
		name: "org_member",
		description: "Regular organization member",
		permissions: [
			{ resource: RESOURCES.SESSIONS, action: ACTIONS.WILDCARD },
			{ resource: RESOURCES.MODELS, action: ACTIONS.EXECUTE },
			{ resource: RESOURCES.CONFIG, action: ACTIONS.READ },
			{ resource: RESOURCES.TOOLS, action: ACTIONS.EXECUTE },
			{ resource: RESOURCES.API_KEYS, action: ACTIONS.READ },
			{ resource: RESOURCES.DIRECTORIES, action: ACTIONS.READ },
		],
	},
	ORG_VIEWER: {
		name: "org_viewer",
		description: "Read-only access to organization resources",
		permissions: [
			{ resource: RESOURCES.SESSIONS, action: ACTIONS.READ },
			{ resource: RESOURCES.MODELS, action: ACTIONS.READ },
			{ resource: RESOURCES.CONFIG, action: ACTIONS.READ },
			{ resource: RESOURCES.USERS, action: ACTIONS.READ },
		],
	},
} as const;

// ============================================================================
// TYPES
// ============================================================================

export interface PermissionContext {
	userId: string;
	orgId: string;
	roleId?: string;
	resourceOwnerId?: string;
}

// ============================================================================
// CACHE
// ============================================================================

const permissionCache = new Map<string, boolean>();
const CACHE_TIMEOUT = 5 * 60 * 1000; // 5 minutes

// ============================================================================
// PERMISSION CHECKING FUNCTIONS
// ============================================================================

/**
 * Check if a user has permission to perform an action on a resource
 */
export async function checkPermission(
	context: PermissionContext,
	resource: Resource,
	action: Action,
): Promise<boolean> {
	const cacheKey = `${context.userId}:${context.orgId}:${resource}:${action}`;

	const cached = permissionCache.get(cacheKey);
	if (cached !== undefined) {
		return cached;
	}

	try {
		const db = getDb();

		const membership = await db.query.orgMemberships.findFirst({
			where: and(
				eq(orgMemberships.userId, context.userId),
				eq(orgMemberships.orgId, context.orgId),
			),
			with: {
				role: {
					with: {
						permissions: {
							with: {
								permission: true,
							},
						},
					},
				},
			},
		});

		if (!membership) {
			logger.warn("User not found in organization", {
				userId: context.userId,
				orgId: context.orgId,
			});
			return false;
		}

		const hasPermission = membership.role.permissions.some((rp) => {
			const perm = rp.permission;
			return (
				(perm.resource === resource || perm.resource === "orgs") &&
				(perm.action === action ||
					perm.action === ACTIONS.WILDCARD ||
					perm.action === ACTIONS.ADMIN)
			);
		});

		// Ownership check removed - all access must go through RBAC
		// This ensures audit requirements and organizational policies are enforced

		permissionCache.set(cacheKey, hasPermission);
		setTimeout(() => {
			permissionCache.delete(cacheKey);
		}, CACHE_TIMEOUT);

		return hasPermission;
	} catch (error) {
		logger.error(
			"Permission check failed",
			error instanceof Error ? error : undefined,
			{
				context,
				resource,
				action,
			},
		);
		return false;
	}
}

/**
 * Require permission or throw error
 */
export async function requirePermission(
	context: PermissionContext,
	resource: Resource,
	action: Action,
): Promise<void> {
	const allowed = await checkPermission(context, resource, action);
	if (!allowed) {
		throw new PermissionDeniedError(
			`Permission denied: ${action} on ${resource}`,
			{ resource, action, userId: context.userId },
		);
	}
}

/**
 * Check multiple permissions at once
 */
export async function checkMultiplePermissions(
	context: PermissionContext,
	perms: Permission[],
): Promise<boolean> {
	const results = await Promise.all(
		perms.map((p) => checkPermission(context, p.resource, p.action)),
	);
	return results.every((r) => r);
}

/**
 * Clear permission cache (useful after role changes)
 */
export function clearPermissionCache(userId?: string, orgId?: string): void {
	if (userId && orgId) {
		const prefix = `${userId}:${orgId}:`;
		for (const key of permissionCache.keys()) {
			if (key.startsWith(prefix)) {
				permissionCache.delete(key);
			}
		}
	} else {
		permissionCache.clear();
	}
}

// ============================================================================
// PERMISSION ERRORS
// ============================================================================

export class PermissionDeniedError extends Error {
	constructor(
		message: string,
		public details: {
			resource: Resource;
			action: Action;
			userId: string;
		},
	) {
		super(message);
		this.name = "PermissionDeniedError";
	}
}

// ============================================================================
// SEED DEFAULT PERMISSIONS
// ============================================================================

export async function seedPermissions(): Promise<void> {
	const db = getDb();

	logger.info("Seeding default permissions and roles");

	const allPermissions: Array<{
		resource: Resource;
		action: Action;
		description: string;
	}> = [];

	for (const resource of Object.values(RESOURCES)) {
		for (const action of Object.values(ACTIONS)) {
			allPermissions.push({
				resource,
				action,
				description: `${action} access to ${resource}`,
			});
		}
	}

	try {
		for (const perm of allPermissions) {
			await db.insert(permissions).values(perm).onConflictDoNothing();
		}

		for (const roleData of Object.values(SYSTEM_ROLES)) {
			const [role] = await db
				.insert(roles)
				.values({
					orgId: null,
					name: roleData.name,
					description: roleData.description,
					isSystem: true,
				})
				.onConflictDoNothing()
				.returning();

			if (role) {
				// For each permission defined in the role, find the exact matching permission record
				for (const rolePerm of roleData.permissions) {
					const perm = await db.query.permissions.findFirst({
						where: and(
							eq(permissions.resource, rolePerm.resource),
							eq(permissions.action, rolePerm.action),
						),
					});

					if (perm) {
						await db
							.insert(rolePermissions)
							.values({
								roleId: role.id,
								permissionId: perm.id,
							})
							.onConflictDoNothing();
					}
				}

				logger.info(`Created system role: ${roleData.name}`);
			}
		}

		logger.info("Permission seeding completed");
	} catch (error) {
		logger.error(
			"Failed to seed permissions",
			error instanceof Error ? error : undefined,
		);
		throw error;
	}
}

// ============================================================================
// BACKWARD COMPATIBILITY
// ============================================================================

export const PermissionChecker = {
	check: checkPermission,
	require: requirePermission,
	checkMultiple: checkMultiplePermissions,
	clearCache: clearPermissionCache,
};
