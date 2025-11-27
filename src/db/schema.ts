/**
 * Enterprise Database Schema for Composer
 * Supports multi-tenancy, RBAC, audit logging, and PII protection
 */

import { relations } from "drizzle-orm";
import {
	boolean,
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
	varchar,
} from "drizzle-orm/pg-core";

// ============================================================================
// ENUMS
// ============================================================================

export const userRoleEnum = pgEnum("user_role", [
	"org_owner",
	"org_admin",
	"org_member",
	"org_viewer",
]);

export const auditStatusEnum = pgEnum("audit_status", [
	"success",
	"failure",
	"error",
	"denied",
]);

export const alertSeverityEnum = pgEnum("alert_severity", [
	"critical",
	"high",
	"medium",
	"low",
	"info",
]);

export const modelApprovalStatusEnum = pgEnum("model_approval_status", [
	"approved",
	"pending",
	"denied",
	"auto_approved",
]);

// ============================================================================
// ORGANIZATIONS
// ============================================================================

export const organizations = pgTable(
	"organizations",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		name: varchar("name", { length: 255 }).notNull(),
		slug: varchar("slug", { length: 100 }).notNull().unique(),
		settings: jsonb("settings").$type<OrganizationSettings>().default({}),
		isActive: boolean("is_active").default(true).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		deletedAt: timestamp("deleted_at", { withTimezone: true }),
	},
	(table) => ({
		slugIdx: uniqueIndex("org_slug_idx").on(table.slug),
		activeIdx: index("org_active_idx").on(table.isActive),
	}),
);

export type OrganizationSettings = {
	maxTokensPerUser?: number;
	maxSessionsPerUser?: number;
	maxApiKeysPerUser?: number;
	allowedDirectories?: string[]; // Glob patterns
	deniedDirectories?: string[]; // Glob patterns
	piiRedactionEnabled?: boolean;
	piiPatterns?: string[]; // Regex patterns for custom PII
	auditRetentionDays?: number;
	alertWebhooks?: string[];
	customModelRestrictions?: {
		providers?: string[];
		maxContextWindow?: number;
		requireApproval?: boolean;
	};
};

// ============================================================================
// USERS
// ============================================================================

export const users = pgTable(
	"users",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		email: varchar("email", { length: 255 }).notNull().unique(),
		name: varchar("name", { length: 255 }).notNull(),
		passwordHash: varchar("password_hash", { length: 255 }), // NULL for OAuth users
		emailVerified: boolean("email_verified").default(false).notNull(),
		isActive: boolean("is_active").default(true).notNull(),
		defaultOrgId: uuid("default_org_id").references(() => organizations.id),
		settings: jsonb("settings").$type<UserSettings>().default({}),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
	},
	(table) => ({
		emailIdx: uniqueIndex("user_email_idx").on(table.email),
		activeIdx: index("user_active_idx").on(table.isActive),
	}),
);

export type UserSettings = {
	notificationEmail?: string;
	alertThresholds?: {
		tokenUsagePercent?: number;
		sessionCount?: number;
	};
	preferredModels?: string[];
	defaultThinkingLevel?: string;
};

// ============================================================================
// ORGANIZATION MEMBERSHIPS
// ============================================================================

export const orgMemberships = pgTable(
	"org_memberships",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		roleId: uuid("role_id")
			.notNull()
			.references(() => roles.id),
		tokenQuota: integer("token_quota"), // Per-user quota override
		tokenUsed: integer("token_used").default(0).notNull(),
		quotaResetAt: timestamp("quota_reset_at", { withTimezone: true }),
		joinedAt: timestamp("joined_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => ({
		orgUserIdx: uniqueIndex("org_membership_org_user_idx").on(
			table.orgId,
			table.userId,
		),
		userIdx: index("org_membership_user_idx").on(table.userId),
	}),
);

// ============================================================================
// ROLES & PERMISSIONS
// ============================================================================

export const roles = pgTable(
	"roles",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id").references(() => organizations.id, {
			onDelete: "cascade",
		}), // NULL for system roles
		name: varchar("name", { length: 100 }).notNull(),
		description: text("description"),
		isSystem: boolean("is_system").default(false).notNull(), // Built-in roles
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => ({
		orgNameIdx: uniqueIndex("role_org_name_idx").on(table.orgId, table.name),
	}),
);

export const permissions = pgTable(
	"permissions",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		resource: varchar("resource", { length: 100 }).notNull(), // sessions, models, users, etc.
		action: varchar("action", { length: 50 }).notNull(), // read, write, delete, execute, admin
		description: text("description"),
	},
	(table) => ({
		resourceActionIdx: uniqueIndex("permission_resource_action_idx").on(
			table.resource,
			table.action,
		),
	}),
);

export const rolePermissions = pgTable(
	"role_permissions",
	{
		roleId: uuid("role_id")
			.notNull()
			.references(() => roles.id, { onDelete: "cascade" }),
		permissionId: uuid("permission_id")
			.notNull()
			.references(() => permissions.id, { onDelete: "cascade" }),
	},
	(table) => ({
		pk: uniqueIndex("role_permission_pk").on(table.roleId, table.permissionId),
	}),
);

// ============================================================================
// SESSIONS
// ============================================================================

export const sessions = pgTable(
	"sessions",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		title: varchar("title", { length: 255 }),
		model: varchar("model", { length: 100 }).notNull(),
		thinkingLevel: varchar("thinking_level", { length: 50 })
			.default("off")
			.notNull(),
		systemPrompt: text("system_prompt"),
		metadata: jsonb("metadata").$type<SessionMetadata>().default({}),
		tokenCount: integer("token_count").default(0).notNull(),
		messageCount: integer("message_count").default(0).notNull(),
		isShared: boolean("is_shared").default(false).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		deletedAt: timestamp("deleted_at", { withTimezone: true }),
	},
	(table) => ({
		orgUserIdx: index("session_org_user_idx").on(table.orgId, table.userId),
		userIdx: index("session_user_idx").on(table.userId),
		createdIdx: index("session_created_idx").on(table.createdAt),
	}),
);

export type SessionMetadata = {
	favorite?: boolean;
	summary?: string;
	tags?: string[];
	cwd?: string;
	toolsUsed?: string[];
};

// ============================================================================
// SESSION MESSAGES
// ============================================================================

export const sessionMessages = pgTable(
	"session_messages",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		sessionId: uuid("session_id")
			.notNull()
			.references(() => sessions.id, { onDelete: "cascade" }),
		role: varchar("role", { length: 50 }).notNull(), // user, assistant, system, tool
		content: text("content"),
		toolCalls: jsonb("tool_calls").$type<unknown[]>(),
		toolResults: jsonb("tool_results").$type<unknown[]>(),
		metadata: jsonb("metadata").$type<MessageMetadata>().default({}),
		tokenCount: integer("token_count").default(0).notNull(),
		hasPii: boolean("has_pii").default(false).notNull(), // Flagged by PII detector
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => ({
		sessionIdx: index("session_message_session_idx").on(
			table.sessionId,
			table.createdAt,
		),
		piiIdx: index("session_message_pii_idx").on(table.hasPii),
	}),
);

export type MessageMetadata = {
	thinkingContent?: string;
	durationMs?: number;
	model?: string;
	piiRedacted?: boolean;
	redactedFields?: string[];
};

// ============================================================================
// AUDIT LOGS
// ============================================================================

export const auditLogs = pgTable(
	"audit_logs",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id")
			.notNull()
			.references(() => organizations.id, {
				onDelete: "restrict",
			}),
		userId: uuid("user_id").references(() => users.id, {
			onDelete: "restrict",
		}),
		sessionId: uuid("session_id").references(() => sessions.id, {
			onDelete: "set null",
		}),
		action: varchar("action", { length: 100 }).notNull(), // e.g., "session.create", "tool.bash.execute"
		resourceType: varchar("resource_type", { length: 100 }), // e.g., "session", "tool", "model"
		resourceId: uuid("resource_id"),
		status: auditStatusEnum("status").notNull(),
		ipAddress: varchar("ip_address", { length: 45 }), // IPv6 support
		userAgent: text("user_agent"),
		requestId: varchar("request_id", { length: 100 }),
		traceId: varchar("trace_id", { length: 100 }), // W3C Trace Context
		metadata: jsonb("metadata").$type<AuditMetadata>().default({}),
		durationMs: integer("duration_ms"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => ({
		orgUserIdx: index("audit_log_org_user_idx").on(
			table.orgId,
			table.userId,
			table.createdAt,
		),
		actionIdx: index("audit_log_action_idx").on(table.action, table.createdAt),
		resourceIdx: index("audit_log_resource_idx").on(
			table.resourceType,
			table.resourceId,
		),
		sessionIdx: index("audit_log_session_idx").on(
			table.sessionId,
			table.createdAt,
		),
		traceIdx: index("audit_log_trace_idx").on(table.traceId),
	}),
);

export type AuditMetadata = {
	toolName?: string;
	command?: string; // Redacted if contains secrets
	filePath?: string;
	model?: string;
	thinkingLevel?: string;
	error?: string;
	tokenCount?: number;
	deniedReason?: string; // For permission denials
	originalValue?: string; // For config changes
	newValue?: string;
};

// ============================================================================
// MODEL APPROVALS
// ============================================================================

export const modelApprovals = pgTable(
	"model_approvals",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		modelId: varchar("model_id", { length: 100 }).notNull(), // e.g., "claude-sonnet-4-5"
		provider: varchar("provider", { length: 100 }).notNull(),
		status: modelApprovalStatusEnum("status").notNull(),
		spendLimit: integer("spend_limit"), // In cents
		spendUsed: integer("spend_used").default(0).notNull(),
		tokenLimit: integer("token_limit"),
		tokenUsed: integer("token_used").default(0).notNull(),
		restrictedToRoles: jsonb("restricted_to_roles").$type<string[]>(),
		metadata: jsonb("metadata").$type<ModelApprovalMetadata>().default({}),
		approvedBy: uuid("approved_by").references(() => users.id),
		approvedAt: timestamp("approved_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => ({
		orgModelIdx: uniqueIndex("model_approval_org_model_idx").on(
			table.orgId,
			table.modelId,
		),
		statusIdx: index("model_approval_status_idx").on(table.status),
	}),
);

export type ModelApprovalMetadata = {
	reason?: string;
	autoApprovalRule?: string;
	contextWindowLimit?: number;
	requiresReasoningApproval?: boolean;
	allowedTools?: string[];
	deniedTools?: string[];
};

// ============================================================================
// DIRECTORY ACCESS RULES
// ============================================================================

export const directoryAccessRules = pgTable(
	"directory_access_rules",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		pattern: varchar("pattern", { length: 500 }).notNull(), // Glob pattern
		isAllowed: boolean("is_allowed").notNull(), // true = allowlist, false = denylist
		roleIds: jsonb("role_ids").$type<string[]>(), // NULL = applies to all roles
		description: text("description"),
		priority: integer("priority").default(0).notNull(), // Higher priority = checked first
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => ({
		orgIdx: index("dir_access_org_idx").on(table.orgId, table.priority),
	}),
);

// ============================================================================
// ALERTS
// ============================================================================

export const alerts = pgTable(
	"alerts",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		userId: uuid("user_id").references(() => users.id, {
			onDelete: "set null",
		}),
		severity: alertSeverityEnum("severity").notNull(),
		type: varchar("type", { length: 100 }).notNull(), // token_limit, spend_limit, pii_detected, etc.
		message: text("message").notNull(),
		metadata: jsonb("metadata").$type<AlertMetadata>().default({}),
		isRead: boolean("is_read").default(false).notNull(),
		resolvedAt: timestamp("resolved_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => ({
		orgUserIdx: index("alert_org_user_idx").on(
			table.orgId,
			table.userId,
			table.createdAt,
		),
		typeIdx: index("alert_type_idx").on(table.type),
		unreadIdx: index("alert_unread_idx").on(table.isRead, table.createdAt),
	}),
);

export type AlertMetadata = {
	threshold?: number;
	currentValue?: number;
	sessionId?: string;
	modelId?: string;
	piiPatterns?: string[];
	actionRequired?: boolean;
};

// ============================================================================
// API KEYS
// ============================================================================

export const apiKeys = pgTable(
	"api_keys",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		name: varchar("name", { length: 255 }).notNull(),
		keyHash: varchar("key_hash", { length: 255 }).notNull(), // bcrypt hash
		keyPrefix: varchar("key_prefix", { length: 20 }).notNull(), // e.g., "csk_abc..."
		scopes: jsonb("scopes").$type<string[]>().default([]),
		lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
		expiresAt: timestamp("expires_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		revokedAt: timestamp("revoked_at", { withTimezone: true }),
	},
	(table) => ({
		orgUserIdx: index("api_key_org_user_idx").on(table.orgId, table.userId),
		prefixIdx: index("api_key_prefix_idx").on(table.keyPrefix),
	}),
);

// ============================================================================
// RELATIONS (for Drizzle ORM joins)
// ============================================================================

export const organizationsRelations = relations(organizations, ({ many }) => ({
	memberships: many(orgMemberships),
	sessions: many(sessions),
	modelApprovals: many(modelApprovals),
	directoryRules: many(directoryAccessRules),
	alerts: many(alerts),
	apiKeys: many(apiKeys),
}));

export const usersRelations = relations(users, ({ one, many }) => ({
	defaultOrg: one(organizations, {
		fields: [users.defaultOrgId],
		references: [organizations.id],
	}),
	memberships: many(orgMemberships),
	sessions: many(sessions),
	auditLogs: many(auditLogs),
	alerts: many(alerts),
	apiKeys: many(apiKeys),
}));

export const rolesRelations = relations(roles, ({ one, many }) => ({
	organization: one(organizations, {
		fields: [roles.orgId],
		references: [organizations.id],
	}),
	permissions: many(rolePermissions),
	memberships: many(orgMemberships),
}));

export const orgMembershipsRelations = relations(orgMemberships, ({ one }) => ({
	organization: one(organizations, {
		fields: [orgMemberships.orgId],
		references: [organizations.id],
	}),
	user: one(users, {
		fields: [orgMemberships.userId],
		references: [users.id],
	}),
	role: one(roles, {
		fields: [orgMemberships.roleId],
		references: [roles.id],
	}),
}));

export const rolePermissionsRelations = relations(
	rolePermissions,
	({ one }) => ({
		role: one(roles, {
			fields: [rolePermissions.roleId],
			references: [roles.id],
		}),
		permission: one(permissions, {
			fields: [rolePermissions.permissionId],
			references: [permissions.id],
		}),
	}),
);

export const permissionsRelations = relations(permissions, ({ many }) => ({
	rolePermissions: many(rolePermissions),
}));

export const sessionsRelations = relations(sessions, ({ one, many }) => ({
	organization: one(organizations, {
		fields: [sessions.orgId],
		references: [organizations.id],
	}),
	user: one(users, {
		fields: [sessions.userId],
		references: [users.id],
	}),
	messages: many(sessionMessages),
	auditLogs: many(auditLogs),
}));

export const sessionMessagesRelations = relations(
	sessionMessages,
	({ one }) => ({
		session: one(sessions, {
			fields: [sessionMessages.sessionId],
			references: [sessions.id],
		}),
	}),
);

export const auditLogsRelations = relations(auditLogs, ({ one }) => ({
	organization: one(organizations, {
		fields: [auditLogs.orgId],
		references: [organizations.id],
	}),
	user: one(users, {
		fields: [auditLogs.userId],
		references: [users.id],
	}),
	session: one(sessions, {
		fields: [auditLogs.sessionId],
		references: [sessions.id],
	}),
}));
