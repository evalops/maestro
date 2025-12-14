/**
 * RBAC Permissions - Role-based access control for Slack Agent
 *
 * Simple file-based permission system with 4 roles:
 * - admin: Full access to everything
 * - power_user: All tools, task management, context control
 * - user: Common tools, own task management
 * - viewer: Read-only access
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as logger from "./logger.js";

// ============================================================================
// Types
// ============================================================================

export type SlackRole = "admin" | "power_user" | "user" | "viewer";

export interface UserPermissions {
	role: SlackRole;
	isBlocked: boolean;
	blockedReason?: string;
	updatedAt: string;
}

export interface PermissionCheck {
	allowed: boolean;
	reason?: string;
	role: SlackRole;
}

interface PermissionsData {
	users: Record<string, UserPermissions>;
	defaultRole: SlackRole;
}

// ============================================================================
// Role Definitions
// ============================================================================

/**
 * Permission matrix for Slack roles
 */
const ROLE_PERMISSIONS: Record<SlackRole, string[]> = {
	admin: ["*"], // Full access
	power_user: [
		"execute_tool:*",
		"schedule_task",
		"cancel_task",
		"cancel_own_task",
		"clear_context",
		"toggle_thinking",
		"manage_memory",
		"view_costs",
		"view_own_costs",
		"view_status",
		"view_scheduled_tasks",
		"retry",
		"stop",
	],
	user: [
		"execute_tool:read",
		"execute_tool:write",
		"execute_tool:edit",
		"execute_tool:bash",
		"execute_tool:search",
		"execute_tool:list",
		"execute_tool:diff",
		"execute_tool:attach",
		"execute_tool:status",
		"schedule_task",
		"cancel_own_task",
		"toggle_thinking",
		"view_own_costs",
		"view_status",
		"view_scheduled_tasks",
		"retry",
		"stop",
	],
	viewer: [
		"execute_tool:read",
		"execute_tool:search",
		"execute_tool:list",
		"execute_tool:diff",
		"execute_tool:status",
		"view_status",
		"view_scheduled_tasks",
	],
};

// ============================================================================
// PermissionManager Class
// ============================================================================

export class PermissionManager {
	private data: PermissionsData;
	private filePath: string;

	constructor(
		workingDir: string,
		private options: { defaultRole?: SlackRole } = {},
	) {
		this.filePath = join(workingDir, "permissions.json");
		this.data = this.load();
	}

	private load(): PermissionsData {
		try {
			if (existsSync(this.filePath)) {
				const content = readFileSync(this.filePath, "utf-8");
				return JSON.parse(content);
			}
		} catch (error) {
			logger.logWarning("Failed to load permissions", String(error));
		}
		return {
			users: {},
			defaultRole: this.options.defaultRole ?? "user",
		};
	}

	private save(): void {
		try {
			writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
		} catch (error) {
			logger.logWarning("Failed to save permissions", String(error));
		}
	}

	/**
	 * Get or create user permissions
	 */
	getUser(userId: string): UserPermissions {
		if (!this.data.users[userId]) {
			this.data.users[userId] = {
				role: this.data.defaultRole,
				isBlocked: false,
				updatedAt: new Date().toISOString(),
			};
			this.save();
		}
		return this.data.users[userId];
	}

	/**
	 * Check if a user has permission to perform an action
	 */
	check(userId: string, action: string, resource?: string): PermissionCheck {
		const user = this.getUser(userId);

		// Check if blocked
		if (user.isBlocked) {
			return {
				allowed: false,
				reason: user.blockedReason ?? "User is blocked",
				role: user.role,
			};
		}

		const permissions = ROLE_PERMISSIONS[user.role];
		if (!permissions) {
			return {
				allowed: false,
				reason: `Unknown role: ${user.role}`,
				role: user.role,
			};
		}

		// Check for wildcard
		if (permissions.includes("*")) {
			return { allowed: true, role: user.role };
		}

		// Check specific permission
		const fullAction = resource ? `${action}:${resource}` : action;
		const wildcardAction = `${action}:*`;

		if (
			permissions.includes(fullAction) ||
			permissions.includes(wildcardAction) ||
			permissions.includes(action)
		) {
			return { allowed: true, role: user.role };
		}

		return {
			allowed: false,
			reason: `Permission denied: ${fullAction}`,
			role: user.role,
		};
	}

	/**
	 * Check if user can execute a specific tool
	 */
	canExecuteTool(userId: string, toolName: string): PermissionCheck {
		return this.check(userId, "execute_tool", toolName);
	}

	/**
	 * Check if user can cancel a task
	 */
	canCancelTask(userId: string, taskCreatedBy: string): PermissionCheck {
		const user = this.getUser(userId);

		// Admins and power_users can cancel any task
		if (user.role === "admin" || user.role === "power_user") {
			return { allowed: true, role: user.role };
		}

		// Users can only cancel their own tasks
		if (userId === taskCreatedBy) {
			return this.check(userId, "cancel_own_task");
		}

		return {
			allowed: false,
			reason: "Can only cancel your own tasks",
			role: user.role,
		};
	}

	/**
	 * Set user's role (requires admin)
	 */
	setRole(
		adminUserId: string,
		targetUserId: string,
		newRole: SlackRole,
	): { success: boolean; error?: string } {
		// Only admins can change roles
		const adminUser = this.getUser(adminUserId);
		if (adminUser.role !== "admin") {
			return { success: false, error: "Only admins can change roles" };
		}

		// Prevent admins from changing their own role (use another admin)
		if (adminUserId === targetUserId) {
			return { success: false, error: "Cannot change your own role" };
		}

		this.data.users[targetUserId] = {
			...this.getUser(targetUserId),
			role: newRole,
			updatedAt: new Date().toISOString(),
		};
		this.save();

		logger.logInfo(`User role updated: ${targetUserId} -> ${newRole}`);
		return { success: true };
	}

	/**
	 * Block a user
	 */
	blockUser(
		adminUserId: string,
		targetUserId: string,
		reason: string,
	): { success: boolean; error?: string } {
		if (this.getUser(adminUserId).role !== "admin") {
			return { success: false, error: "Only admins can block users" };
		}

		if (adminUserId === targetUserId) {
			return { success: false, error: "Cannot block yourself" };
		}

		this.data.users[targetUserId] = {
			...this.getUser(targetUserId),
			isBlocked: true,
			blockedReason: reason,
			updatedAt: new Date().toISOString(),
		};
		this.save();

		logger.logInfo(`User blocked: ${targetUserId} - ${reason}`);
		return { success: true };
	}

	/**
	 * Unblock a user
	 */
	unblockUser(
		adminUserId: string,
		targetUserId: string,
	): { success: boolean; error?: string } {
		if (this.getUser(adminUserId).role !== "admin") {
			return { success: false, error: "Only admins can unblock users" };
		}

		this.data.users[targetUserId] = {
			...this.getUser(targetUserId),
			isBlocked: false,
			blockedReason: undefined,
			updatedAt: new Date().toISOString(),
		};
		this.save();

		logger.logInfo(`User unblocked: ${targetUserId}`);
		return { success: true };
	}

	/**
	 * List all users with non-default roles
	 */
	listUsers(): Array<{ userId: string } & UserPermissions> {
		return Object.entries(this.data.users).map(([userId, perms]) => ({
			userId,
			...perms,
		}));
	}

	/**
	 * Set the default role for new users
	 */
	setDefaultRole(role: SlackRole): void {
		this.data.defaultRole = role;
		this.save();
	}
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Get human-readable description of a role
 */
export function getRoleDescription(role: SlackRole): string {
	switch (role) {
		case "admin":
			return "Full access to all features and settings";
		case "power_user":
			return "Execute any tool, manage tasks and context";
		case "user":
			return "Execute common tools, manage own tasks";
		case "viewer":
			return "Read-only access, can search and view status";
		default:
			return "Unknown role";
	}
}

/**
 * Get list of allowed tools for a role
 */
export function getAllowedToolsForRole(role: SlackRole): string[] | "all" {
	const permissions = ROLE_PERMISSIONS[role];
	if (!permissions) return [];

	if (permissions.includes("*") || permissions.includes("execute_tool:*")) {
		return "all";
	}

	return permissions
		.filter((p) => p.startsWith("execute_tool:"))
		.map((p) => p.replace("execute_tool:", ""));
}
