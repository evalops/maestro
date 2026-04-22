/**
 * Enterprise Database Schema for Composer
 * Supports multi-tenancy, RBAC, audit logging, and PII protection
 */

import { relations } from "drizzle-orm";
import {
	bigserial,
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
import type { SessionModelMetadata } from "../session/types.js";

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
	/** Secret for HMAC signing webhook payloads */
	webhookSigningSecret?: string;
	/** IP access control configuration */
	ipAccessControl?: {
		defaultAction: "allow" | "deny";
		rules: Array<{
			pattern: string; // CIDR or IP
			type: "allow" | "deny";
			description?: string;
		}>;
	};
	/** Require 2FA for all org members */
	require2fa?: boolean;
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
	/** 2FA configuration */
	twoFactor?: {
		enabled: boolean;
		/** Base32-encoded TOTP secret (encrypted at rest in production) */
		secret?: string;
		/** Hashed backup codes for recovery */
		backupCodeHashes?: string[];
		/** When 2FA was enabled */
		enabledAt?: string;
	};
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
// HOSTED WEB SESSIONS
// ============================================================================

export const hostedSessions = pgTable(
	"hosted_sessions",
	{
		sessionId: varchar("session_id", { length: 128 }).primaryKey(),
		scope: text("scope").notNull(),
		subject: text("subject"),
		title: varchar("title", { length: 255 }),
		summary: text("summary"),
		resumeSummary: text("resume_summary"),
		memoryExtractionHash: varchar("memory_extraction_hash", { length: 64 }),
		favorite: boolean("favorite").default(false).notNull(),
		tags: jsonb("tags").$type<string[]>(),
		cwd: text("cwd"),
		model: varchar("model", { length: 255 }),
		thinkingLevel: varchar("thinking_level", { length: 50 }),
		systemPrompt: text("system_prompt"),
		promptMetadata: jsonb("prompt_metadata").$type<unknown>(),
		modelMetadata: jsonb("model_metadata").$type<SessionModelMetadata>(),
		tools: jsonb("tools").$type<unknown[]>(),
		messageCount: integer("message_count").default(0).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		deletedAt: timestamp("deleted_at", { withTimezone: true }),
	},
	(table) => ({
		scopeUpdatedIdx: index("hosted_session_scope_updated_idx").on(
			table.scope,
			table.updatedAt,
		),
		scopeSessionIdx: uniqueIndex("hosted_session_scope_id_idx").on(
			table.scope,
			table.sessionId,
		),
		subjectUpdatedIdx: index("hosted_session_subject_updated_idx").on(
			table.subject,
			table.updatedAt,
		),
	}),
);

export const hostedSessionEntries = pgTable(
	"hosted_session_entries",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		sessionId: varchar("session_id", { length: 128 })
			.notNull()
			.references(() => hostedSessions.sessionId, { onDelete: "cascade" }),
		sequence: bigserial("sequence", { mode: "number" }).notNull(),
		entryType: varchar("entry_type", { length: 64 }).notNull(),
		entryId: varchar("entry_id", { length: 128 }),
		entry: jsonb("entry").$type<unknown>().notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => ({
		sessionSequenceIdx: uniqueIndex(
			"hosted_session_entry_session_sequence_idx",
		).on(table.sessionId, table.sequence),
		sessionEntryTypeIdx: index("hosted_session_entry_type_idx").on(
			table.sessionId,
			table.entryType,
		),
	}),
);

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
		/** Hash chain for tamper detection (SHA-256 of entry + previous hash) */
		integrityHash: varchar("integrity_hash", { length: 64 }),
		/** Reference to previous entry's hash for chain verification */
		previousHash: varchar("previous_hash", { length: 64 }),
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
		// For hash chain verification queries that order by createdAt
		orgCreatedIdx: index("audit_log_org_created_idx").on(
			table.orgId,
			table.createdAt,
		),
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
// TOKEN REVOCATION
// ============================================================================

export const revokedTokens = pgTable(
	"revoked_tokens",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		/** SHA-256 hash of the token (never store raw tokens) */
		tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
		/** Token type for metrics/debugging */
		tokenType: varchar("token_type", { length: 20 }).notNull(), // 'access' | 'refresh' | 'api_key'
		/** User who owned the token */
		userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
		/** Org context */
		orgId: uuid("org_id").references(() => organizations.id, {
			onDelete: "cascade",
		}),
		/** Why the token was revoked */
		reason: varchar("reason", { length: 100 }), // 'logout', 'password_change', 'admin_revoke', 'security_incident'
		/** When the token naturally expires (for cleanup) */
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		/** When the token was revoked */
		revokedAt: timestamp("revoked_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		/** Who revoked it (null = user themselves) */
		revokedBy: uuid("revoked_by").references(() => users.id),
	},
	(table) => ({
		tokenHashIdx: uniqueIndex("revoked_token_hash_idx").on(table.tokenHash),
		userIdx: index("revoked_token_user_idx").on(table.userId),
		expiresIdx: index("revoked_token_expires_idx").on(table.expiresAt),
	}),
);

// ============================================================================
// WEBHOOK DELIVERY QUEUE
// ============================================================================

export const webhookDeliveryStatusEnum = pgEnum("webhook_delivery_status", [
	"pending",
	"delivered",
	"failed",
	"retrying",
]);

export const webhookDeliveries = pgTable(
	"webhook_deliveries",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		/** Target URL */
		url: text("url").notNull(),
		/** JSON payload */
		payload: jsonb("payload").notNull(),
		/** HMAC signature */
		signature: varchar("signature", { length: 200 }),
		/** Delivery status */
		status: webhookDeliveryStatusEnum("status").default("pending").notNull(),
		/** Number of delivery attempts */
		attempts: integer("attempts").default(0).notNull(),
		/** Max retry attempts */
		maxAttempts: integer("max_attempts").default(5).notNull(),
		/** Next retry time (exponential backoff) */
		nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
		/** Last error message */
		lastError: text("last_error"),
		/** HTTP status code from last attempt */
		lastStatusCode: integer("last_status_code"),
		/** Response time in ms */
		lastResponseTimeMs: integer("last_response_time_ms"),
		/** When successfully delivered */
		deliveredAt: timestamp("delivered_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => ({
		orgStatusIdx: index("webhook_delivery_org_status_idx").on(
			table.orgId,
			table.status,
		),
		retryIdx: index("webhook_delivery_retry_idx").on(
			table.status,
			table.nextRetryAt,
		),
	}),
);

// ============================================================================
// USER REVOCATION TIMESTAMPS (for "revoke all tokens" functionality)
// ============================================================================

export const userRevocationTimestamps = pgTable(
	"user_revocation_timestamps",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" })
			.unique(),
		/** All tokens issued before this timestamp are revoked */
		revokedBefore: timestamp("revoked_before", {
			withTimezone: true,
		}).notNull(),
		/** Why the tokens were revoked */
		reason: varchar("reason", { length: 100 }).notNull(),
		/** Who initiated the revocation */
		revokedBy: uuid("revoked_by").references(() => users.id),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => ({
		userIdx: uniqueIndex("user_revocation_user_idx").on(table.userId),
	}),
);

// ============================================================================
// TOTP RATE LIMITING (distributed across instances)
// ============================================================================

export const totpRateLimits = pgTable(
	"totp_rate_limits",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" })
			.unique(),
		/** Number of failed attempts in current window */
		attempts: integer("attempts").default(0).notNull(),
		/** When the current rate limit window started */
		windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
		/** When the lockout expires (null = not locked out) */
		lockedUntil: timestamp("locked_until", { withTimezone: true }),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => ({
		userIdx: uniqueIndex("totp_rate_limit_user_idx").on(table.userId),
		lockedIdx: index("totp_rate_limit_locked_idx").on(table.lockedUntil),
	}),
);

// ============================================================================
// SHARED SESSIONS (for session sharing links)
// ============================================================================

export const sharedSessions = pgTable(
	"shared_sessions",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		/** The token used in share URLs */
		shareToken: varchar("share_token", { length: 64 }).notNull().unique(),
		/** Reference to the session being shared (local file-based session ID) */
		sessionId: varchar("session_id", { length: 255 }).notNull(),
		/** User who created the share */
		createdBy: uuid("created_by").references(() => users.id, {
			onDelete: "set null",
		}),
		/** When the share link expires */
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		/** Maximum number of accesses allowed (null = unlimited) */
		maxAccesses: integer("max_accesses"),
		/** Current access count */
		accessCount: integer("access_count").default(0).notNull(),
		/** When it was created */
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => ({
		tokenIdx: uniqueIndex("shared_session_token_idx").on(table.shareToken),
		sessionIdx: index("shared_session_session_idx").on(table.sessionId),
		expiresIdx: index("shared_session_expires_idx").on(table.expiresAt),
	}),
);

// ============================================================================
// TOTP USED CODES (replay protection)
// ============================================================================

export const totpUsedCodes = pgTable(
	"totp_used_codes",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		/** The code that was used */
		codeHash: varchar("code_hash", { length: 64 }).notNull(),
		/** Time window the code was valid for */
		windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
		usedAt: timestamp("used_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => ({
		userCodeIdx: uniqueIndex("totp_used_code_user_idx").on(
			table.userId,
			table.codeHash,
			table.windowStart,
		),
		// For cleanup of old entries
		windowIdx: index("totp_used_code_window_idx").on(table.windowStart),
	}),
);

// ============================================================================
// DISTRIBUTED LOCKS (for background processors)
// ============================================================================

export const distributedLocks = pgTable(
	"distributed_locks",
	{
		id: varchar("id", { length: 100 }).primaryKey(), // e.g., "webhook_processor"
		/** Which instance holds the lock */
		holderId: varchar("holder_id", { length: 100 }).notNull(),
		/** When the lock was acquired */
		acquiredAt: timestamp("acquired_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		/** When the lock expires (for crash recovery) */
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
	},
	(table) => ({
		expiresIdx: index("distributed_lock_expires_idx").on(table.expiresAt),
	}),
);

// ============================================================================
// AUDIT HASH CACHE (for multi-instance consistency)
// ============================================================================

export const auditHashCache = pgTable("audit_hash_cache", {
	orgId: uuid("org_id")
		.primaryKey()
		.references(() => organizations.id, { onDelete: "cascade" }),
	/** Last integrity hash in the chain for this org */
	lastHash: varchar("last_hash", { length: 64 }).notNull(),
	/** When this was last updated */
	updatedAt: timestamp("updated_at", { withTimezone: true })
		.defaultNow()
		.notNull(),
});

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
